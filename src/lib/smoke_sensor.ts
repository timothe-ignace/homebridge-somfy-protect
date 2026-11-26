import {API, Logging, PlatformAccessory} from "homebridge";
import {SomfySite} from "./homekit_somfy_site";

const MANUFACTURER = "Somfy";
const MODEL = "Somfy Protect smoke detector";

/**
 * Wires the HomeKit smoke sensor service of a (new or restored) accessory to one Somfy smoke detector.
 */
export function attachSmokeSensor(
  api: API, logger: Logging, accessory: PlatformAccessory, site: SomfySite, deviceId: string, firmwareRevision: string
) {
  const {Characteristic, Service, HAPStatus, HapStatusError} = api.hap;

  const information = accessory.getService(Service.AccessoryInformation) ?? accessory.addService(Service.AccessoryInformation);
  information
    .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
    .setCharacteristic(Characteristic.Model, MODEL)
    .setCharacteristic(Characteristic.SerialNumber, deviceId)
    .setCharacteristic(Characteristic.FirmwareRevision, firmwareRevision);

  const service = accessory.getService(Service.SmokeSensor) ?? accessory.addService(Service.SmokeSensor, accessory.displayName);

  // "No Response" in HomeKit while Somfy does not report this detector (e.g. it was removed from the site)
  const detector = () => {
    const view = site.getDevicesView().smokeDetectors.find((candidate) => candidate.deviceId === deviceId);
    if (!view) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return view;
  };

  const {SMOKE_DETECTED, SMOKE_NOT_DETECTED} = Characteristic.SmokeDetected;
  const {BATTERY_LEVEL_LOW, BATTERY_LEVEL_NORMAL} = Characteristic.StatusLowBattery;
  const smokeValue = (smoke: boolean) => smoke ? SMOKE_DETECTED : SMOKE_NOT_DETECTED;
  const batteryValue = (low: boolean) => low ? BATTERY_LEVEL_LOW : BATTERY_LEVEL_NORMAL;
  const faultValue = (fault: boolean) => fault ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT;

  service.getCharacteristic(Characteristic.SmokeDetected).onGet(() => smokeValue(detector().smoke));
  service.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => batteryValue(detector().lowBattery));
  service.getCharacteristic(Characteristic.StatusFault).onGet(() => faultValue(detector().fault));

  site.onDevicesChange(() => {
    try {
      const view = detector();
      service.updateCharacteristic(Characteristic.SmokeDetected, smokeValue(view.smoke));
      service.updateCharacteristic(Characteristic.StatusLowBattery, batteryValue(view.lowBattery));
      service.updateCharacteristic(Characteristic.StatusFault, faultValue(view.fault));
      if (view.smoke) {
        logger.warn(`Smoke detected by "${accessory.displayName}" (reported by Somfy)`);
      }
    } catch {
      // detector gone from the report: reads answer "No Response" until it is back
    }
  });
}
