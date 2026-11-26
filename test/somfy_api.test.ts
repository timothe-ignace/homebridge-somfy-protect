import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it, mock} from "node:test";
import {SomfyAPI, SomfyAPIError} from "../src/lib/somfy_api";
import {LoggingAmount} from "../src/lib/logging_amount";
import {fakeLogger, flush, isTokenCall, PASSWORD, stubAxios, tokenResponse, USERNAME} from "./helpers";

function createAPI(loggingAmount = LoggingAmount.OFF) {
  const logger = fakeLogger();
  return {logger, api: new SomfyAPI(logger, {username: USERNAME, password: PASSWORD, loggingAmount})};
}

describe("SomfyAPI", () => {
  beforeEach(() => {
    mock.timers.enable({apis: ["Date"], now: 1_000_000});
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it("treats expires_in as seconds and reuses the token across calls", async () => {
    const stub = stubAxios(call => isTokenCall(call) ? tokenResponse(call.body?.grant_type === "password" ? 1 : 2) : {});
    const {api} = createAPI();

    await api.getSite("s1");
    await api.getSite("s1");
    mock.timers.tick(30 * 60 * 1000); // half of the lifetime
    await api.getSite("s1");
    assert.equal(stub.tokenCalls().length, 1);
    assert.equal(stub.tokenCalls()[0].body?.grant_type, "password");
    assert.equal(stub.apiCalls().length, 3);

    // past expiry minus the one minute margin: the token is renewed with the refresh token
    mock.timers.tick(30 * 60 * 1000);
    await api.getSite("s1");
    assert.equal(stub.tokenCalls().length, 2);
    assert.equal(stub.tokenCalls()[1].body?.grant_type, "refresh_token");
    assert.equal(stub.tokenCalls()[1].body?.refresh_token, "refresh-1");
  });

  it("sends a single token request for concurrent calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const stub = stubAxios(async call => {
      if (isTokenCall(call)) {
        await gate;
        return tokenResponse();
      }
      return {};
    });
    const {api} = createAPI();

    const pending = Promise.all(Array.from({length: 8}, () => api.getSite("s1")));
    await flush();
    release();
    await pending;
    assert.equal(stub.tokenCalls().length, 1);
    assert.equal(stub.apiCalls().length, 8);
  });

  it("falls back to a password login when the refresh token is rejected with 400", async () => {
    const stub = stubAxios(call => {
      if (!isTokenCall(call)) {
        return {};
      }
      if (call.body?.grant_type === "refresh_token") {
        return {status: 400, data: {error: "invalid_grant"}};
      }
      return tokenResponse(stub.tokenCalls().length);
    });
    const {api} = createAPI();

    await api.getSite("s1");
    mock.timers.tick(2 * 3600 * 1000);
    await api.getSite("s1");
    assert.deepEqual(stub.tokenCalls().map(call => call.body?.grant_type), ["password", "refresh_token", "password"]);
  });

  it("does not call SSO again when the refresh is rate limited (429)", async () => {
    const stub = stubAxios(call => {
      if (!isTokenCall(call)) {
        return {};
      }
      return call.body?.grant_type === "refresh_token" ? {status: 429, headers: {"retry-after": "30"}} : tokenResponse();
    });
    const {api} = createAPI();

    await api.getSite("s1");
    mock.timers.tick(2 * 3600 * 1000);
    await assert.rejects(api.getSite("s1"), (error: SomfyAPIError) => {
      assert.ok(error instanceof SomfyAPIError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 30000);
      return true;
    });
    assert.deepEqual(stub.tokenCalls().map(call => call.body?.grant_type), ["password", "refresh_token"]);
  });

  it("logs in again once on a 401 and retries the request", async () => {
    let siteCalls = 0;
    const stub = stubAxios(call => {
      if (isTokenCall(call)) {
        return tokenResponse(stub.tokenCalls().length);
      }
      return ++siteCalls === 1 ? {status: 401} : {data: {ok: true}};
    });
    const {api} = createAPI();

    const response = await api.getSite("s1");
    assert.deepEqual(response.data, {ok: true});
    assert.equal(stub.apiCalls().length, 2);
    assert.deepEqual(stub.tokenCalls().map(call => call.body?.grant_type), ["password", "password"]);
  });

  it("gives up after a second 401", async () => {
    const stub = stubAxios(call => isTokenCall(call) ? tokenResponse() : {status: 401});
    const {api} = createAPI();

    await assert.rejects(api.getSite("s1"), (error: SomfyAPIError) => error.status === 401);
    assert.equal(stub.apiCalls().length, 2);
  });

  it("surfaces a 429 with Retry-After as SomfyAPIError", async () => {
    stubAxios(call => isTokenCall(call) ? tokenResponse() : {status: 429, headers: {"retry-after": "120"}});
    const {api} = createAPI();

    await assert.rejects(api.getSite("s1"), (error: SomfyAPIError) => {
      assert.ok(error instanceof SomfyAPIError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 120000);
      return true;
    });
  });

  it("never logs or exposes the password", async () => {
    stubAxios(call => {
      if (isTokenCall(call)) {
        return call.body?.grant_type === "refresh_token" ? {status: 400} : tokenResponse();
      }
      return {status: 429};
    });
    const {api, logger} = createAPI(LoggingAmount.FULL);

    const errors: SomfyAPIError[] = [];
    await api.getSite("s1").catch(error => errors.push(error));
    mock.timers.tick(2 * 3600 * 1000);
    await api.getSite("s1").catch(error => errors.push(error));

    assert.ok(logger.lines.length > 0);
    assert.ok(logger.lines.some(line => line.includes("logging in again")));
    for (const line of logger.lines) {
      assert.ok(!line.includes(PASSWORD), line);
    }
    assert.equal(errors.length, 2);
    for (const error of errors) {
      assert.ok(!error.message.includes(PASSWORD));
      assert.ok(!JSON.stringify(error).includes(PASSWORD));
      assert.ok(!String(error.stack).includes(PASSWORD));
    }
  });
});
