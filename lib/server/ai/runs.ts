import "server-only";
import { randomUUID } from "node:crypto";
import { MongoServerError, type ClientSession, type Db, type IndexDescription } from "mongodb";
import { z } from "zod";
import { AppError, idSchema, type SellerContext } from "@/lib/contracts/common";
import { analysisRunViewSchema, type AnalysisRunView, type IntelligenceInput } from "@/lib/contracts/intelligence";
import { receiptSchema, sourceSchema, type Customer, type Plan, type Proposal, type Receipt, type Seller, type Source } from "@/lib/contracts/records";
import { getClient, getDb } from "@/lib/server/db/client";
import { assertRevision, found, ownerSeller, payloadHash } from "@/lib/server/receipts";
import { extractionSchema, jevResultSchema } from "./schemas";
import { EXTRACTION_PROMPT, PROMPT_VERSION, gemmaContent, type ModelSourceContext } from "./prompts";
import type { AiConfig } from "./config";
import { assertModelInput, type ProviderMetadata } from "./backboard";

export const aiRunRecordSchema = analysisRunViewSchema.extend({
  _id: idSchema, sellerId: idSchema, payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  capturedDraftHash: z.string(), capturedPlanHash: z.string(),
  providerIds: z.array(z.strictObject({ stage: z.enum(["gemma", "jev"]), assistantId: z.string().max(256).optional(), threadId: z.string().max(256).optional(), messageId: z.string().max(256).optional(), runId: z.string().max(256).optional() })).max(4),
  extraction: extractionSchema.nullable(), classification: jevResultSchema.nullable(),
});
export type AiRunRecord = z.infer<typeof aiRunRecordSchema>;
export interface ClassificationRecord {
  _id: string; sellerId: string; sourceId: string; sourceRevision: number; computedAt: string;
  labels: string[]; intent: string; probabilities: Record<string, number>; model: string; promptVersion: string; runId: string;
}
export interface AiAdmission {
  _id: string; sellerId: string; budgetPeriod: string; requestsReserved: number; inputTokensReserved: number;
  leaseRunId: string | null; leaseDeadline: string | null;
}
export const aiIndexes: Record<string, IndexDescription[]> = {
  aiRuns: [
    { key: { sellerId: 1, requestKey: 1 }, name: "ai_seller_key_unique", unique: true },
    { key: { sellerId: 1, state: 1, deadline: 1 }, name: "ai_seller_state_deadline" },
    { key: { sellerId: 1, sourceId: 1, sourceRevision: 1 }, name: "ai_seller_source_revision" },
  ],
  classifications: [
    { key: { sellerId: 1, sourceId: 1, sourceRevision: 1, runId: 1 }, name: "classification_source_run_unique", unique: true },
    { key: { sellerId: 1, computedAt: 1 }, name: "classification_seller_computed" },
  ],
  aiAdmissions: [{ key: { sellerId: 1, budgetPeriod: 1 }, name: "ai_seller_period_unique", unique: true }],
};
export async function initializeAiIndexes(db: Db): Promise<void> {
  for (const [name, indexes] of Object.entries(aiIndexes)) await db.collection(name).createIndexes(indexes);
}
export async function checkAiIndexes(db: Db): Promise<boolean> {
  for (const [name, indexes] of Object.entries(aiIndexes)) {
    if (!await db.listCollections({ name }, { nameOnly: true }).hasNext()) return false;
    const actual = await db.collection(name).listIndexes().toArray();
    for (const index of indexes) if (!actual.some((item) => item.name === index.name && JSON.stringify(item.key) === JSON.stringify(index.key) && Boolean(item.unique) === Boolean(index.unique))) return false;
  }
  return true;
}
export const aiTransactionOptions = { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 3000, timeoutMS: 5000 } as const;
export async function activeAiSeller(db: Db, context: SellerContext, session?: ClientSession): Promise<Seller> {
  const seller = await db.collection<Seller & { privacyDeleting?: boolean }>("sellers").findOne({ _id: context.sellerId, ownerUserId: context.userId, status: "active" }, { session });
  if (seller?.privacyDeleting) throw new AppError("INVALID_STATE", "Seller deletion is in progress.", 409);
  return ownerSeller(db, context, session);
}
export function effectiveRunState(run: Pick<AiRunRecord, "state" | "deadline">, now = Date.now()): AiRunRecord["state"] {
  return run.state === "running" && Date.parse(run.deadline) <= now ? "unknown" : run.state;
}
export function runStatusView(run: AiRunRecord, now = Date.now()): AnalysisRunView {
  const { _id, sellerId, payloadHash: hash, capturedDraftHash, capturedPlanHash, providerIds, extraction, classification, ...view } = run;
  void _id; void sellerId; void hash; void capturedDraftHash; void capturedPlanHash; void providerIds; void extraction; void classification;
  const state = effectiveRunState(run, now);
  return analysisRunViewSchema.parse({ ...view, state, unknownSpend: view.unknownSpend || state === "unknown", ...(state !== run.state ? { error: { code: "PROVIDER_OUTCOME_UNKNOWN", message: "The execution deadline elapsed. Check this run before acknowledging a new attempt.", status: 503, retryAfterSeconds: null } } : {}) });
}
export const analysisRunView = runStatusView;
export function assertRunReplay(run: AiRunRecord, hash: string): AnalysisRunView {
  if (run.payloadHash !== hash) throw new AppError("IDEMPOTENCY_CONFLICT", "This analysis key belongs to a different payload.", 409);
  return runStatusView(run);
}
export async function getAnalysisRun(db: Db, context: SellerContext, query: { runId?: string; requestKey?: string }): Promise<AiRunRecord> {
  await activeAiSeller(db, context);
  return found(await db.collection<AiRunRecord>("aiRuns").findOne({ sellerId: context.sellerId, ...(query.runId ? { _id: query.runId } : { requestKey: query.requestKey }) }));
}
export type AnalyzeCommand = IntelligenceInput<"analyzeSource">;
export function draftSetHash(drafts: Proposal[]): string {
  return payloadHash(drafts.map((draft) => ({ id: draft._id, revision: draft.draftRevision, status: draft.status, operations: draft.operations, missingFields: draft.missingFields })).sort((a, b) => a.id.localeCompare(b.id)));
}
export function planSetHash(plans: Plan[]): string { return payloadHash([...plans].sort((a, b) => a._id.localeCompare(b._id))); }
export async function sourceSnapshot(db: Db, seller: Seller, sourceId: string, session?: ClientSession) {
  const source = found(await db.collection<Source & { erasurePending?: boolean }>("sources").findOne({ _id: sourceId, sellerId: seller._id }, { session }));
  if (source.erasurePending || source.status !== "needs_review") throw new AppError("INVALID_STATE", "Source is not available for analysis.", 409);
  const { erasurePending, ...safeSource } = source;
  void erasurePending;
  const validated = sourceSchema.parse(safeSource);
  if (!validated.customerId) throw new AppError("INVALID_STATE", "Select an active source customer before analysis.", 409);
  const customer = found(await db.collection<Customer>("customers").findOne({ _id: validated.customerId, sellerId: seller._id, status: "active" }, { session }));
  const plans = await db.collection<Plan>("plans").find({ sellerId: seller._id, customerId: validated.customerId }, { session }).limit(101).toArray();
  const drafts = await db.collection<Proposal>("proposals").find({ sellerId: seller._id, sourceId }, { session }).limit(101).toArray();
  if (plans.length > 100 || drafts.length > 100) throw new AppError("INVALID_STATE", "Source context exceeds the analysis limit.", 409);
  const modelSource: ModelSourceContext = { text: validated.text, sentAt: validated.sentAt, timezone: seller.settings.timezone, alias: customer.alias,
    schedule: plans.map(({ startDate, endDate, quantities }) => ({ startDate, endDate, quantities })) };
  return { seller, source: validated, customer, plans, drafts, modelSource };
}
export type SourceSnapshot = Awaited<ReturnType<typeof sourceSnapshot>>;
export async function reserveAnalysis(input: AnalyzeCommand, context: SellerContext, config: AiConfig, hash: string, retryOfRunId: string | null = null, acknowledgeUnknownSpend = false, requestStartedAt = Date.now()): Promise<{ run: AiRunRecord; snapshot: SourceSnapshot | null; reserved: boolean }> {
  const db = await getDb();
  const client = await getClient();
  const now = new Date().toISOString();
  const runId = randomUUID();
  const deadline = new Date(requestStartedAt + config.totalTimeoutMs).toISOString();
  try {
    return await client.withSession((session) => session.withTransaction(async () => {
      const seller = await activeAiSeller(db, context, session);
      const existing = await db.collection<AiRunRecord>("aiRuns").findOne({ sellerId: seller._id, requestKey: input.meta.idempotencyKey }, { session });
      if (existing) { assertRunReplay(existing, hash); return { run: existing, snapshot: null, reserved: false }; }
      if (await db.collection("receipts").findOne({ sellerId: seller._id, idempotencyKey: input.meta.idempotencyKey }, { session })) throw new AppError("IDEMPOTENCY_CONFLICT", "This key belongs to a business command.", 409);
      let retryRun: AiRunRecord | null = null;
      if (retryOfRunId) {
        retryRun = found(await db.collection<AiRunRecord>("aiRuns").findOne({ _id: retryOfRunId, sellerId: seller._id }, { session }));
        const state = effectiveRunState(retryRun);
        if (state === "succeeded" || state === "running") throw new AppError("INVALID_STATE", "This run is not eligible for retry.", 409);
        if (retryRun.sourceId !== input.sourceId) throw new AppError("INVALID_STATE", "Retry source does not match.", 409);
        if ((state === "unknown" || retryRun.unknownSpend) && !acknowledgeUnknownSpend) throw new AppError("UNKNOWN_SPEND_ACKNOWLEDGEMENT_REQUIRED", "A new attempt may incur additional provider spend.", 409);
        if (state !== retryRun.state) await db.collection<AiRunRecord>("aiRuns").updateOne({ _id: retryRun._id, state: "running" }, { $set: { state: "unknown", unknownSpend: true, updatedAt: now, completedAt: now } }, { session });
      }
      assertRevision(seller.stateRevision, input.expectedStateRevision);
      if (seller.stateRevision >= Number.MAX_SAFE_INTEGER - 2) throw new AppError("INVALID_STATE", "Seller revision limit reached.", 409);
      const snapshot = await sourceSnapshot(db, seller, input.sourceId, session);
      assertRevision(snapshot.source.revision, input.expectedSourceRevision);
      if (snapshot.source.text.length > config.maxSourceChars) throw new AppError("AI_INPUT_TOO_LARGE", "Source exceeds the configured size limit.", 422);
      assertModelInput(gemmaContent(snapshot.modelSource), config, EXTRACTION_PROMPT);
      if (input.expectedDraftRevisions) {
        const expected = input.expectedDraftRevisions.map((draft) => `${draft.proposalId}:${draft.draftRevision}`).sort();
        const actual = snapshot.drafts.filter((draft) => draft.status === "needs_review" || draft.status === "deferred").map((draft) => `${draft._id}:${draft.draftRevision}`).sort();
        if (new Set(expected).size !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw new AppError("STALE_REVISION", "The source draft set changed.", 409);
      }
      if (Date.parse(deadline) - Date.now() <= 5000) throw new AppError("PROVIDER_TIMEOUT", "The request deadline elapsed before provider admission.", 504);
      const lockId = `ai-lock-${seller._id}`;
      const admissions = db.collection<AiAdmission>("aiAdmissions");
      const lock = await admissions.findOne({ _id: lockId }, { session });
      if (lock?.leaseRunId && lock.leaseRunId !== retryOfRunId) throw new AppError("AI_BUSY", "Another analysis holds the seller admission slot. Inspect its run before retrying.", 429);
      if (lock?.leaseRunId === retryOfRunId && retryRun && (effectiveRunState(retryRun) === "unknown" || retryRun.unknownSpend) && !acknowledgeUnknownSpend) throw new AppError("AI_BUSY", "Uncertain spend requires explicit acknowledgement.", 429);
      if (lock) await admissions.updateOne({ _id: lockId }, { $set: { leaseRunId: runId, leaseDeadline: deadline } }, { session });
      else await admissions.insertOne({ _id: lockId, sellerId: seller._id, budgetPeriod: "lock", requestsReserved: 0, inputTokensReserved: 0, leaseRunId: runId, leaseDeadline: deadline }, { session });
      const period = now.slice(0, 10); // UTC; changing seller timezone cannot reset budgets.
      const budgetId = `ai-budget-${seller._id}-${period}`;
      const budget = await admissions.findOne({ _id: budgetId }, { session });
      const requestsReserved = (budget?.requestsReserved ?? 0) + 2;
      const inputTokensReserved = (budget?.inputTokensReserved ?? 0) + config.maxInputTokens * 2;
      if (requestsReserved > config.dailyRequestLimit || inputTokensReserved > config.dailyInputTokenLimit) throw new AppError("AI_BUDGET_EXCEEDED", "The conservative daily AI budget is exhausted.", 429);
      // Keep conservative reservations, including failures/unknown spend; an operator can reconcile actual usage.
      if (budget) await admissions.updateOne({ _id: budgetId }, { $set: { requestsReserved, inputTokensReserved } }, { session });
      else await admissions.insertOne({ _id: budgetId, sellerId: seller._id, budgetPeriod: period, requestsReserved, inputTokensReserved, leaseRunId: null, leaseDeadline: null }, { session });
      const run = aiRunRecordSchema.parse({ _id: runId, runId, sellerId: seller._id, requestKey: input.meta.idempotencyKey, payloadHash: hash,
        sourceId: input.sourceId, sourceRevision: snapshot.source.revision, expectedStateRevision: seller.stateRevision, stateRevision: null,
        capturedDraftHash: draftSetHash(snapshot.drafts), capturedPlanHash: planSetHash(snapshot.plans),
        state: "running", stage: "reserved", createdAt: now, updatedAt: now, deadline, completedAt: null, retryOfRunId, unknownSpend: false,
        proposalIds: [], classificationId: null, providerIds: [], extraction: null, classification: null, extractionAvailable: false,
        models: { gemmaProvider: config.gemmaProvider, gemmaRequested: config.gemmaModel, gemmaResolved: null, jevRequested: config.jevModel, jevResolved: null },
        promptVersion: PROMPT_VERSION, schemaVersion: 1, usage: { gemma: null, jev: null }, warnings: [], error: null,
      });
      await db.collection<AiRunRecord>("aiRuns").insertOne(run, { session });
      const fence = await db.collection<Seller>("sellers").updateOne({ _id: seller._id, ownerUserId: context.userId, stateRevision: seller.stateRevision, privacyDeleting: { $ne: true } }, { $set: { status: "active" } }, { session });
      if (!fence.matchedCount) throw new AppError("STALE_REVISION", "Seller state changed before admission.", 409);
      // Shared unique receipt keys fence cross-operation races; reservation is not model completion.
      await db.collection<Receipt>("receipts").insertOne(receiptSchema.parse({ _id: runId, sellerId: seller._id, schemaVersion: 1, createdAt: now, operation: retryOfRunId ? "retryAnalysis" : "analyzeSource", idempotencyKey: input.meta.idempotencyKey, payloadHash: hash, actorUserId: context.userId, committedAt: now, priorStateRevision: seller.stateRevision, stateRevision: seller.stateRevision, resourceIds: [runId], affectedDates: [], warnings: ["AI reservation only; read the run for completion."], before: null, after: { runId } }), { session });
      return { run, snapshot, reserved: true };
    }, aiTransactionOptions));
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      const existing = await db.collection<AiRunRecord>("aiRuns").findOne({ sellerId: context.sellerId, requestKey: input.meta.idempotencyKey });
      if (existing) { assertRunReplay(existing, hash); return { run: existing, snapshot: null, reserved: false }; }
      throw new AppError("AI_BUSY", "Another request reserved the seller admission slot.", 429);
    }
    throw error;
  }
}
export async function recordProviderResponse(db: Db, run: AiRunRecord, stage: "gemma" | "jev", metadata: ProviderMetadata): Promise<void> {
  // Never upsert: late responses may record identifiers on an existing run, never recreate erased records.
  await db.collection<AiRunRecord>("aiRuns").updateOne({ _id: run._id, sellerId: run.sellerId }, {
    $push: { providerIds: { stage, ...metadata.ids } },
    $set: { [`models.${stage}Resolved`]: metadata.resolvedModel, [`usage.${stage}`]: metadata.usage },
  });
  run.providerIds.push({ stage, ...metadata.ids });
  run.models[stage === "gemma" ? "gemmaResolved" : "jevResolved"] = metadata.resolvedModel;
  run.usage[stage] = metadata.usage;
}
