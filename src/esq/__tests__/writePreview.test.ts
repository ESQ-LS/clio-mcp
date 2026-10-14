import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadTokens, getSessionContext, getClioBaseUrl } = vi.hoisted(() => ({
  loadTokens: vi.fn(),
  getSessionContext: vi.fn(),
  getClioBaseUrl: vi.fn(),
}));
vi.mock("../../auth/tokenStorage.js", () => ({ loadTokens }));
vi.mock("../../utils/sessionContext.js", () => ({ getSessionContext }));
vi.mock("../../utils/clioClient.js", () => ({ getClioBaseUrl }));

import { makeWritePreviewToken, consumeWritePreviewToken } from "../writePreview.js";

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY", "1".repeat(64));
  loadTokens.mockResolvedValue({ clio_user_id: "100", expires_at: Date.now() + 3600000 });
  getSessionContext.mockReturnValue(undefined);
  getClioBaseUrl.mockReturnValue("https://ca.app.clio.com/api/v4");
});
afterEach(() => vi.unstubAllEnvs());

describe("intake write preview tokens", () => {
  const proposal = { name: "Synthetic", type: "Company" };

  it("allows the same authenticated user to confirm once", async () => {
    const token = await makeWritePreviewToken("create_contact", proposal);
    await expect(consumeWritePreviewToken(token, "create_contact", proposal)).resolves.toBeUndefined();
    await expect(consumeWritePreviewToken(token, "create_contact", proposal)).rejects.toThrow("already been used");
  });

  it("rejects another user and another API region", async () => {
    const token = await makeWritePreviewToken("create_contact", proposal);
    loadTokens.mockResolvedValue({ clio_user_id: "200", expires_at: Date.now() + 3600000 });
    await expect(consumeWritePreviewToken(token, "create_contact", proposal)).rejects.toThrow("authenticated user");
    loadTokens.mockResolvedValue({ clio_user_id: "100", expires_at: Date.now() + 3600000 });
    getClioBaseUrl.mockReturnValue("https://app.clio.com/api/v4");
    await expect(consumeWritePreviewToken(token, "create_contact", proposal)).rejects.toThrow("authenticated user");
  });

  it("never falls back to stored credentials for an unauthenticated HTTP session", async () => {
    getSessionContext.mockReturnValue({ getTokens: () => null });
    await expect(makeWritePreviewToken("create_contact", proposal)).rejects.toThrow("authenticated Clio user");
  });

  it("binds confirmation to the HTTP session's Clio user", async () => {
    let user = "100";
    getSessionContext.mockReturnValue({
      getTokens: () => ({ clio_user_id: user, expires_at: Date.now() + 3600000 }),
    });
    const token = await makeWritePreviewToken("create_contact", proposal);
    user = "200";
    await expect(consumeWritePreviewToken(token, "create_contact", proposal)).rejects.toThrow("authenticated user");
  });

  it("rejects changed payloads, actions, tampering, and expired tokens", async () => {
    const now = Date.now();
    const token = await makeWritePreviewToken("create_contact", proposal, now);
    await expect(consumeWritePreviewToken(token, "update_contact", proposal)).rejects.toThrow("proposal changed");
    await expect(consumeWritePreviewToken(token, "create_contact", { ...proposal, name: "Changed" })).rejects.toThrow("proposal changed");
    await expect(consumeWritePreviewToken(`${token}x`, "create_contact", proposal)).rejects.toThrow("Invalid preview");
    await expect(consumeWritePreviewToken(token, "create_contact", proposal, now + 900001)).rejects.toThrow("expired");
  });

  it("rejects tokens after a server module restart", async () => {
    const token = await makeWritePreviewToken("create_contact", proposal);
    vi.resetModules();
    const restarted = await import("../writePreview.js");
    await expect(restarted.consumeWritePreviewToken(token, "create_contact", proposal)).rejects.toThrow("server changed");
  });

  it("refuses missing or expired authenticated identity", async () => {
    loadTokens.mockResolvedValue(null);
    await expect(makeWritePreviewToken("create_contact", proposal)).rejects.toThrow("authenticated Clio user");
    loadTokens.mockResolvedValue({ clio_user_id: "100", expires_at: Date.now() - 1 });
    await expect(makeWritePreviewToken("create_contact", proposal)).rejects.toThrow("authenticated Clio user");
  });
});
