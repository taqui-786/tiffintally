import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { dateSchema, idempotencyKeySchema, idSchema, quantitySchema, revisionSchema, timestampSchema } from "./common";

const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const settingsSchema = z.strictObject({
  timezone: z.string().min(1).max(100).refine((zone) => {
    try { return !/^[+-]/.test(zone) && !!Temporal.Instant.from("2026-01-01T00:00:00Z").toZonedDateTimeISO(zone); } catch { return false; }
  }, "Expected an IANA timezone"),
  weekdays: z.array(z.int().min(1).max(7)).min(1).max(7).refine((days) => new Set(days).size === days.length, "Duplicate weekday"),
  quantityCap: quantitySchema.min(1), customerCap: z.int().min(1).max(100),
  planningTime: timeSchema, cutoffTime: timeSchema,
}).refine((settings) => settings.planningTime < settings.cutoffTime, "Planning time must precede cutoff time");
export type Settings = z.infer<typeof settingsSchema>;
// Provisional lunch policy; recipient confirmation is still required.
export const DEFAULT_SETTINGS: Settings = { timezone: "Asia/Kolkata", weekdays: [1, 2, 3, 4, 5, 6], quantityCap: 100, customerCap: 100, planningTime: "09:00", cutoffTime: "10:00" };
const recordShape = { _id: idSchema, sellerId: idSchema, schemaVersion: z.literal(1), createdAt: timestampSchema };
export const sellerSchema = z.strictObject({ _id: idSchema, ownerUserId: z.string().min(1).max(256), settings: settingsSchema, stateRevision: revisionSchema, status: z.literal("active"), schemaVersion: z.literal(1), createdAt: timestampSchema, privacyDeleting: z.boolean().optional() });
export const customerSchema = z.strictObject({ ...recordShape, alias: z.string().trim().min(1).max(120), packingNote: z.string().max(500), status: z.enum(["active", "archived"]), revision: revisionSchema });
export const quantitiesSchema = z.tuple([quantitySchema, quantitySchema, quantitySchema, quantitySchema, quantitySchema, quantitySchema, quantitySchema]);
export const planSchema = z.strictObject({ ...recordShape, customerId: idSchema, startDate: dateSchema, endDate: dateSchema.nullable(), quantities: quantitiesSchema, revision: revisionSchema, approvalId: idSchema, supersedesPlanIds: z.array(idSchema) }).refine((plan) => plan.endDate === null || plan.startDate <= plan.endDate, "End date precedes start date");
export const dailyOverrideSchema = z.strictObject({ ...recordShape, customerId: idSchema, serviceDate: dateSchema, quantity: quantitySchema, approvalId: idSchema, kind: z.enum(["quantity", "pause"]) }).refine((override) => override.kind !== "pause" || override.quantity === 0, "Pause quantity must be zero");
export const sourceStatusSchema = z.enum(["needs_review", "resolved", "dismissed", "deferred", "superseded"]);
export const sourceSchema = z.strictObject({
  ...recordShape, text: z.string().min(1).max(8000), sentAt: timestampSchema, receivedAt: timestampSchema,
  customerId: idSchema.nullable(), revision: revisionSchema, status: sourceStatusSchema,
  deferredDate: dateSchema.nullable(), fingerprint: z.string().min(1).max(128),
  channel: z.enum(["manual", "whatsapp"]).default("manual"), upstreamId: z.string().min(1).max(256).nullable(),
  replacesSourceId: idSchema.nullable(), dispositionReason: z.string().max(1000).nullable(),
  erasurePending: z.boolean().optional(),
});
function boundedInterval(value: { fromDate: string; toDate: string }) {
  try { const days = Temporal.PlainDate.from(value.fromDate).until(Temporal.PlainDate.from(value.toDate)).days; return days >= 0 && days < 31; } catch { return false; }
}
const intervalShape = { customerId: idSchema, fromDate: dateSchema, toDate: dateSchema };
export const orderOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("set_daily_quantity"), customerId: idSchema, serviceDate: dateSchema, quantity: quantitySchema }),
  z.strictObject({ type: z.literal("pause_interval"), ...intervalShape }).refine(boundedInterval, "Interval must contain 1–31 days"),
  z.strictObject({ type: z.literal("resume_interval"), ...intervalShape }).refine(boundedInterval, "Interval must contain 1–31 days"),
  z.strictObject({ type: z.literal("replace_recurring_plan"), customerId: idSchema, startDate: dateSchema, endDate: dateSchema.nullable(), quantities: quantitiesSchema }).refine((op) => op.endDate === null || op.startDate <= op.endDate, "End date precedes start date"),
]);
export const evidenceSpanSchema = z.strictObject({ start: z.int().min(0).max(8000), end: z.int().min(1).max(8000) }).refine((span) => span.start < span.end, "Empty evidence span");
export const proposalStatusSchema = z.enum(["needs_review", "approved", "rejected", "deferred", "obsolete"]);
export const proposalSchema = z.strictObject({
  ...recordShape, sourceId: idSchema.nullable(), sourceRevision: revisionSchema.nullable(), manualReason: z.string().max(1000).nullable(),
  operations: z.array(orderOperationSchema).max(20), evidenceSpans: z.array(evidenceSpanSchema).max(40),
  missingFields: z.array(z.string().min(1).max(200)).max(40), draftRevision: revisionSchema,
  status: proposalStatusSchema, deferredDate: dateSchema.nullable(), dispositionReason: z.string().max(1000).nullable(),
});
export const sheetRowSchema = z.strictObject({ customerId: idSchema, alias: z.string(), packingNote: z.string(), baseline: quantitySchema, quantity: quantitySchema, approvalId: idSchema.nullable() });
export const sheetDeltaSchema = z.strictObject({ customerId: idSchema, before: quantitySchema, after: quantitySchema, difference: z.int().min(-1000).max(1000) });
export const sheetSchema = z.strictObject({
  ...recordShape, serviceDate: dateSchema, revision: revisionSchema.min(1), rows: z.array(sheetRowSchema).max(100), total: z.int().min(0).max(100000),
  computedFromStateRevision: revisionSchema, committedStateRevision: revisionSchema,
  finalizedBy: z.string(), finalizedAt: timestampSchema, previousSheetId: idSchema.nullable(), delta: z.array(sheetDeltaSchema).max(200),
});
export const receiptSchema = z.strictObject({
  ...recordShape, operation: z.string().min(1), idempotencyKey: idempotencyKeySchema, payloadHash: z.string().min(1).max(128),
  actorUserId: z.string(), committedAt: timestampSchema, priorStateRevision: revisionSchema, stateRevision: revisionSchema,
  resourceIds: z.array(idSchema).max(100), affectedDates: z.array(dateSchema).max(620),
  warnings: z.array(z.string().max(1000)).max(100),
  // JSON snapshots retain the complete old/new facts for audit without BSON or class instances.
  before: z.json(), after: z.json(),
});
export type Seller = z.infer<typeof sellerSchema>;
export type Customer = z.infer<typeof customerSchema>;
export type Plan = z.infer<typeof planSchema>;
export type DailyOverride = z.infer<typeof dailyOverrideSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type OrderOperation = z.infer<typeof orderOperationSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type Sheet = z.infer<typeof sheetSchema>;
export type SheetRow = z.infer<typeof sheetRowSchema>;
export type SheetDelta = z.infer<typeof sheetDeltaSchema>;
