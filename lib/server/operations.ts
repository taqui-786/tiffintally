import "server-only";
import { z } from "zod";
import type { Filter } from "mongodb";
import { AppError, idSchema, timestampSchema, type SellerContext } from "@/lib/contracts/common";
import { operationSchemas, outputSchemas, type OperationName, type OperationOutput } from "@/lib/contracts/api";
import type { Customer, Proposal, Receipt, Sheet, Source } from "@/lib/contracts/records";
import { calculateDay } from "@/lib/domain/orders";
import { dateRange } from "@/lib/domain/dates";
import { createCustomer, updateCustomer, updateSettings } from "./customers";
import { approveProposal, correctSource, createProposal, customerFor, editProposal, importSources, previewProposal, proposalDisposition, proposalFor, readOrderState, sourceDisposition, sourceFor } from "./orders";
import { exportSheet, finalizeSheet, getDay, sheetFor } from "./sheets";
import { found, payloadHash, readSnapshot, runCommand, type Change, type MutationScope, type ReadScope } from "./receipts";

type Handler = (raw: unknown, context: SellerContext) => Promise<unknown>;
function read<S extends z.ZodType>(schema: S, handle: (input: z.output<S>, scope: ReadScope) => Promise<unknown>): Handler {
  return async (raw, context) => {
    const input = schema.parse(raw);
    return readSnapshot(context, (scope) => handle(input, scope));
  };
}
function write<S extends z.ZodType<{ expectedStateRevision: number; meta: { idempotencyKey: string } }>>(name: OperationName, schema: S, handle: (input: z.output<S>, scope: MutationScope) => Promise<Change>): Handler {
  return async (raw, context) => {
    const input = schema.parse(raw);
    return runCommand(name, input, context, (scope) => handle(input, scope));
  };
}

const cursorSchema = z.strictObject({ scope: z.string().regex(/^[a-f0-9]{64}$/), id: idSchema, time: timestampSchema.nullable() });
function cursorFor(raw: string | undefined, scope: string) {
  if (!raw) return null;
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (cursor.scope !== scope) throw new Error("Cursor scope mismatch");
    return cursor;
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid cursor for this list.", 422);
  }
}
function page<T extends { _id: string }>(rows: T[], limit: number, scope: string, time: (row: T) => string | null) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ scope, id: last._id, time: time(last) })).toString("base64url") : null };
}

