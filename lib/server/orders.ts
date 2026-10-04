import "server-only";
import { AppError } from "@/lib/contracts/common";
import { previewSchema, type OperationInput, type Preview } from "@/lib/contracts/api";
import { proposalSchema, sourceSchema, type Customer, type DailyOverride, type Plan, type Proposal, type Sheet, type Source } from "@/lib/contracts/records";
import { applyOperations, assertOperationalDates, assertProposalReady, isAdvisoryField, previewOperations, proposalAffectsDate, transitionProposal, type OrderState } from "@/lib/domain/orders";
import { assertRevision, found, payloadHash, type Change, type MutationScope, type ReadScope } from "./receipts";

export async function customerFor(scope: ReadScope, customerId: string) {
  return found(await scope.db.collection<Customer>("customers").findOne({ _id: customerId, sellerId: scope.seller._id }, { session: scope.session }));
}

export async function sourceFor(scope: ReadScope, sourceId: string) {
  return found(await scope.db.collection<Source>("sources").findOne({ _id: sourceId, sellerId: scope.seller._id }, { session: scope.session }));
}

export async function proposalFor(scope: ReadScope, proposalId: string) {
  return found(await scope.db.collection<Proposal>("proposals").findOne({ _id: proposalId, sellerId: scope.seller._id }, { session: scope.session }));
}

async function supportingSource(scope: ReadScope, sourceId: string | null, expectedRevision: number | null) {
  if (sourceId === null) {
    assertRevision(null, expectedRevision);
    return null;
  }
  const source = await sourceFor(scope, sourceId);
  if (source.erasurePending) throw new AppError("INVALID_STATE", "Erased source evidence cannot be reused.", 409);
  assertRevision(source.revision, expectedRevision);
  if (source.status === "superseded" || source.status === "dismissed") throw new AppError("INVALID_STATE", "This source is no longer open for review.", 409);
  return source;
}

async function validateDraftReferences(scope: ReadScope, draft: Pick<Proposal, "operations" | "evidenceSpans">, source: Source | null) {
  for (const customerId of new Set(draft.operations.map((operation) => operation.customerId))) {
    const customer = await customerFor(scope, customerId);
    if (customer.status !== "active") throw new AppError("INVALID_STATE", "Archived customers cannot receive order changes.", 409);
  }
  if (draft.evidenceSpans.length && !source) throw new AppError("VALIDATION_FAILED", "Manual drafts cannot cite source text.", 422);
  if (source && draft.evidenceSpans.some((span) => span.end > source.text.length)) throw new AppError("VALIDATION_FAILED", "Evidence span is outside the source text.", 422);
}

export async function importSources(input: OperationInput<"importSources">, scope: MutationScope): Promise<Change> {
  const { db, session, seller, now, id } = scope;
  const sources: Source[] = [];
  const warnings: string[] = [];
  for (const [index, entry] of input.sources.entries()) {
    if (entry.customerId) await customerFor(scope, entry.customerId);
    const fingerprint = payloadHash({ text: entry.text.trim().replace(/\s+/g, " ").toLocaleLowerCase("en"), sentAt: entry.sentAt, customerId: entry.customerId });
    const duplicate = await db.collection<Source>("sources").findOne({ sellerId: seller._id, fingerprint }, { session });
    const source = sourceSchema.parse({ ...entry, _id: id(`source:${index}`), sellerId: seller._id, schemaVersion: 1, createdAt: now, receivedAt: now, revision: 0, status: "needs_review", deferredDate: null, fingerprint, replacesSourceId: null, dispositionReason: null });
    if (duplicate) warnings.push(`Suspected duplicate source ${duplicate._id} for imported source ${source._id}.`);
    await db.collection<Source>("sources").insertOne(source, { session });
    sources.push(source);
  }
  return { before: null, after: sources, resourceIds: sources.map((source) => source._id), warnings };
}

