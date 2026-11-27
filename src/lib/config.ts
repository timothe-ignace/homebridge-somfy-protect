import {LoggingAmount} from "./logging_amount";

export interface ValidatedConfig {
  username: string;
  password: string;
  loggingAmount: LoggingAmount;
  /** empty means every site of the account */
  siteIds: string[];
  /** read the devices: smoke detectors become HomeKit sensors, tamper and fault show on the alarm */
  exposeSensors: boolean;
  /** a HomeKit switch for the privacy shutter of each indoor camera */
  exposeCameraPrivacy: boolean;
  clientId?: string;
  clientSecret?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/*
 * Validates the raw platform config. Returns the cleaned config, or a list of errors.
 * Never logs or returns the password.
 */
export function validateConfig(config: Record<string, unknown>): { config?: ValidatedConfig; errors: string[] } {
  const errors: string[] = [];

  if (!isNonEmptyString(config.username)) {
    errors.push("\"username\" is required and must be a non-empty string");
  }
  if (!isNonEmptyString(config.password)) {
    errors.push("\"password\" is required and must be a non-empty string");
  }

  // sites: "siteIds" (list), or the single "siteId" of the 2.x accessory config
  const siteIds: string[] = [];
  if (!isUnset(config.siteIds)) {
    if (Array.isArray(config.siteIds) && config.siteIds.every(isNonEmptyString)) {
      siteIds.push(...config.siteIds.map((siteId: string) => siteId.trim()));
    } else {
      errors.push("\"siteIds\" must be a list of strings when specified");
    }
  }
  if (!isUnset(config.siteId)) {
    if (isNonEmptyString(config.siteId)) {
      siteIds.push(config.siteId.trim());
    } else {
      errors.push("\"siteId\" must be a string when specified");
    }
  }

  // optional OAuth client override: both or none
  const clientId = isNonEmptyString(config.clientId) ? config.clientId.trim() : undefined;
  const clientSecret = isNonEmptyString(config.clientSecret) ? config.clientSecret.trim() : undefined;
  for (const [key, value] of [["clientId", config.clientId], ["clientSecret", config.clientSecret]]) {
    if (!isUnset(value) && !isNonEmptyString(value)) {
      errors.push(`"${key}" must be a string when specified`);
    }
  }
  if ((clientId === undefined) !== (clientSecret === undefined) && errors.length === 0) {
    errors.push("\"clientId\" and \"clientSecret\" must be set together (or both left empty to use the built-in client)");
  }

  // exposeSensors: default true
  let exposeSensors = true;
  if (!isUnset(config.exposeSensors)) {
    if (typeof config.exposeSensors === "boolean") {
      exposeSensors = config.exposeSensors;
    } else {
      errors.push("\"exposeSensors\" must be true or false when specified");
    }
  }

  // exposeCameraPrivacy: default true
  let exposeCameraPrivacy = true;
  if (!isUnset(config.exposeCameraPrivacy)) {
    if (typeof config.exposeCameraPrivacy === "boolean") {
      exposeCameraPrivacy = config.exposeCameraPrivacy;
    } else {
      errors.push("\"exposeCameraPrivacy\" must be true or false when specified");
    }
  }

  // loggingAmount: coerced to 0 / 1 / 2, default 0
  let loggingAmount = LoggingAmount.OFF;
  if (!isUnset(config.loggingAmount)) {
    const parsed = Number(config.loggingAmount);
    if (Number.isInteger(parsed) && parsed >= LoggingAmount.OFF && parsed <= LoggingAmount.FULL) {
      loggingAmount = parsed;
    }
  }

  if (errors.length > 0) {
    return {errors};
  }
  return {
    errors,
    config: {
      username: (config.username as string).trim(),
      password: config.password as string,
      loggingAmount,
      siteIds: [...new Set(siteIds)],
      exposeSensors,
      exposeCameraPrivacy,
      clientId,
      clientSecret
    }
  };
}
