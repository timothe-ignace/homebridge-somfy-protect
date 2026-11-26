import axios, {AxiosInstance, AxiosRequestConfig, AxiosResponse} from "axios";
import {Logging} from "homebridge";
import {LoggingAmount} from "./logging_amount";

const CLIENT_ID = "84eddf48-2b8e-11e5-b2a5-124cfab25595_475buqrf8v8kgwoo4gow08gkkc0ck80488wo44s8o48sg84k40";
const CLIENT_SECRET = "4dsqfntieu0wckwwo40kw848gw4o0c8k4owc80k4go0cs0k844";

const TOKEN_URL = "https://sso.myfox.io/oauth/oauth/v2/token";
const REQUEST_TIMEOUT = 30000;
const TOKEN_EXPIRY_MARGIN = 60000; // renew the token one minute before it really expires
const DEFAULT_EXPIRES_IN = 3600; // seconds, used when the server does not provide expires_in
const MAX_RETRY_AFTER = 15 * 60 * 1000;

interface SomfyAPIConfig {
  username: string;
  password: string;
  loggingAmount: LoggingAmount;
}

interface Token {
  access_token: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  issuance: number; // ms since epoch
}

/**
 * Error thrown by the API. It never carries the axios request/config (which contains credentials).
 */
export class SomfyAPIError extends Error {

  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "SomfyAPIError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const seconds = Number(value);
  const ms = String(value).trim() !== "" && !isNaN(seconds) ? seconds * 1000 : Date.parse(String(value)) - Date.now();
  if (isNaN(ms)) {
    return undefined;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER);
}

interface AxiosLikeError {
  message?: unknown;
  code?: unknown;
  response?: {status?: number; headers?: Record<string, unknown>};
}

function toAPIError(raw: unknown): SomfyAPIError {
  const error = raw as AxiosLikeError | null | undefined;
  if (raw instanceof SomfyAPIError) {
    return raw;
  }
  // only use the message/code, never the whole axios error (it contains the request config incl. credentials)
  const status = error?.response?.status;
  const retryAfterMs = parseRetryAfter(error?.response?.headers?.["retry-after"]);
  let message = typeof error?.message === "string" ? error.message : "Unknown error";
  if (status === undefined && typeof error?.code === "string") {
    message += ` (${error.code})`;
  }
  return new SomfyAPIError(message, status, retryAfterMs);
}

export class SomfyAPI {

  private logger: Logging;
  private config: SomfyAPIConfig;
  private baseUrl = "https://api.myfox.io/v3";
  private token: Token | null = null;
  private tokenPromise: Promise<Token> | null = null;
  private readonly http: AxiosInstance;
  private readonly requestStart = new WeakMap<object, [number, number]>();

  constructor(logger: Logging, config: SomfyAPIConfig) {
    this.logger = logger;
    this.config = config;

    // dedicated instance, so that the global axios instance (shared with other plugins) is left untouched
    this.http = axios.create({timeout: REQUEST_TIMEOUT});

    this.http.interceptors.request.use(config => {
      // keep the timing locally, nothing is sent to Somfy
      this.requestStart.set(config, process.hrtime());
      config.headers.set("Content-Type", "application/json");
      return config;
    });

    this.http.interceptors.response.use(response => {
      const start = this.requestStart.get(response.config);
      if (start) {
        this.requestStart.delete(response.config);
        const end = process.hrtime(start);
        const duration = Math.round((end[0] * 1000) + (end[1] / 1000000));
        // logging
        if (this.config.loggingAmount === LoggingAmount.FULL) {
          this.logger.info(`${response.config.url} : ${duration} ms`);
        }
      }
      return response;
    });
  }

  private async requestToken(body: Record<string, string>): Promise<Token> {
    try {
      const response = await this.http.post(TOKEN_URL, {client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body});
      if (!response.data?.access_token) {
        throw new SomfyAPIError("Token response did not contain an access token");
      }
      return {...response.data, issuance: new Date().getTime()};
    } catch (error: unknown) {
      throw toAPIError(error);
    }
  }

  private async getNewToken(): Promise<Token> {
    // logging
    if (this.config.loggingAmount === LoggingAmount.FULL) {
      this.logger.info("Getting a new token");
    }
    return this.requestToken({username: this.config.username, password: this.config.password, grant_type: "password"});
  }

  private async getRefreshToken(refreshToken: string): Promise<Token> {
    // logging
    if (this.config.loggingAmount === LoggingAmount.FULL) {
      this.logger.info("Refreshing token");
    }
    return this.requestToken({refresh_token: refreshToken, grant_type: "refresh_token"});
  }

  private hasExpired(token: Token): boolean {
    const expiresIn = typeof token.expires_in === "number" && token.expires_in > 0 ? token.expires_in : DEFAULT_EXPIRES_IN;
    // expires_in is expressed in seconds, issuance in milliseconds
    return token.issuance + (expiresIn * 1000) - TOKEN_EXPIRY_MARGIN < new Date().getTime();
  }

  private async renewToken(): Promise<Token> {
    const refreshToken = this.token?.refresh_token;
    if (refreshToken) {
      try {
        return await this.getRefreshToken(refreshToken);
      } catch (error: unknown) {
        const status = error instanceof SomfyAPIError ? error.status : undefined;
        // only log in again when the refresh token was rejected, not on rate limiting or network/server errors
        if (status !== 400 && status !== 401 && status !== 403) {
          throw error;
        }
        this.logger.warn(`Refreshing the token failed (${toAPIError(error).message}), logging in again`);
      }
    }
    return this.getNewToken();
  }

  /**
   * Returns a valid token. Concurrent callers share a single in-flight request. Throws a SomfyAPIError on failure.
   */
  async updateToken(): Promise<Token> {
    if (this.token && !this.hasExpired(this.token)) {
      return this.token;
    }
    if (!this.tokenPromise) {
      this.tokenPromise = this.renewToken()
        .then(token => {
          this.token = token;
          return token;
        })
        .finally(() => {
          this.tokenPromise = null;
        });
    }
    return this.tokenPromise;
  }

  private async request(method: "get" | "put", path: string, data?: unknown): Promise<AxiosResponse> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.updateToken();
      const options: AxiosRequestConfig = {headers: {"Authorization": `Bearer ${token.access_token}`}};
      try {
        if (method === "put") {
          return await this.http.put(`${this.baseUrl}${path}`, data, options);
        }
        return await this.http.get(`${this.baseUrl}${path}`, options);
      } catch (error: unknown) {
        const apiError = toAPIError(error);
        if (apiError.status === 401 && attempt === 0) {
          // token rejected (e.g. revoked): drop it, the next attempt will log in again
          if (this.token === token) {
            this.token = null;
          }
          continue;
        }
        throw apiError;
      }
    }
  }

  async getALLSites() {
    return this.request("get", "/site");
  }

  async getSite(siteId: string) {
    return this.request("get", `/site/${encodeURIComponent(siteId)}`);
  }

  async setSecurityLevel(siteId: string, status: "disarmed" | "armed" | "partial") {
    return this.request("put", `/site/${encodeURIComponent(siteId)}/security`, {status});
  }
}
