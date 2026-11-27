import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it, mock} from "node:test";
import {SomfySite, State} from "../src/lib/homekit_somfy_site";
import {SomfyAccount} from "../src/lib/somfy_account";
import {LoggingAmount} from "../src/lib/logging_amount";
import {
  cameraFixture, deviceFixtures, fakeLogger, flush, isTokenCall, PASSWORD, RecordedCall, stubAxios, tokenResponse, USERNAME
} from "./helpers";

describe("SomfyAccount", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    mock.timers.enable({apis: ["setTimeout", "Date"], now: 1_000_000});
    mock.method(Math, "random", () => 0.5); // jitter factor 1.0
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    mock.timers.reset();
    mock.restoreAll();
  });

  function createSite(siteIds: string[] = [], fetchDevices = false) {
    const logger = fakeLogger();
    const account = new SomfyAccount(logger, {
      username: USERNAME, password: PASSWORD, loggingAmount: LoggingAmount.FULL, siteIds, fetchDevices
    });
    const discovered: SomfySite[][] = [];
    account.onDiscovered((sites) => discovered.push(sites));
    account.start();
    return {logger, account, discovered, get site() {
      return discovered[0]?.[0];
    }};
  }

  const sitesBody = {items: [{site_id: "s1", name: "Home", security_level: "armed"}]};
  const countPath = (calls: RecordedCall[], suffix: string) => calls.filter(call => call.url.endsWith(suffix)).length;

  it("initializes, reads the state and polls", async () => {
    const stub = stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      return call.url.endsWith("/site") ? {data: sitesBody} : {data: {security_level: "partial"}};
    });
    const created = createSite();
    await flush();
    const site = created.site;
    assert.ok(site.isInitialized());
    assert.equal(site.getCurrentState(), State.AWAY_ARM);

    mock.timers.tick(0); // first poll
    await flush();
    assert.equal(countPath(stub.calls, "/site/s1"), 1);
    assert.equal(site.getCurrentState(), State.NIGHT_ARM);
  });

  it("warns once about an alarm status other than none, and not for none", async () => {
    let alarm: unknown = {status: "none"};
    stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      return call.url.endsWith("/site") ? {data: sitesBody} : {data: {security_level: "armed", alarm}};
    });
    const {logger} = createSite();
    await flush();
    mock.timers.tick(0);
    await flush();
    const warnings = () => logger.lines.filter(line => line.includes("alarm status"));
    assert.equal(warnings().length, 0);

    alarm = {status: "pending_test"};
    for (let i = 0; i < 2; i++) {
      mock.timers.tick(10000);
      await flush();
    }
    assert.equal(warnings().length, 1);
    assert.ok(warnings()[0].includes("pending_test"));
  });

  it("retries with a growing backoff when the siteId is unknown", async () => {
    const stub = stubAxios(call => isTokenCall(call) ? tokenResponse() : {data: sitesBody});
    const {discovered, logger} = createSite(["does-not-exist"]);
    await flush();
    assert.equal(discovered.length, 0);
    assert.equal(countPath(stub.calls, "/site"), 1);
    assert.ok(logger.lines.some(line => line.includes("does-not-exist")));

    mock.timers.tick(19999); // first backoff: 10 s * 2^1
    await flush();
    assert.equal(countPath(stub.calls, "/site"), 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(countPath(stub.calls, "/site"), 2);

    mock.timers.tick(39999); // second backoff: 10 s * 2^2
    await flush();
    assert.equal(countPath(stub.calls, "/site"), 2);
    mock.timers.tick(1);
    await flush();
    assert.equal(countPath(stub.calls, "/site"), 3);
    assert.equal(stub.tokenCalls().length, 1);
    assert.deepEqual(unhandled, []);
  });

  it("backs off on 429 during polling, honours Retry-After and leaves no unhandled rejection", async () => {
    let rateLimited = true;
    const stub = stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      if (call.url.endsWith("/site")) {
        return {data: sitesBody};
      }
      return rateLimited ? {status: 429, headers: {"retry-after": "600"}} : {data: {security_level: "armed"}};
    });
    const {logger} = createSite();
    await flush();

    mock.timers.tick(0);
    await flush();
    assert.equal(countPath(stub.calls, "/site/s1"), 1);
    assert.ok(logger.lines.some(line => line.includes("Poll failed")));

    mock.timers.tick(599_999);
    await flush();
    assert.equal(countPath(stub.calls, "/site/s1"), 1, "must wait for Retry-After");

    rateLimited = false;
    mock.timers.tick(1);
    await flush();
    assert.equal(countPath(stub.calls, "/site/s1"), 2);
    assert.ok(logger.lines.some(line => line.includes("Connection to somfy restored")));
    assert.equal(stub.tokenCalls().length, 1);
    assert.deepEqual(unhandled, []);
    for (const line of logger.lines) {
      assert.ok(!line.includes(PASSWORD), line);
    }
  });

  it("does not crash when initialization fails with a server error", async () => {
    stubAxios(() => ({status: 500}));
    const {discovered, logger} = createSite();
    await flush();
    assert.equal(discovered.length, 0);
    assert.ok(logger.lines.some(line => line.includes("Could not initialize")));
    assert.ok(logger.lines.every(line => !line.includes(PASSWORD)));
    assert.deepEqual(unhandled, []);
  });

  it("keeps the previous state and warns once on an unknown security level", async () => {
    let level = "armed";
    const stub = stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      return call.url.endsWith("/site") ? {data: sitesBody} : {data: {security_level: level}};
    });
    const {logger, discovered} = createSite();
    await flush();
    const site = discovered[0][0];
    level = "something_new";
    mock.timers.tick(0);
    await flush();
    mock.timers.tick(10000);
    await flush();
    assert.equal(countPath(stub.calls, "/site/s1"), 2);
    assert.equal(site.getCurrentState(), State.AWAY_ARM);
    assert.equal(logger.lines.filter(line => line.includes("Unknown security level")).length, 1);
    assert.deepEqual(unhandled, []);
  });

  it("stops polling after stop()", async () => {
    const stub = stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      return call.url.endsWith("/site") ? {data: sitesBody} : {data: {security_level: "armed"}};
    });
    const {account} = createSite();
    await flush();
    mock.timers.tick(0);
    await flush();
    assert.equal(countPath(stub.calls, "/site/s1"), 1);
    account.stop();
    mock.timers.tick(10 * 60 * 1000);
    await flush();
    assert.equal(countPath(stub.calls, "/site/s1"), 1);
    assert.deepEqual(unhandled, []);
  });
  it("exposes every site by default and only the listed ones with siteIds", async () => {
    const two = {items: [
      {site_id: "s1", name: "Home", security_level: "armed"},
      {site_id: "s2", name: "Cabin", security_level: "disarmed"}
    ]};
    const stub = stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      return call.url.endsWith("/site") ? {data: two} : {data: {security_level: call.url.endsWith("/s2") ? "partial" : "armed"}};
    });
    const all = createSite();
    await flush();
    assert.deepEqual(all.discovered[0].map(site => site.siteId), ["s1", "s2"]);
    assert.equal(all.discovered[0][1].getCurrentState(), State.DISARMED);

    mock.timers.tick(0); // one poll cycle reads both sites with the same token
    await flush();
    assert.equal(countPath(stub.calls, "/site/s1"), 1);
    assert.equal(countPath(stub.calls, "/site/s2"), 1);
    assert.equal(all.discovered[0][1].getCurrentState(), State.NIGHT_ARM);
    assert.equal(stub.tokenCalls().length, 1);

    const some = createSite(["s2", "missing"]);
    await flush();
    assert.deepEqual(some.discovered[0].map(site => site.siteId), ["s2"]);
    assert.ok(some.logger.lines.some(line => line.includes("missing")));
    assert.deepEqual(unhandled, []);
  });

  it("sends a command for the right site and reverts the target when it fails", async () => {
    const two = {items: [
      {site_id: "s1", name: "Home", security_level: "armed"},
      {site_id: "s2", name: "Cabin", security_level: "armed"}
    ]};
    const stub = stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      if (call.method === "put") {
        return {status: 500};
      }
      return call.url.endsWith("/site") ? {data: two} : {data: {security_level: "armed"}};
    });
    const {discovered, logger} = createSite();
    await flush();
    const cabin = discovered[0][1];
    cabin.setTargetState(State.DISARMED);
    assert.equal(cabin.getTargetState(), State.DISARMED);
    await flush();
    const puts = stub.calls.filter(call => call.method === "put");
    assert.equal(puts.length, 1);
    assert.ok(puts[0].url.includes("/site/s2/"));
    assert.equal(cabin.getTargetState(), State.AWAY_ARM, "reverted");
    assert.equal(discovered[0][0].getTargetState(), State.AWAY_ARM);
    assert.ok(logger.lines.some(line => line.includes("Could not set the security level")));
    assert.deepEqual(unhandled, []);
  });

  describe("devices", () => {
    function devicesStub(deviceHandler: () => { status?: number; data?: unknown }) {
      return stubAxios(call => {
        if (isTokenCall(call)) {
          return tokenResponse();
        }
        if (call.url.endsWith("/device")) {
          return deviceHandler();
        }
        return call.url.endsWith("/site") ? {data: sitesBody} : {data: {security_level: "armed"}};
      });
    }

    it("reads the devices at discovery, then at most every 30 s", async () => {
      let smoke = false;
      const stub = devicesStub(() => ({data: {items: deviceFixtures({smoke})}}));
      const created = createSite([], true);
      await flush();
      const site = created.site;
      assert.equal(countPath(stub.calls, "/device"), 1);
      assert.equal(site.getDevicesView().smokeDetectors.length, 1);
      let notifications = 0;
      site.onDevicesChange(() => notifications++);

      smoke = true;
      mock.timers.tick(0); // first alarm poll: the devices were read a moment ago
      await flush();
      mock.timers.tick(10000);
      await flush();
      mock.timers.tick(10000);
      await flush();
      assert.equal(countPath(stub.calls, "/device"), 1);

      mock.timers.tick(10000); // 30 s after the first read
      await flush();
      assert.equal(countPath(stub.calls, "/device"), 2);
      assert.equal(site.getDevicesView().smokeDetectors[0].smoke, true);
      assert.equal(notifications, 1);
      assert.deepEqual(unhandled, []);
    });

    it("does not read the devices unless asked to", async () => {
      const stub = devicesStub(() => ({data: {items: deviceFixtures()}}));
      createSite();
      await flush();
      mock.timers.tick(60000);
      await flush();
      assert.equal(countPath(stub.calls, "/device"), 0);
    });

    it("keeps the alarm working when the device list is refused", async () => {
      const stub = devicesStub(() => ({status: 403}));
      const {logger, discovered} = createSite([], true);
      await flush();
      assert.equal(discovered.length, 1, "the alarm is discovered");
      assert.ok(logger.lines.some(line => line.includes("sensors are switched off")));
      mock.timers.tick(120000);
      await flush();
      assert.equal(countPath(stub.calls, "/device"), 1, "no further attempts");
      assert.ok(countPath(stub.calls, "/site/s1") >= 1, "the alarm is still polled");
      assert.deepEqual(unhandled, []);
    });

    it("backs off when the device list is rate limited", async () => {
      let limited = false;
      const stub = devicesStub(() => limited ? {status: 429, headers: {"retry-after": "300"}} : {data: {items: deviceFixtures()}});
      const {logger} = createSite([], true);
      await flush();
      limited = true;
      mock.timers.tick(0);
      await flush();
      mock.timers.tick(30000); // next device read is due and gets 429
      await flush();
      mock.timers.tick(10000);
      await flush();
      mock.timers.tick(10000);
      await flush();
      mock.timers.tick(10000);
      await flush();
      assert.ok(logger.lines.some(line => line.includes("Poll failed")));
      const before = countPath(stub.calls, "/site/s1");
      mock.timers.tick(200000);
      await flush();
      assert.equal(countPath(stub.calls, "/site/s1"), before, "waits for Retry-After");
      assert.deepEqual(unhandled, []);
    });
  });
  describe("camera shutter", () => {
    function cameraStub(actionStatus = 200) {
      let shutter: "opened" | "closed" = "opened";
      const stub = stubAxios(call => {
        if (isTokenCall(call)) {
          return tokenResponse();
        }
        if (call.method === "post") {
          if (actionStatus === 200) {
            shutter = call.body?.action === "shutter_close" ? "closed" : "opened";
          }
          return {status: actionStatus};
        }
        if (call.url.endsWith("/device")) {
          return {data: {items: [cameraFixture(shutter)]}};
        }
        return call.url.endsWith("/site") ? {data: sitesBody} : {data: {security_level: "armed"}};
      });
      return stub;
    }

    it("sends the shutter command, shows it at once and reads the devices again", async () => {
      const stub = cameraStub();
      const created = createSite([], true);
      await flush();
      const site = created.site;
      assert.equal(site.getDevicesView().cameras[0].shutterClosed, false);
      let notifications = 0;
      site.onDevicesChange(() => notifications++);

      site.setShutter("d-cam", true);
      await flush();
      const posts = stub.apiCalls().filter(call => call.method === "post");
      assert.equal(posts.length, 1);
      assert.ok(posts[0].url.endsWith("/site/s1/device/d-cam/action"));
      assert.deepEqual(posts[0].body, {action: "shutter_close"});
      assert.equal(site.getDevicesView().cameras[0].shutterClosed, true, "shown at once");
      assert.equal(notifications, 1);

      const reads = countPath(stub.calls, "/device");
      mock.timers.tick(3000);
      await flush();
      assert.equal(countPath(stub.calls, "/device"), reads + 1, "devices are read again");
      assert.equal(site.getDevicesView().cameras[0].shutterClosed, true);
      assert.deepEqual(unhandled, []);
    });

    it("shows the real position again when the command fails", async () => {
      const stub = cameraStub(500);
      const created = createSite([], true);
      await flush();
      const site = created.site;
      let notifications = 0;
      site.onDevicesChange(() => notifications++);
      site.setShutter("d-cam", true);
      await flush();
      assert.equal(stub.apiCalls().filter(call => call.method === "post").length, 1);
      assert.equal(site.getDevicesView().cameras[0].shutterClosed, false);
      assert.equal(notifications, 1, "listeners are told to show the real state");
      assert.ok(created.logger.lines.some(line => line.includes("Could not move the camera shutter")));
      assert.deepEqual(unhandled, []);
    });

    it("cancels the pending device read on stop()", async () => {
      const stub = cameraStub();
      const created = createSite([], true);
      await flush();
      created.site.setShutter("d-cam", true);
      await flush();
      const reads = countPath(stub.calls, "/device");
      created.account.stop();
      mock.timers.tick(10000);
      await flush();
      assert.equal(countPath(stub.calls, "/device"), reads);
    });
  });
});
