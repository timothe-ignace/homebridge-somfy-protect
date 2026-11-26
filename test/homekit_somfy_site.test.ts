import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  homekitStateToSomfySecurityLevel,
  SomfySite,
  somfySecurityLevelToHomekitState,
  State
} from "../src/lib/homekit_somfy_site";

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

describe("SomfySite", () => {
  it("is not usable before it has a state, and throws instead of inventing one", () => {
    const site = new SomfySite("s1", "Home", () => undefined);
    assert.equal(site.isInitialized(), false);
    assert.throws(() => site.getCurrentState(), /not properly initialized/);
    assert.throws(() => site.getTargetState(), /not properly initialized/);
  });

  it("notifies only when the polled state changes, and keeps the target in step", () => {
    const site = new SomfySite("s1", "Home", () => undefined);
    let notifications = 0;
    site.onCurrentStateChange(() => notifications++);
    site.initState(State.DISARMED);
    assert.equal(notifications, 0);
    site.updateState(State.DISARMED);
    assert.equal(notifications, 0);
    site.updateState(State.AWAY_ARM);
    assert.equal(notifications, 1);
    assert.equal(site.getTargetState(), State.AWAY_ARM);
  });

  it("forwards commands and can revert a failed one", () => {
    const sent: State[] = [];
    const site = new SomfySite("s1", "Home", (_site, state) => {
      site.requestTargetState(state);
      sent.push(state);
    });
    site.initState(State.DISARMED);
    let notifications = 0;
    site.onCurrentStateChange(() => notifications++);
    site.setTargetState(State.AWAY_ARM);
    assert.deepEqual(sent, [State.AWAY_ARM]);
    assert.equal(site.getTargetState(), State.AWAY_ARM);
    site.revertTargetState(State.AWAY_ARM);
    assert.equal(site.getTargetState(), State.DISARMED);
    assert.equal(notifications, 1);
  });
});
