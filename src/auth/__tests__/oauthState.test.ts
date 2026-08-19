import { beforeEach, describe, expect, it } from "vitest";
import { buildAuthorizationUrl, getClioApiBase, validateAuthorizationState } from "../oauth.js";

beforeEach(() => {
  process.env.CLIO_CLIENT_ID = "client-id";
  process.env.CLIO_CLIENT_SECRET = "client-secret";
  process.env.MCP_BASE_URL = "https://example.test";
  delete process.env.OAUTH_STATE_SECRET;
  delete process.env.CLIO_API_BASE;
  process.env.CLIO_REGION = "us";
});

describe("HTTP OAuth state", () => {
  it("round-trips a signed state without requiring a live session record", () => {
    const { url } = buildAuthorizationUrl("session-123");
    const state = new URL(url).searchParams.get("state");
    expect(state).toBeTruthy();
    expect(validateAuthorizationState(state!).session_id).toBe("session-123");
  });

  it("rejects tampered state", () => {
    const { url } = buildAuthorizationUrl("session-123");
    const state = new URL(url).searchParams.get("state")!;
    const tampered = state.slice(0, -1) + (state.endsWith("a") ? "b" : "a");
    expect(() => validateAuthorizationState(tampered)).toThrow("Invalid OAuth state signature");
  });

  it("rejects expired state", () => {
    const before = Date.now();
    const { url } = buildAuthorizationUrl("session-123");
    const state = new URL(url).searchParams.get("state")!;
    expect(() => validateAuthorizationState(state, before + 11 * 60 * 1000)).toThrow("OAuth state has expired");
  });
});

describe("regional API base", () => {
  it("uses the Canadian Clio host when CLIO_REGION=ca", () => {
    process.env.CLIO_REGION = "ca";
    expect(getClioApiBase()).toBe("https://ca.app.clio.com/api/v4");
  });

  it("honours CLIO_API_BASE override", () => {
    process.env.CLIO_API_BASE = "https://custom.example/api/v4/";
    expect(getClioApiBase()).toBe("https://custom.example/api/v4");
  });
});
