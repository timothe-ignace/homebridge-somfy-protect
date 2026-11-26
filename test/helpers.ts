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

export const isTokenCall = (call: RecordedCall) => call.url.includes("sso.myfox.io");

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
