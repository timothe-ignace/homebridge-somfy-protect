#!/usr/bin/env node
/*
 * Live check of the Somfy (ex-MyFox) API with a real account. Read-only: it never changes the alarm state.
 *
 *   node scripts/live-check.mjs [--form]
 *
 * Credentials are read from SOMFY_USERNAME / SOMFY_PASSWORD, or prompted (the password is not echoed).
 * Tokens and the password are never printed. --form sends the OAuth requests form-encoded instead of JSON.
 */
import {readFileSync} from "node:fs";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const TOKEN_URL = "https://sso.myfox.io/oauth/oauth/v2/token";
const API_URL = "https://api.myfox.io/v3";
const form = process.argv.includes("--form");

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

function describe(value) {
  return Array.isArray(value) ? `array(${value.length})` : value === null ? "null" : typeof value === "object" ? "object" : JSON.stringify(value);
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
      const interesting = /alarm|trigger|status|state|security|mode/i.test(key);
      console.log(`    ${key}: ${interesting ? describe(value) : typeof value}`);
    }
  }
  const devices = await report("5. GET /site/{id}/device", await fetch(`${API_URL}/site/${encodeURIComponent(items[0].site_id)}/device`, {headers, signal: AbortSignal.timeout(30000)}));
  console.log(`  ${devices?.items?.length ?? "?"} device(s)`);
}

console.log("\nDone. Nothing was changed on your alarm. Test arming/disarming from the Home app.");
