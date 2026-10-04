import { z } from "zod";
import { commandMetaSchema, idSchema, revisionSchema, timestampSchema } from "./common";

const command = { meta: commandMetaSchema, expectedStateRevision: revisionSchema, confirm: z.literal(true) };
export const privacyInputSchemas = {
  privacyExport: z.strictObject({ scope: z.literal("business").default("business") }),
  eraseSources: z.strictObject({
    ...command, sourceIds: z.array(idSchema).min(1).max(20), expectedSourceRevisions: z.record(idSchema, revisionSchema),
  }).refine((input) => new Set(input.sourceIds).size === input.sourceIds.length && Object.keys(input.expectedSourceRevisions).length === input.sourceIds.length && input.sourceIds.every((id) => Object.hasOwn(input.expectedSourceRevisions, id)), "Each distinct source requires exactly one expected revision"),
  eraseSeller: z.strictObject({ ...command, sellerId: idSchema }),
  getPrivacyOperation: z.strictObject({ operationId: idSchema }),
} as const;

export const privacyGapSchema = z.enum(["PROVIDER_RETENTION_UNVERIFIED", "REMOTE_DELETE_UNCONFIRMED", "PROVIDER_IDENTIFIERS_UNAVAILABLE", "INFLIGHT_PROVIDER_CALL", "AUTH_SESSIONS_RETAINED", "LOCAL_CLEANUP_PENDING"]);
export const privacyOperationSchema = z.strictObject({
  operationId: idSchema, receiptId: idSchema, kind: z.enum(["source_erasure", "seller_erasure"]),
  state: z.enum(["running", "partial", "needs_reconciliation", "completed"]),
  createdAt: timestampSchema, updatedAt: timestampSchema, stateRevision: revisionSchema,
  counts: z.strictObject({ localRecords: z.int().min(0), remoteConfirmed: z.int().min(0), remotePending: z.int().min(0) }),
  gaps: z.array(privacyGapSchema).max(6),
});
export const privacyOutputSchemas = {
  privacyExport: z.strictObject({ filename: z.string(), contentType: z.literal("application/json; charset=utf-8"), json: z.string().max(2 * 1024 * 1024), bytes: z.int().min(0).max(2 * 1024 * 1024) }),
  eraseSources: privacyOperationSchema, eraseSeller: privacyOperationSchema, getPrivacyOperation: privacyOperationSchema,
} as const;
export type PrivacyOperationName = keyof typeof privacyInputSchemas;
export type PrivacyInput<K extends PrivacyOperationName> = z.output<(typeof privacyInputSchemas)[K]>;
export type PrivacyOutput<K extends PrivacyOperationName> = z.output<(typeof privacyOutputSchemas)[K]>;
export type PrivacyOperation = z.output<typeof privacyOperationSchema>;
