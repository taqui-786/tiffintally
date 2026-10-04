import "server-only";
import { randomUUID } from "node:crypto";
import type { SellerContext } from "@/lib/contracts/common";
import { AppError } from "@/lib/contracts/common";
import { FEATURE_NAMES, forecastRunSchema, type AcceptedHistory, type ForecastRun, type HistoryInput, type PlanningSnapshot } from "@/lib/contracts/history";
import { found, payloadHash } from "@/lib/server/receipts";
import { getClient, getDb } from "@/lib/server/db/client";
import { availableHistory, historicalFeatures, recentDeltas } from "./features";
import { forecastServiceConfig, predictTabPfn, type PredictionRequest, type PredictionResponse } from "./client";
import { datasetHash, evaluationSchema, evaluateHistoryRows, type ForecastEvaluation } from "./evaluate";
import { forecastingSeller, historyCommand, historyRead, type HistoryScope, type HistoryState } from "./history";
import { captureSafeBackendError } from "@/lib/server/telemetry";

interface Admission { _id: string; sellerId: string; period: string; reservedRequests: number }
interface ForecastRecord extends ForecastRun { trainingData: { rowIds: string[]; trainRows: (number | null)[][]; targets: number[] }; providerResult?: PredictionResponse }
export function effectiveForecast(run: ForecastRun, scope: Pick<HistoryScope, "now" | "seller" | "history">): ForecastRun {
  const obsolete = run.obsolete || run.stateRevision !== scope.seller.stateRevision || run.historyVersion !== scope.history.version;
  const unknown = run.runState === "running" && Date.parse(run.deadline) <= Date.parse(scope.now);
  const dto = Object.fromEntries(Object.keys(forecastRunSchema.shape).map((key) => [key, run[key as keyof ForecastRun]]));
  return forecastRunSchema.parse({ ...dto, obsolete, runState: unknown ? "unknown" : run.runState, result: run.result && obsolete ? { ...run.result, status: "obsolete" } : run.result });
}
export async function readForecast(scope: HistoryScope, filter: { _id?: string; requestKey?: string }) { return effectiveForecast(found(await scope.db.collection<ForecastRun>("forecastRuns").findOne({ sellerId: scope.seller._id, ...filter }, { session: scope.session })), scope); }
async function releaseForecast(scope: HistoryScope, runId: string) { await scope.db.collection<HistoryState>("historyStates").updateOne({ sellerId: scope.seller._id, "forecastLease.runId": runId }, { $set: { forecastLease: null } }, { session: scope.session }); }
export async function requestForecast(input: HistoryInput<"requestForecast">, context: SellerContext) {
  let dispatch: PredictionRequest | null = null;
  let evaluation: ForecastEvaluation | null = null;
  const reservation = await historyCommand("requestForecast", input, context, async (scope) => {
    dispatch = null; evaluation = null;
    const snapshot = found(await scope.db.collection<PlanningSnapshot>("planningSnapshots").findOne({ sellerId: scope.seller._id, _id: input.snapshotId, serviceDate: input.serviceDate, active: true }, { session: scope.session }));
    if (input.experiment && snapshot.evidenceMode !== "synthetic_demo") throw new AppError("VALIDATION_FAILED", "The experiment bypass is only permitted for synthetic_demo snapshots.", 422);
    if (snapshot.evidenceMode === "real" && snapshot.stateRevision !== scope.seller.stateRevision) throw new AppError("STALE_REVISION", "The saved snapshot is obsolete after an approved state change.", 409);
    const all = await scope.db.collection<AcceptedHistory>("historyRows").find({ sellerId: scope.seller._id, active: true }, { session: scope.session }).toArray();
    const eligible = availableHistory(all, snapshot).filter((entry) => Math.abs(entry.row.features[1]! - snapshot.features[1]!) <= 10).slice(-2000);
    const trainRows = eligible.map((entry) => historicalFeatures(entry, all)), targets = eligible.map((entry) => entry.row.cutoffTotal - entry.row.confirmedMeals), queryRow = [...snapshot.features];
    if (snapshot.provenanceReference.startsWith("import:")) [queryRow[11], queryRow[12]] = recentDeltas(all, snapshot);
    const dataset = datasetHash(eligible), dataHash = payloadHash({ featureSchemaVersion: 1, trainRows, targets, queryRow });
    const evaluations = await scope.db.collection<ForecastEvaluation>("forecastEvaluations").find({ sellerId: scope.seller._id, dataHash: dataset, historyVersion: scope.history.version, featureSchemaVersion: 1, model: "tabpfn", evidenceMode: "real", validated: true }, { session: scope.session }).sort({ createdAt: -1 }).limit(1).toArray();
    evaluation = evaluations.length ? evaluationSchema.parse(evaluations[0]) : null;
    // A stored internal receipt, never a user-supplied flag, grants measured operational validation.
    const result = { status: "not_validated" as "available" | "insufficient_history" | "not_validated" | "unavailable", predictedDelta: null, roundedDelta: null, roundingRule: "Math.round" as const, baselineDelta: snapshot.features[12] ?? 0, baselineMethod: "earlier_same_weekday_mean_or_no_change" as const, trainingRows: Math.max(0, eligible.length - 10), holdoutRows: Math.min(10, eligible.length), modelVersion: null, evaluationId: evaluation?._id ?? null, durationMs: null };
    if (eligible.length < 40 && !input.experiment) result.status = "insufficient_history";
    else if (!forecastServiceConfig()) result.status = "unavailable";
    else if (input.experiment && eligible.length < 2) result.status = "insufficient_history";
    else if (input.experiment || evaluation) result.status = "available";
    const run = forecastRunSchema.parse({ _id: randomUUID(), sellerId: scope.seller._id, schemaVersion: 1, createdAt: scope.now, completedAt: result.status === "available" ? null : scope.now, deadline: new Date(Date.parse(scope.now) + 45000).toISOString(), requestKey: input.meta.idempotencyKey, payloadHash: payloadHash({ operation: "requestForecast", input }), runState: result.status === "available" ? "running" : "succeeded", snapshotId: snapshot._id, serviceDate: snapshot.serviceDate, asOf: snapshot.asOf, confirmedMeals: snapshot.confirmedMeals, stateRevision: scope.seller.stateRevision, historyVersion: scope.history.version, dataHash, datasetHash: dataset, featureSchemaVersion: 1, model: "tabpfn", featureNames: [...FEATURE_NAMES], queryRow, evidenceMode: snapshot.evidenceMode, experiment: input.experiment, result: result.status === "available" ? null : result, failureCode: null, obsolete: false });
    if (run.runState === "running") {
      // Unknown leases stay reserved: HTTP timeout cannot prove Python stopped. Operator reconciliation is explicit.
      if (scope.history.forecastLease) throw new AppError("AI_BUSY", "A forecast/evaluation run has an unresolved admission slot.", 429);
      const period = scope.now.slice(0, 10), admission = await scope.db.collection<Admission>("forecastAdmissions").findOne({ sellerId: scope.seller._id, period }, { session: scope.session });
      if ((admission?.reservedRequests ?? 0) >= 20) throw new AppError("AI_BUDGET_EXCEEDED", "Daily forecast request limit reached.", 429);
      await scope.db.collection<Admission>("forecastAdmissions").updateOne({ sellerId: scope.seller._id, period }, { $setOnInsert: { _id: `${scope.seller._id}_${period}`, sellerId: scope.seller._id, period }, $inc: { reservedRequests: 1 } }, { upsert: true, session: scope.session });
      await scope.db.collection<HistoryState>("historyStates").updateOne({ sellerId: scope.seller._id }, { $set: { forecastLease: { runId: run._id, deadline: run.deadline } } }, { session: scope.session });
      dispatch = { schemaVersion: 1, runId: run._id, dataHash, featureSchemaVersion: 1, model: "tabpfn", featureNames: [...FEATURE_NAMES], trainRows, targets, queryRow };
    }
    await scope.db.collection<ForecastRecord>("forecastRuns").insertOne({ ...run, trainingData: { rowIds: eligible.map((entry) => entry._id), trainRows, targets } }, { session: scope.session });
    return run;
  });
  if (reservation.replayed || !dispatch) return historyRead(context, (scope) => readForecast(scope, { _id: reservation.value._id }));
  const run = reservation.value;
  let response: PredictionResponse | null = null, failure: AppError | null = null;
   try { response = await predictTabPfn(dispatch); } catch (error) { captureSafeBackendError(error, context.requestId); failure = error instanceof AppError ? error : new AppError("PROVIDER_OUTCOME_UNKNOWN", "Forecast outcome is unknown.", 502); }
  const db = await getDb(), client = await getClient();
  try {
    await client.withSession((session) => session.withTransaction(async () => {
      const seller = await forecastingSeller(db, context, session), history = found(await db.collection<HistoryState>("historyStates").findOne({ sellerId: context.sellerId }, { session }));
      const current = found(await db.collection<ForecastRecord>("forecastRuns").findOne({ _id: run._id, sellerId: context.sellerId }, { session }));
      if (current.runState !== "running") return;
      const now = new Date().toISOString(), obsolete = current.obsolete || seller.stateRevision !== run.stateRevision || history.version !== run.historyVersion;
      const validated = evaluation as ForecastEvaluation | null;
      const accepted = !!response && (run.experiment || !!validated && validated.modelVersion === response.modelVersion);
      const result = response ? { status: obsolete ? "obsolete" : accepted ? "available" : "not_validated", predictedDelta: accepted ? response.predictedDelta : null, roundedDelta: accepted ? Math.round(response.predictedDelta) : null, roundingRule: "Math.round", baselineDelta: run.queryRow[12] ?? 0, baselineMethod: "earlier_same_weekday_mean_or_no_change", trainingRows: response.trainingRows, holdoutRows: Math.min(10, response.trainingRows), modelVersion: response.modelVersion, evaluationId: validated?._id ?? null, durationMs: response.durationMs } : { status: obsolete ? "obsolete" : "unavailable", predictedDelta: null, roundedDelta: null, roundingRule: "Math.round", baselineDelta: run.queryRow[12] ?? 0, baselineMethod: "earlier_same_weekday_mean_or_no_change", trainingRows: (dispatch as PredictionRequest).trainRows.length, holdoutRows: 0, modelVersion: null, evaluationId: null, durationMs: null };
      const unknown = failure?.code === "PROVIDER_OUTCOME_UNKNOWN";
      const dto = Object.fromEntries(Object.keys(forecastRunSchema.shape).map((key) => [key, current[key as keyof ForecastRun]]));
      const updated = forecastRunSchema.parse({ ...dto, completedAt: now, obsolete, runState: unknown ? "unknown" : obsolete ? "obsolete" : failure ? "failed" : "succeeded", result, failureCode: failure?.code ?? null });
      await db.collection<ForecastRecord>("forecastRuns").replaceOne({ _id: run._id, sellerId: context.sellerId, runState: "running" }, { ...updated, trainingData: current.trainingData, ...(response ? { providerResult: response } : {}) }, { session });
      // Serialize late completion with history corrections and privacy deletion without modifying fulfillment revisions.
      await db.collection<HistoryState>("historyStates").updateOne({ sellerId: context.sellerId }, { $inc: { sequence: 1 } }, { session });
      const fence = await db.collection("sellers").updateOne({ _id: seller._id as never, privacyDeleting: { $ne: true }, stateRevision: seller.stateRevision }, { $set: { status: "active" } }, { session });
      if (!fence.matchedCount) throw new AppError("PRIVACY_DELETING", "Seller erasure is in progress.", 409);
      if (!unknown) await releaseForecast({ db, session, seller, context, now, history }, run._id);
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", timeoutMS: 15000 }));
  } catch { // A dispatched computation is never automatically repeated after storage uncertainty.
    return historyRead(context, (scope) => readForecast(scope, { _id: run._id }));
  }
  return historyRead(context, (scope) => readForecast(scope, { _id: run._id }));
}

/** Internal operator entry point; deliberately absent from public operation schema maps. */
export async function evaluateHistory(input: { meta: { idempotencyKey: string }; expectedStateRevision: number; expectedHistoryVersion: number; snapshotId: string }, context: SellerContext, predict?: (request: PredictionRequest) => Promise<PredictionResponse>) {
  let rows: AcceptedHistory[] = [];
  const admitted = await historyCommand("evaluateHistory", input, context, async (scope) => {
    if (scope.history.forecastLease) throw new AppError("AI_BUSY", "Forecast admission slot is occupied.", 429);
    const snapshot = found(await scope.db.collection<PlanningSnapshot>("planningSnapshots").findOne({ sellerId: scope.seller._id, _id: input.snapshotId, active: true }, { session: scope.session }));
    const all = await scope.db.collection<AcceptedHistory>("historyRows").find({ sellerId: scope.seller._id, active: true }, { session: scope.session }).toArray();
    rows = availableHistory(all, snapshot).filter((entry) => Math.abs(entry.row.features[1]! - snapshot.features[1]!) <= 10).slice(-2000);
    if (rows.length < 40) throw new AppError("INSUFFICIENT_HISTORY", "At least 40 eligible days are required.", 422);
    const period = scope.now.slice(0, 10), admission = await scope.db.collection<Admission>("forecastAdmissions").findOne({ sellerId: scope.seller._id, period }, { session: scope.session });
    if ((admission?.reservedRequests ?? 0) + 20 > 20) throw new AppError("AI_BUDGET_EXCEEDED", "A chronological evaluation requires a reservation of 20 forecast calls.", 429);
    await scope.db.collection<Admission>("forecastAdmissions").updateOne({ sellerId: scope.seller._id, period }, { $setOnInsert: { _id: `${scope.seller._id}_${period}`, sellerId: scope.seller._id, period }, $inc: { reservedRequests: 20 } }, { upsert: true, session: scope.session });
    const id = randomUUID();
    const deadline = new Date(Date.parse(scope.now) + 20 * 45000).toISOString();
    await scope.db.collection<HistoryState>("historyStates").updateOne({ sellerId: scope.seller._id }, { $set: { forecastLease: { runId: id, deadline } } }, { session: scope.session });
    await scope.db.collection("forecastEvaluationRuns").insertOne({ _id: id as never, sellerId: scope.seller._id, requestKey: input.meta.idempotencyKey, state: "running", createdAt: scope.now, deadline, historyVersion: scope.history.version }, { session: scope.session });
    return { evaluationRunId: id, historyVersion: scope.history.version };
  });
  if (admitted.replayed) return historyRead(context, (scope) => scope.db.collection("forecastEvaluationRuns").findOne({ _id: admitted.value.evaluationRunId as never, sellerId: context.sellerId }, { session: scope.session }));
  let evaluation: ForecastEvaluation;
  try { evaluation = await evaluateHistoryRows({ sellerId: context.sellerId, historyVersion: admitted.value.historyVersion, rows }, predict); }
  catch (error) {
    await historyCommand("finishEvaluationFailure", { ...input, meta: { idempotencyKey: `${admitted.value.evaluationRunId}_failed` } }, context, async (scope) => { const unknown = !(error instanceof AppError) || error.code === "PROVIDER_OUTCOME_UNKNOWN"; await scope.db.collection("forecastEvaluationRuns").updateOne({ _id: admitted.value.evaluationRunId as never, sellerId: context.sellerId }, { $set: { state: unknown ? "unknown" : "failed", failureCode: error instanceof AppError ? error.code : "PROVIDER_OUTCOME_UNKNOWN", completedAt: scope.now } }, { session: scope.session }); if (!unknown) await releaseForecast(scope, admitted.value.evaluationRunId); return { status: unknown ? "unknown" : "failed" }; });
    throw error;
  }
  await historyCommand("finishEvaluation", { ...input, meta: { idempotencyKey: `${admitted.value.evaluationRunId}_finished` } }, context, async (scope) => {
    await scope.db.collection<ForecastEvaluation>("forecastEvaluations").insertOne(evaluation, { session: scope.session });
    await scope.db.collection("forecastEvaluationRuns").updateOne({ _id: admitted.value.evaluationRunId as never, sellerId: context.sellerId }, { $set: { state: "succeeded", evaluationId: evaluation._id, completedAt: scope.now } }, { session: scope.session });
    await releaseForecast(scope, admitted.value.evaluationRunId);
    return { evaluationId: evaluation._id };
  });
  return evaluation;
}
