import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockClioGet } = vi.hoisted(() => ({ mockClioGet: vi.fn() }));
vi.mock("../../utils/clioClient.js", () => ({ clioGet: mockClioGet }));

import {
  buildNewCustomFieldValues,
  buildUpdatedCustomFieldValues,
  resolveCustomFieldValueDetails,
} from "../customFieldValues.js";

beforeEach(() => vi.clearAllMocks());

describe("custom-field reference validation", () => {
  it("preserves checkbox booleans in previews and create/update payloads", async () => {
    mockClioGet.mockResolvedValue({ data: {
      id: 9, name: "Synthetic checkbox", field_type: "checkbox", parent_type: "Contact",
    } });
    await expect(resolveCustomFieldValueDetails([
      { custom_field_id: 9, value: false },
    ], "Contact")).resolves.toEqual([expect.objectContaining({ value: false })]);
    expect(buildNewCustomFieldValues([
      { custom_field_id: 9, value: true },
    ])).toEqual([{ custom_field: { id: 9 }, value: true }]);
    expect(buildUpdatedCustomFieldValues(
      [{ custom_field_id: 9, value: false }],
      [{ id: "checkbox-9", custom_field: { id: 9 } }],
    )).toEqual([{ id: "checkbox-9", value: false }]);
  });

  it("resolves picklist, contact, and matter values into signed preview details", async () => {
    mockClioGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === "/custom_fields/1.json") return { data: {
        id: 1, name: "Source", field_type: "picklist", parent_type: "Contact",
        picklist_options: [{ id: 11, option: "Referral" }],
      } };
      if (requestPath === "/custom_fields/2.json") return { data: {
        id: 2, name: "Related contact", field_type: "contact", parent_type: "Contact",
      } };
      if (requestPath === "/custom_fields/3.json") return { data: {
        id: 3, name: "Related matter", field_type: "matter", parent_type: "Contact",
      } };
      if (requestPath === "/contacts/21.json") return { data: {
        id: 21, name: "Synthetic Contact", type: "Person",
      } };
      if (requestPath === "/matters/31.json") return { data: {
        id: 31, display_number: "SYN-0031", description: "Synthetic matter", status: "open",
      } };
      throw new Error(`unexpected path ${requestPath}`);
    });

    const details = await resolveCustomFieldValueDetails([
      { custom_field_id: 1, value: 11 },
      { custom_field_id: 2, value: 21 },
      { custom_field_id: 3, value: 31 },
    ], "Contact");

    expect(details.map((detail) => detail.resolved_value)).toEqual([
      { id: 11, label: "Referral" },
      { id: 21, label: "Synthetic Contact", type: "Person" },
      { id: 31, label: "SYN-0031", description: "Synthetic matter", status: "open" },
    ]);
  });

  it("rejects definitions for the wrong parent and unknown picklist options", async () => {
    mockClioGet.mockResolvedValueOnce({ data: {
      id: 1, name: "Wrong parent", field_type: "text_line", parent_type: "Matter",
    } });
    await expect(resolveCustomFieldValueDetails([
      { custom_field_id: 1, value: "text" },
    ], "Contact")).rejects.toThrow("does not belong to Contact records");

    mockClioGet.mockResolvedValueOnce({ data: {
      id: 2, name: "Source", field_type: "picklist", parent_type: "Contact",
      picklist_options: [{ id: 20, option: "Known" }],
    } });
    await expect(resolveCustomFieldValueDetails([
      { custom_field_id: 2, value: 999 },
    ], "Contact")).rejects.toThrow("does not belong to custom field 2");
  });

  it("rejects an unresolvable reference before preview authorization", async () => {
    mockClioGet.mockImplementation(async (requestPath: string) => {
      if (requestPath === "/custom_fields/4.json") return { data: {
        id: 4, name: "Related contact", field_type: "contact", parent_type: "Matter",
      } };
      if (requestPath === "/contacts/44.json") return { data: { id: 45, name: "Different contact" } };
      throw new Error(`unexpected path ${requestPath}`);
    });
    await expect(resolveCustomFieldValueDetails([
      { custom_field_id: 4, value: 44 },
    ], "Matter")).rejects.toThrow("could not be validated");
  });

  it("validates scalar values against each custom-field definition", async () => {
    const cases = [
      { field_type: "text_line", valid: "Synthetic code", invalid: "two\nlines" },
      { field_type: "text_area", valid: "Synthetic\nnotes", invalid: 42 },
      { field_type: "numeric", valid: "42", invalid: "4.2" },
      { field_type: "currency", valid: "42.50", invalid: "forty" },
      { field_type: "date", valid: "2026-02-28", invalid: "2026-02-31" },
      { field_type: "time", valid: "23:59:30", invalid: "25:00" },
      { field_type: "checkbox", valid: true, invalid: "true" },
      { field_type: "email", valid: "synthetic@example.test", invalid: "not-an-email" },
      { field_type: "url", valid: "https://example.test/path", invalid: "not a url" },
    ];
    for (const [index, testCase] of cases.entries()) {
      const id = index + 100;
      mockClioGet.mockResolvedValue({ data: {
        id, name: `Synthetic ${testCase.field_type}`, field_type: testCase.field_type, parent_type: "Contact",
      } });
      await expect(resolveCustomFieldValueDetails([
        { custom_field_id: id, value: testCase.valid },
      ], "Contact")).resolves.toHaveLength(1);
      await expect(resolveCustomFieldValueDetails([
        { custom_field_id: id, value: testCase.invalid },
      ], "Contact")).rejects.toThrow();
    }
  });

  it.each([1.234, "1.234"])("rejects currency precision beyond two decimal places: %s", async (value) => {
    mockClioGet.mockResolvedValue({ data: {
      id: 201, name: "Synthetic amount", field_type: "currency", parent_type: "Contact",
    } });
    await expect(resolveCustomFieldValueDetails([
      { custom_field_id: 201, value },
    ], "Contact")).rejects.toThrow("at most two decimal places");
  });

  it.each([
    ["text_line", "x".repeat(256), "at most 255 characters"],
    ["text_area", "x".repeat(64_001), "at most 64000 characters"],
  ])("rejects overlong %s values", async (fieldType, value, message) => {
    mockClioGet.mockResolvedValue({ data: {
      id: 202, name: "Synthetic text", field_type: fieldType, parent_type: "Contact",
    } });
    await expect(resolveCustomFieldValueDetails([
      { custom_field_id: 202, value },
    ], "Contact")).rejects.toThrow(message);
  });

  it("rejects unsupported custom-field types before preview authorization", async () => {
    mockClioGet.mockResolvedValue({ data: {
      id: 200, name: "Synthetic unknown", field_type: "future_type", parent_type: "Contact",
    } });
    await expect(resolveCustomFieldValueDetails([
      { custom_field_id: 200, value: "synthetic" },
    ], "Contact")).rejects.toThrow("Unsupported custom field type");
  });

  it("bounds concurrent definition and reference lookups", async () => {
    let active = 0;
    let peak = 0;
    mockClioGet.mockImplementation(async (requestPath: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      const id = Number(requestPath.match(/\d+/)?.[0]);
      if (requestPath.startsWith("/custom_fields/")) return { data: {
        id, name: `Synthetic field ${id}`, field_type: "contact", parent_type: "Matter",
      } };
      return { data: { id, name: `Synthetic contact ${id}`, type: "Person" } };
    });
    const requests = Array.from({ length: 12 }, (_, index) => ({
      custom_field_id: index + 1,
      value: index + 101,
    }));
    await expect(resolveCustomFieldValueDetails(requests, "Matter")).resolves.toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
