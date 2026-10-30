import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetValidAccessToken, mockGetSessionContext, mockGetClioApiBase } = vi.hoisted(() => ({
  mockGetValidAccessToken: vi.fn(),
  mockGetSessionContext: vi.fn(),
  mockGetClioApiBase: vi.fn(),
}));

vi.mock("../../auth/oauth.js", () => ({ getValidAccessToken: mockGetValidAccessToken }));
vi.mock("../sessionContext.js", () => ({ getSessionContext: mockGetSessionContext }));
vi.mock("../clioRegion.js", () => ({ getClioApiBase: mockGetClioApiBase }));

import { ClioApiError, clioPatch } from "../clioClient.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionContext.mockReturnValue(null);
  mockGetValidAccessToken.mockResolvedValue("synthetic-token");
  mockGetClioApiBase.mockReturnValue("https://example.test/api/v4");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Clio API errors", () => {
  it("preserves the structured error type when Clio also returns a message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        type: "UploadTimeoutError",
        message: "Document verification timed out.",
      },
    }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    })));

    const error = await clioPatch("/documents/7.json", { data: { fully_uploaded: true } })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ClioApiError);
    expect(error).toMatchObject({
      statusCode: 422,
      errorType: "UploadTimeoutError",
    });
    expect(error.message).toContain("Document verification timed out.");
  });
});
