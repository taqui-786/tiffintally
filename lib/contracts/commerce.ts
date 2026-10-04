import { z } from "zod";
import { commandMetaSchema, dateSchema, idSchema, quantitySchema, revisionSchema, timestampSchema } from "./common";
import { commandOutputSchema } from "./api";

export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const moneySchema = z.int().min(0).max(1_000_000_000);
const signedMoneySchema = z.int().min(-1_000_000_000).max(1_000_000_000);
export const phoneSchema = z.union([z.literal(""), z.string().regex(/^[1-9]\d{7,14}$/)]);
export const commerceSettingsSchema = z.strictObject({
  upiId: z.union([z.literal(""), z.string().trim().max(120).regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/)]),
  helperPhone: phoneSchema,
});
export const commerceProfileSchema = z.strictObject({
  unitPricePaise: moneySchema.nullable(), phone: phoneSchema,
  routeName: z.string().trim().max(120), routeOrder: z.int().min(0).max(9999), deliveryNote: z.string().trim().max(300),
});
export const commerceCustomerSchema = z.strictObject({
  customerId: idSchema, alias: z.string(), status: z.enum(["active", "archived"]), profile: commerceProfileSchema, revision: revisionSchema.nullable(),
});
export const billingAdjustmentSchema = z.strictObject({ serviceDate: dateSchema, amountPaise: moneySchema, reason: z.string().trim().min(1).max(300) });
export const billingAdjustmentsSchema = z.array(billingAdjustmentSchema).max(31).refine((rows) => new Set(rows.map((row) => row.serviceDate)).size === rows.length, "One adjustment per date");
export const invoiceLineSchema = z.strictObject({
  serviceDate: dateSchema, baseline: quantitySchema, quantity: quantitySchema,
  baseAmountPaise: moneySchema, amountPaise: moneySchema, adjustmentPaise: signedMoneySchema, adjustmentReason: z.string().nullable(),
  sheetId: idSchema, sheetRevision: revisionSchema.min(1), finalizedAt: timestampSchema,
  approvalReceiptId: idSchema.nullable(), approvalReceiptKey: z.string().nullable(), approvedAt: timestampSchema.nullable(),
});
const invoiceFacts = {
  customerId: idSchema, alias: z.string(), month: monthSchema, currency: z.literal("INR"), unitPricePaise: moneySchema.nullable(),
  phone: phoneSchema, upiId: commerceSettingsSchema.shape.upiId, lines: z.array(invoiceLineSchema).max(31),
  baselineSubtotalPaise: moneySchema, skipCreditPaise: moneySchema, reductionCreditPaise: moneySchema, extraChargesPaise: moneySchema,
  adjustmentsPaise: signedMoneySchema, totalPaise: moneySchema,
  missingDates: z.array(dateSchema).max(31), warnings: z.array(z.string()).max(20), canIssue: z.boolean(),
  expectedStateRevision: revisionSchema, basisHash: z.string().regex(/^[a-f0-9]{64}$/), priorInvoiceId: idSchema.nullable(), message: z.string().max(30_000),
};
export const invoicePreviewSchema = z.strictObject(invoiceFacts);
export const invoiceSchema = z.strictObject({ ...invoiceFacts, _id: idSchema, version: revisionSchema.min(1), status: z.literal("issued"), issuedAt: timestampSchema, issuedBy: z.string(), previousInvoiceId: idSchema.nullable() });
export const dispatchCustomerSchema = z.strictObject({ customerId: idSchema, alias: z.string(), quantity: quantitySchema, deliveryNote: z.string() });
export const dispatchSchema = z.strictObject({
  serviceDate: dateSchema, sheetId: idSchema.nullable(), sheetRevision: revisionSchema.nullable(), stateRevision: revisionSchema,
  isReady: z.boolean(), reason: z.string().nullable(), pendingCount: z.int().min(0), total: z.int().min(0).max(100_000),
  helperPhone: phoneSchema,
  groups: z.array(z.strictObject({ routeName: z.string(), routeOrder: z.int().min(0), total: z.int().min(0), customers: z.array(dispatchCustomerSchema).max(100) })).max(100),
  doNotStop: z.array(z.strictObject({ customerId: idSchema, alias: z.string(), routeName: z.string(), reason: z.string() })).max(100),
  unroutedCustomerIds: z.array(idSchema).max(100), message: z.string().max(40_000),
});
const command = { meta: commandMetaSchema, expectedStateRevision: revisionSchema };
export const commerceInputSchemas = {
  getCommerceSetup: z.strictObject({}),
  saveCommerceSettings: z.strictObject({ ...command, settings: commerceSettingsSchema }),
  saveCommerceCustomer: z.strictObject({ ...command, customerId: idSchema, expectedProfileRevision: revisionSchema.nullable(), profile: commerceProfileSchema }),
  previewInvoice: z.strictObject({ customerId: idSchema, month: monthSchema, adjustments: billingAdjustmentsSchema.default([]) }),
  createInvoice: z.strictObject({ ...command, customerId: idSchema, month: monthSchema, adjustments: billingAdjustmentsSchema.default([]), expectedBasisHash: z.string().regex(/^[a-f0-9]{64}$/), expectedPriorInvoiceId: idSchema.nullable() }),
  listInvoices: z.strictObject({ month: monthSchema, customerId: idSchema.optional() }),
  getInvoice: z.strictObject({ invoiceId: idSchema }),
  getDispatch: z.strictObject({ serviceDate: dateSchema }),
} as const;
export const commerceOutputSchemas = {
  getCommerceSetup: z.strictObject({ settings: commerceSettingsSchema, customers: z.array(commerceCustomerSchema).max(100), stateRevision: revisionSchema }),
  saveCommerceSettings: commandOutputSchema, saveCommerceCustomer: commandOutputSchema,
  previewInvoice: invoicePreviewSchema, createInvoice: commandOutputSchema,
  listInvoices: z.strictObject({ items: z.array(invoiceSchema).max(100), hasMore: z.boolean() }),
  getInvoice: invoiceSchema, getDispatch: dispatchSchema,
} as const;
export type CommerceOperationName = keyof typeof commerceInputSchemas;
export type CommerceInput<K extends CommerceOperationName> = z.infer<(typeof commerceInputSchemas)[K]>;
export type CommerceOutput<K extends CommerceOperationName> = z.infer<(typeof commerceOutputSchemas)[K]>;
export type CommerceProfile = z.infer<typeof commerceProfileSchema>;
export type InvoicePreview = z.infer<typeof invoicePreviewSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;
export type Dispatch = z.infer<typeof dispatchSchema>;
