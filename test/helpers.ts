import axios, {AxiosError, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig} from "axios";
import {Logging} from "homebridge";
import {mock} from "node:test";

export const PASSWORD = "s3cr3t-p@ss&word";
export const USERNAME = "user@example.com";

export interface FakeResponse {
  status?: number;
  data?: unknown;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  method: string;
  url: string;
  body: Record<string, string> | undefined;
}

export type Handler = (call: RecordedCall, config: AxiosRequestConfig) => FakeResponse | Promise<FakeResponse>;

export const isTokenCall = (call: RecordedCall) => {
  try {
    return new URL(call.url).hostname === "sso.myfox.io";
  } catch {
    return false;
  }
};

/**
 * Replaces axios.create so that every instance created by the code under test uses a fake adapter.
 * Interceptors and error handling of the real axios instance stay active; only the network is faked.
 */
export function stubAxios(handler: Handler) {
  const calls: RecordedCall[] = [];
  const originalCreate = axios.create.bind(axios);
  mock.method(axios, "create", (config?: AxiosRequestConfig) => originalCreate({
    ...config,
    adapter: async (requestConfig: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
      let body: Record<string, string> | undefined;
      if (typeof requestConfig.data === "string") {
        body = JSON.parse(requestConfig.data);
      }
      const call: RecordedCall = {method: String(requestConfig.method).toLowerCase(), url: String(requestConfig.url), body};
      calls.push(call);
      const {status = 200, data = {}, headers = {}} = await handler(call, requestConfig);
      const response = {data, status, statusText: String(status), headers, config: requestConfig, request: {}} as AxiosResponse;
      if (status >= 400) {
        throw new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_REQUEST", requestConfig, {}, response);
      }
      return response;
    }
  }));
  return {
    calls,
    tokenCalls: () => calls.filter(isTokenCall),
    apiCalls: () => calls.filter(call => !isTokenCall(call))
  };
}

export function tokenResponse(n = 1, expiresIn = 3600): FakeResponse {
  return {data: {access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: expiresIn}};
}

export interface FakeLogger extends Logging {
  lines: string[];
}

export function fakeLogger(): FakeLogger {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
  };
  const logger = ((...args: unknown[]) => record(...args)) as unknown as FakeLogger & Record<string, unknown>;
  for (const level of ["info", "warn", "error", "debug", "success", "log"]) {
    logger[level] = record;
  }
  logger.lines = lines;
  return logger;
}

/** Lets pending promise callbacks run (setImmediate is not affected by mock timers). */
export async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** Devices as returned by GET /site/{id}/device (structure observed on a real account, values made up). */
export function deviceFixtures(overrides: { smoke?: boolean; coverPresent?: boolean; deviceLost?: boolean } = {}) {
  const {smoke = false, coverPresent = true, deviceLost = false} = overrides;
  return [
    {
      device_id: "d-tag-1", label: "Window", device_definition: {type: "tag"},
      status: {cover_present: coverPresent, battery_level: 100, device_lost: deviceLost, last_status_at: "2026-11-12T19:23:28.000000Z"}
    },
    {device_id: "d-siren", label: "Siren", device_definition: {type: "siren"}, status: {battery_level: 100, device_lost: false}},
    {
      device_id: "d-smoke", label: "Kitchen smoke", device_definition: {type: "sp_risk_detector"},
      status: {
        battery_level: 100, battery_low: false, device_lost: false,
        sp_smoke_detector_smoke_detection: smoke, sp_smoke_detector_error_chamber: false
      }
    }
  ];
}

/** An indoor camera as returned by GET /site/{id}/device (structure observed on a real account, values made up). */
export function cameraFixture(shutterState: "opened" | "closed" | null = "opened") {
  return {
    device_id: "d-cam", label: "Living room", device_definition: {type: "indoor_camera"},
    status: {power_state: 1, wifi_level_percent: 89, ...(shutterState ? {shutter_state: shutterState} : {})}
  };
}
