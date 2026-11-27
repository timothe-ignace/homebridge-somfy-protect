import {Logging} from "homebridge";
import {SomfyAPI, SomfyAPIError} from "./somfy_api";
import {SomfyDevice} from "./devices";
import {LoggingAmount} from "./logging_amount";
import {homekitStateToSomfySecurityLevel, SomfySite, somfySecurityLevelToHomekitState, State} from "./homekit_somfy_site";
import {SomfyEventSocket, WebSocketLike} from "./somfy_events";
import {handleSiteEvent} from "./somfy_event_handler";
import Timeout = NodeJS.Timeout;

const POLL_INTERVAL = 10000;
const MAX_BACKOFF = 15 * 60 * 1000;
const DEVICE_POLL_INTERVAL = 30000;
const DEVICE_REFRESH_DELAY = 3000;

export interface SomfyAccountConfig {
  username: string;
  password: string;
  loggingAmount: LoggingAmount;
  /** sites to expose; empty or undefined means every site of the account */
  siteIds?: string[];
  /** read the devices (smoke detectors, camera shutters, tamper, fault) in addition to the alarm state */
  fetchDevices?: boolean;
  clientId?: string;
  clientSecret?: string;
  tokenFile?: string;
  /** real-time events (experimental, unofficial channel) in addition to polling */
  realtimeEvents?: boolean;
  /** test seam: replaces the global WebSocket */
  webSocketFactory?: (url: string) => WebSocketLike;
}

interface SomfySiteItem {
  site_id: string;
  name: string;
  security_level?: "disarmed" | "armed" | "partial";
}

type DiscoveryCallback = (sites: SomfySite[]) => void;

/**
 * One Somfy account: one login (token), one discovery of the sites and one polling loop for all of them.
 */
export class SomfyAccount {

  private readonly logger: Logging;
  private readonly config: SomfyAccountConfig;
  private readonly somfyAPI: SomfyAPI;

  private sites: SomfySite[] = [];
  private readonly discoveryCallbacks: DiscoveryCallback[] = [];
  private timeout: Timeout | null = null;
  private initTimeout: Timeout | null = null;
  private polling = false;
  private stopped = false;
  private readonly warnedLevels = new Set<string>();
  private readonly warnedAlarmStatuses = new Set<string>();
  private pollingStopped = false;
  private commandsInFlight = 0;
  private failureCount = 0;
  private retryAfterMs = 0;
  private fetchDevices: boolean;
  private readonly deviceRefreshTimers = new Map<string, Timeout>();
  private eventSocket: SomfyEventSocket | null = null;

  constructor(logger: Logging, config: SomfyAccountConfig) {
    this.logger = logger;
    this.config = config;
    this.fetchDevices = config.fetchDevices === true;

    this.somfyAPI = new SomfyAPI(logger, {
      username: config.username,
      password: config.password,
      loggingAmount: config.loggingAmount,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tokenFile: config.tokenFile
    });
  }

  /**
   * Called once, when the sites of the account have been found.
   */
  onDiscovered(callback: DiscoveryCallback) {
    this.discoveryCallbacks.push(callback);
  }

  /**
   * Starts discovering the sites (retrying with backoff), then polling them.
   */
  start() {
    this.initializeWithRetry();
  }

