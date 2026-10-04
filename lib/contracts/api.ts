import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { commandMetaSchema, dateSchema, idempotencyKeySchema, idSchema, pageShape, quantitySchema, revisionSchema, timestampSchema } from "./common";
import { customerSchema, dailyOverrideSchema, evidenceSpanSchema, orderOperationSchema, planSchema, proposalSchema, proposalStatusSchema, receiptSchema, sellerSchema, settingsSchema, sheetRowSchema, sheetSchema, sourceSchema, sourceStatusSchema } from "./records";

const command = { meta: commandMetaSchema, expectedStateRevision: revisionSchema };
const reason = z.string().trim().min(1).max(1000);
const operations = z.array(orderOperationSchema).max(20);
const missingFields = z.array(z.string().min(1).max(200)).max(40);
const evidenceSpans = z.array(evidenceSpanSchema).max(40);
const proposalEdit = { operations, missingFields, evidenceSpans };
const sourceVersion = { expectedSourceRevision: revisionSchema.nullable() };
const disposition = { reason, serviceDate: dateSchema.optional() };
const sourceImportSchema = z.strictObject({ text: z.string().min(1).max(8000), sentAt: timestampSchema, customerId: idSchema.nullable(), channel: z.enum(["manual", "whatsapp"]).default("manual"), upstreamId: z.string().min(1).max(256).nullable().default(null) });
export const operationSchemas = {
  me: z.strictObject({}),
  getSettings: z.strictObject({}),
  updateSettings: z.strictObject({ ...command, settings: settingsSchema }),
  listCustomers: z.strictObject({ ...pageShape, status: z.enum(["active", "archived"]).optional() }),
  createCustomer: z.strictObject({ ...command, alias: z.string().trim().min(1).max(120), packingNote: z.string().max(500).default("") }),
  getCustomer: z.strictObject({ customerId: idSchema }),
  updateCustomer: z.strictObject({ ...command, customerId: idSchema, expectedCustomerRevision: revisionSchema, alias: z.string().trim().min(1).max(120).optional(), packingNote: z.string().max(500).optional(), status: z.enum(["active", "archived"]).optional() }).refine((value) => value.alias !== undefined || value.packingNote !== undefined || value.status !== undefined, "No customer fields to update"),
  getSchedule: z.strictObject({ customerId: idSchema, fromDate: dateSchema, toDate: dateSchema }).refine((value) => {
    try { const days = Temporal.PlainDate.from(value.fromDate).until(Temporal.PlainDate.from(value.toDate)).days; return days >= 0 && days < 31; } catch { return false; }
  }, "Schedule interval must contain 1–31 days"),
  listSources: z.strictObject({ ...pageShape, status: sourceStatusSchema.optional() }),
  importSources: z.strictObject({ ...command, sources: z.array(sourceImportSchema).min(1).max(20) }),
  getSource: z.strictObject({ sourceId: idSchema }),
  correctSource: z.strictObject({ ...command, sourceId: idSchema, expectedSourceRevision: revisionSchema, customerId: idSchema.nullable().optional(), text: z.string().min(1).max(8000).optional(), sentAt: timestampSchema.optional(), reason }).refine((value) => value.customerId !== undefined || value.text !== undefined || value.sentAt !== undefined, "No source correction supplied"),
  sourceDisposition: z.strictObject({ ...command, sourceId: idSchema, expectedSourceRevision: revisionSchema, action: z.enum(["dismiss", "defer", "reopen"]), ...disposition }).refine((value) => value.action !== "defer" || value.serviceDate !== undefined, "Deferral requires serviceDate"),
  listProposals: z.strictObject({ ...pageShape, status: proposalStatusSchema.optional(), serviceDate: dateSchema.optional(), sourceId: idSchema.optional() }),
  createProposal: z.strictObject({ ...command, ...sourceVersion, sourceId: idSchema.nullable(), manualReason: reason.nullable(), ...proposalEdit }).refine((value) => value.sourceId !== null ? value.manualReason === null && value.expectedSourceRevision !== null : value.manualReason !== null && value.expectedSourceRevision === null, "Choose a versioned source or a manual reason"),
  getProposal: z.strictObject({ proposalId: idSchema }),
  editProposal: z.strictObject({ ...command, ...sourceVersion, proposalId: idSchema, expectedDraftRevision: revisionSchema, ...proposalEdit }),
  previewProposal: z.strictObject({ proposalId: idSchema, expectedDraftRevision: revisionSchema }),
  approveProposal: z.strictObject({ ...command, ...sourceVersion, proposalId: idSchema, expectedDraftRevision: revisionSchema, previewHash: z.string().regex(/^[a-f0-9]{64}$/), supersedesApprovalIds: z.array(idSchema).max(100).default([]), acknowledgeLateChange: z.boolean().default(false) }),
  proposalDisposition: z.strictObject({ ...command, ...sourceVersion, proposalId: idSchema, expectedDraftRevision: revisionSchema, action: z.enum(["reject", "defer", "reopen"]), ...disposition }).refine((value) => value.action !== "defer" || value.serviceDate !== undefined, "Deferral requires serviceDate"),
  getDay: z.strictObject({ serviceDate: dateSchema }),
  listSheets: z.strictObject({ ...pageShape, serviceDate: dateSchema }),
  finalizeSheet: z.strictObject({ ...command, serviceDate: dateSchema, expectedPriorSheetId: idSchema.nullable(), acknowledgeLateChange: z.boolean().default(false) }),
  getSheet: z.strictObject({ sheetId: idSchema }),
  exportSheet: z.strictObject({ sheetId: idSchema, format: z.literal("csv").default("csv") }),
  getReceipt: z.strictObject({ idempotencyKey: idempotencyKeySchema }),
} as const;

