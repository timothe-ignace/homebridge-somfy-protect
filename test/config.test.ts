import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {validateConfig} from "../src/lib/config";
import {LoggingAmount} from "../src/lib/logging_amount";

const valid = {platform: "SomfyProtect", name: "Somfy Protect", username: " user@example.com ", password: "s3cr3t"};

describe("validateConfig", () => {
  it("accepts a minimal config and applies the defaults", () => {
    const {config, errors} = validateConfig(valid);
    assert.deepEqual(errors, []);
    assert.equal(config?.username, "user@example.com");
    assert.equal(config?.password, "s3cr3t");
    assert.equal(config?.loggingAmount, LoggingAmount.OFF);
    assert.deepEqual(config?.siteIds, []);
  });

  it("requires username and password and never echoes the password", () => {
    const {config, errors} = validateConfig({username: "", password: "  "});
    assert.equal(config, undefined);
    assert.equal(errors.length, 2);
    assert.ok(errors.every(error => !error.includes("  ")));
  });

  it("accepts a siteIds list and the legacy 2.x siteId, without duplicates", () => {
    assert.deepEqual(validateConfig({...valid, siteIds: ["a", " b "]}).config?.siteIds, ["a", "b"]);
    assert.deepEqual(validateConfig({...valid, siteId: "a"}).config?.siteIds, ["a"]);
    assert.deepEqual(validateConfig({...valid, siteIds: ["a"], siteId: "a"}).config?.siteIds, ["a"]);
  });

  it("rejects malformed site settings", () => {
    assert.equal(validateConfig({...valid, siteIds: "a"}).errors.length, 1);
    assert.equal(validateConfig({...valid, siteIds: ["a", 3]}).errors.length, 1);
    assert.equal(validateConfig({...valid, siteId: 12}).errors.length, 1);
  });

  it("reads exposeSensors, on by default", () => {
    assert.equal(validateConfig(valid).config?.exposeSensors, true);
    assert.equal(validateConfig({...valid, exposeSensors: false}).config?.exposeSensors, false);
    assert.equal(validateConfig({...valid, exposeSensors: "no"}).errors.length, 1);
  });

  it("reads exposeCameraPrivacy, on by default", () => {
    assert.equal(validateConfig(valid).config?.exposeCameraPrivacy, true);
    assert.equal(validateConfig({...valid, exposeCameraPrivacy: false}).config?.exposeCameraPrivacy, false);
    assert.equal(validateConfig({...valid, exposeCameraPrivacy: 1}).errors.length, 1);
  });

  it("needs clientId and clientSecret together", () => {
    assert.equal(validateConfig({...valid, clientId: "id"}).errors.length, 1);
    const both = validateConfig({...valid, clientId: "id", clientSecret: "secret"});
    assert.deepEqual(both.errors, []);
    assert.equal(both.config?.clientId, "id");
  });

  it("coerces loggingAmount to 0, 1 or 2", () => {
    assert.equal(validateConfig({...valid, loggingAmount: "2"}).config?.loggingAmount, LoggingAmount.FULL);
    assert.equal(validateConfig({...valid, loggingAmount: 1}).config?.loggingAmount, LoggingAmount.PARTIAL);
    assert.equal(validateConfig({...valid, loggingAmount: 7}).config?.loggingAmount, LoggingAmount.OFF);
  });
});
