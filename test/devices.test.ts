import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {viewDevices} from "../src/lib/devices";
import {cameraFixture, deviceFixtures} from "./helpers";

describe("viewDevices", () => {
  it("finds the smoke detectors and reports a quiet system", () => {
    const view = viewDevices(deviceFixtures());
    assert.deepEqual(view.smokeDetectors, [{deviceId: "d-smoke", name: "Kitchen smoke", smoke: false, lowBattery: false, fault: false}]);
    assert.equal(view.tampered, false);
    assert.equal(view.fault, false);
  });

  it("reports smoke, an opened cover and a lost device", () => {
    assert.equal(viewDevices(deviceFixtures({smoke: true})).smokeDetectors[0].smoke, true);
    assert.equal(viewDevices(deviceFixtures({coverPresent: false})).tampered, true);
    assert.equal(viewDevices(deviceFixtures({deviceLost: true})).fault, true);
  });

  it("treats a missing field as no information, and survives odd input", () => {
    const view = viewDevices([
      {device_id: "x", device_definition: {type: "tag"}, status: {}},
      {device_id: "y", device_definition: {type: "sp_risk_detector"}},
      {device_id: "z"}
    ]);
    assert.equal(view.tampered, false);
    assert.equal(view.fault, false);
    assert.equal(view.smokeDetectors.length, 1);
    assert.equal(view.smokeDetectors[0].name, "Smoke detector");
    assert.equal(view.smokeDetectors[0].smoke, false);
  });

  it("shows an indoor camera only when it reports its shutter", () => {
    assert.deepEqual(viewDevices([cameraFixture("closed")]).cameras, [{deviceId: "d-cam", name: "Living room", shutterClosed: true}]);
    assert.equal(viewDevices([cameraFixture("opened")]).cameras[0].shutterClosed, false);
    assert.deepEqual(viewDevices([cameraFixture(null)]).cameras, []);
    assert.deepEqual(viewDevices(deviceFixtures()).cameras, []);
  });
});