export const previewEffectSchema = z.strictObject({ customerId: idSchema, serviceDate: dateSchema, before: quantitySchema, after: quantitySchema });
export const previewConflictSchema = z.strictObject({ customerId: idSchema, serviceDate: dateSchema, approvalId: idSchema, kind: z.enum(["override", "plan"]) });
export const previewSchema = z.strictObject({
  proposalId: idSchema, operations, affectedDates: z.array(dateSchema).max(620), effects: z.array(previewEffectSchema).max(620),
  totals: z.array(z.strictObject({ serviceDate: dateSchema, before: z.int().min(0).max(100000), after: z.int().min(0).max(100000) })).max(620),
  sourceId: idSchema.nullable(), sourceRevision: revisionSchema.nullable(), missingFields,
  conflicts: z.array(previewConflictSchema).max(1000), requiredAcknowledgements: z.array(z.enum(["supersession", "late_change"])),
  expectedDraftRevision: revisionSchema, expectedStateRevision: revisionSchema, continuesBeyondWindow: z.boolean(), previewHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const commandOutputSchema = z.strictObject({ receipt: receiptSchema, stateRevision: revisionSchema, resourceIds: z.array(idSchema).max(100), affectedDates: z.array(dateSchema).max(620), warnings: z.array(z.string()).max(100) });
const page = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item).max(100), nextCursor: z.string().nullable() });
export const daySchema = z.strictObject({ serviceDate: dateSchema, rows: z.array(sheetRowSchema).max(100), total: z.int().min(0).max(100000), pendingCount: z.int().min(0), latestSheetId: idSchema.nullable(), stateRevision: revisionSchema });
export const outputSchemas = {
  me: z.strictObject({ seller: sellerSchema, stateRevision: revisionSchema, capabilities: z.strictObject({ manualOrders: z.literal(true), textImport: z.literal(true), ai: z.literal(false) }) }),
  getSettings: z.strictObject({ settings: settingsSchema, stateRevision: revisionSchema }),
  updateSettings: commandOutputSchema,
  listCustomers: page(customerSchema), createCustomer: commandOutputSchema, getCustomer: customerSchema, updateCustomer: commandOutputSchema,
  getSchedule: z.strictObject({ customerId: idSchema, fromDate: dateSchema, toDate: dateSchema, plans: z.array(planSchema), overrides: z.array(dailyOverrideSchema), days: z.array(z.strictObject({ serviceDate: dateSchema, baseline: quantitySchema, quantity: quantitySchema, approvalId: idSchema.nullable() })).max(31), stateRevision: revisionSchema }),
  listSources: page(sourceSchema.omit({ text: true })), importSources: commandOutputSchema,
  getSource: z.strictObject({ source: sourceSchema, proposals: z.array(proposalSchema) }), correctSource: commandOutputSchema, sourceDisposition: commandOutputSchema,
  listProposals: page(proposalSchema), createProposal: commandOutputSchema, getProposal: proposalSchema, editProposal: commandOutputSchema,
  previewProposal: previewSchema, approveProposal: commandOutputSchema, proposalDisposition: commandOutputSchema,
  getDay: daySchema, listSheets: page(sheetSchema), finalizeSheet: commandOutputSchema, getSheet: sheetSchema,
  exportSheet: z.strictObject({ filename: z.string(), contentType: z.literal("text/csv; charset=utf-8"), csv: z.string() }), getReceipt: receiptSchema,
} as const;
export type OperationName = keyof typeof operationSchemas;
export type OperationInput<K extends OperationName> = z.infer<(typeof operationSchemas)[K]>;
export type OperationOutput<K extends OperationName> = z.infer<(typeof outputSchemas)[K]>;
export type Preview = z.infer<typeof previewSchema>;
export type CommandOutput = z.infer<typeof commandOutputSchema>;
