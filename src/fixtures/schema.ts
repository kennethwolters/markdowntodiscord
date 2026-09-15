export const fixtureLabelOrigins = ["spec", "policy", "observed", "human", "synthetic"] as const;
export const fixtureRisks = ["normal", "lossy", "unsafe"] as const;

export type FixtureLabelOrigin = typeof fixtureLabelOrigins[number];
export type FixtureRisk = typeof fixtureRisks[number];

export interface FixtureProvenance {
  sourceUrl: string;
  license: string;
  version?: string;
  commit?: string;
  upstreamId?: string | number;
  derivedFrom?: string;
}

export interface BenchmarkFixture {
  schemaVersion: 1;
  id: string;
  sourceMarkdown: string;
  expectedDiscordMessages: string[];
  categories: string[];
  risk: FixtureRisk;
  labelOrigin: FixtureLabelOrigin;
  provenance: FixtureProvenance;
  options?: {
    maxMessageLength?: number;
    neutralizeMentions?: boolean;
  };
  expectedWarningCodes?: string[];
  notes?: string;
}

export function validateBenchmarkFixture(value: unknown): BenchmarkFixture {
  const errors: string[] = [];
  if (!isObject(value)) throw new TypeError("Fixture must be an object");
  rejectUnknown(value, ["schemaVersion", "id", "sourceMarkdown", "expectedDiscordMessages", "categories", "risk", "labelOrigin", "provenance", "options", "expectedWarningCodes", "notes"], "fixture", errors);
  if (value.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  requiredString(value, "id", errors);
  requiredString(value, "sourceMarkdown", errors, true);
  stringArray(value, "expectedDiscordMessages", errors, { allowEmptyArray: false, nonEmptyItems: false, unique: false });
  stringArray(value, "categories", errors, { allowEmptyArray: false, nonEmptyItems: true, unique: true });
  if (!fixtureRisks.includes(value.risk as FixtureRisk)) errors.push(`risk must be one of ${fixtureRisks.join(", ")}`);
  if (!fixtureLabelOrigins.includes(value.labelOrigin as FixtureLabelOrigin)) errors.push(`labelOrigin must be one of ${fixtureLabelOrigins.join(", ")}`);

  if (!isObject(value.provenance)) errors.push("provenance must be an object");
  else {
    rejectUnknown(value.provenance, ["sourceUrl", "license", "version", "commit", "upstreamId", "derivedFrom"], "provenance", errors);
    requiredString(value.provenance, "sourceUrl", errors);
    requiredString(value.provenance, "license", errors);
    optionalString(value.provenance, "version", errors);
    optionalString(value.provenance, "commit", errors);
    optionalString(value.provenance, "derivedFrom", errors);
    if (value.provenance.upstreamId != null && typeof value.provenance.upstreamId !== "string" && typeof value.provenance.upstreamId !== "number") {
      errors.push("provenance.upstreamId must be a string or number");
    }
  }

  if (value.options != null) {
    if (!isObject(value.options)) errors.push("options must be an object");
    else {
      rejectUnknown(value.options, ["maxMessageLength", "neutralizeMentions"], "options", errors);
      if (value.options.maxMessageLength != null && (!Number.isInteger(value.options.maxMessageLength) || Number(value.options.maxMessageLength) < 32)) {
        errors.push("options.maxMessageLength must be an integer of at least 32");
      }
      if (value.options.neutralizeMentions != null && typeof value.options.neutralizeMentions !== "boolean") {
        errors.push("options.neutralizeMentions must be boolean");
      }
    }
  }
  if (value.expectedWarningCodes != null) stringArray(value, "expectedWarningCodes", errors, { allowEmptyArray: true, nonEmptyItems: true, unique: true });
  optionalString(value, "notes", errors);

  if (errors.length) throw new TypeError(`Invalid fixture ${typeof value.id === "string" ? value.id : "<unknown>"}: ${errors.join("; ")}`);
  return value as unknown as BenchmarkFixture;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value: Record<string, unknown>, key: string, errors: string[], allowEmpty = false): void {
  if (typeof value[key] !== "string" || (!allowEmpty && value[key].length === 0)) errors.push(`${key} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
}
function optionalString(value: Record<string, unknown>, key: string, errors: string[]): void {
  if (value[key] != null && typeof value[key] !== "string") errors.push(`${key} must be a string when present`);
}
function stringArray(
  value: Record<string, unknown>,
  key: string,
  errors: string[],
  rules: { allowEmptyArray: boolean; nonEmptyItems: boolean; unique: boolean }
): void {
  const item = value[key];
  if (!Array.isArray(item) || (!rules.allowEmptyArray && item.length === 0) || item.some((entry) => typeof entry !== "string" || (rules.nonEmptyItems && entry.length === 0))) {
    errors.push(`${key} must be ${rules.allowEmptyArray ? "an" : "a non-empty"} array of ${rules.nonEmptyItems ? "non-empty " : ""}strings`);
    return;
  }
  if (rules.unique && new Set(item).size !== item.length) errors.push(`${key} must contain unique values`);
}
function rejectUnknown(value: Record<string, unknown>, allowed: string[], path: string, errors: string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) errors.push(`${path} contains unknown properties: ${unknown.join(", ")}`);
}
