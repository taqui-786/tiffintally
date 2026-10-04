import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "@/lib/contracts/common";
import { FEATURE_NAMES, hashSchema, type AcceptedHistory } from "@/lib/contracts/history";
import { payloadHash } from "@/lib/server/receipts";
import { availableHistory, historicalFeatures, recentDeltas } from "./features";
import { predictTabPfn, validatePredictionResponse, type PredictionRequest, type PredictionResponse } from "./client";

export const evaluationSchema = z.strictObject({
  _id: z.string().min(1).max(128), sellerId: z.string().min(1).max(128), createdAt: z.iso.datetime(), dataHash: hashSchema,
  historyVersion: z.int().min(0), featureSchemaVersion: z.literal(1), model: z.literal("tabpfn"), modelVersion: z.string().min(1).max(256),
  evidenceMode: z.enum(["real", "synthetic_demo"]), trainingDays: z.int().min(30), holdoutDays: z.int().min(10),
  split: z.literal("chronological_rolling_origin_last_10"), featureAvailabilityRule: z.literal("available_by_each_origin_v1"),
  metrics: z.strictObject({ noChange: z.number().finite().min(0), sameWeekday: z.number().finite().min(0), noJev: z.number().finite().min(0), withJev: z.number().finite().min(0), signedBias: z.number().finite(), underpredictions: z.int().min(0), overpredictions: z.int().min(0), missingFeatureCells: z.int().min(0), durationMs: z.number().finite().min(0) }),
  validated: z.boolean(), caveat: z.literal("Ten holdout days are exploratory; synthetic data proves plumbing only."),
});
export type ForecastEvaluation = z.infer<typeof evaluationSchema>;
export function datasetHash(entries: AcceptedHistory[]) {
  return payloadHash({ featureSchemaVersion: 1, rows: entries.map((entry) => ({ id: entry._id, historyVersion: entry.historyVersion, row: entry.row })).sort((a, b) => a.row.serviceDate.localeCompare(b.row.serviceDate)) });
}
/** Operator-only helper. All calls are explicit, sequential, and injectable for offline contract tests. */
export async function evaluateHistoryRows(input: { sellerId: string; historyVersion: number; rows: AcceptedHistory[] }, predict: (request: PredictionRequest) => Promise<PredictionResponse> = predictTabPfn): Promise<ForecastEvaluation> {
  const rows = input.rows.filter((row) => row.active).sort((a, b) => a.row.serviceDate.localeCompare(b.row.serviceDate));
  if (rows.length < 40) throw new AppError("INSUFFICIENT_HISTORY", "Evaluation requires 30 earlier training days and 10 later holdout days.", 422);
  if (new Set(rows.map((r) => r.row.serviceDate)).size !== rows.length || new Set(rows.map((r) => `${r.row.policyHash}:${r.row.evidenceMode}`)).size !== 1) throw new AppError("HISTORY_CONFLICT", "Evaluation requires distinct dates, one policy and one evidence mode.", 422);
  const holdout = rows.slice(-10), errors = { noChange: [] as number[], sameWeekday: [] as number[], noJev: [] as number[], withJev: [] as number[] };
  let modelVersion: string | null = null, durationMs = 0, missingFeatureCells = 0, signedBias = 0, underpredictions = 0, overpredictions = 0;
  const withoutMessages = (row: (number | null)[]) => row.map((cell, index) => index >= 5 && index <= 9 ? null : index === 13 ? 0 : cell);
  for (const test of holdout) {
    const train = availableHistory(rows, test.row);
    if (train.length < 30) throw new AppError("INSUFFICIENT_HISTORY", "Thirty outcomes must actually be available by every holdout origin.", 422);
    const trainRows = train.map((entry) => historicalFeatures(entry, rows)), queryRow = historicalFeatures(test, rows), targets = train.map((entry) => entry.row.cutoffTotal - entry.row.confirmedMeals), target = test.row.cutoffTotal - test.row.confirmedMeals;
    missingFeatureCells += queryRow.filter((value) => value === null).length;
    const baseline = recentDeltas(rows, test.row)[1] ?? 0;
    errors.noChange.push(Math.abs(target)); errors.sameWeekday.push(Math.abs(baseline - target));
    for (const ablation of ["noJev", "withJev"] as const) {
      const requestRows = ablation === "noJev" ? trainRows.map(withoutMessages) : trainRows, requestQuery = ablation === "noJev" ? withoutMessages(queryRow) : queryRow;
      const request: PredictionRequest = { schemaVersion: 1, runId: randomUUID(), dataHash: payloadHash({ trainRows: requestRows, targets, queryRow: requestQuery }), featureSchemaVersion: 1, model: "tabpfn", featureNames: [...FEATURE_NAMES], trainRows: requestRows, targets, queryRow: requestQuery };
      const response = validatePredictionResponse(await predict(request), request);
      if (modelVersion !== null && response.modelVersion !== modelVersion) throw new AppError("INVALID_MODEL_OUTPUT", "Model version changed during evaluation.", 502);
      modelVersion = response.modelVersion; durationMs += response.durationMs;
      const residual = response.predictedDelta - target;
      errors[ablation].push(Math.abs(residual));
      if (ablation === "withJev") { signedBias += residual; if (residual < 0) underpredictions++; if (residual > 0) overpredictions++; }
    }
  }
  const mae = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const metrics = { noChange: mae(errors.noChange), sameWeekday: mae(errors.sameWeekday), noJev: mae(errors.noJev), withJev: mae(errors.withJev), signedBias: signedBias / holdout.length, underpredictions, overpredictions, missingFeatureCells, durationMs };
  return evaluationSchema.parse({ _id: randomUUID(), sellerId: input.sellerId, createdAt: new Date().toISOString(), dataHash: datasetHash(rows), historyVersion: input.historyVersion, featureSchemaVersion: 1, model: "tabpfn", modelVersion, evidenceMode: rows[0].row.evidenceMode, trainingDays: rows.length - holdout.length, holdoutDays: holdout.length, split: "chronological_rolling_origin_last_10", featureAvailabilityRule: "available_by_each_origin_v1", metrics, validated: rows[0].row.evidenceMode === "real" && metrics.withJev < Math.min(metrics.noChange, metrics.sameWeekday, metrics.noJev), caveat: "Ten holdout days are exploratory; synthetic data proves plumbing only." });
}
