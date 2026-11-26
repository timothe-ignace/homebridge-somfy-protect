import {EventEmitter} from "events";

export enum State {
  AWAY_ARM = 1,
  NIGHT_ARM = 2,
  DISARMED = 3,
  ALARM_TRIGGERED = 4
}

type SendTargetState = (site: SomfySite, state: State) => void;

/**
 * The state of one Somfy site as seen from HomeKit. It is fed by a SomfyAccount (polling) and sends commands through it.
 */
export class SomfySite {

  private currentState: State | null = null;
  private targetState: State | null = null;
  private readonly emitter = new EventEmitter();

  constructor(readonly siteId: string, readonly name: string, private readonly sendTargetState: SendTargetState) {
  }

  isInitialized(): boolean {
    return this.currentState !== null && this.targetState !== null;
  }

  getCurrentState(): State {
    if (this.currentState) {
      return this.currentState;
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

  /** @internal Sets the first known state, without notification. */
  initState(state: State) {
    this.currentState = state;
    this.targetState = state;
  }

  /** @internal The state seen by a poll (also needed for changes made outside HomeKit). */
  updateState(state: State) {
    if (this.currentState !== state) {
      this.currentState = state;
      this.targetState = state;
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
