import "server-only";
import { createHash } from "node:crypto";
import { AppError, type SellerContext } from "@/lib/contracts/common";
import { intelligenceInputSchemas, intelligenceOutputSchemas, type AnalysisRunView, type IntelligenceInput, type IntelligenceOperationName, type IntelligenceOutput } from "@/lib/contracts/intelligence";
import { proposalSchema, type Proposal, type Seller, type Source } from "@/lib/contracts/records";
import { getClient, getDb } from "@/lib/server/db/client";
import { payloadHash } from "@/lib/server/receipts";
import { captureSafeBackendError, withStageSpan } from "@/lib/server/telemetry";
import { AiStageError, assertModelInput, boundedStage, callGemma, callJev, safeAiError } from "./backboard";
import { classificationSummary } from "./classify";
import { aiCapabilityFlags, getAiConfig } from "./config";
import { normalizeExtraction } from "./normalize";
import { EXTRACTION_PROMPT, gemmaContent } from "./prompts";
import { activeAiSeller, aiTransactionOptions, assertRunReplay, draftSetHash, getAnalysisRun, planSetHash, recordProviderResponse, reserveAnalysis, runStatusView, sourceSnapshot, type AiAdmission, type AiRunRecord, type ClassificationRecord, type SourceSnapshot } from "./runs";
import type { Extraction, JevResult } from "./schemas";