const handlers: Record<OperationName, Handler> = {
  me: read(operationSchemas.me, async (_, { seller }) => ({ seller, stateRevision: seller.stateRevision, capabilities: { manualOrders: true, textImport: true, ai: false } })),
  getSettings: read(operationSchemas.getSettings, async (_, { seller }) => ({ settings: seller.settings, stateRevision: seller.stateRevision })),
  updateSettings: write("updateSettings", operationSchemas.updateSettings, updateSettings),
  createCustomer: write("createCustomer", operationSchemas.createCustomer, createCustomer),
  updateCustomer: write("updateCustomer", operationSchemas.updateCustomer, updateCustomer),
  getCustomer: read(operationSchemas.getCustomer, (input, scope) => customerFor(scope, input.customerId)),
  listCustomers: read(operationSchemas.listCustomers, async (input, scope) => {
    const fingerprint = payloadHash({ name: "listCustomers", seller: scope.seller._id, status: input.status });
    const cursor = cursorFor(input.cursor, fingerprint);
    if (cursor?.time !== null && cursor) throw new AppError("VALIDATION_FAILED", "Invalid customer cursor.", 422);
    const filter: Filter<Customer> = { sellerId: scope.seller._id, ...(input.status ? { status: input.status } : {}), ...(cursor ? { _id: { $gt: cursor.id } } : {}) };
    const rows = await scope.db.collection<Customer>("customers").find(filter, { session: scope.session }).sort({ _id: 1 }).limit(input.limit + 1).toArray();
    return page(rows, input.limit, fingerprint, () => null);
  }),
  getSchedule: read(operationSchemas.getSchedule, async (input, scope) => {
    const dates = dateRange(input.fromDate, input.toDate);
    const customer = await customerFor(scope, input.customerId);
    const state = await readOrderState(scope);
    const plans = state.plans.filter((plan) => plan.customerId === customer._id && plan.startDate <= input.toDate && (plan.endDate === null || plan.endDate >= input.fromDate));
    const overrides = state.overrides.filter((override) => override.customerId === customer._id && override.serviceDate >= input.fromDate && override.serviceDate <= input.toDate);
    const days = dates.map((serviceDate) => {
      // A schedule describes the approved history even after its customer is archived.
      const row = calculateDay({ customers: [{ ...customer, status: "active" }], plans, overrides, serviceDate, settings: scope.seller.settings }).rows[0];
      return { serviceDate, baseline: row?.baseline ?? 0, quantity: row?.quantity ?? 0, approvalId: row?.approvalId ?? null };
    });
    return { customerId: customer._id, fromDate: input.fromDate, toDate: input.toDate, plans, overrides, days, stateRevision: scope.seller.stateRevision };
  }),
  importSources: write("importSources", operationSchemas.importSources, importSources),
  correctSource: write("correctSource", operationSchemas.correctSource, correctSource),
  sourceDisposition: write("sourceDisposition", operationSchemas.sourceDisposition, sourceDisposition),
  getSource: read(operationSchemas.getSource, async (input, scope) => {
    const source = await sourceFor(scope, input.sourceId);
    const proposals = await scope.db.collection<Proposal>("proposals").find({ sellerId: scope.seller._id, sourceId: source._id }, { session: scope.session }).sort({ createdAt: 1, _id: 1 }).toArray();
    return { source, proposals };
  }),
  listSources: read(operationSchemas.listSources, async (input, scope) => {
    const fingerprint = payloadHash({ name: "listSources", seller: scope.seller._id, status: input.status });
    const cursor = cursorFor(input.cursor, fingerprint);
    if (cursor && !cursor.time) throw new AppError("VALIDATION_FAILED", "Invalid source cursor.", 422);
    const filter: Filter<Source> = { sellerId: scope.seller._id, ...(input.status ? { status: input.status } : {}), ...(cursor?.time ? { $or: [{ receivedAt: { $gt: cursor.time } }, { receivedAt: cursor.time, _id: { $gt: cursor.id } }] } : {}) };
    const rows = await scope.db.collection<Source>("sources").find(filter, { session: scope.session }).project<Omit<Source, "text">>({ text: 0 }).sort({ receivedAt: 1, _id: 1 }).limit(input.limit + 1).toArray();
    return page(rows, input.limit, fingerprint, (row) => row.receivedAt);
  }),
  createProposal: write("createProposal", operationSchemas.createProposal, createProposal),
  editProposal: write("editProposal", operationSchemas.editProposal, editProposal),
  previewProposal: read(operationSchemas.previewProposal, previewProposal),
  approveProposal: write("approveProposal", operationSchemas.approveProposal, approveProposal),
  proposalDisposition: write("proposalDisposition", operationSchemas.proposalDisposition, proposalDisposition),
  getProposal: read(operationSchemas.getProposal, (input, scope) => proposalFor(scope, input.proposalId)),
  listProposals: read(operationSchemas.listProposals, async (input, scope) => {
    const fingerprint = payloadHash({ name: "listProposals", seller: scope.seller._id, status: input.status, sourceId: input.sourceId, serviceDate: input.serviceDate });
    const cursor = cursorFor(input.cursor, fingerprint);
    if (cursor && !cursor.time) throw new AppError("VALIDATION_FAILED", "Invalid proposal cursor.", 422);
    if (input.sourceId) await sourceFor(scope, input.sourceId);
    const and: Filter<Proposal>[] = [];
    if (cursor?.time) and.push({ $or: [{ createdAt: { $gt: cursor.time } }, { createdAt: cursor.time, _id: { $gt: cursor.id } }] });
    if (input.serviceDate) and.push({ $or: [
      { operations: { $size: 0 } }, { "missingFields.0": { $exists: true } },
      { operations: { $elemMatch: { type: "set_daily_quantity", serviceDate: input.serviceDate } } },
      { operations: { $elemMatch: { type: { $in: ["pause_interval", "resume_interval"] }, fromDate: { $lte: input.serviceDate }, toDate: { $gte: input.serviceDate } } } },
      { operations: { $elemMatch: { type: "replace_recurring_plan", startDate: { $lte: input.serviceDate }, $or: [{ endDate: null }, { endDate: { $gte: input.serviceDate } }] } } },
    ] });
    const filter: Filter<Proposal> = { sellerId: scope.seller._id, ...(input.status ? { status: input.status } : {}), ...(input.sourceId ? { sourceId: input.sourceId } : {}), ...(and.length ? { $and: and } : {}) };
    const rows = await scope.db.collection<Proposal>("proposals").find(filter, { session: scope.session }).sort({ createdAt: 1, _id: 1 }).limit(input.limit + 1).toArray();
    return page(rows, input.limit, fingerprint, (row) => row.createdAt);
  }),
  getDay: read(operationSchemas.getDay, getDay),
  finalizeSheet: write("finalizeSheet", operationSchemas.finalizeSheet, finalizeSheet),
  getSheet: read(operationSchemas.getSheet, (input, scope) => sheetFor(scope, input.sheetId)),
  exportSheet: read(operationSchemas.exportSheet, exportSheet),
  listSheets: read(operationSchemas.listSheets, async (input, scope) => {
    const fingerprint = payloadHash({ name: "listSheets", seller: scope.seller._id, serviceDate: input.serviceDate });
    const cursor = cursorFor(input.cursor, fingerprint);
    if (cursor && !cursor.time) throw new AppError("VALIDATION_FAILED", "Invalid sheet cursor.", 422);
    const filter: Filter<Sheet> = { sellerId: scope.seller._id, serviceDate: input.serviceDate, ...(cursor?.time ? { $or: [{ createdAt: { $gt: cursor.time } }, { createdAt: cursor.time, _id: { $gt: cursor.id } }] } : {}) };
    const rows = await scope.db.collection<Sheet>("sheets").find(filter, { session: scope.session }).sort({ createdAt: 1, _id: 1 }).limit(input.limit + 1).toArray();
    return page(rows, input.limit, fingerprint, (row) => row.createdAt);
  }),
  getReceipt: read(operationSchemas.getReceipt, async (input, scope) => found(await scope.db.collection<Receipt>("receipts").findOne({ sellerId: scope.seller._id, idempotencyKey: input.idempotencyKey }, { session: scope.session }))),
};

export function executeOperation<K extends OperationName>(name: K, rawInput: unknown, context: SellerContext): Promise<OperationOutput<K>>;
export async function executeOperation(name: OperationName, rawInput: unknown, context: SellerContext): Promise<unknown> {
  const parsed = operationSchemas[name].safeParse(rawInput);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Operation input is invalid.", 422);
  const output = outputSchemas[name].safeParse(await handlers[name](parsed.data, context));
  if (!output.success) throw new AppError("INTERNAL_ERROR", "The operation produced an invalid result. Reconcile its receipt before retrying a command.", 500);
  return output.data;
}
