import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockClioApiError extends Error {
    constructor(public statusCode: number, message: string) {
      super(message);
    }
  }
  return {
    MockClioApiError,
    appendAuditLog: vi.fn().mockResolvedValue(true),
    buildAuthorizationUrl: vi.fn(),
    clearTokens: vi.fn(),
    clioGet: vi.fn(),
    clioPatch: vi.fn(),
    clioPost: vi.fn(),
    clioPut: vi.fn(),
    getValidAccessToken: vi.fn(),
    loadTokens: vi.fn(),
    readAuditLog: vi.fn(),
    sessionClearTokens: vi.fn(),
    sessionGetTokens: vi.fn(),
  };
});

vi.mock("../../utils/clioClient.js", () => ({
  ClioApiError: mocks.MockClioApiError,
  clioGet: mocks.clioGet,
  clioPatch: mocks.clioPatch,
  clioPost: mocks.clioPost,
  clioPut: mocks.clioPut,
  extractNextPageToken: () => null,
  getClioBaseUrl: () => "https://app.clio.com/api/v4",
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mocks.appendAuditLog,
  readAuditLog: mocks.readAuditLog,
}));

vi.mock("../../auth/tokenStorage.js", () => ({
  clearTokens: mocks.clearTokens,
  loadTokens: mocks.loadTokens,
}));

vi.mock("../../auth/oauth.js", () => ({
  buildAuthorizationUrl: mocks.buildAuthorizationUrl,
  getValidAccessToken: mocks.getValidAccessToken,
}));

vi.mock("../../utils/sessionContext.js", () => ({
  getSessionContext: () => ({
    clearTokens: mocks.sessionClearTokens,
    getTokens: mocks.sessionGetTokens,
  }),
}));

import { registerAuthTools } from "../../auth/authTools.js";
import { registerActivityTools } from "../activities.js";
import { registerAuditExportTool } from "../auditExport.js";
import { registerBillingTools } from "../billing.js";
import { registerCalendarTools } from "../calendar.js";
import { registerCommunicationTools } from "../communications.js";
import { registerContactTools } from "../contacts.js";
import { registerDocumentTools } from "../documents.js";
import { registerMatterTools } from "../matters.js";
import { registerTaskTools } from "../tasks.js";
import { registerUserTools } from "../users.js";

type Handler = (args: Record<string, unknown>) => Promise<any>;

const AUTH_FIXTURE = {
  access_token: "synthetic-access-token",
  refresh_token: "synthetic-refresh-token",
  expires_at: Date.now() + 60 * 60 * 1000,
  clio_user_id: 1,
};

function buildReadHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
  };

  registerAuthTools(server as any);
  registerMatterTools(server as any);
  registerContactTools(server as any);
  registerDocumentTools(server as any);
  registerTaskTools(server as any);
  registerCalendarTools(server as any);
  registerActivityTools(server as any);
  registerBillingTools(server as any);
  registerCommunicationTools(server as any);
  registerUserTools(server as any);
  registerAuditExportTool(server as any);
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadTokens.mockResolvedValue(AUTH_FIXTURE);
  mocks.sessionGetTokens.mockReturnValue(AUTH_FIXTURE);
  mocks.readAuditLog.mockResolvedValue({ entries: [], total_matched: 0, truncated: false });
  mocks.clioGet.mockImplementation(async (path: string) => {
    if (path === "/matters/1.json") {
      return { data: { id: 1, display_number: "SYN-1", description: "Synthetic matter", status: "open", billable: true } };
    }
    if (path === "/contacts/1.json") {
      return { data: { id: 1, name: "Synthetic Contact", type: "Person" } };
    }
    if (path === "/documents/1.json") {
      return { data: { id: 1, name: "synthetic.txt", content_type: "text/plain", size: 1 } };
    }
    if (path === "/activities/1.json") {
      return { data: { id: 1, type: "TimeEntry", date: "2026-01-01", quantity_in_hours: 1 } };
    }
    if (path === "/users/1.json") {
      return { data: { id: 1, name: "Synthetic User", enabled: true } };
    }
    return { data: [], meta: {} };
  });
});

describe("read-only action side effects", () => {
  it("does not mutate Clio or local authentication state", async () => {
    const handlers = buildReadHandlers();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["auth_status", {}],
      ["list_matters", { limit: 25 }],
      ["get_matter", { matter_id: 1 }],
      ["search_contacts", { query: "Synthetic", limit: 25 }],
      ["get_contact", { contact_id: 1 }],
      ["list_documents", { matter_id: 1, limit: 25 }],
      ["get_document", { document_id: 1 }],
      ["list_tasks", { limit: 25 }],
      ["list_calendar_entries", { from: "2026-01-01", to: "2026-01-02" }],
      ["list_calendars", {}],
      ["list_time_entries", { status: "unbilled", limit: 25 }],
      ["get_time_entry", { activity_id: 1 }],
      ["list_activity_descriptions", { limit: 100 }],
      ["get_billing_summary", { matter_id: 1 }],
      ["list_bills", { limit: 25 }],
      ["list_communications", { limit: 25, full_body: false }],
      ["list_users", { limit: 200 }],
      ["get_user", { user_id: 1 }],
      ["export_audit_log", { limit: 500, offset: 0 }],
    ];

    expect(Object.keys(handlers)).toEqual(expect.arrayContaining(cases.map(([name]) => name)));
    for (const [name, args] of cases) {
      const result = await handlers[name](args);
      expect(result?.isError, name).not.toBe(true);
    }

    expect(mocks.clioGet).toHaveBeenCalledTimes(17);
    expect(mocks.clioPost).not.toHaveBeenCalled();
    expect(mocks.clioPatch).not.toHaveBeenCalled();
    expect(mocks.clioPut).not.toHaveBeenCalled();
    expect(mocks.clearTokens).not.toHaveBeenCalled();
    expect(mocks.sessionClearTokens).not.toHaveBeenCalled();
    expect(mocks.sessionGetTokens).toHaveBeenCalledOnce();
    expect(mocks.loadTokens).not.toHaveBeenCalled();
    expect(mocks.buildAuthorizationUrl).not.toHaveBeenCalled();
    expect(mocks.getValidAccessToken).not.toHaveBeenCalled();
  });
});