function stableId(runId: string, label: string) { return createHash("sha256").update(`${runId}:${label}`).digest("hex").slice(0, 32); }
async function commitAnalysis(run: AiRunRecord, snapshot: SourceSnapshot, context: SellerContext, extraction: Extraction | null, classification: JevResult | null, error: AiStageError | null): Promise<AnalysisRunView> {
  const db = await getDb();
  const client = await getClient();
  const completedAt = new Date().toISOString();
  try {
    return await client.withSession((session) => session.withTransaction(async () => {
      const stored = await db.collection<AiRunRecord>("aiRuns").findOne({ _id: run._id, sellerId: context.sellerId }, { session });
      if (!stored) return runStatusView({ ...run, state: "obsolete", completedAt, updatedAt: completedAt, warnings: ["source_or_seller_erased"], extractionAvailable: false });
      if (stored.state !== "running") {
        // Privacy can obsolete a run while a call is in flight. Final response handling never
        // restores evidence; it only retains uncertain-spend provenance or releases a known-finished lease.
        if (stored.state === "obsolete") {
          const unknownSpend = stored.unknownSpend || Boolean(error?.unknownOutcome);
          if (unknownSpend && !stored.unknownSpend) await db.collection<AiRunRecord>("aiRuns").updateOne({ _id: stored._id, sellerId: context.sellerId, state: "obsolete" }, { $set: { unknownSpend: true } }, { session });
          if (!unknownSpend) await db.collection<AiAdmission>("aiAdmissions").updateOne({ sellerId: context.sellerId, budgetPeriod: "lock", leaseRunId: run._id }, { $set: { leaseRunId: null, leaseDeadline: null } }, { session });
          return runStatusView({ ...stored, unknownSpend });
        }
        return runStatusView(stored);
      }
      const seller = await db.collection<Seller & { privacyDeleting?: boolean }>("sellers").findOne({ _id: context.sellerId, ownerUserId: context.userId, status: "active", privacyDeleting: { $ne: true } }, { session });
      let current: SourceSnapshot | null = null;
      if (seller && seller.stateRevision === run.expectedStateRevision) {
        try { current = await sourceSnapshot(db, seller, run.sourceId, session); } catch (failure) {
          if (!(failure instanceof AppError)) throw failure;
        }
      }
      const changed = !current || current.source.revision !== run.sourceRevision || current.source.text !== snapshot.source.text ||
        draftSetHash(current.drafts) !== run.capturedDraftHash || planSetHash(current.plans) !== run.capturedPlanHash;
      const expired = Date.now() >= Date.parse(run.deadline);
      const summary = classification && extraction ? classificationSummary(classification, extraction) : null;
      const warnings = [...new Set([...(summary?.warnings ?? []), ...(extraction && !classification ? ["classification_unavailable"] : []), ...(changed ? ["stale_analysis"] : [])])];
      const drafts = extraction && !changed && !expired ? normalizeExtraction(extraction, current!.source, current!.seller.settings, warnings) : [];
      const state: AiRunRecord["state"] = changed ? "obsolete" : expired || error?.unknownOutcome ? "unknown" : !extraction ? "failed" : !classification || warnings.length || drafts.some((draft) => draft.missingFields.length || !draft.operations.length) ? "needs_review" : "succeeded";
      const proposalIds: string[] = [];
      let classificationId: string | null = null;
      let stateRevision: number | null = null;
      if (drafts.length || (classification && !changed && !expired)) {
        // ponytail: any seller revision change invalidates analysis; recompute only when throughput requires it.
        const lock = await db.collection<Seller>("sellers").updateOne({ _id: context.sellerId, ownerUserId: context.userId, status: "active", privacyDeleting: { $ne: true }, stateRevision: run.expectedStateRevision }, { $inc: { stateRevision: 1 } }, { session });
        if (lock.modifiedCount !== 1) throw new AppError("STALE_ANALYSIS", "Seller state changed before committing analysis.", 409);
        stateRevision = run.expectedStateRevision + 1;
        for (const [index, draft] of drafts.entries()) {
          const id = stableId(run._id, `proposal:${index}`);
          const proposal = proposalSchema.parse({ _id: id, sellerId: context.sellerId, schemaVersion: 1, createdAt: completedAt,
            sourceId: run.sourceId, sourceRevision: run.sourceRevision, manualReason: null, ...draft,
            draftRevision: 0, status: "needs_review", deferredDate: null, dispositionReason: null });
          await db.collection<Proposal>("proposals").insertOne(proposal, { session });
          proposalIds.push(id);
        }
        if (classification && summary) {
          classificationId = stableId(run._id, "classification");
          const record: ClassificationRecord = { _id: classificationId, sellerId: context.sellerId, sourceId: run.sourceId,
            sourceRevision: run.sourceRevision, computedAt: completedAt, labels: summary.labels, intent: summary.intent,
            probabilities: summary.probabilities, model: classification.model, promptVersion: run.promptVersion, runId: run._id };
          await db.collection<ClassificationRecord>("classifications").insertOne(record, { session });
        }
      }
      const unknownSpend = Boolean(error?.unknownOutcome || expired);
      const safeError = unknownSpend ? safeAiError(error ?? new AiStageError("PROVIDER_OUTCOME_UNKNOWN", 503, true)) : changed ? { code: "STALE_ANALYSIS", message: "Supporting seller/source/drafts changed; these results were not applied.", status: 409, retryAfterSeconds: null } : error ? safeAiError(error) : null;
      const updates = { state, stage: "complete" as const, completedAt, updatedAt: completedAt, proposalIds, classificationId, stateRevision,
        warnings, error: safeError, unknownSpend, extraction: changed ? null : extraction, classification: changed ? null : classification, extractionAvailable: !changed && extraction !== null };
      await db.collection<AiRunRecord>("aiRuns").updateOne({ _id: run._id, sellerId: context.sellerId, state: "running" }, { $set: updates }, { session });
      if (!unknownSpend) await db.collection<AiAdmission>("aiAdmissions").updateOne({ sellerId: context.sellerId, budgetPeriod: "lock", leaseRunId: run._id }, { $set: { leaseRunId: null, leaseDeadline: null } }, { session });
      return runStatusView({ ...stored, ...updates });
    }, aiTransactionOptions));
  } catch {
    // A commit failure is not a safely failed paid call. Leave the durable reservation for lookup/reconciliation.
    const latest = await db.collection<AiRunRecord>("aiRuns").findOne({ _id: run._id, sellerId: context.sellerId });
    if (latest && latest.state !== "running") return runStatusView(latest);
    return runStatusView({ ...(latest ?? run), state: "unknown", unknownSpend: true, error: safeAiError(new AiStageError("PROVIDER_OUTCOME_UNKNOWN", 503, true)) });
  }
}
async function analyze(input: IntelligenceInput<"analyzeSource">, context: SellerContext, hash: string, retryOfRunId: string | null = null, acknowledgeUnknownSpend = false, requestStartedAt = Date.now(), execution?: { run?: AiRunRecord }): Promise<AnalysisRunView> {
  const db = await getDb();
  await activeAiSeller(db, context);
  // A repeat wins over configuration/staleness checks and never dispatches again.
  const existing = await db.collection<AiRunRecord>("aiRuns").findOne({ sellerId: context.sellerId, requestKey: input.meta.idempotencyKey });
  if (existing) return assertRunReplay(existing, hash);
  const config = getAiConfig();
  const reservation = await reserveAnalysis(input, context, config, hash, retryOfRunId, acknowledgeUnknownSpend, requestStartedAt);
  if (!reservation.reserved || !reservation.snapshot) return runStatusView(reservation.run);
  const { run, snapshot } = reservation;
  if (execution) execution.run = run;
  let extraction: Extraction | null = null;
  let classification: JevResult | null = null;
  let error: AiStageError | null = null;
  const stageBudget = () => Math.min(config.stageTimeoutMs, Date.parse(run.deadline) - Date.now() - 5000);
  const setStage = async (stage: "gemma" | "jev") => {
    if (stageBudget() < 1) throw new AiStageError("PROVIDER_TIMEOUT", 504, false);
    const seller = await db.collection<Seller>("sellers").findOne({ _id: context.sellerId, ownerUserId: context.userId, status: "active", privacyDeleting: { $ne: true } });
    const source = await db.collection<Source>("sources").findOne({ _id: run.sourceId, sellerId: context.sellerId, revision: run.sourceRevision, status: "needs_review", erasurePending: { $ne: true } });
    if (!seller || !source || seller.stateRevision !== run.expectedStateRevision) throw new AiStageError("STALE_ANALYSIS", 409);
    await db.collection<AiRunRecord>("aiRuns").updateOne({ _id: run._id, sellerId: context.sellerId, state: "running" }, { $set: { stage, updatedAt: new Date().toISOString() } });
    run.stage = stage;
    if (stageBudget() < 1) throw new AiStageError("PROVIDER_TIMEOUT", 504, false);
  };
  const work = async () => {
    try {
      assertModelInput(gemmaContent(snapshot.modelSource), config, EXTRACTION_PROMPT);
      await setStage("gemma");
      const gemma = await withStageSpan("gemma", { stage: "gemma", "gen_ai.request.model": config.gemmaModel, "gen_ai.provider.name": "backboard", "gen_ai.operation.name": "chat" }, () => boundedStage(callGemma(snapshot.modelSource, config, (metadata) => recordProviderResponse(db, run, "gemma", metadata)), stageBudget()));
      extraction = gemma.extraction;
      await setStage("jev");
      const jev = await withStageSpan("jev", { stage: "jev", "gen_ai.request.model": config.jevModel, "gen_ai.provider.name": "backboard", "gen_ai.operation.name": "classify" }, () => boundedStage(callJev(snapshot.modelSource, extraction!, config, (metadata) => recordProviderResponse(db, run, "jev", metadata)), stageBudget()));
      classification = jev.classification;
    } catch (failure) {
      captureSafeBackendError(failure, context.requestId);
      error = failure instanceof AiStageError ? failure : failure instanceof AppError ? new AiStageError(failure.code, failure.status) : new AiStageError("PROVIDER_OUTCOME_UNKNOWN", 503, true);
    }
    return withStageSpan("persistence", { stage: "persistence" }, () => commitAnalysis(run, snapshot, context, extraction, classification, error));
  };
  try {
    return await boundedStage(work(), Date.parse(run.deadline) - Date.now());
  } catch {
    return runStatusView({ ...run, state: "unknown", unknownSpend: true, error: safeAiError(new AiStageError("PROVIDER_TIMEOUT", 504, true)) });
  }
}
async function execute<K extends IntelligenceOperationName>(name: K, raw: unknown, context: SellerContext, requestStartedAt: number, execution: { run?: AiRunRecord }): Promise<IntelligenceOutput<K>> {
  const parsed = intelligenceInputSchemas[name].safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid intelligence operation input.", 422);
  const db = await getDb();
  await activeAiSeller(db, context);
  let output: unknown;
  switch (name) {
    case "capabilities": output = aiCapabilityFlags(); break;
    case "getAnalysis": output = runStatusView(await getAnalysisRun(db, context, { runId: (parsed.data as IntelligenceInput<"getAnalysis">).runId })); break;
    case "getAnalysisByKey": output = runStatusView(await getAnalysisRun(db, context, { requestKey: (parsed.data as IntelligenceInput<"getAnalysisByKey">).requestKey })); break;
    case "analyzeSource": {
      const input = parsed.data as IntelligenceInput<"analyzeSource">;
      output = await analyze(input, context, payloadHash({ operation: name, input }), null, false, requestStartedAt, execution); break;
    }
    case "retryAnalysis": {
      const input = parsed.data as IntelligenceInput<"retryAnalysis">;
      const hash = payloadHash({ operation: name, input });
      const existing = await db.collection<AiRunRecord>("aiRuns").findOne({ sellerId: context.sellerId, requestKey: input.meta.idempotencyKey });
      if (existing) { output = assertRunReplay(existing, hash); break; }
      const old = await getAnalysisRun(db, context, { runId: input.runId });
      output = await analyze({ meta: input.meta, sourceId: old.sourceId, expectedSourceRevision: input.expectedSourceRevision,
        expectedStateRevision: input.expectedStateRevision, expectedDraftRevisions: input.expectedDraftRevisions, consentAcknowledged: true }, context, hash, old._id, input.acknowledgeUnknownSpend, requestStartedAt, execution);
      break;
    }
  }
  return intelligenceOutputSchemas[name].parse(output) as IntelligenceOutput<K>;
}
export async function executeIntelligenceOperation<K extends IntelligenceOperationName>(name: K, raw: unknown, context: SellerContext): Promise<IntelligenceOutput<K>> {
  const requestStartedAt = Date.now();
  const execution: { run?: AiRunRecord } = {};
  if (name !== "analyzeSource" && name !== "retryAnalysis") return execute(name, raw, context, requestStartedAt, execution);
  const rawBudget = Number(process.env.AI_TOTAL_TIMEOUT_MS?.trim() || 45000);
  const timeoutMs = Number.isSafeInteger(rawBudget) && rawBudget > 0 && rawBudget <= 45000 ? rawBudget : 45000;
  try { return await boundedStage(execute(name, raw, context, requestStartedAt, execution), timeoutMs); }
  catch (error) {
    if (!(error instanceof AiStageError) || error.code !== "PROVIDER_TIMEOUT") throw error;
    if (execution.run) return runStatusView({ ...execution.run, state: "unknown", unknownSpend: true, error: safeAiError(error) }) as IntelligenceOutput<K>;
    throw new AppError("PROVIDER_TIMEOUT", "The request deadline elapsed. Look up this request key before an explicit retry.", 504);
  }
}