export async function correctSource(input: OperationInput<"correctSource">, scope: MutationScope): Promise<Change> {
  const { db, session, seller, now, id } = scope;
  const before = await sourceFor(scope, input.sourceId);
  if (before.erasurePending) throw new AppError("INVALID_STATE", "Erased source evidence cannot be corrected.", 409);
  assertRevision(before.revision, input.expectedSourceRevision);
  if (before.status === "superseded") throw new AppError("INVALID_STATE", "Correct the replacement source instead.", 409);
  if (input.customerId) await customerFor(scope, input.customerId);
  const drafts = await db.collection<Proposal>("proposals").find({ sellerId: seller._id, sourceId: before._id, status: { $in: ["needs_review", "deferred"] } }, { session }).toArray();
  const changedDrafts: Proposal[] = [];
  for (const draft of drafts) {
    const updated = proposalSchema.parse({ ...draft, status: "obsolete", draftRevision: draft.draftRevision + 1, dispositionReason: "Supporting source was corrected." });
    await db.collection<Proposal>("proposals").replaceOne({ _id: draft._id, sellerId: seller._id }, updated, { session });
    changedDrafts.push(updated);
  }
  let after: Source;
  let original: Source | null = null;
  if (input.text !== undefined || input.sentAt !== undefined) {
    original = sourceSchema.parse({ ...before, status: "superseded", revision: before.revision + 1, dispositionReason: input.reason });
    await db.collection<Source>("sources").replaceOne({ _id: before._id, sellerId: seller._id }, original, { session });
    const text = input.text ?? before.text;
    const sentAt = input.sentAt ?? before.sentAt;
    const customerId = input.customerId === undefined ? before.customerId : input.customerId;
    after = sourceSchema.parse({ ...before, _id: id("replacement-source"), createdAt: now, receivedAt: now, text, sentAt, customerId, revision: 0, status: "needs_review", deferredDate: null, replacesSourceId: before._id, upstreamId: null, dispositionReason: input.reason, fingerprint: payloadHash({ text: text.trim().replace(/\s+/g, " ").toLocaleLowerCase("en"), sentAt, customerId }) });
    await db.collection<Source>("sources").insertOne(after, { session });
  } else {
    after = sourceSchema.parse({ ...before, customerId: input.customerId === undefined ? before.customerId : input.customerId, revision: before.revision + 1, status: "needs_review", deferredDate: null, dispositionReason: input.reason });
    await db.collection<Source>("sources").replaceOne({ _id: before._id, sellerId: seller._id }, after, { session });
  }
  return { before: { source: before, proposals: drafts }, after: { source: after, original, proposals: changedDrafts }, resourceIds: [before._id, after._id, ...drafts.map((draft) => draft._id)] };
}

export async function sourceDisposition(input: OperationInput<"sourceDisposition">, scope: MutationScope): Promise<Change> {
  const { db, session, seller } = scope;
  const before = await sourceFor(scope, input.sourceId);
  assertRevision(before.revision, input.expectedSourceRevision);
  if (before.status === "superseded") throw new AppError("INVALID_STATE", "A superseded source cannot be reopened or disposed.", 409);
  const drafts = await db.collection<Proposal>("proposals").find({ sellerId: seller._id, sourceId: before._id, status: { $in: ["needs_review", "deferred"] } }, { session }).toArray();
  if (input.action !== "reopen" && drafts.some((draft) => input.action !== "defer" || draft.status !== "deferred" || draft.deferredDate !== input.serviceDate)) throw new AppError("PENDING_REVIEW", "Resolve linked proposals consistently before disposing this source.", 409);
  const status = input.action === "dismiss" ? "dismissed" : input.action === "defer" ? "deferred" : "needs_review";
  const after = sourceSchema.parse({ ...before, status, revision: before.revision + 1, deferredDate: input.action === "defer" ? input.serviceDate : null, dispositionReason: input.reason });
  await db.collection<Source>("sources").replaceOne({ _id: before._id, sellerId: seller._id }, after, { session });
  return { before, after, resourceIds: [after._id], affectedDates: input.serviceDate ? [input.serviceDate] : [] };
}

export async function createProposal(input: OperationInput<"createProposal">, scope: MutationScope): Promise<Change> {
  const { db, session, seller, now, id } = scope;
  const source = await supportingSource(scope, input.sourceId, input.expectedSourceRevision);
  await validateDraftReferences(scope, input, source);
  const proposal = proposalSchema.parse({ _id: id("proposal"), sellerId: seller._id, schemaVersion: 1, createdAt: now, sourceId: input.sourceId, sourceRevision: source?.revision ?? null, manualReason: input.manualReason, operations: input.operations, evidenceSpans: input.evidenceSpans, missingFields: input.missingFields, draftRevision: 0, status: "needs_review", deferredDate: null, dispositionReason: null });
  await db.collection<Proposal>("proposals").insertOne(proposal, { session });
  if (source) await db.collection<Source>("sources").updateOne({ _id: source._id, sellerId: seller._id }, { $set: { status: "needs_review", deferredDate: null } }, { session });
  return { before: source ? { source } : null, after: { proposal, source: source ? { ...source, status: "needs_review", deferredDate: null } : null }, resourceIds: [proposal._id, ...(source ? [source._id] : [])] };
}

