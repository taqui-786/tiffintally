import "server-only";
import { stringify } from "csv-stringify/sync";
import { AppError } from "@/lib/contracts/common";
import type { OperationInput, OperationOutput } from "@/lib/contracts/api";
import { sheetSchema, type Proposal, type Sheet, type Source } from "@/lib/contracts/records";
import { isLateServiceDate, localDateAt } from "@/lib/domain/dates";
import { calculateDay, pendingReviewCount } from "@/lib/domain/orders";
import { safeCsvCell, sheetDelta } from "@/lib/domain/sheets";
import { readOrderState } from "./orders";
import { found, type Change, type MutationScope, type ReadScope } from "./receipts";

export async function sheetFor(scope: ReadScope, sheetId: string): Promise<Sheet> {
  return found(await scope.db.collection<Sheet>("sheets").findOne({ _id: sheetId, sellerId: scope.seller._id }, { session: scope.session }));
}

export async function dayFacts(serviceDate: string, scope: ReadScope) {
  const { db, session, seller } = scope;
  const state = await readOrderState(scope);
  const sources = await db.collection<Source>("sources").find({ sellerId: seller._id }, { session }).toArray();
  const proposals = await db.collection<Proposal>("proposals").find({ sellerId: seller._id }, { session }).toArray();
  const latest = await db.collection<Sheet>("sheets").findOne({ sellerId: seller._id, serviceDate }, { session, sort: { revision: -1 } });
  const calculated = calculateDay({ ...state, serviceDate, settings: seller.settings });
  return { ...calculated, sources, proposals, latest, pendingCount: pendingReviewCount(sources, proposals, serviceDate) };
}

export async function getDay(input: OperationInput<"getDay">, scope: ReadScope): Promise<OperationOutput<"getDay">> {
  const facts = await dayFacts(input.serviceDate, scope);
  const frozen = facts.latest && input.serviceDate < localDateAt(scope.now, scope.seller.settings.timezone) ? facts.latest : null;
  return { serviceDate: input.serviceDate, rows: frozen?.rows ?? facts.rows, total: frozen?.total ?? facts.total, pendingCount: facts.pendingCount, latestSheetId: facts.latest?._id ?? null, stateRevision: scope.seller.stateRevision };
}

export async function finalizeSheet(input: OperationInput<"finalizeSheet">, scope: MutationScope): Promise<Change> {
  const { db, session, seller, now, id, context } = scope;
  const facts = await dayFacts(input.serviceDate, scope);
  if ((facts.latest?._id ?? null) !== input.expectedPriorSheetId) throw new AppError("STALE_REVISION", "The prior sheet has changed; refresh before finalizing.", 409);
  if (facts.latest && input.serviceDate < localDateAt(now, seller.settings.timezone)) throw new AppError("INVALID_STATE", "Past finalized service days are read-only.", 409);
  if (facts.pendingCount) throw new AppError("PENDING_REVIEW", "Resolve or explicitly defer relevant sources and proposals before finalizing.", 409);
  if ((facts.latest || isLateServiceDate(input.serviceDate, seller.settings, now)) && !input.acknowledgeLateChange) throw new AppError("INVALID_STATE", "Acknowledge the late change or sheet amendment.", 409);
  const sheet = sheetSchema.parse({
    _id: id("sheet"), sellerId: seller._id, schemaVersion: 1, createdAt: now, serviceDate: input.serviceDate,
    revision: (facts.latest?.revision ?? 0) + 1, rows: facts.rows, total: facts.total,
    computedFromStateRevision: seller.stateRevision, committedStateRevision: seller.stateRevision + 1,
    finalizedBy: context.userId, finalizedAt: now, previousSheetId: facts.latest?._id ?? null,
    delta: sheetDelta(facts.latest?.rows ?? [], facts.rows),
  });
  await db.collection<Sheet>("sheets").insertOne(sheet, { session });
  const deferredSources = facts.sources.filter((source) => source.status === "deferred" && source.deferredDate === input.serviceDate);
  const deferredProposals = facts.proposals.filter((proposal) => proposal.status === "deferred" && proposal.deferredDate === input.serviceDate);
  return { before: facts.latest, after: { sheet, deferredSources, deferredProposals, acknowledgeLateChange: input.acknowledgeLateChange }, resourceIds: [sheet._id], affectedDates: [input.serviceDate] };
}

export async function exportSheet(input: OperationInput<"exportSheet">, scope: ReadScope): Promise<OperationOutput<"exportSheet">> {
  const sheet = await sheetFor(scope, input.sheetId);
  const rows = sheet.rows.map((row) => ({
    serviceDate: sheet.serviceDate, revision: sheet.revision, finalizedAt: sheet.finalizedAt,
    customerId: row.customerId, alias: safeCsvCell(row.alias), quantity: row.quantity, packingNote: safeCsvCell(row.packingNote),
  }));
  return {
    filename: `packing-${sheet.serviceDate}-r${sheet.revision}.csv`, contentType: "text/csv; charset=utf-8",
    csv: stringify(rows, { header: true, columns: ["serviceDate", "revision", "finalizedAt", "customerId", "alias", "quantity", "packingNote"], escape_formulas: true }),
  };
}
