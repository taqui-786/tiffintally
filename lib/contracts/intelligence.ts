import { z } from "zod";
import { commandMetaSchema, idempotencyKeySchema, idSchema, revisionSchema, timestampSchema } from "./common";

const analysisCommand = {
  meta: commandMetaSchema, expectedStateRevision: revisionSchema,
  expectedSourceRevision: revisionSchema, consentAcknowledged: z.literal(true),
  expectedDraftRevisions: z.array(z.strictObject({ proposalId: idSchema, draftRevision: revisionSchema })).max(100).optional(),
};
const runId = idSchema.refine((id) => id !== "by-key", "Reserved path segment");
export const intelligenceInputSchemas = {
  capabilities: z.strictObject({}),
  analyzeSource: z.strictObject({ ...analysisCommand, sourceId: idSchema }),
  getAnalysis: z.strictObject({ runId }),
  getAnalysisByKey: z.strictObject({ requestKey: idempotencyKeySchema }),
  retryAnalysis: z.strictObject({ ...analysisCommand, runId, acknowledgeUnknownSpend: z.boolean().default(false) }),
} as const;
export const analysisStateSchema = z.enum(["running", "succeeded", "needs_review", "failed", "unknown", "obsolete"]);
export const aiUsageSchema = z.strictObject({ inputTokens: z.int().nonnegative().nullable(), outputTokens: z.int().nonnegative().nullable() });
export const analysisRunViewSchema = z.strictObject({
  runId: idSchema, requestKey: idempotencyKeySchema, sourceId: idSchema, sourceRevision: revisionSchema,
  state: analysisStateSchema, stage: z.enum(["reserved", "gemma", "jev", "commit", "complete"]),
  createdAt: timestampSchema, updatedAt: timestampSchema, deadline: timestampSchema,
  completedAt: timestampSchema.nullable(), retryOfRunId: idSchema.nullable(),
  unknownSpend: z.boolean(),
  expectedStateRevision: revisionSchema, stateRevision: revisionSchema.nullable(),
  proposalIds: z.array(idSchema).max(20), classificationId: idSchema.nullable(),
  models: z.strictObject({ gemmaProvider: z.string(), gemmaRequested: z.string(), gemmaResolved: z.string().nullable(), jevRequested: z.string(), jevResolved: z.string().nullable() }),
  promptVersion: z.string(), schemaVersion: z.literal(1), extractionAvailable: z.boolean(),
  usage: z.strictObject({ gemma: aiUsageSchema.nullable(), jev: aiUsageSchema.nullable() }),
  warnings: z.array(z.string().max(200)).max(40),
  error: z.strictObject({ code: z.string().max(100), message: z.string().max(300), status: z.int().min(400).max(599), retryAfterSeconds: z.int().nonnegative().max(86400).nullable() }).nullable(),
});
export const capabilitiesSchema = z.strictObject({
  ai: z.strictObject({ configured: z.boolean(), gemmaConfigured: z.boolean(), jevConfigured: z.boolean(), mode: z.literal("bounded_sync"), requiresConsent: z.literal(true) }),
  forecasting: z.strictObject({ configured: z.boolean() }), privacyExport: z.literal(true),
});
export const intelligenceOutputSchemas = {
  capabilities: capabilitiesSchema, analyzeSource: analysisRunViewSchema, getAnalysis: analysisRunViewSchema,
  getAnalysisByKey: analysisRunViewSchema, retryAnalysis: analysisRunViewSchema,
} as const;
export type IntelligenceOperationName = keyof typeof intelligenceInputSchemas;
export type IntelligenceInput<K extends IntelligenceOperationName> = z.infer<(typeof intelligenceInputSchemas)[K]>;
export type IntelligenceOutput<K extends IntelligenceOperationName> = z.infer<(typeof intelligenceOutputSchemas)[K]>;
export type AnalysisRunView = z.infer<typeof analysisRunViewSchema>;
