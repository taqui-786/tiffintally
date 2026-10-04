import "server-only";
import type { Document, Filter } from "mongodb";
import { AppError, type SellerContext } from "@/lib/contracts/common";
import { commerceInputSchemas, commerceOutputSchemas, commerceProfileSchema, commerceSettingsSchema, invoicePreviewSchema, invoiceSchema, type CommerceInput, type CommerceOperationName, type CommerceOutput, type CommerceProfile, type Invoice, type InvoicePreview } from "@/lib/contracts/commerce";
import { planSchema, type Customer, type DailyOverride, type Plan, type Proposal, type Receipt, type Sheet, type Source } from "@/lib/contracts/records";
import { billingMonthDates, calculateBilling, invoiceMessage } from "@/lib/domain/billing";
import { isServiceDate, localDateAt, parseDate } from "@/lib/domain/dates";
import { baselineQuantity, pendingReviewCount } from "@/lib/domain/orders";
import { customerFor } from "./orders";
import { assertRevision, found, payloadHash, readSnapshot, runCommand, type Change, type MutationScope, type ReadScope } from "./receipts";

export const DEFAULT_COMMERCE_PROFILE: CommerceProfile = { unitPricePaise: null, phone: "", routeName: "", routeOrder: 0, deliveryNote: "" };
export const DEFAULT_COMMERCE_SETTINGS = { upiId: "", helperPhone: "" };
type SettingsRecord = { _id: string; sellerId: string; settings: typeof DEFAULT_COMMERCE_SETTINGS; updatedAt: string };
type ProfileRecord = { _id: string; sellerId: string; customerId: string; profile: CommerceProfile; revision: number; createdAt: string; updatedAt: string };
type InvoiceRecord = Invoice & { sellerId: string };
type Operation = Exclude<CommerceOperationName, "getDispatch">;

// ponytail: bounded in-memory month reconciliation for <=100 customers; refuse oversized histories.
async function bounded<T extends Document>(scope: ReadScope, collection: string, filter: Filter<T>, limit: number, projection?: Document): Promise<T[]> {
  const rows = await scope.db.collection<T>(collection).find(filter, { session: scope.session, projection }).limit(limit + 1).toArray();
  if (rows.length > limit) throw new AppError("INVALID_STATE", `${collection} exceeds the supported billing reconciliation limit (${limit}); reconcile history before continuing.`, 409);
  return rows as T[];
}

export async function loadCommerceSettings(scope: ReadScope) {
  const row = await scope.db.collection<SettingsRecord>("commerceSettings").findOne({ _id: scope.seller._id, sellerId: scope.seller._id }, { session: scope.session });
  return commerceSettingsSchema.parse(row?.settings ?? DEFAULT_COMMERCE_SETTINGS);
}

export async function loadCommerceProfiles(scope: ReadScope) {
  return bounded<ProfileRecord>(scope, "customerCommerce", { sellerId: scope.seller._id }, 100);
}

async function profileFor(scope: ReadScope, customerId: string) {
  return scope.db.collection<ProfileRecord>("customerCommerce").findOne({ _id: `${scope.seller._id}_${customerId}`, sellerId: scope.seller._id, customerId }, { session: scope.session });
}

async function getCommerceSetup(scope: ReadScope) {
  const customers = await bounded<Customer>(scope, "customers", { sellerId: scope.seller._id }, 100);
  const profiles = await loadCommerceProfiles(scope);
  return {
    settings: await loadCommerceSettings(scope), stateRevision: scope.seller.stateRevision,
    customers: customers.sort((a, b) => a.alias.localeCompare(b.alias) || a._id.localeCompare(b._id)).map((customer) => {
      const row = profiles.find((profile) => profile.customerId === customer._id);
      return { customerId: customer._id, alias: customer.alias, status: customer.status, profile: commerceProfileSchema.parse(row?.profile ?? DEFAULT_COMMERCE_PROFILE), revision: row?.revision ?? null };
    }),
  };
}

async function saveCommerceSettings(input: CommerceInput<"saveCommerceSettings">, scope: MutationScope): Promise<Change> {
  const { db, session, seller, now } = scope;
  const before = await db.collection<SettingsRecord>("commerceSettings").findOne({ _id: seller._id, sellerId: seller._id }, { session });
  const after: SettingsRecord = { _id: seller._id, sellerId: seller._id, settings: input.settings, updatedAt: now };
  await db.collection<SettingsRecord>("commerceSettings").replaceOne({ _id: seller._id, sellerId: seller._id }, after, { session, upsert: true });
  return { before, after, resourceIds: [seller._id] };
}

