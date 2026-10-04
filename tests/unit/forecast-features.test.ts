import { describe, expect, it } from "vitest";
import { FEATURE_NAMES, type AcceptedHistory, type HistoryRow } from "@/lib/contracts/history";
import type { Source } from "@/lib/contracts/records";
import { availableHistory, buildFeatureRow, historicalFeatures, messageFeatures, recentDeltas } from "@/lib/server/forecasting/features";

const origin = { serviceDate: "2026-01-08", asOf: "2026-01-08T09:00:00Z", policyHash: "a".repeat(64), evidenceMode: "synthetic_demo" };
function entry(date: string, delta: number, available: string = `${date}T10:00:00Z`): AcceptedHistory {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  const row: HistoryRow = { schemaVersion: 1, serviceDate: date, timezone: "UTC", policyHash: origin.policyHash, asOf: `${date}T09:00:00Z`, cutoffAt: `${date}T10:00:00Z`, outcomeAvailableAt: available, confirmedMeals: 10, cutoffTotal: 10 + delta, features: [weekday, 60, 10, 10, 2, null, null, null, null, null, 0, 999, 999, 0], evidenceMode: "synthetic_demo", provenance: { kind: "synthetic", reference: "fixture", complete: true, snapshotEvidenceAt: `${date}T09:00:00Z`, cutoffEvidenceAt: `${date}T10:00:00Z`, messageFeatures: "missing", messageEvidenceAt: null } };
  return { _id: date, sellerId: "s", snapshotId: `snapshot_${date}`, outcomeId: `outcome_${date}`, createdAt: "2026-01-09T00:00:00Z", historyVersion: 1, active: true, supersedesIds: [], importId: "i", row };
}
function source(overrides: Partial<Source> = {}): Source {
  return { _id: "source", sellerId: "s", schemaVersion: 1, createdAt: "2026-01-08T08:00:00Z", receivedAt: "2026-01-08T08:00:00Z", sentAt: "2026-01-01T00:00:00Z", text: "synthetic", customerId: null, revision: 0, status: "needs_review", deferredDate: null, fingerprint: "fixture", channel: "manual", upstreamId: null, replacesSourceId: null, dispositionReason: null, ...overrides };
}
describe("forecast availability and deterministic counts", () => {
  it("pins the complete 14-column order", () => {
    expect(FEATURE_NAMES).toEqual(["weekday", "minutesToCutoff", "baselineMeals", "confirmedMeals", "activeCustomers", "receivedSourceCount", "pauseIntentCount", "resumeIntentCount", "quantityChangeIntentCount", "unclearSourceCount", "pendingChangeCount", "recentMeanDelta", "recentSameWeekdayDelta", "messageFeaturesAvailable"]);
  });
  it("excludes same-day targets, later-available outcomes, corrections and foreign policies", () => {
    const valid = entry("2026-01-01", 2);
    const laterOutcome = entry("2026-01-02", 8, "2026-01-09T10:00:00Z");
    const correction = { ...entry("2026-01-03", 7), supersedesIds: ["old"] };
    const wrongPolicy = entry("2026-01-04", 9); wrongPolicy.row.policyHash = "b".repeat(64);
    expect(availableHistory([valid, laterOutcome, correction, wrongPolicy, entry(origin.serviceDate, 20)], origin)).toEqual([valid]);
    expect(recentDeltas([valid, laterOutcome], origin)).toEqual([2, 2]);
  });
  it("recomputes earlier means instead of trusting uploaded future aggregates", () => {
    const earlier = entry("2026-01-01", 2), next = entry("2026-01-02", 0);
    expect(historicalFeatures(earlier, [earlier, next]).slice(11, 13)).toEqual([null, null]);
    expect(historicalFeatures(next, [earlier, next]).slice(11, 13)).toEqual([2, null]);
  });
  it("excludes messages received later even if their sent time was backdated", () => {
    const messages = messageFeatures({ ...origin, sources: [source({ receivedAt: "2026-01-08T09:00:01Z" })], proposals: [], classifications: [{ sourceId: "source", sourceRevision: 0, computedAt: "2026-01-08T08:30:00Z", labels: ["pause"] }] });
    expect(messages.values).toEqual([0, 0, 0, 0, 0]);
  });
  it("missing classifications remain null instead of zero", () => {
    const messages = messageFeatures({ ...origin, sources: [source()], proposals: [], classifications: [{ sourceId: "source", sourceRevision: 0, computedAt: "2026-01-08T09:00:01Z", labels: ["pause"] }] });
    expect(messages).toEqual({ values: [null, null, null, null, null], complete: false });
    const row = buildFeatureRow({ ...origin, cutoffAt: "2026-01-08T10:00:00Z", baselineMeals: 10, confirmedMeals: 10, activeCustomers: 2, pendingChangeCount: 1, history: [], messages });
    expect(row.slice(5, 10)).toEqual([null, null, null, null, null]); expect(row[13]).toBe(0);
  });
  it("deduplicates source revisions and labels and excludes future reviewed labels", () => {
    const classified = { sourceId: "source", sourceRevision: 0, computedAt: "2026-01-08T08:30:00Z", labels: ["pause", "pause", "quantity_change"], reviewedAt: "2026-01-08T09:01:00Z", reviewedLabels: ["resume"] };
    expect(messageFeatures({ ...origin, sources: [source(), source()], proposals: [], classifications: [classified, classified] }).values).toEqual([1, 1, 0, 1, 0]);
    expect(messageFeatures({ ...origin, sources: [source()], proposals: [], classifications: [{ ...classified, reviewedAt: "2026-01-08T08:59:00Z" }] }).values).toEqual([1, 0, 1, 0, 0]);
  });
  it("does not use a classification for a different source revision", () => {
    expect(messageFeatures({ ...origin, sources: [source({ revision: 1 })], proposals: [], classifications: [{ sourceId: "source", sourceRevision: 0, computedAt: "2026-01-08T08:30:00Z", labels: ["pause"] }] }).complete).toBe(false);
  });
  it("excludes erasure-pending sources", () => {
    expect(messageFeatures({ ...origin, sources: [{ ...source(), erasurePending: true }], proposals: [], classifications: [] }).values).toEqual([0, 0, 0, 0, 0]);
  });
});
