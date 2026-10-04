import "server-only";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { ClientSession, Db, IndexDescription } from "mongodb";
import { AppError, type SellerContext } from "@/lib/contracts/common";
import { acceptedHistorySchema, historyImportSchema, historyRowSchema, MAX_HISTORY_BYTES, outcomeSchema, planningSnapshotSchema, type AcceptedHistory, type HistoryInput, type HistoryRow, type PlanningSnapshot } from "@/lib/contracts/history";
import { receiptSchema, sellerSchema, type Proposal, type Receipt, type Seller, type Source } from "@/lib/contracts/records";
import { localTimeInstant } from "@/lib/domain/dates";
import { calculateDay, pendingReviewCount } from "@/lib/domain/orders";
import { getClient, getDb } from "@/lib/server/db/client";
import { readOrderState } from "@/lib/server/orders";
import { assertRevision, found, payloadHash, type ReadScope } from "@/lib/server/receipts";
import { buildFeatureRow, messageFeatures, type ClassificationFeatureInput } from "./features";

export const HISTORY_INDEX_VERSION = 1;
export const forecastIndexes: Record<string, IndexDescription[]> = {
  historyStates: [{ key: { sellerId: 1 }, name: "history_seller_unique", unique: true }],
  historyReceipts: [{ key: { sellerId: 1, idempotencyKey: 1 }, name: "history_key_unique", unique: true }],
  historyImports: [{ key: { sellerId: 1, idempotencyKey: 1 }, name: "history_import_key_unique", unique: true }],
  historyRows: [{ key: { sellerId: 1, "row.serviceDate": 1, "row.policyHash": 1 }, name: "history_active_date_unique", unique: true, partialFilterExpression: { active: true } }, { key: { sellerId: 1, "row.serviceDate": 1, _id: 1 }, name: "history_date_id" }],
  planningSnapshots: [{ key: { sellerId: 1, serviceDate: 1, policyHash: 1 }, name: "snapshot_active_unique", unique: true, partialFilterExpression: { active: true } }],
  outcomes: [{ key: { sellerId: 1, snapshotId: 1 }, name: "outcome_active_unique", unique: true, partialFilterExpression: { active: true } }],
  forecastRuns: [{ key: { sellerId: 1, requestKey: 1 }, name: "forecast_key_unique", unique: true }, { key: { sellerId: 1, snapshotId: 1, dataHash: 1, featureSchemaVersion: 1, model: 1 }, name: "forecast_snapshot_data" }, { key: { sellerId: 1, runState: 1, deadline: 1 }, name: "forecast_deadline" }],
  forecastAdmissions: [{ key: { sellerId: 1, period: 1 }, name: "forecast_period_unique", unique: true }],
  forecastEvaluations: [{ key: { sellerId: 1, dataHash: 1, featureSchemaVersion: 1, modelVersion: 1 }, name: "forecast_evaluation_data_model" }],
  forecastEvaluationRuns: [{ key: { sellerId: 1, requestKey: 1 }, name: "forecast_evaluation_key_unique", unique: true }],
};
export async function initializeForecastIndexes(db: Db) { for (const [name, indexes] of Object.entries(forecastIndexes)) await db.collection(name).createIndexes(indexes); }
export async function checkForecastIndexes(db: Db): Promise<boolean> {
  for (const [name, expected] of Object.entries(forecastIndexes)) {
    if (!await db.listCollections({ name }, { nameOnly: true }).hasNext()) return false;
    const actual = await db.collection(name).listIndexes().toArray();
    for (const index of expected) { const match = actual.find((item) => item.name === index.name); if (!match || JSON.stringify(match.key) !== JSON.stringify(index.key) || Boolean(match.unique) !== Boolean(index.unique) || JSON.stringify(match.partialFilterExpression) !== JSON.stringify(index.partialFilterExpression)) return false; }
  }
  return true;
}
export function currentPolicyHash(seller: Pick<Seller, "settings">) { return payloadHash(seller.settings); }
export interface HistoryState { _id: string; sellerId: string; version: number; sequence: number; forecastLease: { runId: string; deadline: string } | null }
export interface HistoryScope extends ReadScope { history: HistoryState }
export interface StagedImport extends z.infer<typeof historyImportSchema> { normalizedRows: HistoryRow[] }
interface HistoryReceipt { _id: string; sellerId: string; idempotencyKey: string; operation: string; payloadHash: string; committedAt: string; actorUserId: string; stateRevision: number; historyVersion: number; output: z.infer<ReturnType<typeof z.json>> }
export async function forecastingSeller(db: Db, context: SellerContext, session?: ClientSession): Promise<Seller> {
  const raw = await db.collection("sellers").findOne({ _id: context.sellerId as never, ownerUserId: context.userId, status: "active" }, { session });
  if (!raw) throw new AppError("FORBIDDEN", "An active owner binding is required.", 403);
  if (raw.privacyDeleting) throw new AppError("PRIVACY_DELETING", "Seller erasure is in progress.", 409);
  // The Phase 1 DTO is strict; internal privacy flags are deliberately absent from the public seller DTO.
  return sellerSchema.parse(Object.fromEntries(Object.keys(sellerSchema.shape).map((key) => [key, raw[key]])));
}
const transactionOptions = { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 5000, timeoutMS: 15000 } as const;
async function stateFor(db: Db, sellerId: string, session: ClientSession): Promise<HistoryState> {
  return await db.collection<HistoryState>("historyStates").findOne({ sellerId }, { session }) ?? { _id: sellerId, sellerId, version: 0, sequence: 0, forecastLease: null };
}
export async function historyRead<T>(context: SellerContext, read: (scope: HistoryScope) => Promise<T>) {
  const db = await getDb(), client = await getClient(), now = new Date().toISOString();
  return client.withSession((session) => session.withTransaction(async () => { const seller = await forecastingSeller(db, context, session); return read({ db, session, seller, context, now, history: await stateFor(db, seller._id, session) }); }, transactionOptions));
}
export async function historyCommand<T>(name: string, input: { meta: { idempotencyKey: string }; expectedStateRevision: number; expectedHistoryVersion: number }, context: SellerContext, mutate: (scope: HistoryScope, receiptId: string) => Promise<T>): Promise<{ value: T; replayed: boolean }> {
  const db = await getDb(), client = await getClient(), receiptId = randomUUID();
  const hash = payloadHash({ operation: name, input });
  const replay = (receipt: HistoryReceipt) => { if (receipt.operation !== name || receipt.payloadHash !== hash) throw new AppError("IDEMPOTENCY_CONFLICT", "Request key has a different payload.", 409); return { value: receipt.output as T, replayed: true }; };
  try {
    return await client.withSession((session) => session.withTransaction(async () => {
      const seller = await forecastingSeller(db, context, session);
      const previous = await db.collection<HistoryReceipt>("historyReceipts").findOne({ sellerId: seller._id, idempotencyKey: input.meta.idempotencyKey }, { session });
      if (previous) return replay(previous);
      if (await db.collection<Receipt>("receipts").findOne({ sellerId: seller._id, idempotencyKey: input.meta.idempotencyKey }, { session })) throw new AppError("IDEMPOTENCY_CONFLICT", "Request key already belongs to another operation.", 409);
      if (await db.collection("aiRuns").findOne({ sellerId: seller._id, requestKey: input.meta.idempotencyKey }, { session })) throw new AppError("IDEMPOTENCY_CONFLICT", "Request key belongs to an analysis.", 409);
      assertRevision(seller.stateRevision, input.expectedStateRevision);
      const history = await stateFor(db, seller._id, session);
      assertRevision(history.version, input.expectedHistoryVersion);
      // Snapshot reads began before this instant; recording request-arrival time would backdate acquired facts.
      const now = new Date().toISOString();
      // Separate serialization point: history/admission never increments fulfillment stateRevision.
      await db.collection<HistoryState>("historyStates").updateOne({ sellerId: seller._id }, { $setOnInsert: { _id: seller._id, sellerId: seller._id, version: 0, forecastLease: null }, $inc: { sequence: 1 } }, { upsert: true, session });
      const value = await mutate({ db, session, seller, context, now, history }, receiptId);
      const fence = await db.collection<Seller & { privacyDeleting?: boolean }>("sellers").updateOne({ _id: seller._id, ownerUserId: context.userId, stateRevision: seller.stateRevision, status: "active", privacyDeleting: { $ne: true } }, { $set: { status: "active" } }, { session });
      if (!fence.matchedCount) throw new AppError("STALE_REVISION", "Seller state changed.", 409);
      const next = await stateFor(db, seller._id, session);
      await db.collection<HistoryReceipt>("historyReceipts").insertOne({ _id: receiptId, sellerId: seller._id, idempotencyKey: input.meta.idempotencyKey, operation: name, payloadHash: hash, committedAt: now, actorUserId: context.userId, stateRevision: seller.stateRevision, historyVersion: next.version, output: z.json().parse(value) }, { session });
      // Shared Phase 1 audit/lookup receipt records the reservation/history commit, not an order approval.
      const output = z.json().parse(value);
      const resourceId = output && typeof output === "object" && !Array.isArray(output) && typeof output._id === "string" ? output._id : receiptId;
      await db.collection<Receipt>("receipts").insertOne(receiptSchema.parse({ _id: receiptId, sellerId: seller._id, schemaVersion: 1, createdAt: now, operation: name, idempotencyKey: input.meta.idempotencyKey, payloadHash: hash, actorUserId: context.userId, committedAt: now, priorStateRevision: seller.stateRevision, stateRevision: seller.stateRevision, resourceIds: [resourceId], affectedDates: [], warnings: name === "requestForecast" || name === "evaluateHistory" ? ["Receipt confirms a compute reservation, not provider completion or an order approval."] : [], before: null, after: { historyVersion: next.version, output } }), { session });
      return { value, replayed: false };
    }, transactionOptions));
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === 11000) { await forecastingSeller(db, context); const previous = await db.collection<HistoryReceipt>("historyReceipts").findOne({ sellerId: context.sellerId, idempotencyKey: input.meta.idempotencyKey }); if (previous) return replay(previous); if (await db.collection<Receipt>("receipts").findOne({ sellerId: context.sellerId, idempotencyKey: input.meta.idempotencyKey })) throw new AppError("IDEMPOTENCY_CONFLICT", "Request key already belongs to another operation.", 409); }
    if (typeof error === "object" && error && "hasErrorLabel" in error && typeof error.hasErrorLabel === "function" && error.hasErrorLabel("UnknownTransactionCommitResult")) throw new AppError("COMMIT_UNCERTAIN", "Look up the request key before retrying.", 503);
    throw error;
  }
}
export async function bumpHistory(scope: HistoryScope) {
  if (scope.history.version >= Number.MAX_SAFE_INTEGER - 2) throw new AppError("INVALID_STATE", "History version exhausted.", 409);
  await scope.db.collection<HistoryState>("historyStates").updateOne({ sellerId: scope.seller._id }, { $inc: { version: 1 } }, { session: scope.session });
  await scope.db.collection("forecastRuns").updateMany({ sellerId: scope.seller._id, obsolete: false }, { $set: { obsolete: true } }, { session: scope.session });
  return scope.history.version + 1;
}
export function exactSupersession(actual: string[], requested: string[]) {
  if ([...new Set(actual)].sort().join() !== [...new Set(requested)].sort().join()) throw new AppError("HISTORY_CONFLICT", "Acknowledge exactly the active history IDs being superseded.", 409);
}
export function importDto(record: StagedImport) { return historyImportSchema.parse(Object.fromEntries(Object.keys(historyImportSchema.shape).map((key) => [key, record[key as keyof StagedImport]]))); }
export async function importFor(scope: HistoryScope, importId: string) { return found(await scope.db.collection<StagedImport>("historyImports").findOne({ sellerId: scope.seller._id, _id: importId }, { session: scope.session })); }
export function validateHistoryRows(rawRows: unknown[], options: { policyHash: string; timezone: string; evidenceMode: string; now?: string; planningTime?: string; cutoffTime?: string }) {
  const errors: z.infer<typeof historyImportSchema>["errors"] = [], rows: HistoryRow[] = [], dates = new Set<string>();
  for (const [index, raw] of rawRows.entries()) {
    const result = historyRowSchema.safeParse(raw);
    if (!result.success) { for (const issue of result.error.issues.slice(0, 10)) errors.push({ row: index + 1, code: "INVALID_ROW", message: `${issue.path.join(".")}: ${issue.message}`.slice(0, 256) }); continue; }
    const row = result.data;
    const error = (message: string) => errors.push({ row: index + 1, code: "INVALID_PROVENANCE", message });
    if (dates.has(row.serviceDate)) error("Duplicate service date");
    dates.add(row.serviceDate);
    if (row.policyHash !== options.policyHash || row.timezone !== options.timezone || row.evidenceMode !== options.evidenceMode) error("History timezone, policy or evidence mode mismatch");
    if (options.planningTime && options.cutoffTime) {
      try { if (Date.parse(row.cutoffAt) !== Date.parse(localTimeInstant(row.serviceDate, options.cutoffTime, options.timezone)) || Math.abs(Date.parse(row.asOf) - Date.parse(localTimeInstant(row.serviceDate, options.planningTime, options.timezone))) > 300000) error("History must match the declared cutoff and five-minute planning policy window"); }
      catch { error("History policy time is invalid or ambiguous"); }
    }
    if (row.provenance.kind === "native") error("Native provenance is server-generated only");
    if (options.now && Date.parse(row.outcomeAvailableAt) > Date.parse(options.now)) error("Outcome evidence is not available yet");
    rows.push(row);
  }
  return { rows, errors };
}
export function parseHistoryCsv(text: string): unknown[] {
  if (Buffer.byteLength(text, "utf8") > MAX_HISTORY_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "History import exceeds 2 MiB.", 413);
  const columns = new Set(["schemaVersion", "serviceDate", "timezone", "policyHash", "asOf", "cutoffAt", "outcomeAvailableAt", "confirmedMeals", "cutoffTotal", "features", "evidenceMode", "provenance"]);
  try {
    const records = parse(text, { bom: true, columns: (headers: string[]) => { if (new Set(headers).size !== headers.length || headers.length !== columns.size || headers.some((name) => !columns.has(name))) throw new Error("columns"); return headers; }, skip_empty_lines: true, max_record_size: 65536, on_record: (record: Record<string, string>, context: { records: number }) => { if (context.records > 2000) throw new Error("rows"); return record; } }) as Record<string, string>[];
    if (!records.length || records.length > 2000) throw new Error("rows");
    const jsonCell = (cell: string): unknown => { try { return JSON.parse(cell); } catch { return cell; } };
    return records.map((row) => ({ ...row, schemaVersion: /^\d+$/.test(row.schemaVersion) ? Number(row.schemaVersion) : row.schemaVersion, confirmedMeals: /^\d+$/.test(row.confirmedMeals) ? Number(row.confirmedMeals) : row.confirmedMeals, cutoffTotal: /^\d+$/.test(row.cutoffTotal) ? Number(row.cutoffTotal) : row.cutoffTotal, features: jsonCell(row.features), provenance: jsonCell(row.provenance) }));
  } catch { throw new AppError("VALIDATION_FAILED", "CSV must have strict history columns, valid JSON feature/provenance cells and at most 2000 rows.", 422); }
}
export async function stageHistory(input: HistoryInput<"stageHistory">, scope: HistoryScope) {
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_HISTORY_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "History import exceeds 2 MiB.", 413);
  const validated = validateHistoryRows(input.rows, { policyHash: currentPolicyHash(scope.seller), timezone: scope.seller.settings.timezone, evidenceMode: input.evidenceMode, now: scope.now, planningTime: scope.seller.settings.planningTime, cutoffTime: scope.seller.settings.cutoffTime });
  const metadata = historyImportSchema.parse({ _id: randomUUID(), sellerId: scope.seller._id, createdAt: scope.now, schemaVersion: 1, idempotencyKey: input.meta.idempotencyKey, payloadHash: payloadHash(input), digest: payloadHash(input.rows), format: input.format, evidenceMode: input.evidenceMode, status: validated.errors.length ? "invalid" : "staged", rowCount: input.rows.length, validRowCount: input.rows.length - new Set(validated.errors.map((error) => error.row)).size, errors: validated.errors, committedAt: null, committedBy: null, historyVersion: null });
  await scope.db.collection<StagedImport>("historyImports").insertOne({ ...metadata, normalizedRows: validated.rows }, { session: scope.session });
  return metadata;
}
export async function commitHistory(input: HistoryInput<"commitHistory">, scope: HistoryScope, receiptId: string) {
  const record = await importFor(scope, input.importId);
  if (record.status !== "staged" || record.digest !== input.digest) throw new AppError("HISTORY_CONFLICT", "Import must be a valid unchanged staging record.", 409);
  const conflicts = await scope.db.collection<AcceptedHistory>("historyRows").find({ sellerId: scope.seller._id, active: true, "row.serviceDate": { $in: record.normalizedRows.map((row) => row.serviceDate) } }, { session: scope.session }).toArray();
  const snapshotConflicts = await scope.db.collection<PlanningSnapshot>("planningSnapshots").find({ sellerId: scope.seller._id, active: true, serviceDate: { $in: record.normalizedRows.map((row) => row.serviceDate) } }, { session: scope.session }).toArray();
  exactSupersession([...conflicts.map((entry) => entry._id), ...snapshotConflicts.map((entry) => entry._id)], input.supersedesIds);
  const version = await bumpHistory(scope);
  await scope.db.collection<AcceptedHistory>("historyRows").updateMany({ sellerId: scope.seller._id, _id: { $in: conflicts.map((entry) => entry._id) } }, { $set: { active: false } }, { session: scope.session });
  await scope.db.collection<PlanningSnapshot>("planningSnapshots").updateMany({ sellerId: scope.seller._id, _id: { $in: snapshotConflicts.map((entry) => entry._id) } }, { $set: { active: false } }, { session: scope.session });
  await scope.db.collection<z.infer<typeof outcomeSchema>>("outcomes").updateMany({ sellerId: scope.seller._id, snapshotId: { $in: snapshotConflicts.map((entry) => entry._id) } }, { $set: { active: false } }, { session: scope.session });
  for (const row of record.normalizedRows) {
    const supersedesIds = [...conflicts.filter((entry) => entry.row.serviceDate === row.serviceDate).map((entry) => entry._id), ...snapshotConflicts.filter((entry) => entry.serviceDate === row.serviceDate).map((entry) => entry._id)];
    const snapshotId = randomUUID(), outcomeId = randomUUID();
    await scope.db.collection<AcceptedHistory>("historyRows").insertOne(acceptedHistorySchema.parse({ _id: randomUUID(), sellerId: scope.seller._id, snapshotId, outcomeId, createdAt: scope.now, historyVersion: version, active: true, supersedesIds, importId: record._id, row }), { session: scope.session });
    await scope.db.collection<PlanningSnapshot>("planningSnapshots").insertOne(planningSnapshotSchema.parse({ _id: snapshotId, sellerId: scope.seller._id, schemaVersion: 1, createdAt: scope.now, serviceDate: row.serviceDate, timezone: row.timezone, policyHash: row.policyHash, asOf: row.asOf, cutoffAt: row.cutoffAt, confirmedMeals: row.confirmedMeals, features: row.features, stateRevision: scope.seller.stateRevision, historyVersion: version, active: true, supersedesIds: [], evidenceMode: row.evidenceMode, provenanceReference: `import:${record._id}` }), { session: scope.session });
    await scope.db.collection<z.infer<typeof outcomeSchema>>("outcomes").insertOne(outcomeSchema.parse({ _id: outcomeId, sellerId: scope.seller._id, createdAt: scope.now, snapshotId, serviceDate: row.serviceDate, cutoffAt: row.cutoffAt, cutoffTotal: row.cutoffTotal, outcomeAvailableAt: row.outcomeAvailableAt, historyVersion: version, active: true, supersedesIds: [], provenance: row.provenance }), { session: scope.session });
  }
  const updated = { ...record, status: "committed" as const, committedAt: scope.now, committedBy: scope.context.userId, historyVersion: version };
  await scope.db.collection<StagedImport>("historyImports").replaceOne({ _id: record._id, sellerId: scope.seller._id }, updated, { session: scope.session });
  return { import: importDto(updated), historyVersion: version, receiptId };
}
export async function capturePlanningSnapshot(input: HistoryInput<"capturePlanningSnapshot">, scope: HistoryScope) {
  const settings = scope.seller.settings;
  if (input.policyHash !== currentPolicyHash(scope.seller)) throw new AppError("HISTORY_CONFLICT", "Current policy hash is required.", 409);
  const planningAt = localTimeInstant(input.serviceDate, settings.planningTime, settings.timezone), cutoffAt = localTimeInstant(input.serviceDate, settings.cutoffTime, settings.timezone);
  if (Math.abs(Date.parse(scope.now) - Date.parse(planningAt)) > 300000 || Date.parse(scope.now) >= Date.parse(cutoffAt)) throw new AppError("OUTSIDE_PLANNING_WINDOW", "Capture must occur within five minutes of today's configured planning time.", 409);
  const snapshots = await scope.db.collection<PlanningSnapshot>("planningSnapshots").find({ sellerId: scope.seller._id, serviceDate: input.serviceDate, active: true }, { session: scope.session }).toArray();
  const oldRows = await scope.db.collection<AcceptedHistory>("historyRows").find({ sellerId: scope.seller._id, active: true, "row.serviceDate": input.serviceDate }, { session: scope.session }).toArray();
  exactSupersession([...snapshots.map((s) => s._id), ...oldRows.map((r) => r._id)], input.supersedesIds);
  const orderState = await readOrderState(scope), day = calculateDay({ ...orderState, serviceDate: input.serviceDate, settings });
  const sources = await scope.db.collection<Source & { erasurePending?: boolean }>("sources").find({ sellerId: scope.seller._id, receivedAt: { $lte: scope.now }, erasurePending: { $ne: true } }, { session: scope.session }).toArray();
  const proposals = await scope.db.collection<Proposal>("proposals").find({ sellerId: scope.seller._id, createdAt: { $lte: scope.now } }, { session: scope.session }).toArray();
  const classifications = await scope.db.collection<ClassificationFeatureInput & { sellerId: string }>("classifications").find({ sellerId: scope.seller._id, computedAt: { $lte: scope.now } }, { session: scope.session }).toArray();
  const history = await scope.db.collection<AcceptedHistory>("historyRows").find({ sellerId: scope.seller._id, active: true }, { session: scope.session }).toArray();
  const messages = messageFeatures({ asOf: scope.now, serviceDate: input.serviceDate, sources, proposals, classifications });
  const features = buildFeatureRow({ serviceDate: input.serviceDate, asOf: scope.now, cutoffAt, baselineMeals: day.rows.reduce((sum, row) => sum + row.baseline, 0), confirmedMeals: day.total, activeCustomers: orderState.customers.filter((c) => c.status === "active").length, pendingChangeCount: pendingReviewCount(sources, proposals, input.serviceDate), policyHash: input.policyHash, evidenceMode: "real", history, messages });
  const version = await bumpHistory(scope);
  await scope.db.collection<PlanningSnapshot>("planningSnapshots").updateMany({ sellerId: scope.seller._id, _id: { $in: snapshots.map((s) => s._id) } }, { $set: { active: false } }, { session: scope.session });
  await scope.db.collection<z.infer<typeof outcomeSchema>>("outcomes").updateMany({ sellerId: scope.seller._id, snapshotId: { $in: snapshots.map((s) => s._id) } }, { $set: { active: false } }, { session: scope.session });
  await scope.db.collection<AcceptedHistory>("historyRows").updateMany({ sellerId: scope.seller._id, _id: { $in: oldRows.map((s) => s._id) } }, { $set: { active: false } }, { session: scope.session });
  const snapshot = planningSnapshotSchema.parse({ _id: randomUUID(), sellerId: scope.seller._id, schemaVersion: 1, createdAt: scope.now, serviceDate: input.serviceDate, timezone: settings.timezone, policyHash: input.policyHash, asOf: scope.now, cutoffAt, confirmedMeals: day.total, features, stateRevision: scope.seller.stateRevision, historyVersion: version, active: true, supersedesIds: input.supersedesIds, evidenceMode: "real", provenanceReference: "native:explicit_planning_capture:v1" });
  const featureInputs = { relevanceRuleVersion: 1, sourceVersions: sources.map((source) => ({ sourceId: source._id, revision: source.revision, receivedAt: source.receivedAt, status: source.status, deferredDate: source.deferredDate })), classifications: classifications.map((classification) => ({ classificationId: classification._id ?? null, runId: classification.runId ?? null, model: classification.model ?? null, promptVersion: classification.promptVersion ?? null, sourceId: classification.sourceId, sourceRevision: classification.sourceRevision, computedAt: classification.computedAt, labels: classification.labels ?? [], intent: classification.intent ?? null, reviewedAt: classification.reviewedAt && Date.parse(classification.reviewedAt) <= Date.parse(scope.now) ? classification.reviewedAt : null, reviewedLabels: classification.reviewedAt && Date.parse(classification.reviewedAt) <= Date.parse(scope.now) ? classification.reviewedLabels ?? null : null })), historyRowIds: history.map((entry) => entry._id), stateRevision: scope.seller.stateRevision };
  await scope.db.collection<PlanningSnapshot & { featureInputs: typeof featureInputs }>("planningSnapshots").insertOne({ ...snapshot, featureInputs }, { session: scope.session });
  return snapshot;
}
export async function recordOutcome(input: HistoryInput<"recordOutcome">, scope: HistoryScope) {
  const snapshot = found(await scope.db.collection<PlanningSnapshot>("planningSnapshots").findOne({ _id: input.snapshotId, sellerId: scope.seller._id, serviceDate: input.serviceDate, active: true }, { session: scope.session }));
  const imported = await importFor(scope, input.evidenceImportId), evidence = imported.normalizedRows[input.evidenceRow - 1];
  // Safe initial path: trusted explicit accepted aggregate provenance only. Phase 1 has no timestamp-complete cutoff replay contract.
  if (!["staged", "committed"].includes(imported.status) || !evidence || evidence.serviceDate !== snapshot.serviceDate || evidence.policyHash !== snapshot.policyHash || Date.parse(evidence.cutoffAt) !== Date.parse(snapshot.cutoffAt) || evidence.evidenceMode !== snapshot.evidenceMode || Date.parse(evidence.asOf) !== Date.parse(snapshot.asOf) || evidence.confirmedMeals !== snapshot.confirmedMeals || !["imported_complete", "synthetic"].includes(evidence.provenance.kind) || Date.parse(evidence.outcomeAvailableAt) > Date.parse(scope.now)) throw new AppError("CUTOFF_EVIDENCE_REQUIRED", "Explicit complete imported evidence must establish this exact snapshot and cutoff; current totals cannot stand in for past cutoff evidence.", 422);
  const old = await scope.db.collection<z.infer<typeof outcomeSchema>>("outcomes").find({ sellerId: scope.seller._id, snapshotId: snapshot._id, active: true }, { session: scope.session }).toArray();
  const oldRows = await scope.db.collection<AcceptedHistory>("historyRows").find({ sellerId: scope.seller._id, active: true, "row.serviceDate": input.serviceDate }, { session: scope.session }).toArray();
  exactSupersession([...old.map((o) => o._id), ...oldRows.map((r) => r._id)], input.supersedesIds);
  const version = await bumpHistory(scope);
  await scope.db.collection<z.infer<typeof outcomeSchema>>("outcomes").updateMany({ sellerId: scope.seller._id, _id: { $in: old.map((o) => o._id) } }, { $set: { active: false } }, { session: scope.session });
  await scope.db.collection<AcceptedHistory>("historyRows").updateMany({ sellerId: scope.seller._id, _id: { $in: oldRows.map((r) => r._id) } }, { $set: { active: false } }, { session: scope.session });
  const outcome = outcomeSchema.parse({ _id: randomUUID(), sellerId: scope.seller._id, createdAt: scope.now, snapshotId: snapshot._id, serviceDate: snapshot.serviceDate, cutoffAt: snapshot.cutoffAt, cutoffTotal: evidence.cutoffTotal, outcomeAvailableAt: evidence.outcomeAvailableAt, historyVersion: version, active: true, supersedesIds: input.supersedesIds, provenance: evidence.provenance });
  await scope.db.collection<z.infer<typeof outcomeSchema>>("outcomes").insertOne(outcome, { session: scope.session });
  const provenance = { ...evidence.provenance, messageFeatures: snapshot.features[13] === 1 ? "as_of" : "missing", messageEvidenceAt: snapshot.features[13] === 1 ? snapshot.asOf : null };
  await scope.db.collection<AcceptedHistory>("historyRows").insertOne(acceptedHistorySchema.parse({ _id: randomUUID(), sellerId: scope.seller._id, snapshotId: snapshot._id, outcomeId: outcome._id, createdAt: scope.now, historyVersion: version, active: true, supersedesIds: oldRows.map((r) => r._id), importId: imported._id, row: { ...evidence, asOf: snapshot.asOf, cutoffAt: snapshot.cutoffAt, features: snapshot.features, provenance } }), { session: scope.session });
  return outcome;
}
