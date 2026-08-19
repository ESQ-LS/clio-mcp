import { afterEach, describe, expect, it } from "vitest";
import { getClioApiBase, getClioOrigin, getClioRegion } from "../clioRegion.js";

const originalApiBase = process.env.CLIO_API_BASE;

afterEach(() => {
  if (originalApiBase === undefined) delete process.env.CLIO_API_BASE;
  else process.env.CLIO_API_BASE = originalApiBase;
});

describe("Clio region routing", () => {
  it.each([
    ["us", "https://app.clio.com"],
    ["ca", "https://ca.app.clio.com"],
    ["eu", "https://eu.app.clio.com"],
    ["au", "https://au.app.clio.com"],
  ])("maps %s to its regional Clio origin", (region, expected) => {
    expect(getClioRegion(region)).toBe(region);
    expect(getClioOrigin(region)).toBe(expected);
  });

  it("fails closed for an unknown region", () => {
    expect(() => getClioRegion("unknown")).toThrow(/Unsupported CLIO_REGION/);
  });

  it("uses an explicit API base override", () => {
    process.env.CLIO_API_BASE = "https://example.invalid/api/v4";
    expect(getClioApiBase()).toBe("https://example.invalid/api/v4");
  });
});