export async function editProposal(input: OperationInput<"editProposal">, scope: MutationScope): Promise<Change> {
  const { db, session, seller } = scope;
  const before = await proposalFor(scope, input.proposalId);
  assertRevision(before.draftRevision, input.expectedDraftRevision);
  if (before.status !== "needs_review") throw new AppError("INVALID_STATE", "Only an open review draft can be edited.", 409);
  const source = await supportingSource(scope, before.sourceId, input.expectedSourceRevision);
  await validateDraftReferences(scope, input, source);
  const after = proposalSchema.parse({ ...before, operations: input.operations, evidenceSpans: input.evidenceSpans, missingFields: input.missingFields, sourceRevision: source?.revision ?? null, draftRevision: before.draftRevision + 1 });
  await db.collection<Proposal>("proposals").replaceOne({ _id: before._id, sellerId: seller._id }, after, { session });
  return { before, after, resourceIds: [after._id] };
}

export async function resolveSource(scope: ReadScope, sourceId: string | null): Promise<Source | null> {
  if (!sourceId) return null;
  const source = await sourceFor(scope, sourceId);
  const proposals = await scope.db.collection<Proposal>("proposals").find({ sellerId: scope.seller._id, sourceId, sourceRevision: source.revision }, { session: scope.session }).toArray();
  if (proposals.length && proposals.every((proposal) => proposal.status === "approved" || proposal.status === "rejected")) {
    const after = sourceSchema.parse({ ...source, status: "resolved", deferredDate: null });
    await scope.db.collection<Source>("sources").replaceOne({ _id: sourceId, sellerId: scope.seller._id }, after, { session: scope.session });
    return after;
  }
  return source;
}

export async function proposalDisposition(input: OperationInput<"proposalDisposition">, scope: MutationScope): Promise<Change> {
  const { db, session, seller } = scope;
  const before = await proposalFor(scope, input.proposalId);
  assertRevision(before.draftRevision, input.expectedDraftRevision);
  const source = await supportingSource(scope, before.sourceId, input.expectedSourceRevision);
  const status = transitionProposal(before.status, input.action, input.serviceDate);
  const after = proposalSchema.parse({ ...before, status, sourceRevision: source?.revision ?? null, deferredDate: input.action === "defer" ? input.serviceDate : null, dispositionReason: input.reason, draftRevision: before.draftRevision + 1 });
  await db.collection<Proposal>("proposals").replaceOne({ _id: before._id, sellerId: seller._id }, after, { session });
  const afterSource = input.action === "reject" ? await resolveSource(scope, before.sourceId) : source;
  return { before: { proposal: before, source }, after: { proposal: after, source: afterSource }, resourceIds: [after._id, ...(source ? [source._id] : [])], affectedDates: input.serviceDate ? [input.serviceDate] : [] };
}

export async function readOrderState(scope: ReadScope): Promise<OrderState> {
  const filter = { sellerId: scope.seller._id };
  const options = { session: scope.session };
  const customers = await scope.db.collection<Customer>("customers").find(filter, options).toArray();
  const plans = await scope.db.collection<Plan>("plans").find(filter, options).toArray();
  const overrides = await scope.db.collection<DailyOverride>("dailyOverrides").find(filter, options).toArray();
  return { customers, plans, overrides };
}

