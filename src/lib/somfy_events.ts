import {Logging} from "homebridge";
import {LoggingAmount} from "./logging_amount";

const EVENTS_URL = "wss://websocket.myfox.io/events/websocket";
const INITIAL_BACKOFF = 5000;
const MAX_BACKOFF = 5 * 60 * 1000;
/** a connection that stayed open this long counts as stable: the backoff starts again from the beginning */
const STABLE_AFTER = 60 * 1000;

/** The part of the WebSocket API that is used (the global WebSocket of Node >= 22 fits). */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/** One message of the event channel, reduced to what the plugin uses. */
export interface SomfyEvent {
  key: string;
  siteId?: string;
  deviceId?: string;
  securityLevel?: string;
  active?: boolean;
}

export interface SomfyEventSocketOptions {
  /** returns an access token; `forceRefresh` asks for a new one (used after a token error of the channel) */
  getToken: (forceRefresh: boolean) => Promise<string>;
  onEvent: (event: SomfyEvent) => void;
  webSocketFactory?: (url: string) => WebSocketLike;
  loggingAmount: LoggingAmount;
}

function defaultFactory(url: string): WebSocketLike {
  const ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!ctor) {
    throw new Error("WebSocket is not available in this Node.js version");
  }
  return new ctor(url);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Parses one raw message; returns undefined for anything that is not a JSON object with a string "key".
 */
export function parseEvent(data: unknown): { event: SomfyEvent; messageId?: string | number } | undefined {
  if (typeof data !== "string") {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const message = raw as Record<string, unknown>;
  const key = asString(message.key);
  if (key === undefined) {
    return undefined;
  }
  const id = message.message_id;
  return {
    event: {
      key,
      siteId: asString(message.site_id),
      deviceId: asString(message.device_id),
      securityLevel: asString(message.security_level),
      active: typeof message.active === "boolean" ? message.active : undefined
    },
    messageId: typeof id === "string" || typeof id === "number" ? id : undefined
  };
}

/**
 * Optional real-time channel of Somfy (unofficial). Reconnects by itself; its failures are only logged and never
 * thrown. The URL contains the access token, so it is never logged.
 */
export class SomfyEventSocket {

  private socket: WebSocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private failures = 0;
  private openedAt = 0;
  private forceRefresh = false;
  private connecting = false;

  constructor(private readonly logger: Logging, private readonly options: SomfyEventSocketOptions) {
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      this.detach(socket);
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  }

  private detach(socket: WebSocketLike) {
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
  }

  private connect() {
    if (!this.running || this.connecting || this.socket) {
      return;
    }
    this.connecting = true;
    this.options.getToken(this.forceRefresh).then(token => {
      this.connecting = false;
      if (!this.running) {
        return;
      }
      this.forceRefresh = false;
      this.open(token);
    }).catch((error: unknown) => {
      this.connecting = false;
      this.logger.warn(`Real-time events: could not get a token: ${errorMessage(error)}`);
      this.scheduleReconnect();
    });
  }

  private open(token: string) {
    let socket: WebSocketLike;
    try {
      const factory = this.options.webSocketFactory ?? defaultFactory;
      socket = factory(`${EVENTS_URL}?token=${encodeURIComponent(token)}`);
    } catch (error: unknown) {
      this.logger.warn(`Real-time events: could not connect: ${errorMessage(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.openedAt = 0;
    socket.onopen = () => {
      if (this.socket === socket) {
        this.openedAt = Date.now();
        if (this.options.loggingAmount === LoggingAmount.FULL) {
          this.logger.info("Real-time events: connected");
        }
      }
    };
    socket.onmessage = (message) => {
      if (this.socket === socket) {
        this.handleMessage(socket, message?.data);
      }
    };
    socket.onerror = () => {
      // details are not logged (they could contain the URL); onclose follows
      if (this.options.loggingAmount === LoggingAmount.FULL) {
        this.logger.info("Real-time events: connection error");
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = null;
        this.detach(socket);
        this.scheduleReconnect();
      }
    };
  }

  private handleMessage(socket: WebSocketLike, data: unknown) {
    const parsed = parseEvent(data);
    if (!parsed) {
      return;
    }
    if (parsed.messageId !== undefined) {
      try {
        socket.send(JSON.stringify({ack: true, message_id: parsed.messageId, client: "Android"}));
      } catch {
        // a lost ack is harmless
      }
    }
    if (parsed.event.key === "websocket.connection.ready") {
      return;
    }
    if (parsed.event.key === "websocket.error.token") {
      this.logger.warn("Real-time events: Somfy rejected the token, getting a new one");
      this.forceRefresh = true;
      this.socket = null;
      this.detach(socket);
      try {
        socket.close();
      } catch {
        // ignore
      }
      this.scheduleReconnect();
      return;
    }
    try {
      this.options.onEvent(parsed.event);
    } catch (error: unknown) {
      this.logger.warn(`Real-time events: could not process "${parsed.event.key}": ${errorMessage(error)}`);
    }
  }

  private scheduleReconnect() {
    if (!this.running || this.timer !== null) {
      return;
    }
    if (this.openedAt > 0 && Date.now() - this.openedAt >= STABLE_AFTER) {
      this.failures = 0;
    }
    this.openedAt = 0;
    const backoff = Math.min(MAX_BACKOFF, INITIAL_BACKOFF * Math.pow(2, this.failures));
    this.failures++;
    const delay = Math.round(backoff * (0.8 + Math.random() * 0.4));
    if (this.options.loggingAmount > LoggingAmount.OFF) {
      this.logger.info(`Real-time events: reconnecting in ${Math.round(delay / 1000)} s`);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

}

function errorMessage(error: unknown): string {
  // only a message: never the error object (a library could attach the URL)
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/token=[^&\s"']+/gi, "token=***");
}
