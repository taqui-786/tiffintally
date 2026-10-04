import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { commandMetaSchema, dateSchema, idempotencyKeySchema, idSchema, pageShape, revisionSchema, timestampSchema } from "./common";
import { settingsSchema } from "./records";

export const FEATURE_NAMES = ["weekday", "minutesToCutoff", "baselineMeals", "confirmedMeals", "activeCustomers", "receivedSourceCount", "pauseIntentCount", "resumeIntentCount", "quantityChangeIntentCount", "unclearSourceCount", "pendingChangeCount", "recentMeanDelta", "recentSameWeekdayDelta", "messageFeaturesAvailable"] as const;
export const FEATURE_SCHEMA_VERSION = 1;
export const HISTORY_SCHEMA_VERSION = 1;
export const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.int().min(0).max(100000);
export const featureRowSchema = z.array(z.number().finite().min(-100000).max(100000).nullable()).length(14);
export const provenanceSchema = z.strictObject({
  kind: z.enum(["native", "imported_complete", "synthetic"]), reference: z.string().min(1).max(256),
  complete: z.literal(true), snapshotEvidenceAt: timestampSchema, cutoffEvidenceAt: timestampSchema,
  messageFeatures: z.enum(["as_of", "missing", "retrospective"]), messageEvidenceAt: timestampSchema.nullable(),
});
export const historyRowSchema = z.strictObject({
  schemaVersion: z.literal(1), serviceDate: dateSchema, timezone: settingsSchema.shape.timezone, policyHash: hashSchema,
  asOf: timestampSchema, cutoffAt: timestampSchema, outcomeAvailableAt: timestampSchema,
  confirmedMeals: count, cutoffTotal: count, features: featureRowSchema,
  evidenceMode: z.enum(["real", "synthetic_demo"]), provenance: provenanceSchema,
}).superRefine((row, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  let snapshotDate: string, cutoffDate: string, weekday: number;
  try { snapshotDate = Temporal.Instant.from(row.asOf).toZonedDateTimeISO(row.timezone).toPlainDate().toString(); cutoffDate = Temporal.Instant.from(row.cutoffAt).toZonedDateTimeISO(row.timezone).toPlainDate().toString(); weekday = Temporal.PlainDate.from(row.serviceDate).dayOfWeek; }
  catch { issue("Invalid service date, timestamp or timezone"); return; }
  if (Date.parse(row.asOf) >= Date.parse(row.cutoffAt) || Date.parse(row.outcomeAvailableAt) < Date.parse(row.cutoffAt)) issue("Invalid snapshot/cutoff/outcome availability ordering");
  if (Date.parse(row.provenance.snapshotEvidenceAt) > Date.parse(row.asOf) || Date.parse(row.provenance.cutoffEvidenceAt) !== Date.parse(row.cutoffAt)) issue("Timestamped evidence must establish the exact snapshot and cutoff");
  if (snapshotDate !== row.serviceDate || cutoffDate !== row.serviceDate) issue("Snapshot and cutoff must match the local service date");
  if ((row.evidenceMode === "synthetic_demo") !== (row.provenance.kind === "synthetic")) issue("Synthetic evidence must remain separate from real history");
  if (row.features[0] !== weekday || row.features[1] !== (Date.parse(row.cutoffAt) - Date.parse(row.asOf)) / 60000 || row.features[3] !== row.confirmedMeals) issue("Features disagree with snapshot facts");
  for (const index of [2, 3, 4, 5, 6, 7, 8, 9, 10]) if (row.features[index] !== null && (!Number.isSafeInteger(row.features[index]) || row.features[index]! < 0)) issue("Count features must be nonnegative integers or missing");
  if (![0, 1].includes(row.features[13]!)) issue("Message availability must be 0 or 1");
  if (row.provenance.messageFeatures !== "as_of") {
    if (row.features[13] !== 0 || row.features.slice(5, 10).some((x) => x !== null)) issue("Missing/retrospective message features cannot enter live feature rows");
  } else if (row.features[13] !== 1 || row.features.slice(5, 10).some((x) => x === null) || !row.provenance.messageEvidenceAt || Date.parse(row.provenance.messageEvidenceAt) > Date.parse(row.asOf)) issue("As-of message features require complete timestamped evidence");
});
export type HistoryRow = z.infer<typeof historyRowSchema>;
export const acceptedHistorySchema = z.strictObject({ _id: idSchema, sellerId: idSchema, snapshotId: idSchema, outcomeId: idSchema, createdAt: timestampSchema, historyVersion: revisionSchema, active: z.boolean(), supersedesIds: z.array(idSchema).max(2000), importId: idSchema.nullable(), row: historyRowSchema });
export type AcceptedHistory = z.infer<typeof acceptedHistorySchema>;
export const historyImportSchema = z.strictObject({ _id: idSchema, sellerId: idSchema, createdAt: timestampSchema, schemaVersion: z.literal(1), idempotencyKey: idempotencyKeySchema, payloadHash: hashSchema, digest: hashSchema, format: z.enum(["json", "csv"]), evidenceMode: z.enum(["real", "synthetic_demo"]), status: z.enum(["staged", "invalid", "committed"]), rowCount: z.int().min(1).max(2000), validRowCount: z.int().min(0).max(2000), errors: z.array(z.strictObject({ row: z.int().min(1).max(2000), code: z.string().max(100), message: z.string().max(256) })).max(20000), committedAt: timestampSchema.nullable(), committedBy: z.string().nullable(), historyVersion: revisionSchema.nullable() });
export const planningSnapshotSchema = z.strictObject({ _id: idSchema, sellerId: idSchema, schemaVersion: z.literal(1), createdAt: timestampSchema, serviceDate: dateSchema, timezone: settingsSchema.shape.timezone, policyHash: hashSchema, asOf: timestampSchema, cutoffAt: timestampSchema, confirmedMeals: count, features: featureRowSchema, stateRevision: revisionSchema, historyVersion: revisionSchema, active: z.boolean(), supersedesIds: z.array(idSchema).max(100), evidenceMode: z.enum(["real", "synthetic_demo"]), provenanceReference: z.string().max(256) });
export type PlanningSnapshot = z.infer<typeof planningSnapshotSchema>;
export const outcomeSchema = z.strictObject({ _id: idSchema, sellerId: idSchema, createdAt: timestampSchema, snapshotId: idSchema, serviceDate: dateSchema, cutoffAt: timestampSchema, cutoffTotal: count, outcomeAvailableAt: timestampSchema, historyVersion: revisionSchema, active: z.boolean(), supersedesIds: z.array(idSchema).max(100), provenance: provenanceSchema });
export const forecastResultSchema = z.strictObject({ status: z.enum(["available", "insufficient_history", "not_validated", "unavailable", "obsolete"]), predictedDelta: z.number().finite().min(-100000).max(100000).nullable(), roundedDelta: z.int().min(-100000).max(100000).nullable(), roundingRule: z.literal("Math.round"), baselineDelta: z.number().finite(), baselineMethod: z.literal("earlier_same_weekday_mean_or_no_change"), trainingRows: z.int().min(0).max(2000), holdoutRows: z.int().min(0).max(2000), modelVersion: z.string().min(1).max(256).nullable(), evaluationId: idSchema.nullable(), durationMs: z.number().finite().min(0).nullable() }).refine((result) => result.status !== "available" || result.predictedDelta !== null && result.roundedDelta !== null && result.modelVersion !== null && result.durationMs !== null, "Available predictions require a measured model result");
export const forecastRunSchema = z.strictObject({ _id: idSchema, sellerId: idSchema, schemaVersion: z.literal(1), createdAt: timestampSchema, completedAt: timestampSchema.nullable(), deadline: timestampSchema, requestKey: idempotencyKeySchema, payloadHash: hashSchema, runState: z.enum(["running", "succeeded", "failed", "unknown", "obsolete"]), snapshotId: idSchema, serviceDate: dateSchema, asOf: timestampSchema, confirmedMeals: count, stateRevision: revisionSchema, historyVersion: revisionSchema, dataHash: hashSchema, datasetHash: hashSchema, featureSchemaVersion: z.literal(1), model: z.literal("tabpfn"), featureNames: z.array(z.string()).length(14).refine((names) => names.join() === FEATURE_NAMES.join(), "Feature order mismatch"), queryRow: featureRowSchema, evidenceMode: z.enum(["real", "synthetic_demo"]), experiment: z.boolean(), result: forecastResultSchema.nullable(), failureCode: z.string().max(100).nullable(), obsolete: z.boolean() }).refine((run) => run.queryRow[3] === run.confirmedMeals && (!run.experiment || run.evidenceMode === "synthetic_demo") && (run.evidenceMode !== "real" || run.result?.status !== "available" || run.result.evaluationId !== null), "Forecast evidence and snapshot facts must agree");
export type ForecastRun = z.infer<typeof forecastRunSchema>;
const command = { meta: commandMetaSchema, expectedStateRevision: revisionSchema, expectedHistoryVersion: revisionSchema };
const ids = z.array(idSchema).max(2000).default([]).refine((value) => new Set(value).size === value.length, "Duplicate supersession ID");
const pathId = idSchema.refine((id) => id !== "by-key", "Reserved path segment");
export const historyInputSchemas = {
  stageHistory: z.strictObject({ ...command, schemaVersion: z.literal(1), format: z.enum(["json", "csv"]).default("json"), evidenceMode: z.enum(["real", "synthetic_demo"]), rows: z.array(z.json()).min(1).max(2000) }),
  getHistoryImport: z.strictObject({ importId: pathId }),
  commitHistory: z.strictObject({ ...command, importId: pathId, digest: hashSchema, supersedesIds: ids }),
  listHistory: z.strictObject({ ...pageShape, fromDate: dateSchema.optional(), toDate: dateSchema.optional(), evidenceMode: z.enum(["real", "synthetic_demo"]).optional() }),
  capturePlanningSnapshot: z.strictObject({ ...command, serviceDate: dateSchema, policyHash: hashSchema, supersedesIds: ids }),
  recordOutcome: z.strictObject({ ...command, serviceDate: dateSchema, snapshotId: pathId, evidenceImportId: pathId, evidenceRow: z.int().min(1).max(2000), complete: z.literal(true), supersedesIds: ids }),
  requestForecast: z.strictObject({ ...command, serviceDate: dateSchema, snapshotId: pathId, experiment: z.boolean().default(false) }),
  listForecasts: z.strictObject({ ...pageShape, serviceDate: dateSchema, snapshotId: pathId.optional() }),
  getForecast: z.strictObject({ forecastId: pathId }),
  getForecastByKey: z.strictObject({ requestKey: idempotencyKeySchema }),
} as const;
const page = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item).max(100), nextCursor: z.string().nullable(), historyVersion: revisionSchema });
export const historyOutputSchemas = { stageHistory: historyImportSchema, getHistoryImport: historyImportSchema, commitHistory: z.strictObject({ import: historyImportSchema, historyVersion: revisionSchema, receiptId: idSchema }), listHistory: page(acceptedHistorySchema), capturePlanningSnapshot: planningSnapshotSchema, recordOutcome: outcomeSchema, requestForecast: forecastRunSchema, listForecasts: page(forecastRunSchema), getForecast: forecastRunSchema, getForecastByKey: forecastRunSchema } as const;
export type HistoryOperationName = keyof typeof historyInputSchemas;
export type HistoryInput<K extends HistoryOperationName> = z.infer<(typeof historyInputSchemas)[K]>;
