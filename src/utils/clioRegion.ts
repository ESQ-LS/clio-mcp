export type ClioRegion = "us" | "ca" | "eu" | "au";

const CLIO_ORIGINS: Record<ClioRegion, string> = {
  us: "https://app.clio.com",
  ca: "https://ca.app.clio.com",
  eu: "https://eu.app.clio.com",
  au: "https://au.app.clio.com",
};

export function getClioRegion(raw = process.env.CLIO_REGION): ClioRegion {
  const region = (raw ?? "us").trim().toLowerCase();
  if (region in CLIO_ORIGINS) return region as ClioRegion;
  throw new Error(
    `Unsupported CLIO_REGION "${region}". Expected one of: us, ca, eu, au.`,
  );
}

export function getClioOrigin(raw = process.env.CLIO_REGION): string {
  return CLIO_ORIGINS[getClioRegion(raw)];
}

export function getClioApiBase(): string {
  return process.env.CLIO_API_BASE?.trim() || `${getClioOrigin()}/api/v4`;
}
