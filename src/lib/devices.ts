/**
 * The parts of a Somfy device (GET /site/{id}/device) that the plugin uses. Everything is optional: the structure
 * differs per device type and was only observed, never documented.
 */
export interface SomfyDevice {
  device_id: string;
  label?: string;
  device_definition?: { type?: string; label?: string };
  status?: Record<string, unknown>;
}

export interface SmokeDetectorView {
  deviceId: string;
  name: string;
  smoke: boolean;
  lowBattery: boolean;
  fault: boolean;
}

export interface DevicesView {
  smokeDetectors: SmokeDetectorView[];
  /** a device cover is open (cover_present is false) */
  tampered: boolean;
  /** a device lost its radio link, or a smoke detector reports an internal error */
  fault: boolean;
}

export const SMOKE_DETECTOR_TYPE = "sp_risk_detector";
const DEFAULT_SMOKE_DETECTOR_NAME = "Smoke detector";

export function isSmokeDetector(device: SomfyDevice): boolean {
  return device.device_definition?.type === SMOKE_DETECTOR_TYPE;
}

/**
 * Reduces the raw devices to what HomeKit shows. Only a strict `true` / `false` counts: a missing field is no information.
 */
export function viewDevices(devices: SomfyDevice[]): DevicesView {
  const smokeDetectors = devices.filter(isSmokeDetector).map((device): SmokeDetectorView => {
    const status = device.status ?? {};
    return {
      deviceId: device.device_id,
      name: typeof device.label === "string" && device.label.trim() ? device.label.trim() : DEFAULT_SMOKE_DETECTOR_NAME,
      smoke: status.sp_smoke_detector_smoke_detection === true,
      lowBattery: status.battery_low === true,
      fault: status.device_lost === true || status.sp_smoke_detector_error_chamber === true
    };
  });
  return {
    smokeDetectors,
    tampered: devices.some((device) => device.status?.cover_present === false),
    fault: devices.some((device) => device.status?.device_lost === true || device.status?.sp_smoke_detector_error_chamber === true)
  };
}