async function saveCommerceCustomer(input: CommerceInput<"saveCommerceCustomer">, scope: MutationScope): Promise<Change> {
  await customerFor(scope, input.customerId);
  const before = await profileFor(scope, input.customerId);
  assertRevision(before?.revision ?? null, input.expectedProfileRevision);
  if (before && before.revision >= Number.MAX_SAFE_INTEGER - 2) throw new AppError("INVALID_STATE", "Customer commerce revision limit reached.", 409);
  const after: ProfileRecord = { _id: `${scope.seller._id}_${input.customerId}`, sellerId: scope.seller._id, customerId: input.customerId, profile: input.profile, revision: (before?.revision ?? -1) + 1, createdAt: before?.createdAt ?? scope.now, updatedAt: scope.now };
  await scope.db.collection<ProfileRecord>("customerCommerce").replaceOne({ _id: after._id, sellerId: scope.seller._id }, after, { session: scope.session, upsert: true });
  return { before, after, resourceIds: [input.customerId] };
}

function invoiceOutput(row: InvoiceRecord): Invoice {
  const invoice: Partial<InvoiceRecord> = { ...row };
  delete invoice.sellerId;
  return invoiceSchema.parse(invoice);
}

function validMonth(month: string, scope: ReadScope) {
  const dates = billingMonthDates(month);
  if (month > localDateAt(scope.now, scope.seller.settings.timezone).slice(0, 7)) throw new AppError("VALIDATION_FAILED", "Future billing months are not available.", 422);
  return dates;
}

/** Rebuild the approved plan snapshot at a sheet's revision, including deleted historical plans. */
function plansAt(receipts: Receipt[], stateRevision: number, customerId: string): Plan[] {
  const plans = new Map<string, Plan>();
  for (const receipt of receipts) {
    if (receipt.stateRevision > stateRevision) break;
    const before = receipt.before as { plans?: unknown[] } | null;
    const after = receipt.after as { plans?: unknown[] } | null;
    for (const raw of before?.plans ?? []) {
      const parsed = planSchema.safeParse(raw);
      if (parsed.success && parsed.data.customerId === customerId) plans.delete(parsed.data._id);
    }
    for (const raw of after?.plans ?? []) {
      const parsed = planSchema.safeParse(raw);
      if (parsed.success && parsed.data.customerId === customerId) plans.set(parsed.data._id, parsed.data);
    }
  }
  return [...plans.values()];
}

function proofFor(sheet: Sheet, row: Sheet["rows"][number], receipts: Receipt[], currentPlans: Plan[]) {
  const historical = plansAt(receipts, sheet.computedFromStateRevision, row.customerId);
  const baselinePlan = (historical.length ? historical : currentPlans).find((plan) => plan.startDate <= sheet.serviceDate && (plan.endDate === null || plan.endDate >= sheet.serviceDate) && plan.quantities[parseDate(sheet.serviceDate).dayOfWeek - 1] === row.baseline);
  const approvalId = row.approvalId ?? (row.baseline > 0 ? baselinePlan?.approvalId ?? null : null);
  const receipt = approvalId ? receipts.find((item) => item._id === approvalId && item.stateRevision <= sheet.computedFromStateRevision) : undefined;
  return {
    serviceDate: sheet.serviceDate, baseline: row.baseline, quantity: row.quantity,
    sheetId: sheet._id, sheetRevision: sheet.revision, finalizedAt: sheet.finalizedAt,
    approvalReceiptId: receipt?._id ?? null, approvalReceiptKey: receipt?.idempotencyKey ?? null, approvedAt: receipt?.committedAt ?? null,
  };
}

