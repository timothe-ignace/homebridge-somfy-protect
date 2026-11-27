import {Logging} from "homebridge";
import {LoggingAmount} from "./logging_amount";
import {SomfySite, State} from "./homekit_somfy_site";
import {SomfyEvent} from "./somfy_events";

/** Event keys that start an alarm. Names come from a third-party client and are not verified on a real alarm. */
const ALARM_START_KEYS = ["alarm.trespass", "alarm.panic", "alarm.domestic.fire"];
const ALARM_END_KEY = "alarm.end";
const SECURITY_LEVEL_KEY = "security.level.change";

export interface EventContext {
  logger: Logging;
  loggingAmount: LoggingAmount;
  sites: () => SomfySite[];
  mapSecurityLevel: (securityLevel: string) => State | undefined;
  /** a command of HomeKit is in flight: its result has priority over what an event says */
  commandInFlight: () => boolean;
  /** asks for an immediate REST refresh */
  requestRefresh: (site: SomfySite) => void;
  requestDeviceRefresh: (siteId: string) => void;
}

/**
 * Applies one event of the real-time channel to the known sites. Events of unknown sites are ignored.
 */
export function handleSiteEvent(context: EventContext, event: SomfyEvent) {
  const site = context.sites().find(candidate => candidate.siteId === event.siteId);
  if (!site) {
    return;
  }
  const {logger} = context;
  if (event.key === SECURITY_LEVEL_KEY) {
    const state = event.securityLevel === undefined ? undefined : context.mapSecurityLevel(event.securityLevel);
    if (state !== undefined && !context.commandInFlight()) {
      site.updateState(state);
    }
  } else if (ALARM_START_KEYS.includes(event.key)) {
    if (!site.isTriggered()) {
      logger.warn(`Alarm triggered (${site.name}): ${event.key}`);
    }
    site.setTriggered(true);
  } else if (event.key === ALARM_END_KEY) {
    if (site.isTriggered()) {
      logger.info(`Alarm ended (${site.name})`);
    }
    site.setTriggered(false);
    context.requestRefresh(site);
  } else {
    if (context.loggingAmount === LoggingAmount.FULL) {
      logger.info(`Real-time event: ${event.key}`);
    }
    context.requestDeviceRefresh(site.siteId);
  }
}
