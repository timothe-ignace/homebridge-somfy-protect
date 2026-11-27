import {readFileSync} from "fs";
import {join} from "path";
import {API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig} from "homebridge";
import {SomfySite} from "./lib/homekit_somfy_site";
import {SomfyAccount} from "./lib/somfy_account";
import {validateConfig} from "./lib/config";
import {attachSecuritySystem} from "./lib/security_system";
import {attachSmokeSensor} from "./lib/smoke_sensor";
import {attachCameraShutter} from "./lib/camera_shutter";

const PLUGIN_VERSION: string = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version;

const PLUGIN_NAME = "homebridge-somfy-protect-v2";
const PLATFORM_NAME = "SomfyProtect";
const TOKEN_FILE_NAME = "somfy-protect-token.json";

/*
 * Initializer function called when the plugin is loaded.
 */
export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, SomfyProtectPlatform);
};

class SomfyProtectPlatform implements DynamicPlatformPlugin {

  // accessories restored from the Homebridge cache, by UUID
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private account?: SomfyAccount;

  constructor(private readonly logger: Logging, private readonly config: PlatformConfig, private readonly api: API) {
    this.api.on("didFinishLaunching", () => this.start());
    this.api.on("shutdown", () => this.account?.stop());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private start() {
    this.warnAboutLegacyConfig();

    const validation = validateConfig(this.config);
    if (!validation.config) {
      validation.errors.forEach((error) => this.logger.error(`Invalid configuration: ${error}`));
      this.logger.error("The plugin will not connect to Somfy until the configuration is fixed and Homebridge is restarted.");
      return;
    }
    const config = validation.config;

    const account = new SomfyAccount(this.logger, {
      username: config.username,
      password: config.password,
      loggingAmount: config.loggingAmount,
      siteIds: config.siteIds,
      fetchDevices: config.exposeSensors || config.exposeCameraPrivacy,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tokenFile: join(this.api.user.storagePath(), TOKEN_FILE_NAME)
    });
    this.account = account;
    account.onDiscovered((sites) => {
      this.syncAccessories(sites, config.loggingAmount, config.exposeSensors, config.exposeCameraPrivacy);
    });
    account.start();
  }

  /*
   * One security system per site, one smoke sensor per smoke detector and one privacy switch per indoor camera:
   * restore the cached accessory or create it, and remove the ones whose site or device is gone.
   */
  private syncAccessories(
    sites: SomfySite[], loggingAmount: number, exposeSensors: boolean, exposeCameraPrivacy: boolean
  ) {
    const used = new Set<string>();
    for (const site of sites) {
      const accessory = this.accessoryFor(`somfy-protect:${site.siteId}`, site.name, used);
      attachSecuritySystem(this.api, this.logger, accessory, site, loggingAmount, PLUGIN_VERSION);
      if (exposeSensors) {
        for (const detector of site.getDevicesView().smokeDetectors) {
          const sensor = this.accessoryFor(`somfy-protect:${site.siteId}:${detector.deviceId}`, detector.name, used);
          attachSmokeSensor(this.api, this.logger, sensor, site, detector.deviceId, PLUGIN_VERSION);
        }
      }
      if (exposeCameraPrivacy) {
        for (const camera of site.getDevicesView().cameras) {
          const shutter = this.accessoryFor(`somfy-protect:${site.siteId}:${camera.deviceId}`, `${camera.name} privacy`, used);
          attachCameraShutter(this.api, this.logger, shutter, site, camera.deviceId, PLUGIN_VERSION);
        }
      }
    }

    const stale = [...this.cachedAccessories.entries()].filter(([uuid]) => !used.has(uuid));
    if (stale.length > 0) {
      stale.forEach(([, accessory]) => this.logger.info(`Removing accessory: ${accessory.displayName}`));
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale.map(([, accessory]) => accessory));
      stale.forEach(([uuid]) => this.cachedAccessories.delete(uuid));
    }
  }

  private accessoryFor(seed: string, name: string, used: Set<string>): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(seed);
    used.add(uuid);
    let accessory = this.cachedAccessories.get(uuid);
    if (accessory) {
      this.logger.info(`Restoring accessory from cache: ${name}`);
    } else {
      this.logger.info(`Adding accessory: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.set(uuid, accessory);
    }
    return accessory;
  }

  /*
   * 2.x was an accessory plugin. If its config entry is still there, Homebridge would load a second, broken plugin instance.
   */
  private warnAboutLegacyConfig() {
    try {
      const homebridgeConfig = JSON.parse(readFileSync(this.api.user.configPath(), "utf8"));
      const legacy = Array.isArray(homebridgeConfig.accessories) && homebridgeConfig.accessories.some(
        (accessory: { accessory?: unknown }) => typeof accessory?.accessory === "string" && accessory.accessory.endsWith("SomfyProtect")
      );
      if (legacy) {
        this.logger.warn(
          "Your config.json still has a \"SomfyProtect\" entry under \"accessories\" (version 2.x). Remove it: this plugin is now a " +
          "platform, configured under \"platforms\". See the migration notes in the README."
        );
      }
    } catch {
      // config unreadable: nothing to warn about
    }
  }

}
