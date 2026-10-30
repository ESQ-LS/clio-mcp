import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockClioGet, mockClioPost, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(),
  mockClioPost: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../utils/clioClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/clioClient.js")>();
  return { ...actual, clioGet: mockClioGet, clioPost: mockClioPost };
});
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));
vi.mock("../../auth/tokenStorage.js", () => ({
  loadTokens: vi.fn(async () => ({ clio_user_id: "100", expires_at: Date.now() + 60000 })),
}));

import { registerCalendarTools, toIso } from "../calendar.js";

function getHandlers(): Record<string, Function> {
  const handlers: Record<string, Function> = {};
  registerCalendarTools({
    registerTool: (name: string, _schema: unknown, handler: Function) => { handlers[name] = handler; },
  } as any);
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = "1".repeat(64);
  mockAppendAuditLog.mockResolvedValue(true);
});

describe("toIso", () => {
  describe("date-only input", () => {
    it("expands to start of day by default", () => {
      expect(toIso("2026-06-01")).toBe("2026-06-01T00:00:00");
    });

    it("expands to end of day when endOfDay=true", () => {
      expect(toIso("2026-06-01", true)).toBe("2026-06-01T23:59:59");
    });
  });

  describe("date+HH:MM input", () => {
    it("pads seconds", () => {
      expect(toIso("2026-06-01T09:00")).toBe("2026-06-01T09:00:00");
    });

    it("endOfDay flag is ignored when time is present", () => {
      expect(toIso("2026-06-01T09:00", true)).toBe("2026-06-01T09:00:00");
    });
  });

  describe("date+HH:MM:SS input", () => {
    it("passes through unchanged", () => {
      expect(toIso("2026-06-01T09:00:00")).toBe("2026-06-01T09:00:00");
    });

    it("endOfDay flag is ignored when time is present", () => {
      expect(toIso("2026-06-01T09:00:00", true)).toBe("2026-06-01T09:00:00");
    });
  });
});

describe("controlled calendar writes", () => {
  it("discloses mandatory external email even when firm notifications are disabled", async () => {
    let contactHasEmail = true;
    mockClioGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === "/calendars.json") return { data: [{ id: 10, name: "Synthetic Calendar", type: "UserCalendar" }] };
      if (requestPath === "/contacts/20.json") return { data: {
        id: 20,
        name: "Synthetic Contact",
        type: "Person",
        email_addresses: contactHasEmail
          ? [{ address: "synthetic@example.test", name: "Work", default_email: true }]
          : [],
      } };
      throw new Error(`unexpected path ${requestPath}`);
    });
    const result = await getHandlers().create_calendar_entry({
      summary: "Synthetic meeting",
      start_at: "2026-11-01T09:00",
      end_at: "2026-11-01T10:00",
      calendar_owner_id: 10,
      send_email_notification: false,
      attendees: [{ id: 20, type: "Contact" }],
    });
    const preview = JSON.parse(result.content[0].text);
    expect(preview.proposal.event).toMatchObject({
      notify_firm_attendees_by_email: false,
      external_contact_email_will_be_sent: true,
    });
    expect(preview.proposal.event).not.toHaveProperty("send_email_notification");
    expect(preview.proposal.attendees[0].email_notification).toEqual({
      will_send: true,
      mandatory: true,
      recipient: "synthetic@example.test",
      reason: "Clio always emails Contact attendees with a valid email address.",
    });
    expect(mockClioPost).not.toHaveBeenCalled();

    contactHasEmail = false;
    const confirmation = await getHandlers().create_calendar_entry({
      summary: "Synthetic meeting",
      start_at: "2026-11-01T09:00",
      end_at: "2026-11-01T10:00",
      calendar_owner_id: 10,
      send_email_notification: false,
      attendees: [{ id: 20, type: "Contact" }],
      confirm_write: true,
      preview_token: preview.preview_token,
    });
    expect(confirmation.isError).toBe(true);
    expect(confirmation.content[0].text).toContain("proposal changed");
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("discloses the unique default Contact email rather than the first address", async () => {
    mockClioGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === "/calendars.json") return { data: [{ id: 10, name: "Synthetic Calendar", type: "UserCalendar" }] };
      if (requestPath === "/contacts/20.json") return { data: {
        id: 20, name: "Synthetic Contact", type: "Person",
        email_addresses: [
          { address: "secondary@example.test", name: "Other", default_email: false },
          { address: "default@example.test", name: "Work", default_email: true },
        ],
      } };
      throw new Error(`unexpected path ${requestPath}`);
    });
    const result = await getHandlers().create_calendar_entry({
      summary: "Synthetic meeting", start_at: "2026-11-01T09:00", end_at: "2026-11-01T10:00",
      calendar_owner_id: 10, attendees: [{ id: 20, type: "Contact" }],
    });
    const preview = JSON.parse(result.content[0].text);
    expect(preview.proposal.attendees[0].email_notification.recipient).toBe("default@example.test");
    expect(preview.proposal.attendees[0].email_notification.recipient).not.toBe("secondary@example.test");
  });

  it("rejects ambiguous Contact default-email responses before preview authorization", async () => {
    mockClioGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === "/calendars.json") return { data: [{ id: 10, name: "Synthetic Calendar", type: "UserCalendar" }] };
      if (requestPath === "/contacts/20.json") return { data: {
        id: 20, name: "Synthetic Contact", type: "Person",
        email_addresses: [
          { address: "first@example.test", default_email: true },
          { address: "second@example.test", default_email: true },
        ],
      } };
      throw new Error(`unexpected path ${requestPath}`);
    });
    const result = await getHandlers().create_calendar_entry({
      summary: "Synthetic meeting", start_at: "2026-11-01T09:00", end_at: "2026-11-01T10:00",
      calendar_owner_id: 10, attendees: [{ id: 20, type: "Contact" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exactly one usable default email address");
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("rejects nonexistent calendar dates and times before API validation", async () => {
    const handlers = getHandlers();
    for (const [start_at, end_at] of [
      ["2026-13-01T09:00", "2026-13-01T10:00"],
      ["2026-02-31T09:00", "2026-02-31T10:00"],
      ["2026-11-01T25:00", "2026-11-01T26:00"],
    ]) {
      const result = await handlers.create_calendar_entry({
        summary: "Synthetic meeting", start_at, end_at, calendar_owner_id: 10,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("real local dates or datetimes");
    }
    expect(mockClioGet).not.toHaveBeenCalled();
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("rejects calendar entries with non-positive time ranges before API validation", async () => {
    const handlers = getHandlers();
    for (const [start_at, end_at] of [
      ["2026-11-01T10:00", "2026-11-01T09:00"],
      ["2026-11-01T10:00", "2026-11-01T10:00"],
    ]) {
      const result = await handlers.create_calendar_entry({
        summary: "Synthetic meeting", start_at, end_at, calendar_owner_id: 10,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("end_at must be later than start_at");
    }
    expect(mockClioGet).not.toHaveBeenCalled();
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("rejects dates before Clio's 1900 persistence floor", async () => {
    const result = await getHandlers().create_calendar_entry({
      summary: "Historical synthetic event",
      start_at: "1899-12-31T09:00",
      end_at: "1900-01-01T10:00",
      calendar_owner_id: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("on or after 1900-01-01");
    expect(mockClioGet).not.toHaveBeenCalled();
    expect(mockClioPost).not.toHaveBeenCalled();
  });
});
