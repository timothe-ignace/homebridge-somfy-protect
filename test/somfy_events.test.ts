import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it, mock} from "node:test";
import {SomfySite, State} from "../src/lib/homekit_somfy_site";
import {SomfyAccount} from "../src/lib/somfy_account";
import {LoggingAmount} from "../src/lib/logging_amount";
import {SomfyEvent, SomfyEventSocket, WebSocketLike} from "../src/lib/somfy_events";
import {fakeLogger, flush, isTokenCall, PASSWORD, stubAxios, tokenResponse, USERNAME} from "./helpers";

class FakeWebSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: unknown[] = [];
  closed = false;

  constructor(readonly url: string) {
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.({});
  }

  push(message: unknown) {
    this.onmessage?.({data: typeof message === "string" ? message : JSON.stringify(message)});
  }

  serverClose() {
    this.onclose?.({});
  }
}

function factory() {
  const sockets: FakeWebSocket[] = [];
  return {sockets, create: (url: string) => {
    const socket = new FakeWebSocket(url);
    sockets.push(socket);
    return socket;
  }};
}

describe("SomfyEventSocket", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    mock.timers.enable({apis: ["setTimeout", "Date"], now: 1_000_000});
    mock.method(Math, "random", () => 0.5);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    mock.timers.reset();
    mock.restoreAll();
  });

  function create(getToken: (force: boolean) => Promise<string> = async () => "tok-secret-1") {
    const logger = fakeLogger();
    const events: SomfyEvent[] = [];
    const f = factory();
    const socket = new SomfyEventSocket(logger, {
      getToken, onEvent: e => events.push(e), webSocketFactory: f.create, loggingAmount: LoggingAmount.FULL
    });
    return {logger, events, socket, sockets: f.sockets};
  }

  it("connects with the token, acks messages with an id and passes events on", async () => {
    const {socket, sockets, events} = create();
    socket.start();
    await flush();
    assert.equal(sockets.length, 1);
    assert.ok(sockets[0].url.startsWith("wss://websocket.myfox.io/events/websocket?token=tok-secret-1"));
    sockets[0].open();
    sockets[0].push({key: "websocket.connection.ready"});
    sockets[0].push({key: "site.privacy", site_id: "s1", active: true, message_id: "m1"});
    assert.deepEqual(sockets[0].sent, [{ack: true, message_id: "m1", client: "Android"}]);
    assert.deepEqual(events, [{key: "site.privacy", siteId: "s1", deviceId: undefined, securityLevel: undefined, active: true}]);
    assert.equal(unhandled.length, 0);
  });

  it("ignores garbage and survives a throwing handler and a throwing ack", async () => {
    const logger = fakeLogger();
    const f = factory();
    const socket = new SomfyEventSocket(logger, {
      getToken: async () => "t", loggingAmount: LoggingAmount.OFF, webSocketFactory: f.create,
      onEvent: () => {
        throw new Error("boom");
      }
    });
    socket.start();
    await flush();
    const ws = f.sockets[0];
    ws.send = () => {
      throw new Error("closed");
    };
    for (const garbage of ["not json", "null", "[1]", "42", JSON.stringify({no: "key"}), JSON.stringify({key: 5})]) {
      ws.push(garbage);
    }
    ws.onmessage?.({data: 12});
    ws.onmessage?.({data: undefined});
    ws.push({key: "x.y", site_id: "s1", message_id: 7});
    assert.ok(logger.lines.some(line => line.includes("boom")));
    assert.equal(unhandled.length, 0);
  });

  it("reconnects with an exponential backoff, and resets it after a stable connection", async () => {
    const {socket, sockets} = create();
    socket.start();
    await flush();
    sockets[0].serverClose(); // never opened: 5 s
    mock.timers.tick(4999);
    await flush();
    assert.equal(sockets.length, 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(sockets.length, 2);
    sockets[1].serverClose(); // 10 s
    mock.timers.tick(9999);
    await flush();
    assert.equal(sockets.length, 2);
    mock.timers.tick(1);
    await flush();
    assert.equal(sockets.length, 3);
    sockets[2].open();
    mock.timers.tick(61000);
    sockets[2].serverClose(); // stable: back to 5 s
    mock.timers.tick(5000);
    await flush();
    assert.equal(sockets.length, 4);
  });

  it("caps the backoff at 5 minutes", async () => {
    const {socket, sockets} = create();
    socket.start();
    await flush();
    for (let i = 0; i < 12; i++) {
      sockets[sockets.length - 1].serverClose();
      mock.timers.tick(300000);
      await flush();
    }
    assert.equal(sockets.length, 13);
  });

  it("gets a fresh token after a token error and reconnects", async () => {
    const forced: boolean[] = [];
    const {socket, sockets} = create(async force => {
      forced.push(force);
      return force ? "fresh" : "old";
    });
    socket.start();
    await flush();
    sockets[0].push({key: "websocket.error.token"});
    assert.ok(sockets[0].closed);
    mock.timers.tick(5000);
    await flush();
    assert.deepEqual(forced, [false, true]);
    assert.ok(sockets[1].url.endsWith("token=fresh"));
  });

  it("retries when the token cannot be fetched, without exposing it", async () => {
    let calls = 0;
    const {socket, sockets, logger} = create(async () => {
      if (calls++ === 0) {
        throw new Error("sso down");
      }
      return "ok";
    });
    socket.start();
    await flush();
    assert.equal(sockets.length, 0);
    mock.timers.tick(5000);
    await flush();
    assert.equal(sockets.length, 1);
    assert.ok(logger.lines.some(line => line.includes("sso down")));
  });

  it("survives a factory that throws", async () => {
    const logger = fakeLogger();
    let calls = 0;
    const socket = new SomfyEventSocket(logger, {
      getToken: async () => "t", onEvent: () => undefined, loggingAmount: LoggingAmount.OFF,
      webSocketFactory: () => {
        calls++;
        throw new Error("failed wss://x/?token=abc123");
      }
    });
    socket.start();
    await flush();
    mock.timers.tick(5000);
    await flush();
    assert.equal(calls, 2);
    assert.ok(!logger.lines.join("\n").includes("abc123"));
  });

  it("stop() closes the socket and cancels the timers", async () => {
    const {socket, sockets} = create();
    socket.start();
    await flush();
    sockets[0].serverClose();
    socket.stop();
    mock.timers.tick(600000);
    await flush();
    assert.equal(sockets.length, 1);

    const second = create();
    second.socket.start();
    await flush();
    second.socket.stop();
    assert.ok(second.sockets[0].closed);
    second.sockets[0].serverClose(); // detached: no reconnect
    mock.timers.tick(600000);
    await flush();
    assert.equal(second.sockets.length, 1);
  });

  it("never logs the token", async () => {
    const {socket, sockets, logger} = create();
    socket.start();
    await flush();
    sockets[0].open();
    sockets[0].onerror?.(new Error("tok-secret-1"));
    sockets[0].serverClose();
    mock.timers.tick(5000);
    await flush();
    assert.ok(logger.lines.length > 0);
    assert.ok(!logger.lines.join("\n").includes("tok-secret-1"));
  });
});