  private async initializeWithRetry() {
    let success = false;
    let threw = false;
    try {
      success = await this.initialize();
    } catch (error: unknown) {
      if (this.stopped) {
        return;
      }
      threw = true;
      this.registerFailure(error);
      this.logger.error(`Could not initialize: ${errorMessage(error)}`);
    }
    if (this.stopped) {
      return;
    }
    if (success) {
      this.failureCount = 0;
      this.retryAfterMs = 0;
      for (const callback of this.discoveryCallbacks) {
        try {
          callback(this.sites);
        } catch (error: unknown) {
          this.logger.error(`Could not set up the discovered sites: ${errorMessage(error)}`);
        }
      }
      this.startPolling();
      this.startEvents();
    } else {
      if (!threw) {
        // no exception (e.g. unknown siteIds, no site on the account): still back off instead of retrying every poll interval
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
   * Returns true when at least one site could be found. Throws when the API call fails.
   */
  private async initialize(): Promise<boolean> {
    const result = await this.somfyAPI.getALLSites();
    const items: SomfySiteItem[] = result?.data?.items ?? [];
    if (!result?.data) {
      this.logger.error("Could not retrieve sites: an unknown error has occurred");
      return false;
    }
    if (items.length === 0) {
      this.logger.error("Could not retrieve sites: no sites are configured on your somfy account");
      return false;
    }

    const wanted = this.config.siteIds ?? [];
    const selected = wanted.length > 0 ? items.filter((item) => wanted.includes(item.site_id)) : items;
    const missing = wanted.filter((siteId) => !items.some((item) => item.site_id === siteId));
    if (missing.length > 0) {
      this.logger.error(`Could not find the configured siteIds on your somfy account: ${missing.join(", ")}`);
      this.logger.error("Possible sites detected on your somfy account:");
      items.forEach((item, index) => this.logger.error(`Site ${index + 1}: ${item.name}, site ID: ${item.site_id}`));
    }
    if (selected.length === 0) {
      return false;
    }

    const names = selected.map((item) => `${item.name} (${item.site_id})`).join(", ");
    this.logger.info(`Using ${selected.length} of ${items.length} site(s): ${names}`);
    this.sites = selected.map((item) => {
      const site = new SomfySite(
        item.site_id, item.name,
        (target, state) => this.sendTargetState(target, state),
        (target, deviceId, closed) => this.sendShutter(target, deviceId, closed)
      );
      if (item.security_level) {
        const state = this.mapSecurityLevel(item.security_level);
        if (state !== undefined) {
          site.initState(state);
        }
      }
      site.onCurrentStateChange(() => {
        if (this.config.loggingAmount > LoggingAmount.OFF) {
          this.logger.info(
            `Current state changed (${site.name}): currentState=${site.getCurrentState()}, targetState=${site.getTargetState()}`
          );
        }
      });
      return site;
    });
    if (this.fetchDevices) {
      for (const site of this.sites) {
        try {
          await this.refreshDevices(site);
        } catch (error: unknown) {
          this.logger.warn(
            `Could not read the devices of ${site.name}, sensors are skipped until Homebridge restarts: ${errorMessage(error)}`
          );
        }
      }
    }
    return true;
  }

  /**
   * Reads the devices of a site. A permanent client error (not 401 / 429) switches the device reads off for this run so
   * that the alarm itself keeps working; any other error is thrown (backoff, Retry-After).
   */
  private async refreshDevices(site: SomfySite) {
    try {
      const result = await this.somfyAPI.getDevices(site.siteId);
      if (this.stopped) {
        return;
      }
      const items: SomfyDevice[] = Array.isArray(result?.data?.items) ? result.data.items : [];
      site.updateDevices(items);
      site.lastDevicesAt = Date.now();
    } catch (error: unknown) {
      const status = error instanceof SomfyAPIError ? error.status : undefined;
      if (status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 429) {
        this.fetchDevices = false;
        this.logger.warn(`Somfy refused to list the devices (HTTP ${status}); sensors are switched off until Homebridge restarts`);
        return;
      }
      throw error;
    }
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
    if (this.sites.length === 0 || this.polling) {
      return;
    }
    this.polling = true;
    try {
      for (const site of this.sites) {
        const result = await this.somfyAPI.getSite(site.siteId);
        if (this.stopped) {
          return;
        }
        this.reportAlarmStatus(site, result?.data?.alarm?.status);
        const security_level = result?.data?.security_level;
        // a pending command has priority over what the poll has seen
        if (security_level && this.commandsInFlight === 0) {
          // logging
          if (this.config.loggingAmount === LoggingAmount.FULL) {
            this.logger.info(`Poll security level (${site.name}) with success, getting:`, security_level);
          }
          const state = this.mapSecurityLevel(security_level);
          if (state !== undefined) {
            site.updateState(state);
          }
        }
        if (this.fetchDevices && !this.stopped && Date.now() - site.lastDevicesAt >= DEVICE_POLL_INTERVAL) {
          await this.refreshDevices(site);
        }
      }
      if (this.failureCount > 0) {
        this.logger.info("Connection to somfy restored");
      }
      this.failureCount = 0;
      this.retryAfterMs = 0;
    } catch (error: unknown) {
      if (this.stopped) {
        return;
      }
      this.registerFailure(error);
      const delay = Math.round(this.nextDelay() / 1000);
      this.logger.error(`Poll failed (attempt ${this.failureCount}), retrying in ${delay} s: ${errorMessage(error)}`);
    } finally {
      this.polling = false;
      this.scheduleNextPoll();
    }
  }

  private scheduleNextPoll(delay?: number) {
    if (this.stopped || this.pollingStopped || this.commandsInFlight > 0) {
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
    if (!this.stopped && this.sites.length > 0) {
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

  /**
   * Stops all timers; in-flight results and rescheduling become no-ops. Call on Homebridge shutdown.
   */
  stop() {
    this.stopped = true;
    this.eventSocket?.stop();
    this.eventSocket = null;
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.initTimeout !== null) {
      clearTimeout(this.initTimeout);
      this.initTimeout = null;
    }
    this.deviceRefreshTimers.forEach((timer) => clearTimeout(timer));
    this.deviceRefreshTimers.clear();
  }

  /**
   * Maps a Somfy security level; for an unknown value warns once per distinct value and returns undefined
   * so that the caller keeps the previous state.
   */
  private mapSecurityLevel(securityLevel: string): State | undefined {
    const state = somfySecurityLevelToHomekitState(securityLevel);
    if (state === undefined && !this.warnedLevels.has(securityLevel)) {
      this.warnedLevels.add(securityLevel);
      this.logger.warn(`Unknown security level "${securityLevel}" received from somfy, keeping the previous state`);
    }
    return state;
  }

  /**
   * `alarm.status` is "none" while idle. Its values during a trigger are not known yet (see issue #6), so they are not
   * mapped to HomeKit: warn once per distinct value so that it can be reported.
   */
  private reportAlarmStatus(site: SomfySite, status: unknown) {
    if (typeof status === "string" && status !== "none" && !this.warnedAlarmStatuses.has(status)) {
      this.warnedAlarmStatuses.add(status);
      this.logger.warn(
        `Somfy reports alarm status "${status}" for ${site.name}. It is not shown in HomeKit yet; please report this value in ` +
        "https://github.com/timothe-ignace/homebridge-somfy-protect-v2/issues/6"
      );
    }
  }

  /**
   * Moves a camera privacy shutter (POST .../action). On success the new position is shown at once and the devices are read
   * again shortly after; on failure the real position is shown again.
   */
  private sendShutter(site: SomfySite, deviceId: string, closed: boolean) {
    // logging
    if (this.config.loggingAmount === LoggingAmount.FULL) {
      this.logger.info(`Camera shutter (${site.name}): ${closed ? "closing" : "opening"}`);
    }
    this.somfyAPI.sendDeviceAction(site.siteId, deviceId, closed ? "shutter_close" : "shutter_open")
      .then(() => {
        site.applyShutter(deviceId, closed);
        this.refreshDevicesSoon(site);
      })
      .catch((error: unknown) => {
        if (error instanceof SomfyAPIError && error.status === 429) {
          this.registerFailure(error);
        }
        this.logger.error(`Could not move the camera shutter: ${errorMessage(error)}`);
        site.notifyDevicesChanged();
      })
      .catch(error => this.logger.error(`Unexpected error: ${errorMessage(error)}`));
  }

  /**
   * Reads the devices of a site again in a few seconds (after a command, or when told that something changed).
   */
  refreshDevicesSoon(site: SomfySite) {
    if (!this.fetchDevices || this.stopped || this.deviceRefreshTimers.has(site.siteId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.deviceRefreshTimers.delete(site.siteId);
      if (this.stopped || !this.fetchDevices) {
        return;
      }
      this.refreshDevices(site).catch(error => this.logger.warn(`Could not read the devices of ${site.name}: ${errorMessage(error)}`));
    }, DEVICE_REFRESH_DELAY);
    this.deviceRefreshTimers.set(site.siteId, timer);
  }

  private startEvents() {
    if (this.config.realtimeEvents !== true || this.eventSocket || this.stopped) {
      return;
    }
    // a failure of the channel is only logged; the polling goes on
    this.eventSocket = new SomfyEventSocket(this.logger, {
      getToken: (forceRefresh) => this.somfyAPI.getAccessToken(forceRefresh),
      loggingAmount: this.config.loggingAmount,
      webSocketFactory: this.config.webSocketFactory,
      onEvent: (event) => handleSiteEvent({
        logger: this.logger,
        loggingAmount: this.config.loggingAmount,
        sites: () => this.sites,
        mapSecurityLevel: (level) => this.mapSecurityLevel(level),
        commandInFlight: () => this.commandsInFlight > 0,
        requestRefresh: () => this.refreshNow(),
        requestDeviceRefresh: (siteId) => this.requestDeviceRefresh(siteId)
      }, event)
    });
    this.eventSocket.start();
  }

  /** Polls now instead of at the next interval (no-op while a poll is under way or polling is paused by a command). */
  private refreshNow() {
    if (!this.polling && !this.pollingStopped) {
      this.scheduleNextPoll(0);
    }
  }

  /** A device or privacy event arrived for this site: read its devices again shortly (shutter moved, battery, tamper...). */
  private requestDeviceRefresh(siteId: string) {
    const site = this.sites.find((candidate) => candidate.siteId === siteId);
    if (site) {
      this.refreshDevicesSoon(site);
    }
  }

  private sendTargetState(site: SomfySite, state: State) {
    site.requestTargetState(state);
    let securityLevel: "disarmed" | "armed" | "partial";
    try {
      securityLevel = homekitStateToSomfySecurityLevel(state);
    } catch (error: unknown) {
      this.logger.error(errorMessage(error));
      return;
    }
    // logging
    if (this.config.loggingAmount === LoggingAmount.FULL) {
      this.logger.info(`setTargetState (${site.name})`, state);
    }
    // no polling while the command is in flight
    this.stopPolling();
    this.commandsInFlight++;
    this.somfyAPI.setSecurityLevel(site.siteId, securityLevel)
      .then(() => {
        this.failureCount = 0;
        this.retryAfterMs = 0;
      })
      .catch((error: unknown) => {
        this.registerFailure(error);
        this.logger.error(`Could not set the security level: ${errorMessage(error)}`);
        site.revertTargetState(state);
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

}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
