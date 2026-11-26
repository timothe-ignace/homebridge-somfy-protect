import {Logging} from "homebridge";
import {SomfyAPI, SomfyAPIError} from "./somfy_api";
import {EventEmitter} from "events";
import {LoggingAmount} from "./logging_amout";
import Timeout = NodeJS.Timeout;

const POLL_INTERVAL = 10000;
const MAX_BACKOFF = 15 * 60 * 1000;

interface SomfySiteConfig {
  username: string;
  password: string;
  loggingAmount: LoggingAmount;
  siteId: string;
}

interface SomfySiteItem {
  site_id: string;
  name: string;
  security_level?: "disarmed" | "armed" | "partial";
}

export enum State {
  AWAY_ARM = 1,
  NIGHT_ARM = 2,
  DISARMED = 3,
  ALARM_TRIGGERED = 4
}

export class HomekitSomfySite {

  private readonly logger: Logging;
  private readonly config: SomfySiteConfig;
  private readonly somfyAPI: SomfyAPI;
  private readonly emitter: EventEmitter;

  private siteId: string | null = null;
  private currentState: State | null = null;
  private targetState: State | null = null;
  private timeout: Timeout | null = null;
  private initTimeout: Timeout | null = null;
  private polling = false;
  private pollingStopped = false;
  private commandsInFlight = 0;
  private failureCount = 0;
  private retryAfterMs = 0;

  constructor(logger: Logging, config: SomfySiteConfig) {
    this.logger = logger;
    this.config = config;

    this.somfyAPI = new SomfyAPI(logger, {
      username: config.username,
      password: config.password,
      loggingAmount: config.loggingAmount
    });

    this.emitter = new EventEmitter();

    // logging
    this.emitter.addListener("currentStateChange", () => {
      if (this.config.loggingAmount > LoggingAmount.OFF) {
        this.logger.info(`Current state changed: currentState=${this.currentState}, targetState=${this.targetState}`);
      }
    });

    this.initializeWithRetry();
  }

  private async initializeWithRetry() {
    let success = false;
    let threw = false;
    try {
      success = await this.initialize();
    } catch (error: unknown) {
      threw = true;
      this.registerFailure(error);
      this.logger.error(`Could not initialize: ${errorMessage(error)}`);
    }
    if (success) {
      this.failureCount = 0;
      this.retryAfterMs = 0;
      this.startPolling();
    } else {
      if (!threw) {
        // no exception (e.g. unknown siteId, no site on the account): still back off instead of retrying every poll interval
        this.failureCount++;
      }
      const delay = this.nextDelay();
      this.logger.warn(`Initialization failed, retrying in ${Math.round(delay / 1000)} s`);
      this.initTimeout = setTimeout(() => {
        this.initTimeout = null;
        this.initializeWithRetry();
      }, delay);
    }
  }

  /**
   * Returns true when the site could be retrieved. Throws when the API call fails.
   */
  private async initialize(): Promise<boolean> {
    const result = await this.somfyAPI.getALLSites();
    const items: SomfySiteItem[] = result?.data?.items ?? [];
    const site = this.config.siteId ? items.find((site) => site.site_id === this.config.siteId) : items[0];
    if (items.length > 1 && site) {
      const loggingFunction = this.config.siteId ? "info" : "warn";
      this.logger[loggingFunction](`Multiple sites detected on your somfy account, using site ID ${site.site_id}. To use an other site, specify site ID in the plugin config under the name "siteId".`);
      this.logger[loggingFunction]("Possible sites detected on your somfy account:");
      items.forEach((site, index) => {
        this.logger[loggingFunction](`Site ${index + 1}: ${site.name}, site ID: ${site.site_id}`);
      });
    }
    if (site) {
      // set site id
      this.siteId = site.site_id;
      // set current state
      if (site.security_level) {
        const currentState = somfySecurityLevelToHomekitState(site.security_level);
        this.currentState = currentState;
        this.targetState = currentState;
      }
      return this.isInitialized();
    }
    if (result?.data) {
      if (items.length === 0) {
        this.logger.error("Could not retrieve site: no sites are configured on your somfy account");
        return false;
      } else if (this.config.siteId) {
        this.logger.error(`Could not retrieve site: the siteId "${this.config.siteId}" you have configured can not be found on your somfy account`);
        this.logger.error("Possible sites detected on your somfy account:");
        items.forEach((site, index) => {
          this.logger.error(`Site ${index + 1}: ${site.name}, site ID: ${site.site_id}`);
        });
        return false;
      }
    }
    this.logger.error("Could not retrieve site: an unknown error has occurred");
    return false;
  }

  isInitialized(): boolean {
    return this.siteId !== null && this.currentState !== null && this.targetState !== null;
  }

  private registerFailure(error: unknown) {
    this.failureCount++;
    const retryAfterMs = error instanceof SomfyAPIError ? error.retryAfterMs : undefined;
    this.retryAfterMs = retryAfterMs ?? 0;
  }

