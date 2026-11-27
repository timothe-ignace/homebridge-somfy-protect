#!/usr/bin/env node
/*
 * Live check of the Somfy (ex-MyFox) API with a real account. Read-only: it never changes the alarm state.
 *
 *   node scripts/live-check.mjs [--form] [--events[=SECONDS]]
 *
 * Credentials are read from SOMFY_USERNAME / SOMFY_PASSWORD, or prompted (the password is not echoed).
 * Tokens and the password are never printed. --form sends the OAuth requests form-encoded instead of JSON.
 * --events also reads the site history and then listens to the real-time event socket for SECONDS (default 60), printing
 * the event names and their structure; during that time use your system normally (open a window, move the camera shutter...).
 */
import {readFileSync} from "node:fs";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const TOKEN_URL = "https://sso.myfox.io/oauth/oauth/v2/token";
const API_URL = "https://api.myfox.io/v3";
const form = process.argv.includes("--form");
const eventsArg = process.argv.find((arg) => arg === "--events" || arg.startsWith("--events="));
const eventsSeconds = eventsArg ? Math.max(5, Number(eventsArg.split("=")[1]) || 60) : 0;
const SOCKET_URL = "wss://websocket.myfox.io/events/websocket";

// the public mobile-app OAuth client, read from the plugin source so it stays in one place
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "somfy_api.ts"), "utf8");
const CLIENT_ID = source.match(/CLIENT_ID = "([^"]+)"/)?.[1];
const CLIENT_SECRET = source.match(/CLIENT_SECRET = "([^"]+)"/)?.[1];
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Could not read the OAuth client from src/lib/somfy_api.ts");
  process.exit(2);
}

function prompt(question, hidden) {
  return new Promise((resolve) => {
    const rl = createInterface({input: process.stdin, output: process.stdout, terminal: true});
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) {
          process.stdout.write(text);
        }
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) {
        process.stdout.write("\n");
      }
      resolve(answer);
    });
  });
}

async function post(body) {
  const payload = {client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body};
  const init = form
    ? {headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: new URLSearchParams(payload).toString()}
    : {headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)};
  return fetch(TOKEN_URL, {method: "POST", signal: AbortSignal.timeout(30000), ...init});
}

async function report(label, response) {
  const retryAfter = response.headers.get("retry-after");
  console.log(`${label}: HTTP ${response.status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ""}`);
  let data = null;
  try {
    data = await response.json();
  } catch {
    // not JSON
  }
  if (!response.ok) {
    // OAuth errors only carry an error code and a description, never the submitted secrets
    console.log(`  error: ${data?.error ?? "?"} ${data?.error_description ?? ""}`.trimEnd());
  }
  return data;
}

const SHOWN = /alarm|trigger|status|state|mode|level|type|active|enabled|available|mfa/i;

// shows structure, and the value only where the key suggests a state (never ids, names or addresses)
function describe(value, key = "", depth = 0) {
  if (Array.isArray(value)) {
    return `array(${value.length})${value[0] !== undefined && depth < 3 ? ` of ${describe(value[0], key, depth + 1)}` : ""}`;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return depth >= 3 ? "object" : `{${Object.entries(value).map(([k, v]) => `${k}: ${describe(v, k, depth + 1)}`).join(", ")}}`;
  }
  return SHOWN.test(key) ? JSON.stringify(value) : typeof value;
}

// keys that identify a person, a place or a device are never shown; state-like keys show their value
const PRIVATE = /(^|_)(id|ids|name|label|serial|mac|address|ssid|token|key|secret|phone|email|latitude|longitude|zip|city|code)(_|$)|address|serial/i;
const STATE_LIKE = /type|status|state|model|battery|open|presence|motion|temperature|humidity|smoke|light|signal|mode|level|available|enabled|online|version|category|capab|feature|reason|alarm/i;