describe("SomfyAccount with real-time events", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    mock.timers.enable({apis: ["setTimeout", "Date"], now: 1_000_000});
    mock.method(Math, "random", () => 0.5);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    mock.timers.reset();
    mock.restoreAll();
  });

  async function setup(realtimeEvents = true, level = "armed") {
    let securityLevel = level;
    let idleAlarm = false;
    let siteReads = 0;
    const stub = stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      if (call.url.endsWith("/site")) {
        return {data: {items: [{site_id: "s1", name: "Home", security_level: level}]}};
      }
      siteReads++;
      return {data: {security_level: securityLevel, ...(idleAlarm ? {alarm: {status: "none"}, domestic_alarm: []} : {})}};
    });
    const logger = fakeLogger();
    const f = factory();
    const account = new SomfyAccount(logger, {
      username: USERNAME, password: PASSWORD, loggingAmount: LoggingAmount.FULL, realtimeEvents, webSocketFactory: f.create
    });
    let site: SomfySite | undefined;
    account.onDiscovered(sites => {
      site = sites[0];
    });
    account.start();
    await flush();
    mock.timers.tick(0);
    await flush();
    return {
      account, logger, stub, sockets: f.sockets, site: site as SomfySite,
      setLevel: (value: string) => securityLevel = value, setIdle: (value: boolean) => idleAlarm = value, reads: () => siteReads
    };
  }

  it("does not open the channel unless realtimeEvents is true", async () => {
    const {sockets, account} = await setup(false);
    assert.equal(sockets.length, 0);
    account.stop();
  });

  it("opens the channel after discovery with the access token and stops it on stop()", async () => {
    const {sockets, account} = await setup();
    assert.equal(sockets.length, 1);
    assert.ok(sockets[0].url.endsWith("token=access-1"));
    account.stop();
    assert.ok(sockets[0].closed);
  });

  it("applies security.level.change at once, and ignores unknown levels and sites", async () => {
    const {sockets, site, account} = await setup();
    sockets[0].open();
    assert.equal(site.getCurrentState(), State.AWAY_ARM);
    sockets[0].push({key: "security.level.change", site_id: "s1", security_level: "partial", message_id: 1});
    assert.equal(site.getCurrentState(), State.NIGHT_ARM);
    assert.equal(site.getTargetState(), State.NIGHT_ARM);
    sockets[0].push({key: "security.level.change", site_id: "s1", security_level: "weird"});
    sockets[0].push({key: "security.level.change", site_id: "other", security_level: "disarmed"});
    sockets[0].push({key: "security.level.change", site_id: "s1"});
    assert.equal(site.getCurrentState(), State.NIGHT_ARM);
    account.stop();
  });

  it("reports a triggered alarm, clears it at alarm.end with a REST refresh", async () => {
    const {sockets, site, account, logger, reads} = await setup();
    let changes = 0;
    site.onCurrentStateChange(() => changes++);
    sockets[0].push({key: "alarm.trespass", site_id: "s1"});
    assert.equal(site.getCurrentState(), State.ALARM_TRIGGERED);
    assert.equal(site.getTargetState(), State.AWAY_ARM);
    assert.equal(changes, 1);
    assert.ok(logger.lines.some(line => line.includes("Alarm triggered")));
    sockets[0].push({key: "alarm.panic", site_id: "s1"});
    assert.equal(changes, 1);

    const before = reads();
    sockets[0].push({key: "alarm.end", site_id: "s1"});
    assert.equal(site.getCurrentState(), State.AWAY_ARM);
    assert.equal(changes, 2);
    assert.ok(logger.lines.some(line => line.includes("Alarm ended")));
    mock.timers.tick(0);
    await flush();
    assert.equal(reads(), before + 1);
    account.stop();
  });

  it("clears a triggered intrusion alarm when the security level changes (disarming)", async () => {
    const {sockets, site, account, setLevel} = await setup();
    sockets[0].push({key: "alarm.trespass", site_id: "s1"});
    assert.equal(site.getCurrentState(), State.ALARM_TRIGGERED);
    sockets[0].push({key: "security.level.change", site_id: "s1", security_level: "disarmed"});
    assert.equal(site.getCurrentState(), State.DISARMED);

    sockets[0].push({key: "security.level.change", site_id: "s1", security_level: "armed"});
    sockets[0].push({key: "alarm.trespass", site_id: "s1"});
    assert.equal(site.getCurrentState(), State.ALARM_TRIGGERED);
    setLevel("disarmed"); // a poll that sees a different level than at the start of the alarm
    mock.timers.tick(10000);
    await flush();
    assert.equal(site.getCurrentState(), State.DISARMED);
    account.stop();
  });

  it("keeps a fire alarm in a disarmed system until alarm.end or until Somfy reports nothing going on", async () => {
    const {sockets, site, account, setLevel, setIdle} = await setup(true, "disarmed");
    setLevel("disarmed");
    sockets[0].push({key: "alarm.domestic.fire", site_id: "s1"});
    assert.equal(site.getCurrentState(), State.ALARM_TRIGGERED);
    mock.timers.tick(10000); // polls say disarmed, which is no end of the alarm
    await flush();
    assert.equal(site.getCurrentState(), State.ALARM_TRIGGERED);

    setIdle(true); // REST data says idle, but the alarm is recent: it may lag behind the event
    mock.timers.tick(10000);
    await flush();
    assert.equal(site.getCurrentState(), State.ALARM_TRIGGERED);
    mock.timers.tick(60000); // idle for long enough: the end event was missed
    await flush();
    assert.equal(site.getCurrentState(), State.DISARMED);

    sockets[0].push({key: "alarm.domestic.fire", site_id: "s1"});
    assert.equal(site.getCurrentState(), State.ALARM_TRIGGERED);
    sockets[0].push({key: "alarm.end", site_id: "s1"});
    assert.equal(site.getCurrentState(), State.DISARMED);
    account.stop();
  });

  it("ignores unknown events and garbage, polling keeps working", async () => {
    const {sockets, site, account, reads, setLevel} = await setup();
    sockets[0].push({key: "camerastatus.shutter.open", site_id: "s1", device_id: "d1"});
    sockets[0].push({key: "site.privacy", site_id: "s1", active: true});
    sockets[0].push({key: "device.status", site_id: "zzz"});
    sockets[0].push("garbage{");
    assert.equal(site.getCurrentState(), State.AWAY_ARM);
    const before = reads();
    setLevel("partial");
    mock.timers.tick(10000);
    await flush();
    assert.equal(reads(), before + 1);
    assert.equal(site.getCurrentState(), State.NIGHT_ARM);
    account.stop();
    assert.equal(unhandled.length, 0);
  });

  it("keeps polling when the channel cannot be opened", async () => {
    stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      return call.url.endsWith("/site") ? {data: {items: [{site_id: "s1", name: "Home", security_level: "armed"}]}}
        : {data: {security_level: "partial"}};
    });
    const logger = fakeLogger();
    const account = new SomfyAccount(logger, {
      username: USERNAME, password: PASSWORD, loggingAmount: LoggingAmount.OFF, realtimeEvents: true,
      webSocketFactory: () => {
        throw new Error("no websocket");
      }
    });
    let site: SomfySite | undefined;
    account.onDiscovered(sites => {
      site = sites[0];
    });
    account.start();
    await flush();
    mock.timers.tick(0);
    await flush();
    assert.equal(site?.getCurrentState(), State.NIGHT_ARM);
    assert.ok(logger.lines.some(line => line.includes("no websocket")));
    account.stop();
    assert.equal(unhandled.length, 0);
  });

  it("refreshes the token through the API after a token error, and never logs it", async () => {
    const {sockets, stub, account, logger} = await setup();
    sockets[0].push({key: "websocket.error.token"});
    mock.timers.tick(5000);
    await flush();
    assert.equal(sockets.length, 2);
    assert.equal(stub.tokenCalls().length, 2); // login, then a refresh
    assert.equal(stub.tokenCalls()[1].body?.grant_type, "refresh_token");
    assert.ok(!logger.lines.join("\n").includes("access-"));
    account.stop();
  });
});
