import {API, CharacteristicValue, Logging, PlatformAccessory} from "homebridge";
import {SomfySite} from "./homekit_somfy_site";

const MANUFACTURER = "Somfy";
const MODEL = "Somfy Protect indoor camera";

/**
 * Wires a HomeKit switch to the privacy shutter of one Somfy indoor camera: on = shutter closed (privacy).
 */
export function attachCameraShutter(
  api: API, logger: Logging, accessory: PlatformAccessory, site: SomfySite, deviceId: string, firmwareRevision: string
) {
  const {Characteristic, Service, HAPStatus, HapStatusError} = api.hap;

  const information = accessory.getService(Service.AccessoryInformation) ?? accessory.addService(Service.AccessoryInformation);
  information
    .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
    .setCharacteristic(Characteristic.Model, MODEL)
    .setCharacteristic(Characteristic.SerialNumber, deviceId)
    .setCharacteristic(Characteristic.FirmwareRevision, firmwareRevision);

  const service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, accessory.displayName);

  // "No Response" in HomeKit while Somfy does not report this camera's shutter
  const camera = () => {
    const view = site.getDevicesView().cameras.find((candidate) => candidate.deviceId === deviceId);
    if (!view) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return view;
  };

  service.getCharacteristic(Characteristic.On)
    .onGet(() => camera().shutterClosed)
    .onSet((value: CharacteristicValue) => {
      if (typeof value !== "boolean") {
        logger.error("Refusing to set an invalid camera shutter value:", value);
        throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
      }
      camera();
      site.setShutter(deviceId, value);
    });

  site.onDevicesChange(() => {
    try {
      service.updateCharacteristic(Characteristic.On, camera().shutterClosed);
    } catch {
      // camera gone from the report: reads answer "No Response" until it is back
    }
  });
}