function shapeOf(value) {
  if (Array.isArray(value)) {
    return `[${value.length ? shapeOf(value[0]) : ""}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${key}:${shapeOf(value[key])}`).join(",")}}`;
  }
  return typeof value;
}

function describeDevice(value, key = "", depth = 0) {
  if (Array.isArray(value)) {
    return `array(${value.length})${value[0] !== undefined && depth < 4 ? ` of ${describeDevice(value[0], key, depth + 1)}` : ""}`;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return depth >= 4 ? "object" : `{${Object.entries(value).map(([k, v]) => `${k}: ${describeDevice(v, k, depth + 1)}`).join(", ")}}`;
  }
  if (PRIVATE.test(key) || !STATE_LIKE.test(key)) {
    return typeof value;
  }
  return JSON.stringify(typeof value === "string" ? value.slice(0, 40) : value);
}

// real-time events: the token goes in the URL (as the Somfy apps do) and is never printed
function listen(accessToken, seconds) {
  return new Promise((resolve) => {
    console.log(`\n7. Event socket: listening for ${seconds} s. Use your system now (alarm disarmed): open and close a window with a detector, move the camera shutter, walk past a detector. Do not trigger the alarm.`);
    let count = 0;
    const socket = new WebSocket(`${SOCKET_URL}?token=${encodeURIComponent(accessToken)}`);
    const done = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      console.log(`  ${count} event(s) received.`);
      resolve();
    };
    const timer = setTimeout(done, seconds * 1000);
    socket.addEventListener("open", () => console.log("  connected"));
    socket.addEventListener("error", () => console.log("  socket error (the event channel may be unavailable for this account)"));
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("message", (message) => {
      count++;
      let text = typeof message.data === "string" ? message.data : "";
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON
      }
      const time = new Date().toISOString().slice(11, 19);
      // the event name is shown as is (a "key" field would otherwise be hidden as private)
      const label = [parsed?.key, parsed?.event, parsed?.type, parsed?.name].find((value) => typeof value === "string" && /^[\w.-]{1,60}$/.test(value));
      console.log(`  ${time} ${label ? `[${label}] ` : ""}${parsed ? describeDevice(parsed, "event") : `(non-JSON, ${text.length} chars)`}`);
      // acknowledge, as the Somfy apps do, so that the server keeps sending
      if (parsed?.message_id !== undefined) {
        try {
          socket.send(JSON.stringify({ack: true, message_id: parsed.message_id, client: "Android"}));
        } catch {
          // closed meanwhile
        }
      }
    });
  });
}

const username = process.env.SOMFY_USERNAME ?? await prompt("Somfy username: ", false);
const password = process.env.SOMFY_PASSWORD ?? await prompt("Somfy password: ", true);
console.log(`\nMode: OAuth requests ${form ? "form-encoded" : "JSON"}\n`);

const login = await post({username, password, grant_type: "password"});
const token = await report("1. Password grant", login);
if (!token?.access_token) {
  console.log("\nResult: FAILED, no access token. The plugin cannot log in with this account/client.");
  process.exit(1);
}
console.log(`  expires_in: ${token.expires_in} (the plugin assumes seconds), refresh_token: ${token.refresh_token ? "yes" : "NO"}`);

if (token.refresh_token) {
  const refreshed = await report("2. Refresh grant", await post({refresh_token: token.refresh_token, grant_type: "refresh_token"}));
  if (refreshed?.access_token) {
    token.access_token = refreshed.access_token;
  }
}

const headers = {Authorization: `Bearer ${token.access_token}`};
const sitesResponse = await fetch(`${API_URL}/site`, {headers, signal: AbortSignal.timeout(30000)});
const sites = await report("3. GET /site", sitesResponse);
const items = sites?.items ?? [];
console.log(`  ${items.length} site(s)`);
items.forEach((site, index) => console.log(`  Site ${index + 1}: ${site.name}, site_id: ${site.site_id}, security_level: ${site.security_level}`));

if (items[0]) {
  const site = await report("4. GET /site/{id}", await fetch(`${API_URL}/site/${encodeURIComponent(items[0].site_id)}`, {headers, signal: AbortSignal.timeout(30000)}));
  if (site) {
    console.log("  keys of the site object (look here for an alarm/triggered state to map to ALARM_TRIGGERED):");
    for (const [key, value] of Object.entries(site)) {
      const interesting = /alarm|trigger|status|state|security|mode|mfa/i.test(key);
      console.log(`    ${key}: ${interesting ? describe(value, key) : typeof value}`);
    }
  }
  const devices = await report("5. GET /site/{id}/device", await fetch(`${API_URL}/site/${encodeURIComponent(items[0].site_id)}/device`, {headers, signal: AbortSignal.timeout(30000)}));
  const list = devices?.items ?? [];
  console.log(`  ${list.length} device(s). One example per distinct structure (ids, names, serials and addresses are never printed):`);
  const shapes = new Map();
  for (const device of list) {
    const signature = shapeOf(device);
    shapes.set(signature, {count: (shapes.get(signature)?.count ?? 0) + 1, device});
  }
  for (const {count, device} of shapes.values()) {
    console.log(`  - x${count}: ${describeDevice(device)}`);
  }

  if (eventsSeconds) {
    const history = await report("6. GET /site/{id}/history", await fetch(`${API_URL}/site/${encodeURIComponent(items[0].site_id)}/history`, {headers, signal: AbortSignal.timeout(30000)}));
    const entries = history?.items ?? [];
    console.log(`  ${entries.length} history entr${entries.length === 1 ? "y" : "ies"}. One example per distinct structure:`);
    const kinds = new Map();
    for (const entry of entries) {
      const signature = shapeOf(entry);
      kinds.set(signature, {count: (kinds.get(signature)?.count ?? 0) + 1, entry});
    }
    for (const {count, entry} of [...kinds.values()].slice(0, 12)) {
      console.log(`  - x${count}: ${describeDevice(entry)}`);
    }
    await listen(token.access_token, eventsSeconds);
  }
}

console.log("\nDone. Nothing was changed on your alarm. Test arming/disarming from the Home app.");
