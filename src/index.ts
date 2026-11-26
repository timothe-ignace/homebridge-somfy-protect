import {readFileSync} from "fs";
import {join} from "path";
import {
  AccessoryConfig,
  AccessoryPlugin,
  API,
  CharacteristicValue,
  HAP,
  Logging,
  Service
} from "homebridge";
import {HomekitSomfySite, State} from "./lib/homekit_somfy_site";
import {LoggingAmount} from "./lib/logging_amout";

const PLUGIN_VERSION: string = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version;

const MODEL = "Somfy Protect";
const DEFAULT_SERIAL_NUMBER = "Default-SerialNumber";

let hap: HAP;

/*
 * Initializer function called when the plugin is loaded.
 */
export = (api: API) => {
  hap = api.hap;
  api.registerAccessory("SomfyProtect", SomfyProtect);
};

interface ValidatedConfig {
  username: string;
  password: string;
  loggingAmount: LoggingAmount;
  siteId?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/*
 * Validates the raw accessory config. Returns the cleaned config, or a list of errors.
 * Never logs or returns the password.
 */
function validateConfig(config: AccessoryConfig): { config?: ValidatedConfig; errors: string[] } {
  const errors: string[] = [];

  if (!isNonEmptyString(config.username)) {
    errors.push("\"username\" is required and must be a non-empty string");
  }
  if (!isNonEmptyString(config.password)) {
    errors.push("\"password\" is required and must be a non-empty string");
  }

  let siteId: string | undefined;
  if (config.siteId !== undefined && config.siteId !== null && config.siteId !== "") {
    if (isNonEmptyString(config.siteId)) {
      siteId = config.siteId.trim();
    } else {
      errors.push("\"siteId\" must be a string when specified");
    }
  }

  // loggingAmount: coerced to 0 / 1 / 2, default 0
  let loggingAmount = LoggingAmount.OFF;
  if (config.loggingAmount !== undefined && config.loggingAmount !== null && config.loggingAmount !== "") {
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
      siteId
    }
  };
}

class SomfyProtect implements AccessoryPlugin {

  private readonly VALID_CURRENT_STATE_VALUES = [
    hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM,
    hap.Characteristic.SecuritySystemCurrentState.AWAY_ARM,
    hap.Characteristic.SecuritySystemCurrentState.DISARMED,
    hap.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED
  ];

  private readonly VALID_TARGET_STATE_VALUES = [
    hap.Characteristic.SecuritySystemTargetState.NIGHT_ARM,
    hap.Characteristic.SecuritySystemTargetState.AWAY_ARM,
    hap.Characteristic.SecuritySystemTargetState.DISARM
  ];

  private readonly logger: Logging;
  private readonly name: string;
  private readonly loggingAmount: LoggingAmount;

  // undefined when the configuration is invalid
  private readonly somfySite?: HomekitSomfySite;

  private readonly informationService: Service;
  private readonly securitySystemService: Service;

  constructor(logger: Logging, config: AccessoryConfig, api: API) {
    this.logger = logger;

    const validation = validateConfig(config);
    this.name = isNonEmptyString(config.name) ? config.name : "Somfy Protect";
    this.loggingAmount = validation.config?.loggingAmount ?? LoggingAmount.OFF;

    this.informationService = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, "Somfy")
      .setCharacteristic(hap.Characteristic.Model, MODEL)
      .setCharacteristic(hap.Characteristic.SerialNumber, validation.config?.siteId ?? DEFAULT_SERIAL_NUMBER)
      .setCharacteristic(hap.Characteristic.FirmwareRevision, PLUGIN_VERSION);

    this.securitySystemService = new hap.Service.SecuritySystem(this.name);

    if (validation.config) {
      const siteConfig = validation.config;
      const site = new HomekitSomfySite(logger, {
        username: siteConfig.username,
        password: siteConfig.password,
        loggingAmount: siteConfig.loggingAmount,
        siteId: siteConfig.siteId as string
      });
      this.somfySite = site;
      api.on("shutdown", () => site.stop());
    } else {
      validation.errors.forEach((error) => logger.error(`Invalid configuration: ${error}`));
      logger.error("The plugin will not connect to Somfy until the configuration is fixed and Homebridge is restarted.");
    }

    this.securitySystemService.getCharacteristic(hap.Characteristic.SecuritySystemCurrentState)
      .setProps({validValues: this.VALID_CURRENT_STATE_VALUES})
      .onGet(() => {
        const currentState = this.getInitializedSite().getCurrentState();
        if (this.loggingAmount > LoggingAmount.OFF) {
          this.logger.info("Current state of security system was requested, returning:", currentState);
        }
        return currentState;
      });

    this.securitySystemService.getCharacteristic(hap.Characteristic.SecuritySystemTargetState)
      .setProps({validValues: this.VALID_TARGET_STATE_VALUES})
      .onGet(() => {
        const targetState = this.getInitializedSite().getTargetState();
        if (this.loggingAmount > LoggingAmount.OFF) {
          this.logger.info("Target state of security system was requested, returning:", targetState);
        }
        return targetState;
      })
      .onSet((value: CharacteristicValue) => {
        if (typeof value !== "number" || !this.VALID_TARGET_STATE_VALUES.includes(value)) {
          this.logger.error("Refusing to set invalid target state:", value);
          throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
        const site = this.getInitializedSite();
        if (this.loggingAmount > LoggingAmount.OFF) {
          this.logger.info("Target state was set to:", value);
        }
        try {
          site.setTargetState(value as State);
        } catch (error) {
          this.logger.error("Failed to set target state:", error instanceof Error ? error.message : error);
          throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });

    this.somfySite?.onCurrentStateChange(() => {
      if (this.somfySite && this.somfySite.isInitialized()) {
        this.securitySystemService.updateCharacteristic(hap.Characteristic.SecuritySystemCurrentState, this.somfySite.getCurrentState());
        this.securitySystemService.updateCharacteristic(hap.Characteristic.SecuritySystemTargetState, this.somfySite.getTargetState());
      }
    });

    if (this.somfySite && this.loggingAmount > LoggingAmount.OFF) {
      this.logger.info("Security system finished initializing!");
    }
  }

  /*
   * Returns the site when it is usable. Otherwise reports "communication failure" to HomeKit
   * (shows "No Response") rather than faking a state such as DISARMED.
   */
  private getInitializedSite(): HomekitSomfySite {
    if (!this.somfySite || !this.somfySite.isInitialized()) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.somfySite;
  }

  /*
   * This method is called directly after creation of this instance.
   * It should return all services which should be added to the accessory.
   */
  getServices(): Service[] {
    return [
      this.informationService,
      this.securitySystemService
    ];
  }

}
