import { describe, expect, it, vi } from "vitest";
import { intelligenceInputSchemas, analysisRunViewSchema } from "@/lib/contracts/intelligence";
import { DEFAULT_SETTINGS } from "@/lib/contracts/records";
import { boundedStage } from "@/lib/server/ai/backboard";
import { aiCapabilityFlags, validateAiConfig } from "@/lib/server/ai/config";
import { normalizeDatePhrase, normalizeExtraction } from "@/lib/server/ai/normalize";
import { aiRunRecordSchema, assertRunReplay, effectiveRunState, runStatusView } from "@/lib/server/ai/runs";
import { jevResultSchema, validateExtractionEvidence } from "@/lib/server/ai/schemas";

const env = { BACKBOARD_API_KEY: "synthetic", GEMMA_PROVIDER: "google", GEMMA_MODEL: "gemma-3-27b-it", JEV_MODEL: "jev-1.13.0" };
const candidate = { kind: "quantity_change" as const, evidence: [{ start: 0, end: 17, quote: "only one tomorrow" }], datePhrase: "tomorrow", endDatePhrase: null, quantity: 1, missingFields: [] };
const source = { text: "only one tomorrow", customerId: "customer-a", sentAt: "2026-10-01T19:00:00Z" };
function savedRun() {
  return aiRunRecordSchema.parse({ _id: "run-a", runId: "run-a", sellerId: "seller-a", requestKey: "request-a", payloadHash: "a".repeat(64),
    sourceId: "source-a", sourceRevision: 0, expectedStateRevision: 2, stateRevision: null, capturedDraftHash: "drafts", capturedPlanHash: "plans",
    state: "running", stage: "gemma", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", deadline: "2026-10-01T00:00:45Z", completedAt: null, retryOfRunId: null, unknownSpend: false,
    proposalIds: [], classificationId: null, providerIds: [{ stage: "gemma", threadId: "private-thread" }], extraction: null, classification: null,
    extractionAvailable: false, models: { gemmaProvider: "google", gemmaRequested: "gemma-3-27b-it", gemmaResolved: null, jevRequested: "jev-1.13.0", jevResolved: null },
    promptVersion: "source-drafts-v1", schemaVersion: 1, usage: { gemma: null, jev: null }, warnings: [], error: null });
}
describe("AI safety and public contracts", () => {
  it("requires trusted revisions, consent, strict meta and fresh retry acknowledgement syntax", () => {
    const input = { sourceId: "source-a", expectedSourceRevision: 0, expectedStateRevision: 2, consentAcknowledged: true, meta: { idempotencyKey: "analysis-key" } };
    expect(intelligenceInputSchemas.analyzeSource.safeParse(input).success).toBe(true);
    for (const invalid of [{ ...input, consentAcknowledged: false }, { ...input, sellerId: "foreign" }, { ...input, meta: { ...input.meta, userId: "foreign" } }, { ...input, expectedStateRevision: undefined }]) expect(intelligenceInputSchemas.analyzeSource.safeParse(invalid).success).toBe(false);
    expect(intelligenceInputSchemas.getAnalysis.safeParse({ runId: "by-key" }).success).toBe(false);
  });
  it("requires real Gemma names and pinned JEV models without accidental defaults", () => {
    for (const invalid of [{}, { ...env, GEMMA_MODEL: "gpt-4o" }, { ...env, GEMMA_PROVIDER: "" }, { ...env, JEV_MODEL: "jev-latest" }, { ...env, AI_DAILY_REQUEST_LIMIT: "-1" }]) expect(() => validateAiConfig(invalid)).toThrow();
    expect(validateAiConfig({ ...env, AI_DAILY_REQUEST_LIMIT: " " }).dailyRequestLimit).toBe(8);
    expect(aiCapabilityFlags({}).ai.configured).toBe(false);
    expect(JSON.stringify(aiCapabilityFlags(env))).not.toContain("synthetic");
  });
  it("uses original timestamp in seller timezone, never evaluation time, and blocks vague dates", () => {
    expect(normalizeDatePhrase("today", source.sentAt, "Asia/Kolkata")).toBe("2026-10-02");
    expect(normalizeDatePhrase("tomorrow", source.sentAt, "Asia/Kolkata")).toBe("2026-10-03");
    expect(normalizeDatePhrase("2026-10-05", source.sentAt, "Asia/Kolkata")).toBe("2026-10-05");
    for (const phrase of ["next week", "soon", "10/05", "2026-02-30"]) expect(normalizeDatePhrase(phrase, source.sentAt, "Asia/Kolkata")).toBeNull();
  });
  it("deduplicates repeated operations and only creates review drafts", () => {
    const drafts = normalizeExtraction({ candidates: [candidate, candidate], clarification: null }, source, { ...DEFAULT_SETTINGS, weekdays: [1, 2, 3, 4, 5, 6, 7] });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].operations).toEqual([{ type: "set_daily_quantity", customerId: "customer-a", serviceDate: "2026-10-03", quantity: 1 }]);
    expect(drafts[0]).not.toHaveProperty("approvalId");
    const vague = normalizeExtraction({ candidates: [{ ...candidate, datePhrase: "soon" }], clarification: null }, source, DEFAULT_SETTINGS);
    expect(vague[0].operations).toEqual([]);
    expect(vague[0].missingFields).toContain("exact_service_dates");
  });
  it("rejects evidence outside original text and invented normalized date phrases", () => {
    expect(() => validateExtractionEvidence({ candidates: [candidate], clarification: null }, source.text)).not.toThrow();
    expect(() => validateExtractionEvidence({ candidates: [{ ...candidate, datePhrase: "2026-10-03" }], clarification: null }, source.text)).toThrow();
    expect(() => validateExtractionEvidence({ candidates: [{ ...candidate, evidence: [{ start: 0, end: 100, quote: source.text }] }], clarification: null }, source.text)).toThrow();
    expect(() => validateExtractionEvidence({ candidates: [{ ...candidate, evidence: [{ start: 0, end: 16, quote: source.text }] }], clarification: null }, source.text)).toThrow();
  });
  it("requires finite probabilities and returned Score legends rather than guessed percentages", () => {
    expect(jevResultSchema.safeParse({ model: "jev-1.13.0", answers: { intent: { type: "choice", choice: "pause", probabilities: { pause: Number.NaN }, confidence: 1 } } }).success).toBe(false);
  });
  it("reads expired executions as unknown without mutating stored records or revealing provider IDs", () => {
    const run = savedRun();
    const before = JSON.stringify(run);
    expect(effectiveRunState(run, Date.parse(run.deadline))).toBe("unknown");
    const view = runStatusView(run, Date.parse(run.deadline));
    expect(view.unknownSpend).toBe(true);
    expect(analysisRunViewSchema.safeParse(view).success).toBe(true);
    expect(JSON.stringify(run)).toBe(before);
    expect(JSON.stringify(view)).not.toContain("private-thread");
    for (const key of ["providerIds", "sellerId", "payloadHash", "extraction", "classification"]) expect(view).not.toHaveProperty(key);
  });
  it("same durable key returns the saved state; changed payload conflicts", () => {
    const run = savedRun();
    expect(assertRunReplay(run, run.payloadHash).runId).toBe("run-a");
    expect(() => assertRunReplay(run, "b".repeat(64))).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT", status: 409 }));
  });
  it("bounds waiting once without pretending to cancel or repeating uncertain work", async () => {
    vi.useFakeTimers();
    try {
      const provider = vi.fn(() => new Promise<never>(() => {}));
      const result = expect(boundedStage(provider(), 20000)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", unknownOutcome: true });
      await vi.advanceTimersByTimeAsync(20000);
      await result;
      expect(provider).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
