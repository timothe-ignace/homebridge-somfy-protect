import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, it, mock} from "node:test";
import * as hap from "@homebridge/hap-nodejs";
import {API, PlatformAccessory, PlatformConfig} from "homebridge";
import init from "../src/index";
import {cameraFixture, deviceFixtures, fakeLogger, flush, isTokenCall, PASSWORD, stubAxios, tokenResponse, USERNAME} from "./helpers";

class FakeAccessory {
  readonly services: hap.Service[] = [];
  context = {};

  constructor(readonly displayName: string, readonly UUID: string) {
  }

  getService(type: { UUID: string }) {
    return this.services.find(service => service.UUID === type.UUID);
  }

  addService(type: new (name?: string) => hap.Service, name?: string) {
    const service = new type(name);
    this.services.push(service);
    return service;
  }
}

const sitesBody = {
  items: [
    {site_id: "s1", name: "Home", security_level: "armed"},
    {site_id: "s2", name: "Cabin", security_level: "disarmed"}
  ]
};

describe("SomfyProtectPlatform", () => {
  let dir: string;
  let platformClass: new (log: unknown, config: PlatformConfig, api: API) => { configureAccessory(accessory: PlatformAccessory): void };
  let registered: FakeAccessory[];
  let unregistered: FakeAccessory[];
  let listeners: Record<string, () => void>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "somfy-platform-"));
    registered = [];
    unregistered = [];
    listeners = {};
    mock.timers.enable({apis: ["setTimeout", "Date"], now: 1_000_000});
    mock.method(Math, "random", () => 0.5);
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
    rmSync(dir, {recursive: true, force: true});
  });

  function fakeApi(): API {
    const api = {
      hap,
      platformAccessory: FakeAccessory,
      user: {storagePath: () => dir, configPath: () => join(dir, "config.json")},
      on: (event: string, callback: () => void) => {
        listeners[event] = callback;
      },
      registerPlatform: (_name: string, constructor: typeof platformClass) => {
        platformClass = constructor;
      },
      registerPlatformAccessories: (_plugin: string, _platform: string, accessories: FakeAccessory[]) => registered.push(...accessories),
      unregisterPlatformAccessories: (_plugin: string, _platform: string, accessories: FakeAccessory[]) => unregistered.push(...accessories)
    };
    init(api as unknown as API);
    return api as unknown as API;
  }

  const config = {platform: "SomfyProtect", name: "Somfy Protect", username: USERNAME, password: PASSWORD};

  function launch(platformConfig: Record<string, unknown> = config, cached: FakeAccessory[] = []) {
    const logger = fakeLogger();
    const api = fakeApi();
    const platform = new platformClass(logger, platformConfig as PlatformConfig, api);
    cached.forEach(accessory => platform.configureAccessory(accessory as unknown as PlatformAccessory));
    listeners.didFinishLaunching();
    return {logger};
  }

  const securityState = (accessory: FakeAccessory) =>
    accessory.getService(hap.Service.SecuritySystem)!.getCharacteristic(hap.Characteristic.SecuritySystemCurrentState);

  it("adds one security system accessory per site, with the state from Somfy", async () => {
    stubAxios(call => isTokenCall(call) ? tokenResponse() : {data: sitesBody});
    launch();
    await flush();
    assert.deepEqual(registered.map(accessory => accessory.displayName), ["Home", "Cabin"]);
    assert.notEqual(registered[0].UUID, registered[1].UUID);
    assert.equal(await securityState(registered[0]).handleGetRequest(), hap.Characteristic.SecuritySystemCurrentState.AWAY_ARM);
    assert.equal(await securityState(registered[1]).handleGetRequest(), hap.Characteristic.SecuritySystemCurrentState.DISARMED);
    const info = registered[0].getService(hap.Service.AccessoryInformation)!;
    assert.equal(info.getCharacteristic(hap.Characteristic.SerialNumber).value, "s1");
  });

  it("adds a smoke sensor per smoke detector, and shows tamper and fault on the alarm", async () => {
    let devices = deviceFixtures();
    stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      if (call.url.endsWith("/device")) {
        return {data: {items: devices}};
      }
      return call.url.endsWith("/site") ? {data: {items: [sitesBody.items[0]]}} : {data: {security_level: "armed"}};
    });
    launch();
    await flush();
    assert.deepEqual(registered.map(accessory => accessory.displayName), ["Home", "Kitchen smoke"]);
    const smoke = registered[1].getService(hap.Service.SmokeSensor)!;
    const detected = smoke.getCharacteristic(hap.Characteristic.SmokeDetected);
    assert.equal(await detected.handleGetRequest(), hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED);
    const alarm = registered[0].getService(hap.Service.SecuritySystem)!;
    const tampered = alarm.getCharacteristic(hap.Characteristic.StatusTampered);
    assert.equal(await tampered.handleGetRequest(), hap.Characteristic.StatusTampered.NOT_TAMPERED);

    devices = deviceFixtures({smoke: true, coverPresent: false});
    mock.timers.tick(30000);
    await flush();
    mock.timers.tick(10000);
    await flush();
    assert.equal(await detected.handleGetRequest(), hap.Characteristic.SmokeDetected.SMOKE_DETECTED);
    assert.equal(await tampered.handleGetRequest(), hap.Characteristic.StatusTampered.TAMPERED);
  });

  it("adds a privacy switch per camera, reads the shutter and sends the command", async () => {
    let shutter: "opened" | "closed" = "closed";
    const stub = stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      if (call.method === "post") {
        shutter = call.body?.action === "shutter_close" ? "closed" : "opened";
        return {data: {}};
      }
      if (call.url.endsWith("/device")) {
        return {data: {items: [cameraFixture(shutter)]}};
      }
      return call.url.endsWith("/site") ? {data: {items: [sitesBody.items[0]]}} : {data: {security_level: "armed"}};
    });
    launch();
    await flush();
    assert.deepEqual(registered.map(accessory => accessory.displayName), ["Home", "Living room privacy"]);
    const on = registered[1].getService(hap.Service.Switch)!.getCharacteristic(hap.Characteristic.On);
    assert.equal(await on.handleGetRequest(), true);

    await on.handleSetRequest(false);
    await flush();
    const post = stub.apiCalls().find(call => call.method === "post");
    assert.deepEqual(post?.body, {action: "shutter_open"});
    assert.equal(await on.handleGetRequest(), false);
  });

  it("makes no camera switch when exposeCameraPrivacy is off, and no device call when both options are off", async () => {
    const stub = stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      if (call.url.endsWith("/device")) {
        return {data: {items: [cameraFixture("closed")]}};
      }
      return call.url.endsWith("/site") ? {data: {items: [sitesBody.items[0]]}} : {data: {security_level: "armed"}};
    });
    launch({...config, exposeCameraPrivacy: false});
    await flush();
    assert.deepEqual(registered.map(accessory => accessory.displayName), ["Home"]);
    assert.equal(stub.calls.filter(call => call.url.endsWith("/device")).length, 1, "sensors still read the devices");
  });

  it("makes no sensor accessory and no device call when exposeSensors is off", async () => {
    const stub = stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse();
      }
      return call.url.endsWith("/site") ? {data: {items: [sitesBody.items[0]]}} : {data: {security_level: "armed"}};
    });
    launch({...config, exposeSensors: false, exposeCameraPrivacy: false});
    await flush();
    mock.timers.tick(60000);
    await flush();
    assert.deepEqual(registered.map(accessory => accessory.displayName), ["Home"]);
    assert.equal(stub.calls.filter(call => call.url.endsWith("/device")).length, 0);
  });

  it("restores cached accessories and removes the ones whose site is gone", async () => {
    stubAxios(call => isTokenCall(call) ? tokenResponse() : {data: {items: [sitesBody.items[0]]}});
    const uuid = (siteId: string) => hap.uuid.generate(`somfy-protect:${siteId}`);
    const kept = new FakeAccessory("Home", uuid("s1"));
    const gone = new FakeAccessory("Old", uuid("gone"));
    launch(config, [kept, gone]);
    await flush();
    assert.deepEqual(registered, [], "the cached accessory is reused, not registered again");
    assert.deepEqual(unregistered, [gone]);
    assert.ok(kept.getService(hap.Service.SecuritySystem), "handlers are attached to the restored accessory");
  });

  it("does not talk to Somfy and logs the errors when the config is invalid", async () => {
    const stub = stubAxios(() => ({data: {}}));
    const {logger} = launch({platform: "SomfyProtect", username: "", password: ""});
    await flush();
    assert.equal(stub.calls.length, 0);
    assert.ok(logger.lines.some(line => line.includes("Invalid configuration")));
    assert.ok(logger.lines.every(line => !line.includes(PASSWORD)));
  });

  it("warns when the 2.x accessory entry is still in config.json", async () => {
    stubAxios(call => isTokenCall(call) ? tokenResponse() : {data: sitesBody});
    writeFileSync(join(dir, "config.json"), JSON.stringify({accessories: [{accessory: "SomfyProtect", name: "Somfy"}]}));
    const {logger} = launch();
    await flush();
    assert.ok(logger.lines.some(line => line.includes("under \"accessories\"")));
  });

  it("stops the account on shutdown", async () => {
    const stub = stubAxios(call => isTokenCall(call) ? tokenResponse() : {data: {...sitesBody, security_level: "armed"}});
    launch();
    await flush();
    mock.timers.tick(0);
    await flush();
    const before = stub.apiCalls().length;
    listeners.shutdown();
    mock.timers.tick(10 * 60 * 1000);
    await flush();
    assert.equal(stub.apiCalls().length, before);
  });
});
