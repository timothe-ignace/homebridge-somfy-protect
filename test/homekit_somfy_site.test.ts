import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it, mock} from "node:test";
import {
  HomekitSomfySite,
  homekitStateToSomfySecurityLevel,
  somfySecurityLevelToHomekitState,
  State
} from "../src/lib/homekit_somfy_site";
import {LoggingAmount} from "../src/lib/logging_amount";
import {fakeLogger, flush, isTokenCall, PASSWORD, RecordedCall, stubAxios, tokenResponse, USERNAME} from "./helpers";

describe("state mapping", () => {
  it("maps somfy security levels to HomeKit states", () => {
    assert.equal(somfySecurityLevelToHomekitState("armed"), State.AWAY_ARM);
    assert.equal(somfySecurityLevelToHomekitState("partial"), State.NIGHT_ARM);
    assert.equal(somfySecurityLevelToHomekitState("disarmed"), State.DISARMED);
  });

  it("returns undefined for an unknown somfy security level", () => {
    assert.equal(somfySecurityLevelToHomekitState("something_new"), undefined);
  });

  it("maps HomeKit states to somfy security levels", () => {
    assert.equal(homekitStateToSomfySecurityLevel(State.AWAY_ARM), "armed");
    assert.equal(homekitStateToSomfySecurityLevel(State.NIGHT_ARM), "partial");
    assert.equal(homekitStateToSomfySecurityLevel(State.DISARMED), "disarmed");
  });

  it("rejects states that cannot be set", () => {
    assert.throws(() => homekitStateToSomfySecurityLevel(State.ALARM_TRIGGERED), /Unknown security level/);
  });
});

describe("HomekitSomfySite", () => {
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

  function createSite(siteId = "") {
    const logger = fakeLogger();
    const site = new HomekitSomfySite(logger, {username: USERNAME, password: PASSWORD, loggingAmount: LoggingAmount.FULL, siteId});
    return {logger, site};
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
    const {site} = createSite();
    await flush();
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
    const {site, logger} = createSite("does-not-exist");
    await flush();
    assert.equal(site.isInitialized(), false);
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
    const {site, logger} = createSite();
    await flush();
    assert.equal(site.isInitialized(), false);
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
    const {site, logger} = createSite();
    await flush();
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
    const {site} = createSite();
    await flush();
    mock.timers.tick(0);
    await flush();
    assert.equal(countPath(stub.calls, "/site/s1"), 1);
    site.stop();
    mock.timers.tick(10 * 60 * 1000);
    await flush();
    assert.equal(countPath(stub.calls, "/site/s1"), 1);
    assert.deepEqual(unhandled, []);
  });
});