export async function previewProposal(input: OperationInput<"previewProposal">, scope: ReadScope): Promise<Preview> {
  const proposal = await proposalFor(scope, input.proposalId);
  assertRevision(proposal.draftRevision, input.expectedDraftRevision);
  if (proposal.status !== "needs_review") throw new AppError("INVALID_STATE", "Only an open draft can be previewed.", 409);
  const source = await supportingSource(scope, proposal.sourceId, proposal.sourceRevision);
  await validateDraftReferences(scope, proposal, source);
  const state = await readOrderState(scope);
  const sheets = await scope.db.collection<Sheet>("sheets").find({ sellerId: scope.seller._id }, { session: scope.session }).toArray();
  assertOperationalDates(proposal.operations, sheets, scope.seller.settings, scope.now);
  const missingFields = proposal.missingFields.filter((field) => !isAdvisoryField(field));
  if (!proposal.operations.length) missingFields.push("operations");
  if (source && (!source.customerId || proposal.operations.some((operation) => operation.customerId !== source.customerId))) missingFields.push("confirmed source customer");
  if (source && !proposal.evidenceSpans.length) missingFields.push("supporting evidence spans");
  const changes = proposal.operations.length
    ? previewOperations({ ...state, operations: proposal.operations, settings: scope.seller.settings, now: scope.now })
    : { operations: proposal.operations, affectedDates: [], effects: [], totals: [], conflicts: [], requiredAcknowledgements: [], continuesBeyondWindow: false };
  const requiredAcknowledgements: Preview["requiredAcknowledgements"] = [...changes.requiredAcknowledgements];
  if (sheets.some((sheet) => proposalAffectsDate(proposal, sheet.serviceDate)) && !requiredAcknowledgements.includes("late_change")) requiredAcknowledgements.push("late_change");
  const canonical = {
    ...changes, requiredAcknowledgements, proposalId: proposal._id, sourceId: proposal.sourceId,
    sourceRevision: source?.revision ?? null, missingFields: [...new Set(missingFields)].slice(0, 40),
    expectedDraftRevision: proposal.draftRevision, expectedStateRevision: scope.seller.stateRevision,
  };
  return previewSchema.parse({ ...canonical, previewHash: payloadHash(canonical) });
}

export async function approveProposal(input: OperationInput<"approveProposal">, scope: MutationScope): Promise<Change> {
  const { db, session, seller, now, id, receiptId } = scope;
  const before = await proposalFor(scope, input.proposalId);
  assertRevision(before.draftRevision, input.expectedDraftRevision);
  const source = await supportingSource(scope, before.sourceId, input.expectedSourceRevision);
  assertRevision(before.sourceRevision, input.expectedSourceRevision);
  assertProposalReady(before, source);
  const preview = await previewProposal(input, scope);
  if (preview.previewHash !== input.previewHash) throw new AppError("STALE_REVISION", "Preview has changed; review a fresh preview.", 409);
  const required = [...new Set(preview.conflicts.map((conflict) => conflict.approvalId))].sort();
  const acknowledged = [...new Set(input.supersedesApprovalIds)].sort();
  if (required.join() !== acknowledged.join()) throw new AppError("OVERLAPPING_CHANGE", "Explicitly acknowledge exactly the approvals being superseded.", 409);
  if (preview.requiredAcknowledgements.includes("late_change") && !input.acknowledgeLateChange) throw new AppError("INVALID_STATE", "Acknowledge this late change before approving.", 409);
  const state = await readOrderState(scope);
  let counter = 0;
  const next = applyOperations(state, before.operations, { approvalId: receiptId, createdAt: now, makeId: () => id(`fulfillment:${counter++}`), settings: seller.settings });
  const oldPlans = state.plans.filter((plan) => !next.plans.some((nextPlan) => nextPlan._id === plan._id));
  const newPlans = next.plans.filter((plan) => !state.plans.some((oldPlan) => oldPlan._id === plan._id));
  const oldOverrides = state.overrides.filter((override) => !next.overrides.some((nextOverride) => nextOverride._id === override._id));
  const newOverrides = next.overrides.filter((override) => !state.overrides.some((oldOverride) => oldOverride._id === override._id));
  for (const plan of oldPlans) await db.collection<Plan>("plans").deleteOne({ _id: plan._id, sellerId: seller._id }, { session });
  for (const plan of newPlans) await db.collection<Plan>("plans").insertOne(plan, { session });
  for (const override of oldOverrides) await db.collection<DailyOverride>("dailyOverrides").deleteOne({ _id: override._id, sellerId: seller._id }, { session });
  for (const override of newOverrides) await db.collection<DailyOverride>("dailyOverrides").insertOne(override, { session });
  const after = proposalSchema.parse({ ...before, status: "approved", draftRevision: before.draftRevision + 1, deferredDate: null });
  await db.collection<Proposal>("proposals").replaceOne({ _id: before._id, sellerId: seller._id }, after, { session });
  const afterSource = await resolveSource(scope, before.sourceId);
  return {
    before: { proposal: before, source, plans: oldPlans, overrides: oldOverrides },
    after: { proposal: after, source: afterSource, plans: newPlans, overrides: newOverrides, supersedesApprovalIds: required, acknowledgeLateChange: input.acknowledgeLateChange },
    resourceIds: [before._id, ...new Set(before.operations.map((operation) => operation.customerId)), ...(source ? [source._id] : [])],
    affectedDates: preview.affectedDates,
    warnings: preview.continuesBeyondWindow ? ["Recurring changes continue beyond the 31-day preview window."] : [],
  };
}
