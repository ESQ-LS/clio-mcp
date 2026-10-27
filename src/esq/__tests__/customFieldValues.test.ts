import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockClioGet } = vi.hoisted(() => ({ mockClioGet: vi.fn() }));
vi.mock("../../utils/clioClient.js", () => ({ clioGet: mockClioGet }));

import { resolveCustomFieldValueDetails } from "../customFieldValues.js";

beforeEach(() => vi.clearAllMocks());

describe("custom-field reference validation", () => {
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
});
