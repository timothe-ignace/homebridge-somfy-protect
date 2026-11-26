import {API, CharacteristicValue, Logging, PlatformAccessory, Service} from "homebridge";
import {SomfySite, State} from "./homekit_somfy_site";
import {LoggingAmount} from "./logging_amount";

const MANUFACTURER = "Somfy";
const MODEL = "Somfy Protect";

/**
 * Wires the HomeKit security system service of a (new or restored) accessory to one Somfy site.
 */
export function attachSecuritySystem(
  api: API, logger: Logging, accessory: PlatformAccessory, site: SomfySite, loggingAmount: LoggingAmount, firmwareRevision: string
) {
  const {Characteristic, Service: HapService, HAPStatus, HapStatusError} = api.hap;

  const validCurrentStates = [
    Characteristic.SecuritySystemCurrentState.NIGHT_ARM,
    Characteristic.SecuritySystemCurrentState.AWAY_ARM,
    Characteristic.SecuritySystemCurrentState.DISARMED,
    Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED
  ];
  const validTargetStates = [
    Characteristic.SecuritySystemTargetState.NIGHT_ARM,
    Characteristic.SecuritySystemTargetState.AWAY_ARM,
    Characteristic.SecuritySystemTargetState.DISARM
  ];

  const information = accessory.getService(HapService.AccessoryInformation) ?? accessory.addService(HapService.AccessoryInformation);
  information
    .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
    .setCharacteristic(Characteristic.Model, MODEL)
    .setCharacteristic(Characteristic.SerialNumber, site.siteId)
    .setCharacteristic(Characteristic.FirmwareRevision, firmwareRevision);

  const service: Service = accessory.getService(HapService.SecuritySystem) ?? accessory.addService(HapService.SecuritySystem, site.name);

  // HomeKit shows "No Response" instead of a made-up state while the site is not usable
  const initializedSite = (): SomfySite => {
    if (!site.isInitialized()) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return site;
  };

  service.getCharacteristic(Characteristic.SecuritySystemCurrentState)
    .setProps({validValues: validCurrentStates})
    .onGet(() => {
      const currentState = initializedSite().getCurrentState();
      if (loggingAmount > LoggingAmount.OFF) {
        logger.info(`Current state of ${site.name} was requested, returning:`, currentState);
      }
      return currentState;
    });

  service.getCharacteristic(Characteristic.SecuritySystemTargetState)
    .setProps({validValues: validTargetStates})
    .onGet(() => {
      const targetState = initializedSite().getTargetState();
      if (loggingAmount > LoggingAmount.OFF) {
        logger.info(`Target state of ${site.name} was requested, returning:`, targetState);
      }
      return targetState;
    })
    .onSet((value: CharacteristicValue) => {
      if (typeof value !== "number" || !validTargetStates.includes(value)) {
        logger.error("Refusing to set invalid target state:", value);
        throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
      }
      const target = initializedSite();
      if (loggingAmount > LoggingAmount.OFF) {
        logger.info(`Target state of ${site.name} was set to:`, value);
      }
      try {
        target.setTargetState(value as State);
      } catch (error) {
        logger.error("Failed to set target state:", error instanceof Error ? error.message : error);
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });

  // the devices of the site: a device cover opened is a tamper, a lost device or a detector error is a fault
  const {TAMPERED, NOT_TAMPERED} = Characteristic.StatusTampered;
  const tamperedValue = (tampered: boolean) => tampered ? TAMPERED : NOT_TAMPERED;
  const faultValue = (fault: boolean) => fault ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT;
  service.getCharacteristic(Characteristic.StatusTampered).onGet(() => tamperedValue(site.getDevicesView().tampered));
  service.getCharacteristic(Characteristic.StatusFault).onGet(() => faultValue(site.getDevicesView().fault));
  site.onDevicesChange(() => {
    const view = site.getDevicesView();
    service.updateCharacteristic(Characteristic.StatusTampered, tamperedValue(view.tampered));
    service.updateCharacteristic(Characteristic.StatusFault, faultValue(view.fault));
  });

  site.onCurrentStateChange(() => {
    if (site.isInitialized()) {
      service.updateCharacteristic(Characteristic.SecuritySystemCurrentState, site.getCurrentState());
      service.updateCharacteristic(Characteristic.SecuritySystemTargetState, site.getTargetState());
    }
  });
}
