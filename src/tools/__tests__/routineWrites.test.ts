import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockClioGet, mockClioPost, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(), mockClioPost: vi.fn(), mockAppendAuditLog: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../utils/clioClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/clioClient.js")>();
  return { ...actual, clioGet: mockClioGet, clioPost: mockClioPost };
});
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));
vi.mock("../../auth/tokenStorage.js", () => ({
  loadTokens: vi.fn(async () => ({ clio_user_id: "100", expires_at: Date.now() + 60000 })),
}));

import { registerCalendarTools } from "../calendar.js";
import { registerCommunicationTools } from "../communications.js";
import { registerNoteTools } from "../notes.js";

function handlersFor(register: (server: any) => void): Record<string, Function> {
  const handlers: Record<string, Function> = {};
  register({ registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } });
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = "1".repeat(64);
  mockAppendAuditLog.mockResolvedValue(true);
});

describe("routine preview-controlled writes", () => {
  it("previews and confirms a matter note without logging its subject or body", async () => {
    mockClioGet.mockResolvedValue({ data: { id: 99, display_number: "00099-001", description: "Synthetic", status: "open" } });
    mockClioPost.mockResolvedValue({ data: { id: 7, subject: "Synthetic note" } });
    const handlers = handlersFor(registerNoteTools);
    const args = { matter_id: 99, subject: "Synthetic note", body: "Privileged synthetic detail" };
    const preview = JSON.parse((await handlers.create_note(args)).content[0].text);
    expect(mockClioPost).not.toHaveBeenCalled();
    await handlers.create_note({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPost).toHaveBeenCalledWith("/notes.json", { data: expect.objectContaining({ subject: "Synthetic note", detail: args.body }) });
    const audit = JSON.stringify(mockAppendAuditLog.mock.calls);
    expect(audit).not.toContain(args.subject);
    expect(audit).not.toContain(args.body);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create_note", confirmation_state: "confirmed", outcome: "attempt",
    }));
  });

  it("reports a failed final audit after a successful note write", async () => {
    mockClioGet.mockResolvedValue({ data: { id: 99, display_number: "00099-001", description: "Synthetic", status: "open" } });
    mockClioPost.mockResolvedValue({ data: { id: 7, subject: "Synthetic note" } });
    const args = { matter_id: 99, subject: "Synthetic note", body: "Synthetic detail" };
    const handler = handlersFor(registerNoteTools).create_note;
    const preview = JSON.parse((await handler(args)).content[0].text);
    mockAppendAuditLog.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await handler({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ success: true, audit_recorded: false });
  });

  it("previews notification consequences before creating a calendar entry", async () => {
    mockClioGet.mockImplementation(async (path: string) => {
      if (path === "/calendars.json") return { data: [{ id: 1, name: "Firm", type: "AccountCalendar" }] };
      if (path === "/matters/99.json") return { data: { id: 99, display_number: "00099-001", description: "Synthetic", status: "open" } };
      if (path === "/contacts/42.json") return { data: {
        id: 42, name: "Synthetic Client", type: "Person",
        email_addresses: [{ address: "synthetic@example.test", name: "Work", default_email: true }],
      } };
      if (path === "/calendars/43.json") return { data: { id: 43, name: "Synthetic Lawyer", type: "UserCalendar" } };
      throw new Error(`unexpected path ${path}`);
    });
    mockClioPost.mockResolvedValue({ data: { id: 8, summary: "Synthetic hearing", attendees: [] } });
    const handlers = handlersFor(registerCalendarTools);
    const args = {
      summary: "Synthetic hearing", start_at: "2026-11-01T09:00", end_at: "2026-11-01T10:00",
      calendar_owner_id: 1, matter_id: 99,
      attendees: [{ id: 42, type: "Contact" }, { id: 43, type: "Calendar" }],
      send_email_notification: true,
    };
    const preview = JSON.parse((await handlers.create_calendar_entry(args)).content[0].text);
    expect(preview.proposal.event).toMatchObject({
      notify_firm_attendees_by_email: true,
      external_contact_email_will_be_sent: true,
    });
    expect(preview.proposal.attendees[0].email_notification).toMatchObject({
      will_send: true, mandatory: true, recipient: "synthetic@example.test",
    });
    expect(mockClioPost).not.toHaveBeenCalled();
    await handlers.create_calendar_entry({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPost).toHaveBeenCalledWith("/calendar_entries.json", { data: expect.objectContaining({
      attendees: args.attendees,
    }) });
    expect(mockClioGet).toHaveBeenCalledWith("/calendars.json", {
      "ids[]": "1", writeable: "true", fields: "id,name,type", limit: "1",
    });
    expect(JSON.stringify(mockAppendAuditLog.mock.calls)).not.toContain(args.summary);
  });

  it("reports a failed final audit after a successful calendar write", async () => {
    mockClioGet.mockResolvedValue({ data: [{ id: 1, name: "Firm", type: "AccountCalendar" }] });
    mockClioPost.mockResolvedValue({ data: { id: 8, summary: "Synthetic hearing", attendees: [] } });
    const args = { summary: "Synthetic hearing", start_at: "2026-11-01T09:00", end_at: "2026-11-01T10:00", calendar_owner_id: 1 };
    const handler = handlersFor(registerCalendarTools).create_calendar_entry;
    const preview = JSON.parse((await handler(args)).content[0].text);
    mockAppendAuditLog.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await handler({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text).audit_recorded).toBe(false);
  });

  it("rejects duplicate or excessive calendar attendees before API validation", async () => {
    const handlers = handlersFor(registerCalendarTools);
    const base = {
      summary: "Synthetic hearing", start_at: "2026-11-01T09:00", end_at: "2026-11-01T10:00",
      calendar_owner_id: 1,
    };
    expect((await handlers.create_calendar_entry({
      ...base, attendees: [{ id: 42, type: "Contact" }, { id: 42, type: "Contact" }],
    })).isError).toBe(true);
    expect((await handlers.create_calendar_entry({
      ...base, attendees: Array.from({ length: 21 }, (_, index) => ({ id: index + 1, type: "Contact" })),
    })).isError).toBe(true);
    expect(mockClioGet).not.toHaveBeenCalled();
  });

  it("refuses to preview a calendar entry unless the owner calendar is writable", async () => {
    mockClioGet.mockResolvedValue({ data: [] });
    const result = await handlersFor(registerCalendarTools).create_calendar_entry({
      summary: "Synthetic hearing", start_at: "2026-11-01T09:00", end_at: "2026-11-01T10:00",
      calendar_owner_id: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Calendar validation failed");
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("logs a communication without sending an external message", async () => {
    mockClioGet.mockImplementation(async (path: string) => {
      if (path === "/matters/99.json") return { data: { id: 99, display_number: "00099-001", description: "Synthetic", status: "open" } };
      if (path === "/users/42.json") return { data: { id: 42, name: "Synthetic Lawyer" } };
      if (path === "/contacts/77.json") return { data: { id: 77, name: "Synthetic Client" } };
      throw new Error(`unexpected path ${path}`);
    });
    mockClioPost.mockResolvedValue({ data: { id: 9, subject: "Synthetic call" } });
    const handlers = handlersFor(registerCommunicationTools);
    const args = { matter_id: 99, type: "PhoneCommunication", subject: "Synthetic call", body: "Synthetic summary", received_at: "2026-10-23T10:00:00-04:00", senders: [{ id: 42, type: "User" }], receivers: [{ id: 77, type: "Contact" }] };
    const preview = JSON.parse((await handlers.create_communication(args)).content[0].text);
    expect(preview.proposal.sends_external_message).toBe(false);
    await handlers.create_communication({ ...args, confirm_write: true, preview_token: preview.preview_token });
    expect(mockClioPost).toHaveBeenCalledWith("/communications.json", { data: expect.objectContaining({ matter: { id: 99 }, type: "PhoneCommunication" }) });
    const audit = JSON.stringify(mockAppendAuditLog.mock.calls);
    expect(audit).not.toContain(args.subject);
    expect(audit).not.toContain(args.body);
  });

  it("validates each distinct communication participant only once per request", async () => {
    mockClioGet.mockImplementation(async (path: string) => {
      if (path === "/matters/99.json") return { data: { id: 99, display_number: "00099-001", description: "Synthetic", status: "open" } };
      if (path === "/users/42.json") return { data: { id: 42, name: "Synthetic Lawyer" } };
      if (path === "/contacts/77.json") return { data: { id: 77, name: "Synthetic Client" } };
      throw new Error(`unexpected path ${path}`);
    });
    const handlers = handlersFor(registerCommunicationTools);
    await handlers.create_communication({
      matter_id: 99,
      type: "EmailCommunication",
      subject: "Synthetic email",
      body: "Synthetic summary",
      received_at: "2026-10-23T10:00:00-04:00",
      senders: [{ id: 42, type: "User" }, { id: 42, type: "User" }],
      receivers: [{ id: 77, type: "Contact" }, { id: 42, type: "User" }, { id: 77, type: "Contact" }],
    });
    expect(mockClioGet.mock.calls.filter(([path]) => path === "/users/42.json")).toHaveLength(1);
    expect(mockClioGet.mock.calls.filter(([path]) => path === "/contacts/77.json")).toHaveLength(1);
  });
});
