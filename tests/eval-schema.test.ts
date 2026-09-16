import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const reviewSchema = JSON.parse(readFileSync("data/schema/eval-review.schema.json", "utf8"));
ajv.addSchema(reviewSchema);
const validateReview = ajv.getSchema(reviewSchema.$id);
const validateGold = ajv.compile(JSON.parse(readFileSync("data/schema/eval-consensus.schema.json", "utf8")));
const validateAdjudication = ajv.compile(JSON.parse(readFileSync("data/schema/eval-adjudication.schema.json", "utf8")));
const sha = "0".repeat(64);

function review(): any {
  return {
    schemaVersion: 2,
    reviewId: "review-a",
    candidateSetId: "semantic-eval-candidates-v2",
    candidateManifestSha256: sha,
    reviewerId: "luna-run-a",
    reviewerKind: "model",
    modelIdentity: "openai-codex/gpt-5.6-luna",
    thinking: "high",
    promptVersion: "semantic-labeler-prompt-v2",
    promptSha256: sha,
    rubricVersion: "semantic-model-rubric-v2",
    policySha256: sha,
    completedAt: "2026-01-01T00:00:00Z",
    reviews: [{
      candidateId: "eval-v2-0123456789abcdef",
      sourceToken: sha,
      privacy: { decision: "approved", piiCategories: [] },
      decision: "label",
      categories: ["link"],
      risk: "normal",
      rationale: "The destination and readable label must remain present.",
      label: {
        mode: "semantic",
        assertions: {
          requiredText: ["docs"], forbiddenText: [], requiredUrls: ["https://example.com"], forbiddenUrls: [],
          requiredWarningCodes: [], forbiddenWarningCodes: [], forbidActiveMentions: true
        }
      }
    }]
  };
}

describe("semantic evaluation authority schemas", () => {
  it("accepts an independently authored Luna semantic review", () => {
    expect(validateReview(review())).toBe(true);
  });

  it("forbids labeling a source before privacy approval", () => {
    const invalid = review();
    invalid.reviews[0].privacy.decision = "needs-redaction";
    expect(validateReview(invalid)).toBe(false);
  });

  it("forbids approving a source with residual PII categories", () => {
    const invalid = review();
    invalid.reviews[0].privacy.piiCategories = ["email"];
    expect(validateReview(invalid)).toBe(false);
  });

  it("rejects a vacuous semantic label", () => {
    const invalid = review();
    invalid.reviews[0].label.assertions.requiredText = [];
    invalid.reviews[0].label.assertions.requiredUrls = [];
    invalid.reviews[0].label.assertions.forbidActiveMentions = false;
    expect(validateReview(invalid)).toBe(false);
  });

  it("requires a complete label when Astra authors silver evidence", () => {
    const submission: any = {
      schemaVersion: 2, adjudicationId: "astra-v3-001", candidateSetId: "semantic-eval-candidates-v2",
      candidateManifestSha256: sha, modelIdentity: "openai-codex/gpt-6-astra", thinking: "xhigh",
      promptVersion: "semantic-adjudicator-prompt-v3", promptSha256: sha, policySha256: sha,
      completedAt: "2026-01-01T00:00:00Z",
      decisions: [{ candidateId: "eval-v2-0123456789abcdef", reviewHashes: [sha, "1".repeat(64)], decision: "author", rationale: "Both reviews under-cover the source." }]
    };
    expect(validateAdjudication(submission)).toBe(false);
    submission.decisions[0].categories = ["link"];
    submission.decisions[0].risk = "normal";
    submission.decisions[0].label = review().reviews[0].label;
    expect(validateAdjudication(submission)).toBe(true);
  });

  it("requires two review records for frozen model consensus", () => {
    const gold = {
      schemaVersion: 2,
      id: "eval-v2-0123456789abcdef",
      source: {
        family: "oasst", contentSha256: sha, lineageId: "oasst:1", sourceMarkdown: "Read [docs](https://example.com)",
        provenance: { dataset: "OpenAssistant/oasst1", revision: "v1", upstreamRecordHash: sha, license: "Apache-2.0", privacyState: "model-screened" }
      },
      split: "validation", portfolioBucket: "representative-natural",
      categories: ["link"], risk: "normal", options: {}, label: review().reviews[0].label,
      evidence: { authority: "dual-luna-consensus", rubricVersion: "semantic-model-rubric-v2", reviews: [{ reviewerId: "luna-run-a", modelIdentity: "openai-codex/gpt-5.6-luna", thinking: "high", promptSha256: sha, reviewSha256: sha }], frozenAt: "2026-01-01T00:00:00Z" }
    };
    expect(validateGold(gold)).toBe(false);
    gold.evidence.reviews.push({ reviewerId: "luna-run-b", modelIdentity: "openai-codex/gpt-5.6-luna", thinking: "high", promptSha256: sha, reviewSha256: "1".repeat(64) });
    expect(validateGold(gold)).toBe(true);
  });
});
