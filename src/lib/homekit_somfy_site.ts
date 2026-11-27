import {EventEmitter} from "events";
import {DevicesView, SomfyDevice, viewDevices} from "./devices";

export enum State {
  AWAY_ARM = 1,
  NIGHT_ARM = 2,
  DISARMED = 3,
  ALARM_TRIGGERED = 4
}

type SendTargetState = (site: SomfySite, state: State) => void;
type SendShutter = (site: SomfySite, deviceId: string, closed: boolean) => void;

/**
 * The state of one Somfy site as seen from HomeKit. It is fed by a SomfyAccount (polling) and sends commands through it.
 */
export class SomfySite {

  private currentState: State | null = null;
  private targetState: State | null = null;
  private triggered = false;
  private readonly emitter = new EventEmitter();
  private devicesView: DevicesView = {smokeDetectors: [], cameras: [], tampered: false, fault: false};
  /** @internal time of the last successful device read */
  lastDevicesAt = 0;

  constructor(
    readonly siteId: string,
    readonly name: string,
    private readonly sendTargetState: SendTargetState,
    private readonly sendShutter?: SendShutter
  ) {
  }

  isInitialized(): boolean {
    return this.currentState !== null && this.targetState !== null;
  }

  getCurrentState(): State {
    if (this.currentState) {
      return this.triggered ? State.ALARM_TRIGGERED : this.currentState;
    } else {
      throw new Error("getCurrentState: SomfySite not properly initialized");
    }
  }

  getTargetState(): State {
    if (this.targetState) {
      return this.targetState;
    } else {
      throw new Error("getTargetState: SomfySite not properly initialized");
    }
  }

  /**
   * Asks Somfy to change the state; never throws, a failure reverts the target state.
   */
  setTargetState(state: State) {
    this.sendTargetState(this, state);
  }

  onCurrentStateChange(callback: () => void) {
    this.emitter.addListener("currentStateChange", callback);
  }

  offCurrentStateChange(callback: () => void) {
    this.emitter.removeListener("currentStateChange", callback);
  }

  getDevicesView(): DevicesView {
    return this.devicesView;
  }

  /**
   * Opens or closes the privacy shutter of a camera; never throws, a failure shows the real state again.
   */
  setShutter(deviceId: string, closed: boolean) {
    this.sendShutter?.(this, deviceId, closed);
  }

  onDevicesChange(callback: () => void) {
    this.emitter.addListener("devicesChange", callback);
  }

  /** @internal A shutter command succeeded: show the new position until the next read confirms it. */
  applyShutter(deviceId: string, closed: boolean) {
    const camera = this.devicesView.cameras.find((candidate) => candidate.deviceId === deviceId);
    if (camera && camera.shutterClosed !== closed) {
      camera.shutterClosed = closed;
      this.emitter.emit("devicesChange");
    }
  }

  /** @internal Tells the listeners to show the real state again (e.g. after a failed command). */
  notifyDevicesChanged() {
    this.emitter.emit("devicesChange");
  }

  /** @internal The devices seen by a read; notifies only when what HomeKit shows has changed. */
  updateDevices(devices: SomfyDevice[]) {
    const view = viewDevices(devices);
    const changed = JSON.stringify(view) !== JSON.stringify(this.devicesView);
    this.devicesView = view;
    if (changed) {
      this.emitter.emit("devicesChange");
    }
  }

  /** @internal Sets the first known state, without notification. */
  initState(state: State) {
    this.currentState = state;
    this.targetState = state;
  }

  /** @internal The state seen by a poll (also needed for changes made outside HomeKit). */
  updateState(state: State) {
    // disarming stops an alarm
    const clears = state === State.DISARMED && this.triggered;
    if (clears) {
      this.triggered = false;
    }
    if (this.currentState !== state || clears) {
      this.currentState = state;
      this.targetState = state;
      this.emitter.emit("currentStateChange");
    }
  }

  isTriggered(): boolean {
    return this.triggered;
  }

  /** @internal An alarm started or ended (real-time events); the target state is left unchanged. */
  setTriggered(triggered: boolean) {
    if (this.triggered !== triggered) {
      this.triggered = triggered;
      this.emitter.emit("currentStateChange");
    }
  }

  /** @internal Remembers the requested state while the command is in flight. */
  requestTargetState(state: State) {
    this.targetState = state;
  }

  /** @internal The command failed: go back to what the system really is. */
  revertTargetState(failed: State) {
    if (this.targetState === failed && this.currentState !== null && this.currentState !== failed) {
      this.targetState = this.currentState;
      this.emitter.emit("currentStateChange");
    }
  }

}

export function somfySecurityLevelToHomekitState(securityLevel: string): State | undefined {
  switch (securityLevel) {
    case "armed":
      return State.AWAY_ARM;
    case "partial":
      return State.NIGHT_ARM;
    case "disarmed":
      return State.DISARMED;
    default:
      return undefined;
  }
}

export function homekitStateToSomfySecurityLevel(state: State): "disarmed" | "armed" | "partial" {
  switch (state) {
    case State.AWAY_ARM:
      return "armed";
    case State.NIGHT_ARM:
      return "partial";
    case State.DISARMED:
      return "disarmed";
    default:
      throw new Error("Unknown security level for " + state);
  }
}
