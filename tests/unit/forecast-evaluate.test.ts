import { describe, expect, it } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { acceptedHistorySchema, type AcceptedHistory } from "@/lib/contracts/history";
import { evaluateHistoryRows } from "@/lib/server/forecasting/evaluate";
import type { PredictionRequest } from "@/lib/server/forecasting/client";
function history(): AcceptedHistory[] {
  return Array.from({ length: 40 }, (_, index) => {
    const day = Temporal.PlainDate.from("2026-01-01").add({ days: index });
    const date = day.toString();
    return acceptedHistorySchema.parse({ _id: `row_${index}`, sellerId: "s", snapshotId: `snapshot_${index}`, outcomeId: `outcome_${index}`, createdAt: `${date}T10:00:00Z`, historyVersion: 1, active: true, supersedesIds: [], importId: "fixture", row: { schemaVersion: 1, serviceDate: date, timezone: "UTC", policyHash: "a".repeat(64), asOf: `${date}T09:00:00Z`, cutoffAt: `${date}T10:00:00Z`, outcomeAvailableAt: `${date}T10:00:00Z`, confirmedMeals: 10, cutoffTotal: 12, features: [day.dayOfWeek, 60, 10, 10, 2, 0, 0, 0, 0, 0, 0, null, null, 1], evidenceMode: "synthetic_demo", provenance: { kind: "synthetic", reference: "fixture", complete: true, snapshotEvidenceAt: `${date}T09:00:00Z`, cutoffEvidenceAt: `${date}T10:00:00Z`, messageFeatures: "as_of", messageEvidenceAt: `${date}T09:00:00Z` } } });
  });
}
describe("chronological TabPFN evaluation", () => {
  it("compares all four methods with genuine measured calls, never validating synthetic data", async () => {
    const requests: PredictionRequest[] = [];
    const result = await evaluateHistoryRows({ sellerId: "s", historyVersion: 1, rows: history().reverse() }, async (request) => { requests.push(request); return { schemaVersion: 1, runId: request.runId, dataHash: request.dataHash, featureSchemaVersion: 1, modelVersion: "synthetic-model-v1", predictedDelta: request.queryRow[13] ? 2 : 1, trainingRows: request.trainRows.length, durationMs: 1 }; });
    expect(requests).toHaveLength(20); expect(requests[0].trainRows).toHaveLength(30); expect(requests[18].trainRows).toHaveLength(39);
    expect(requests[0].queryRow.slice(5, 10)).toEqual([null, null, null, null, null]); expect(requests[1].queryRow.slice(5, 10)).toEqual([0, 0, 0, 0, 0]);
    expect(result.metrics).toMatchObject({ noChange: 2, sameWeekday: 0, noJev: 1, withJev: 0, durationMs: 20 });
    expect(result.validated).toBe(false); expect(result.holdoutDays).toBe(10);
  });
  it("refuses retrospective outcomes unavailable at holdout origin before any call", async () => {
    const rows = history(); rows[0].row.outcomeAvailableAt = "2026-06-01T00:00:00Z";
    let calls = 0;
    await expect(evaluateHistoryRows({ sellerId: "s", historyVersion: 1, rows }, async () => { calls++; throw new Error("must not call"); })).rejects.toMatchObject({ code: "INSUFFICIENT_HISTORY" });
    expect(calls).toBe(0);
  });
  it("does not fabricate evaluation below the training/holdout threshold", async () => {
    await expect(evaluateHistoryRows({ sellerId: "s", historyVersion: 1, rows: history().slice(1) })).rejects.toMatchObject({ code: "INSUFFICIENT_HISTORY" });
  });
});