  /**
   * Delay before the next attempt: the poll interval after a success, otherwise an exponential backoff
   * (capped, with jitter), never shorter than the Retry-After requested by the server.
   */
  private nextDelay(): number {
    if (this.failureCount === 0) {
      return POLL_INTERVAL;
    }
    const backoff = Math.min(MAX_BACKOFF, POLL_INTERVAL * Math.pow(2, this.failureCount));
    const jittered = backoff * (0.8 + Math.random() * 0.4);
    return Math.max(jittered, this.retryAfterMs);
  }

  private async poll() {
    if (this.siteId === null || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const result = await this.somfyAPI.getSite(this.siteId);
      const security_level = result?.data?.security_level;
      if (this.failureCount > 0) {
        this.logger.info("Connection to somfy restored");
      }
      this.failureCount = 0;
      this.retryAfterMs = 0;
      // a pending command has priority over what the poll has seen
      if (security_level && this.commandsInFlight === 0) {
        // logging
        if (this.config.loggingAmount === LoggingAmount.FULL) {
          this.logger.info("Poll security level with success, getting:", security_level);
        }
        const state = somfySecurityLevelToHomekitState(security_level);
        this.setCurrentState(state);
      }
    } catch (error: unknown) {
      this.registerFailure(error);
      const delay = Math.round(this.nextDelay() / 1000);
      this.logger.error(`Poll failed (attempt ${this.failureCount}), retrying in ${delay} s: ${errorMessage(error)}`);
    } finally {
      this.polling = false;
      this.scheduleNextPoll();
    }
  }

  private scheduleNextPoll(delay?: number) {
    if (this.pollingStopped || this.commandsInFlight > 0) {
      return;
    }
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
    }
    this.timeout = setTimeout(() => {
      this.timeout = null;
      this.poll().catch(error => this.logger.error(`Unexpected poll error: ${errorMessage(error)}`));
    }, delay ?? this.nextDelay());
  }

  private startPolling() {
    if (this.isInitialized()) {
      this.pollingStopped = false;
      if (this.timeout === null && !this.polling) {
        this.scheduleNextPoll(0);
      } else {
        // logging
        if (this.config.loggingAmount === LoggingAmount.FULL) {
          this.logger.info("startPolling: Polling already started");
        }
      }
    }
  }

  private stopPolling() {
    this.pollingStopped = true;
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    } else {
      // logging
      if (this.config.loggingAmount === LoggingAmount.FULL) {
        this.logger.info("stopPolling: Polling already stopped");
      }
    }
  }

  getCurrentState(): State {
    if (this.currentState) {
      return this.currentState;
    } else {
      throw new Error("getCurrentState: HomekitSomfySite not properly initialized");
    }
  }

  private setCurrentState(state: State) {
    if (this.currentState !== state) {
      this.currentState = state;
      this.targetState = state; // needed when external changes are occurring
      this.emitter.emit("currentStateChange");
    }
  }

  getTargetState(): State {
    if (this.targetState) {
      return this.targetState;
    } else {
      throw new Error("getTargetState: HomekitSomfySite not properly initialized");
    }
  }

  setTargetState(state: State) {
    this.targetState = state;
    if (this.siteId === null) {
      return;
    }
    let securityLevel: "disarmed" | "armed" | "partial";
    try {
      securityLevel = homekitStateToSomfySecurityLevel(state);
    } catch (error: unknown) {
      this.logger.error(errorMessage(error));
      return;
    }
    // logging
    if (this.config.loggingAmount === LoggingAmount.FULL) {
      this.logger.info("setTargetState", state);
    }
    // no polling while the command is in flight
    this.stopPolling();
    this.commandsInFlight++;
    this.somfyAPI.setSecurityLevel(this.siteId, securityLevel)
      .then(() => {
        this.failureCount = 0;
        this.retryAfterMs = 0;
      })
      .catch((error: unknown) => {
        this.registerFailure(error);
        this.logger.error(`Could not set the security level: ${errorMessage(error)}`);
        // the command failed, go back to what the system really is
        if (this.targetState === state && this.currentState !== null && this.currentState !== state) {
          this.targetState = this.currentState;
          this.emitter.emit("currentStateChange");
        }
      })
      .finally(() => {
        this.commandsInFlight--;
        if (this.commandsInFlight === 0) {
          this.pollingStopped = false;
          this.scheduleNextPoll(this.failureCount > 0 ? undefined : 1000);
        }
      })
      .catch(error => this.logger.error(`Unexpected error: ${errorMessage(error)}`));
  }

  onCurrentStateChange(callback: () => void) {
    this.emitter.addListener("currentStateChange", callback);
  }

  offCurrentStateChange(callback: () => void) {
    this.emitter.removeListener("currentStateChange", callback);
  }

}

function somfySecurityLevelToHomekitState(securityLevel: "disarmed" | "armed" | "partial"): State {
  switch (securityLevel) {
    case "armed":
      return State.AWAY_ARM;
    case "partial":
      return State.NIGHT_ARM;
    case "disarmed":
      return State.DISARMED;
  }
}

function homekitStateToSomfySecurityLevel(state: State): "disarmed" | "armed" | "partial" {
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
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