export async function previewInvoice(input: CommerceInput<"previewInvoice">, scope: ReadScope): Promise<InvoicePreview> {
  const dates = validMonth(input.month, scope);
  const from = dates[0], to = dates.at(-1)!;
  const customer = await customerFor(scope, input.customerId);
  const profileRecord = await profileFor(scope, customer._id);
  const profile = commerceProfileSchema.parse(profileRecord?.profile ?? DEFAULT_COMMERCE_PROFILE);
  const settings = await loadCommerceSettings(scope);
  const common = { sellerId: scope.seller._id, customerId: customer._id };
  const plans = await bounded<Plan>(scope, "plans", { ...common, startDate: { $lte: to }, $or: [{ endDate: null }, { endDate: { $gte: from } }] }, 1000);
  const overrides = await bounded<DailyOverride>(scope, "dailyOverrides", { ...common, serviceDate: { $gte: from, $lte: to } }, 31);
  // Ten versions per calendar day on average is a deliberate reconciliation ceiling, never a truncation.
  const versions = await bounded<Sheet>(scope, "sheets", { sellerId: scope.seller._id, serviceDate: { $gte: from, $lte: to } }, 310);
  const latest = new Map<string, Sheet>();
  for (const sheet of versions) {
    const previous = latest.get(sheet.serviceDate);
    if (previous?.revision === sheet.revision) throw new AppError("INVALID_STATE", "Duplicate finalized sheet revision requires reconciliation.", 409);
    if (!previous || sheet.revision > previous.revision) latest.set(sheet.serviceDate, sheet);
  }
  const receipts = (await bounded<Receipt>(scope, "receipts", { sellerId: scope.seller._id, operation: "approveProposal", resourceIds: customer._id }, 1000, {
    _id: 1, operation: 1, sellerId: 1, idempotencyKey: 1, committedAt: 1, stateRevision: 1,
    "before.plans": 1, "after.plans": 1,
  })).sort((a, b) => a.stateRevision - b.stateRevision);
  const proofs: Parameters<typeof calculateBilling>[0] = [];
  for (const sheet of latest.values()) {
    const rows = sheet.rows.filter((row) => row.customerId === customer._id);
    if (rows.length > 1) throw new AppError("INVALID_STATE", "Duplicate customer rows require sheet reconciliation.", 409);
    if (rows[0]) proofs.push(proofFor(sheet, rows[0], receipts, plans));
  }
   const createdDate = localDateAt(customer.createdAt, scope.seller.settings.timezone);
   const approvedPlans = plansAt(receipts, scope.seller.stateRevision, customer._id);
   const expectedPlans = approvedPlans.length ? approvedPlans : plans;
  const expectedDates = dates.filter((date) => {
    const frozen = proofs.find((row) => row.serviceDate === date);
    if (frozen && (frozen.baseline > 0 || frozen.quantity > 0)) return true;
    // An explicitly approved backdated plan/override still requires finalization; it never creates a charge.
     const baseline = isServiceDate(date, scope.seller.settings.weekdays) ? baselineQuantity(customer._id, date, expectedPlans) : 0;
    const quantity = overrides.find((row) => row.serviceDate === date)?.quantity ?? baseline;
    return baseline > 0 || quantity > 0;
  });
  const missingDates = expectedDates.filter((date) => !proofs.some((row) => row.serviceDate === date));
  // Sources are projected without text. Approval audit snapshots above also omit source messages.
  const sources = await bounded<Source>(scope, "sources", {
    sellerId: scope.seller._id, customerId: { $in: [customer._id, null] }, status: { $in: ["needs_review", "deferred", "resolved"] },
  }, 1000, { text: 0 });
  const proposals = await bounded<Proposal>(scope, "proposals", {
    sellerId: scope.seller._id,
    $or: [{ "operations.customerId": customer._id }, { sourceId: { $in: sources.map((source) => source._id) } }, { operations: { $size: 0 } }, { "missingFields.0": { $exists: true } }],
  }, 1000);
  const relevantDates = dates.filter((date) => expectedDates.includes(date) || (date >= createdDate && isServiceDate(date, scope.seller.settings.weekdays)));
  const pending = relevantDates.some((date) => pendingReviewCount(sources, proposals, date) > 0);
  const closed = input.month < localDateAt(scope.now, scope.seller.settings.timezone).slice(0, 7);
  const noRows = !proofs.some((row) => row.baseline > 0 || row.quantity > 0);
  const missingProof = proofs.some((row) => (row.baseline > 0 || row.quantity > 0) && !row.approvalReceiptId);
  const warnings = [
    ...(!closed ? ["Current month is not closed."] : []),
    ...(missingDates.length ? ["Approved service dates are missing finalized customer rows."] : []),
    ...(profile.unitPricePaise === null ? ["Customer meal price is not configured."] : []),
    ...(noRows ? ["No finalized ordered rows are available for this customer and month."] : []),
    ...(pending ? ["Relevant pending orders remain unreconciled."] : []),
    ...(missingProof ? ["Some finalized rows lack a matching approved-order receipt."] : []),
  ];
  const priorRecord = await scope.db.collection<InvoiceRecord>("invoices").findOne({ ...common, month: input.month }, { session: scope.session, sort: { version: -1, _id: -1 } });
  const priorInvoiceId = priorRecord?._id ?? null;
  const facts = {
    customerId: customer._id, alias: customer.alias, month: input.month, currency: "INR" as const,
    unitPricePaise: profile.unitPricePaise, phone: profile.phone, upiId: settings.upiId,
    ...calculateBilling(proofs, profile.unitPricePaise, input.adjustments),
    missingDates, warnings, canIssue: warnings.length === 0,
    expectedStateRevision: scope.seller.stateRevision, priorInvoiceId,
  };
  const basisHash = payloadHash({ ...facts, adjustments: [...input.adjustments].sort((a, b) => a.serviceDate.localeCompare(b.serviceDate)), profileRevision: profileRecord?.revision ?? null });
  return invoicePreviewSchema.parse({ ...facts, basisHash, message: invoiceMessage(facts) });
}

async function createInvoice(input: CommerceInput<"createInvoice">, scope: MutationScope): Promise<Change> {
  const preview = await previewInvoice(input, scope);
  if (preview.basisHash !== input.expectedBasisHash || preview.priorInvoiceId !== input.expectedPriorInvoiceId) throw new AppError("STALE_REVISION", "The invoice basis has changed; review a fresh preview.", 409);
  if (!preview.canIssue) throw new AppError("INVALID_STATE", "Resolve all billing warnings before issuing a statement.", 409);
  const before = preview.priorInvoiceId ? invoiceOutput(found(await scope.db.collection<InvoiceRecord>("invoices").findOne({ _id: preview.priorInvoiceId, sellerId: scope.seller._id, customerId: input.customerId, month: input.month }, { session: scope.session }))) : null;
  if (before && before.version >= Number.MAX_SAFE_INTEGER - 2) throw new AppError("INVALID_STATE", "Invoice version limit reached.", 409);
   const version = (before?.version ?? 0) + 1;
   const message = `Meal statement · version ${version}${before ? `\nReplaces version ${before.version} for ${input.month}. Do not pay both statements.` : ""}\n${preview.message}`;
   const invoice = invoiceSchema.parse({ ...preview, message, _id: scope.id("invoice"), version, status: "issued", issuedAt: scope.now, issuedBy: scope.context.userId, previousInvoiceId: preview.priorInvoiceId });
  await scope.db.collection<InvoiceRecord>("invoices").insertOne({ ...invoice, sellerId: scope.seller._id }, { session: scope.session });
  return { before, after: invoice, resourceIds: [invoice._id, input.customerId], affectedDates: invoice.lines.map((line) => line.serviceDate) };
}

export function executeCommerceOperation<K extends Operation>(name: K, raw: unknown, context: SellerContext): Promise<CommerceOutput<K>>;
export async function executeCommerceOperation(name: CommerceOperationName, raw: unknown, context: SellerContext): Promise<unknown> {
  if (!Object.hasOwn(commerceInputSchemas, name)) throw new AppError("VALIDATION_FAILED", "Unknown commerce operation.", 422);
  if (name === "getDispatch") throw new AppError("VALIDATION_FAILED", "Dispatch is handled by the dispatch service.", 422);
  const parsed = commerceInputSchemas[name].safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Commerce input is invalid.", 422);
  let output: unknown;
  switch (name) {
    case "getCommerceSetup": output = await readSnapshot(context, getCommerceSetup); break;
    case "saveCommerceSettings": {
      const input = commerceInputSchemas.saveCommerceSettings.parse(parsed.data);
      output = await runCommand(name, input, context, (scope) => saveCommerceSettings(input, scope)); break;
    }
    case "saveCommerceCustomer": {
      const input = commerceInputSchemas.saveCommerceCustomer.parse(parsed.data);
      output = await runCommand(name, input, context, (scope) => saveCommerceCustomer(input, scope)); break;
    }
    case "previewInvoice": output = await readSnapshot(context, (scope) => previewInvoice(commerceInputSchemas.previewInvoice.parse(parsed.data), scope)); break;
    case "createInvoice": {
      const input = commerceInputSchemas.createInvoice.parse(parsed.data);
      output = await runCommand(name, input, context, (scope) => createInvoice(input, scope)); break;
    }
    case "listInvoices": {
      const input = commerceInputSchemas.listInvoices.parse(parsed.data);
      output = await readSnapshot(context, async (scope) => {
        validMonth(input.month, scope);
        if (input.customerId) await customerFor(scope, input.customerId);
        const rows = await scope.db.collection<InvoiceRecord>("invoices").find({ sellerId: scope.seller._id, month: input.month, ...(input.customerId ? { customerId: input.customerId } : {}) }, { session: scope.session }).sort({ issuedAt: -1, version: -1, _id: -1 }).limit(101).toArray();
        return { items: rows.slice(0, 100).map(invoiceOutput), hasMore: rows.length > 100 };
      }); break;
    }
    case "getInvoice": {
      const input = commerceInputSchemas.getInvoice.parse(parsed.data);
      output = await readSnapshot(context, async (scope) => {
        const record = found(await scope.db.collection<InvoiceRecord>("invoices").findOne({ _id: input.invoiceId, sellerId: scope.seller._id }, { session: scope.session }));
        await customerFor(scope, record.customerId);
        return invoiceOutput(record);
      }); break;
    }
  }
  const result = commerceOutputSchemas[name].safeParse(output);
  if (!result.success) throw new AppError("INTERNAL_ERROR", "Commerce produced an invalid result; reconcile its receipt before retrying a command.", 500);
  return result.data;
}
