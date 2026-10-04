import "server-only";
import { randomUUID } from "node:crypto";
import type { BackboardClient } from "backboard-sdk";
import { MongoError, MongoServerError, type ClientSession, type Db, type Document, type Filter, type IndexDescription } from "mongodb";
import { AppError, timestampSchema, type SellerContext } from "@/lib/contracts/common";
import { DEFAULT_SETTINGS, proposalSchema, receiptSchema, sourceSchema } from "@/lib/contracts/records";
import { privacyInputSchemas, privacyOutputSchemas, privacyOperationSchema, type PrivacyInput, type PrivacyOperation, type PrivacyOperationName, type PrivacyOutput } from "@/lib/contracts/privacy";
import { getClient, getDb } from "./db/client";
import { assertRevision, found, ownerSeller, payloadHash, readSnapshot } from "./receipts";
import { aiRunRecordSchema } from "./ai/runs";

export type PrivacyContext = SellerContext & { sessionCreatedAt?: string };
type Row = Document & { _id: string; sellerId?: string };
type StoredOperation = Row & {
  ownerUserId: string; requestKey: string; payloadHash: string;
  view: PrivacyOperation; sourceIds: string[];
  threads: { id: string; confirmed: boolean }[];
};

export const PRIVACY_MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 1000;
const BATCH_SIZE = 100;
// Explicit inventory: auth users/accounts/sessions and infrastructure counters are not seller-owned business collections.
export const SELLER_OWNED_COLLECTIONS = ["customers", "plans", "dailyOverrides", "sources", "proposals", "sheets", "receipts", "aiRuns", "classifications", "aiAdmissions", "planningSnapshots", "outcomes", "historyImports", "historyRows", "historyReceipts", "historyStates", "forecastRuns", "forecastAdmissions", "forecastEvaluations", "forecastEvaluationRuns", "commerceSettings", "customerCommerce", "invoices"] as const;
export const privacyIndexes: Record<string, IndexDescription[]> = {
  privacyOperations: [
    { key: { sellerId: 1, requestKey: 1 }, name: "privacy_seller_key_unique", unique: true },
    { key: { sellerId: 1, ownerUserId: 1, _id: 1 }, name: "privacy_owner_operation" },
  ],
};
export async function initializePrivacyIndexes(db: Db): Promise<void> {
  await db.collection("privacyOperations").createIndexes(privacyIndexes.privacyOperations);
}
export async function checkPrivacyIndexes(db: Db): Promise<boolean> {
  if (!await db.listCollections({ name: "privacyOperations" }, { nameOnly: true }).hasNext()) return false;
  const actual = await db.collection("privacyOperations").listIndexes().toArray();
  return privacyIndexes.privacyOperations.every((expected) => actual.some((index) => index.name === expected.name && JSON.stringify(index.key) === JSON.stringify(expected.key) && Boolean(index.unique) === Boolean(expected.unique)));
}
const txnOptions = { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 5000, timeoutMS: 15000 } as const;

async function boundedRows(db: Db, collection: string, filter: Filter<Row>, session?: ClientSession): Promise<Row[]> {
  const cursor = db.collection<Row>(collection).find(filter, { session }).sort({ _id: 1 }).limit(MAX_ROWS + 1);
  const rows: Row[] = [];
  let bytes = 0;
  try {
    for await (const row of cursor) {
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (rows.length === MAX_ROWS || bytes > PRIVACY_MAX_BYTES) throw new AppError("PRIVACY_LIMIT_EXCEEDED", "Privacy scope exceeds the bounded operation limit; request operator reconciliation.", 413);
      rows.push(row);
    }
  } finally {
    await cursor.close();
  }
  return rows;
}

const factKeys = new Set(["_id", "sellerId", "schemaVersion", "createdAt", "sourceId", "sourceRevision", "customerId", "revision", "draftRevision", "sentAt", "receivedAt", "channel", "replacesSourceId", "status", "deferredDate", "operations", "type", "serviceDate", "quantity", "fromDate", "toDate", "startDate", "endDate", "quantities", "approvalId", "supersedesPlanIds", "plans", "overrides", "supersedesApprovalIds", "acknowledgeLateChange"]);

/** Erase content in nested Phase 1 receipt snapshots, keeping only minimal approved order facts. */
export function redactSourceSnapshots(value: unknown, sourceIds: ReadonlySet<string>, affected = false): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSourceSnapshots(item, sourceIds, affected));
  if (value === null || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const target = affected || (typeof row.sourceId === "string" && sourceIds.has(row.sourceId)) || (typeof row._id === "string" && sourceIds.has(row._id));
  if (!target) return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, redactSourceSnapshots(item, sourceIds)]));
  const clean = Object.fromEntries(Object.entries(row).filter(([key]) => factKeys.has(key)).map(([key, item]) => [key, redactSourceSnapshots(item, sourceIds, true)]));
  if ("text" in row) Object.assign(clean, { text: "[erased]", fingerprint: "erased", upstreamId: null, dispositionReason: null });
  if ("draftRevision" in row) Object.assign(clean, { evidenceSpans: [], manualReason: null, missingFields: ["source_evidence_erased"], dispositionReason: null });
  return clean;
}

const exportKeys = new Set([
  "upiId", "helperPhone", "profile", "unitPricePaise", "phone", "routeName", "routeOrder", "deliveryNote", "month", "currency", "lines", "baseAmountPaise", "amountPaise", "adjustmentPaise", "adjustmentReason", "sheetId", "sheetRevision", "approvalReceiptId", "approvalReceiptKey", "approvedAt", "baselineSubtotalPaise", "skipCreditPaise", "reductionCreditPaise", "extraChargesPaise", "adjustmentsPaise", "totalPaise", "missingDates", "canIssue", "basisHash", "priorInvoiceId", "message", "issuedAt", "issuedBy", "previousInvoiceId",
  ...factKeys, "settings", "timezone", "weekdays", "quantityCap", "customerCap", "planningTime", "cutoffTime", "stateRevision", "alias", "packingNote", "text", "upstreamId", "fingerprint", "manualReason", "evidenceSpans", "start", "end", "missingFields", "dispositionReason", "erasurePending",
  "rows", "baseline", "total", "computedFromStateRevision", "committedStateRevision", "finalizedBy", "finalizedAt", "previousSheetId", "delta", "before", "after", "difference", "operation", "committedAt", "priorStateRevision", "resourceIds", "affectedDates", "warnings",
  "runId", "stage", "updatedAt", "completedAt", "deadline", "retryOfRunId", "expectedStateRevision", "proposalIds", "classificationId", "models", "gemmaProvider", "gemmaRequested", "gemmaResolved", "jevRequested", "jevResolved", "promptVersion", "usage", "gemma", "jev", "inputTokens", "outputTokens", "state",
  "policyVersion", "snapshotRevision", "outcomeRevision", "snapshotId", "asOf", "cutoffAt", "availableAt", "outcomeAvailableAt", "confirmedMeals", "confirmedMealsAtSnapshot", "confirmedMealsAtCutoff", "baselineMeals", "targetDelta", "features", "featureSchemaVersion", "weekday", "minutesToCutoff", "activeCustomers", "receivedSourceCount", "pauseIntentCount", "resumeIntentCount", "quantityChangeIntentCount", "unclearSourceCount", "pendingChangeCount", "recentMeanDelta", "recentSameWeekdayDelta", "messageFeaturesAvailable", "evidenceMode", "provenance", "completeness", "supersedesId", "active", "datasetVersion", "dataHash", "result", "status", "modelVersion", "predictedDelta", "roundedDelta", "trainingRows", "durationMs", "model", "method", "coverage", "trainingFrom", "trainingTo", "historyVersion", "format", "rowCount", "validRows", "invalidRows", "confirmedAt", "computedAt", "reviewedAt", "intent", "labels", "probabilities", "clarity", "replacement",
  "row", "output", "normalizedRows", "policyHash", "cutoffTotal", "supersedesIds", "importId", "validRowCount", "committedBy", "kind", "reference", "complete", "snapshotEvidenceAt", "cutoffEvidenceAt", "messageFeatures", "messageEvidenceAt", "provenanceReference", "runState", "datasetHash", "featureNames", "queryRow", "experiment", "obsolete", "roundingRule", "baselineDelta", "baselineMethod", "holdoutRows", "evaluationId", "version",
  "pause", "resume", "quantity_change", "recurring_change", "multi_intent", "unsupported", "unclear", "no_change", "unknownSpend", "extractionAvailable",
]);

/** Export only known business fields; never pass through arbitrary provider/auth/DB subdocuments. */
export function privacyExportRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(privacyExportRecord);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => exportKeys.has(key)).map(([key, item]) => [key === "_id" ? "id" : key, privacyExportRecord(item)]));
}

async function exportBusiness(context: SellerContext): Promise<PrivacyOutput<"privacyExport">> {
  return readSnapshot(context, async ({ db, session, seller, now }) => {
    const data: Record<string, unknown> = { schemaVersion: 1, exportedAt: now, seller: privacyExportRecord(seller) };
    let bytes = Buffer.byteLength(JSON.stringify(data));
    for (const collection of SELLER_OWNED_COLLECTIONS) {
      if (["aiAdmissions", "historyStates", "forecastAdmissions"].includes(collection)) continue;
      const rows = await boundedRows(db, collection, { sellerId: seller._id }, session);
      data[collection] = rows.map(privacyExportRecord);
      bytes += Buffer.byteLength(JSON.stringify(data[collection]));
      if (bytes > PRIVACY_MAX_BYTES) throw new AppError("PRIVACY_LIMIT_EXCEEDED", "Export exceeds the 2 MiB limit; request a narrower operator export.", 413);
    }
    const json = JSON.stringify(data);
    const length = Buffer.byteLength(json);
    if (length > PRIVACY_MAX_BYTES) throw new AppError("PRIVACY_LIMIT_EXCEEDED", "Export exceeds the 2 MiB limit.", 413);
    return { filename: "seller-business-data.json", contentType: "application/json; charset=utf-8", json, bytes: length };
  });
}

function replay(operation: StoredOperation, hash: string): PrivacyOperation {
  if (operation.payloadHash !== hash) throw new AppError("IDEMPOTENCY_CONFLICT", "This privacy key belongs to a different request.", 409);
  return privacyOperationSchema.parse(operation.view);
}

export function requireFreshPrivacySession(context: PrivacyContext, now = Date.now()): void {
  const created = timestampSchema.safeParse(context.sessionCreatedAt).success ? Date.parse(context.sessionCreatedAt!) : NaN;
  if (!Number.isFinite(created) || created > now || now - created > 5 * 60 * 1000) throw new AppError("FRESH_AUTH_REQUIRED", "Authenticate again before erasing seller data.", 403);
}

function threadInventory(runs: Row[]): { threads: StoredOperation["threads"]; gaps: PrivacyOperation["gaps"] } {
  const ids = new Set<string>();
  const gaps = new Set<PrivacyOperation["gaps"][number]>();
  for (const run of runs) {
    // Unknown/running work can create remote records after this snapshot. Never infer cancellation.
    if (run.state === "running" || run.state === "unknown") gaps.add("INFLIGHT_PROVIDER_CALL");
    const providerIds = run.providerIds;
    let knownThread = false;
    if (providerIds && typeof providerIds === "object") {
      for (const stage of Object.values(providerIds)) {
        if (stage && typeof stage === "object" && "threadId" in stage && typeof stage.threadId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(stage.threadId)) { ids.add(stage.threadId); knownThread = true; }
      }
    }
    if (run.stage !== "reserved" && !knownThread) gaps.add("PROVIDER_IDENTIFIERS_UNAVAILABLE");
  }
  if (runs.some((run) => run.stage !== "reserved")) gaps.add("PROVIDER_RETENTION_UNVERIFIED");
  return { threads: [...ids].map((id) => ({ id, confirmed: false })), gaps: [...gaps] };
}

async function redactLocalSources(db: Db, session: ClientSession, context: SellerContext, input: PrivacyInput<"eraseSources">): Promise<{ count: number; runs: Row[]; hadClassifications: boolean }> {
  const ids = new Set(input.sourceIds);
  const sources = await boundedRows(db, "sources", { sellerId: context.sellerId, _id: { $in: input.sourceIds } }, session);
  if (sources.length !== input.sourceIds.length) throw new AppError("NOT_FOUND", "A source was not found.", 404);
  for (const source of sources) {
    assertRevision(source.revision, input.expectedSourceRevisions[source._id]);
    if (source.revision >= Number.MAX_SAFE_INTEGER - 1) throw new AppError("INVALID_STATE", "Source revision limit reached.", 409);
  }
  const proposals = await boundedRows(db, "proposals", { sellerId: context.sellerId, sourceId: { $in: input.sourceIds } }, session);
  const runs = await boundedRows(db, "aiRuns", { sellerId: context.sellerId, sourceId: { $in: input.sourceIds } }, session);
  const classifications = await boundedRows(db, "classifications", { sellerId: context.sellerId, sourceId: { $in: input.sourceIds } }, session);
  const receipts = await boundedRows(db, "receipts", { sellerId: context.sellerId }, session);
  const snapshots = await boundedRows(db, "planningSnapshots", { sellerId: context.sellerId }, session);
  for (const source of sources) {
    const safe = sourceSchema.parse({
      ...Object.fromEntries(Object.keys(sourceSchema.shape).map((key) => [key, source[key]])),
      text: "[erased]", fingerprint: "erased", upstreamId: null, dispositionReason: null,
      status: "superseded", deferredDate: null, revision: source.revision + 1,
    });
    await db.collection<Row>("sources").replaceOne({ _id: source._id, sellerId: context.sellerId }, { ...safe, erasurePending: true }, { session });
  }
  for (const proposal of proposals) {
    const safe = proposalSchema.parse({
      ...Object.fromEntries(Object.keys(proposalSchema.shape).map((key) => [key, proposal[key]])),
      evidenceSpans: [], manualReason: null, dispositionReason: null, missingFields: ["source_evidence_erased"],
      ...(proposal.status === "approved" ? {} : { status: "obsolete", deferredDate: null }), draftRevision: proposal.draftRevision + 1,
    });
    await db.collection<Row>("proposals").replaceOne({ _id: proposal._id, sellerId: context.sellerId }, safe, { session });
  }
  for (const run of runs) {
    // Retain only non-content run provenance plus the private identifiers needed for deletion.
    const safe = aiRunRecordSchema.parse({
      ...Object.fromEntries(Object.keys(aiRunRecordSchema.shape).map((key) => [key, run[key]])),
      state: "obsolete", extraction: null, classification: null, extractionAvailable: false,
      classificationId: null, capturedDraftHash: "erased", error: null, warnings: ["source_evidence_erased"], updatedAt: new Date().toISOString(),
    });
    await db.collection<Row>("aiRuns").replaceOne({ _id: run._id, sellerId: context.sellerId }, safe, { session });
  }
  await db.collection<Row>("classifications").deleteMany({ sellerId: context.sellerId, sourceId: { $in: input.sourceIds } }, { session });
  let count = sources.length + proposals.length + runs.length + classifications.length;
  for (const receipt of receipts) {
    const before = redactSourceSnapshots(receipt.before, ids);
    const after = redactSourceSnapshots(receipt.after, ids);
    if (JSON.stringify(before) !== JSON.stringify(receipt.before) || JSON.stringify(after) !== JSON.stringify(receipt.after)) {
      await db.collection<Row>("receipts").updateOne({ _id: receipt._id, sellerId: context.sellerId }, { $set: { before, after } }, { session });
      count++;
    }
  }
  for (const snapshot of snapshots) {
    if (!snapshot.featureInputs) continue;
    const featureInputs = redactSourceSnapshots(snapshot.featureInputs, ids);
    if (JSON.stringify(featureInputs) !== JSON.stringify(snapshot.featureInputs)) {
      await db.collection<Row>("planningSnapshots").updateOne({ _id: snapshot._id, sellerId: context.sellerId }, { $set: { featureInputs } }, { session });
      count++;
    }
  }
  return { count, runs, hadClassifications: classifications.length > 0 };
}

async function erase(kind: "eraseSources" | "eraseSeller", input: PrivacyInput<"eraseSources"> | PrivacyInput<"eraseSeller">, context: PrivacyContext): Promise<PrivacyOperation> {
  if (kind === "eraseSeller") {
    requireFreshPrivacySession(context);
    if ((input as PrivacyInput<"eraseSeller">).sellerId !== context.sellerId) throw new AppError("FORBIDDEN", "Seller confirmation does not match the owner session.", 403);
  }
  const db = await getDb();
  const client = await getClient();
  const hash = payloadHash({ operation: kind, input });
  const key = input.meta.idempotencyKey;
  await requirePrivacyOwner(db, context);
  const previous = await db.collection<StoredOperation>("privacyOperations").findOne({ sellerId: context.sellerId, ownerUserId: context.userId, requestKey: key });
  if (previous) return replay(previous, hash);
  const operationId = randomUUID();
  const now = new Date().toISOString();
  let reserved = false;
  try {
    reserved = await client.withSession((session) => session.withTransaction(async () => {
      const seller = await ownerSeller(db, context, session);
      const existing = await db.collection<StoredOperation>("privacyOperations").findOne({ sellerId: context.sellerId, requestKey: key }, { session });
      if (existing) { replay(existing, hash); return false; }
      if (await db.collection("receipts").findOne({ sellerId: seller._id, idempotencyKey: key }, { session })) throw new AppError("IDEMPOTENCY_CONFLICT", "This operation key belongs to another command.", 409);
      for (const [collection, field] of [["aiRuns", "requestKey"], ["forecastRuns", "requestKey"], ["historyReceipts", "idempotencyKey"]]) {
        if (await db.collection<Row>(collection).findOne({ sellerId: seller._id, [field]: key }, { session })) throw new AppError("IDEMPOTENCY_CONFLICT", "This operation key belongs to another command.", 409);
      }
      assertRevision(seller.stateRevision, input.expectedStateRevision);
      if (seller.stateRevision >= Number.MAX_SAFE_INTEGER - 2) throw new AppError("INVALID_STATE", "Seller revision limit reached.", 409);
      const lock = await db.collection<Row>("sellers").updateOne({ _id: seller._id, ownerUserId: context.userId, stateRevision: input.expectedStateRevision, privacyDeleting: { $ne: true } }, { $inc: { stateRevision: 1 }, ...(kind === "eraseSeller" ? { $set: { privacyDeleting: true } } : {}) }, { session });
      if (lock.modifiedCount !== 1) throw new AppError("STALE_REVISION", "Seller state changed.", 409);
      const local = kind === "eraseSources" ? await redactLocalSources(db, session, context, input as PrivacyInput<"eraseSources">) : { count: 0, runs: await boundedRows(db, "aiRuns", { sellerId: seller._id }, session), hadClassifications: !!await db.collection<Row>("classifications").findOne({ sellerId: seller._id }, { session, projection: { _id: 1 } }) };
      const remote = threadInventory(local.runs);
      if (local.hadClassifications) {
        if (!remote.gaps.includes("PROVIDER_RETENTION_UNVERIFIED")) remote.gaps.push("PROVIDER_RETENTION_UNVERIFIED");
        if (!remote.threads.length && !remote.gaps.includes("PROVIDER_IDENTIFIERS_UNAVAILABLE")) remote.gaps.push("PROVIDER_IDENTIFIERS_UNAVAILABLE");
      }
      const oldOperations = await boundedRows(db, "privacyOperations", { sellerId: seller._id, ...(kind === "eraseSources" ? { sourceIds: { $in: (input as PrivacyInput<"eraseSources">).sourceIds } } : {}) }, session);
      for (const old of oldOperations) {
        for (const thread of (old as StoredOperation).threads ?? []) {
          const known = remote.threads.find((item) => item.id === thread.id);
          if (!known) remote.threads.push({ ...thread });
          else if (thread.confirmed) known.confirmed = true;
        }
        for (const gap of (old as StoredOperation).view.gaps) if (!["LOCAL_CLEANUP_PENDING", "AUTH_SESSIONS_RETAINED"].includes(gap) && !remote.gaps.includes(gap)) remote.gaps.push(gap);
      }
      const gaps: PrivacyOperation["gaps"] = [...remote.gaps];
      if (kind === "eraseSeller") gaps.push("AUTH_SESSIONS_RETAINED", "LOCAL_CLEANUP_PENDING");
      const confirmed = remote.threads.filter((thread) => thread.confirmed).length;
      const view: PrivacyOperation = { operationId, receiptId: operationId, kind: kind === "eraseSeller" ? "seller_erasure" : "source_erasure", state: "running", createdAt: now, updatedAt: now, stateRevision: seller.stateRevision + 1, counts: { localRecords: local.count, remoteConfirmed: confirmed, remotePending: remote.threads.length - confirmed }, gaps };
      await db.collection<StoredOperation>("privacyOperations").insertOne({ _id: operationId, sellerId: seller._id, ownerUserId: context.userId, requestKey: key, payloadHash: hash, view, sourceIds: kind === "eraseSources" ? (input as PrivacyInput<"eraseSources">).sourceIds : [], threads: remote.threads }, { session });
      const receipt = receiptSchema.parse({ _id: operationId, sellerId: seller._id, schemaVersion: 1, createdAt: now, operation: kind, idempotencyKey: key, payloadHash: hash, actorUserId: context.userId, committedAt: now, priorStateRevision: seller.stateRevision, stateRevision: seller.stateRevision + 1, resourceIds: [operationId], affectedDates: [], warnings: [], before: null, after: { operationId, kind: view.kind } });
      await db.collection<Row>("receipts").insertOne(receipt, { session });
      return true;
    }, txnOptions));
  } catch (error) {
    if (error instanceof MongoError && error.hasErrorLabel("UnknownTransactionCommitResult")) throw new AppError("COMMIT_UNCERTAIN", "Privacy commit is uncertain; look up the operation key before retrying.", 503);
    if (error instanceof MongoServerError && error.code === 11000) {
      const existing = await db.collection<StoredOperation>("privacyOperations").findOne({ sellerId: context.sellerId, ownerUserId: context.userId, requestKey: key });
      if (existing) return replay(existing, hash);
    }
    throw error;
  }
  const operation = found(await db.collection<StoredOperation>("privacyOperations").findOne({ sellerId: context.sellerId, ownerUserId: context.userId, requestKey: key }));
  if (!reserved) return replay(operation, hash);
  // Remote effects are synchronous and outside retryable transactions; duplicate keys only read progress.
  return reconcilePrivacyOperation(db, operation._id, context);
}

async function boundedDeleteThread(client: BackboardClient, id: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // SDK 1.5.19 passes an unsupported `timeout` to node-fetch 3. Bound our wait, and report uncertainty on timeout.
    const response: unknown = await Promise.race([client.deleteThread(id), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError("REMOTE_DELETE_UNCONFIRMED", "Remote deletion was not confirmed.", 504)), 5000); })]);
    if (!response || typeof response !== "object" || !("thread_id" in response) || response.thread_id !== id || !("deleted_at" in response) || !timestampSchema.safeParse(response.deleted_at).success) throw new AppError("REMOTE_DELETE_UNCONFIRMED", "Remote deletion confirmation was invalid.", 502);
  } finally { if (timer) clearTimeout(timer); }
}

/** Explicit trusted/operator invocation only. Reads never run remote deletes or local cleanup. */
export async function reconcilePrivacyOperation(db: Db, operationId: string, context: SellerContext): Promise<PrivacyOperation> {
  await requirePrivacyOwner(db, context);
  const operation = found(await db.collection<StoredOperation>("privacyOperations").findOne({ _id: operationId, sellerId: context.sellerId, ownerUserId: context.userId }));
  const gaps = new Set(operation.view.gaps);
  if (operation.view.kind === "source_erasure") {
    // A dispatched call can report its thread after erasure. Discover and durably retain that late ID.
    const inventory = threadInventory(await boundedRows(db, "aiRuns", { sellerId: context.sellerId, sourceId: { $in: operation.sourceIds } }));
    for (const thread of inventory.threads) if (!operation.threads.some((known) => known.id === thread.id)) operation.threads.push(thread);
    for (const gap of inventory.gaps) gaps.add(gap);
    await db.collection<StoredOperation>("privacyOperations").updateOne({ _id: operationId, sellerId: context.sellerId, ownerUserId: context.userId }, { $set: { threads: operation.threads } });
  }
  let localCount = operation.view.counts.localRecords;
  if (operation.view.kind === "seller_erasure") {
    const seller = await db.collection<Row>("sellers").findOne({ _id: context.sellerId, ownerUserId: context.userId, privacyDeleting: true });
    if (!seller) throw new AppError("FORBIDDEN", "Deletion-in-progress owner binding is required.", 403);
    // ponytail: one 100-row batch per collection/call; operators repeat explicitly for larger accounts.
    let remains = false;
    for (const collection of SELLER_OWNED_COLLECTIONS) {
      const rows = await db.collection<Row>(collection).find({ sellerId: context.sellerId }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(BATCH_SIZE).toArray();
      if (rows.length) localCount += (await db.collection<Row>(collection).deleteMany({ sellerId: context.sellerId, _id: { $in: rows.map((row) => row._id) } })).deletedCount;
      if (await db.collection<Row>(collection).findOne({ sellerId: context.sellerId }, { projection: { _id: 1 } })) remains = true;
    }
    // Retain a schema-compatible tombstone binding so only owner-scoped progress remains accessible.
    const oldOperations = await db.collection<Row>("privacyOperations").find({ sellerId: context.sellerId, _id: { $ne: operationId } }, { projection: { _id: 1 } }).limit(BATCH_SIZE).toArray();
    if (oldOperations.length) await db.collection<Row>("privacyOperations").deleteMany({ sellerId: context.sellerId, _id: { $in: oldOperations.map((row) => row._id) } });
    if (await db.collection<Row>("privacyOperations").findOne({ sellerId: context.sellerId, _id: { $ne: operationId } }, { projection: { _id: 1 } })) remains = true;
    await db.collection<Row>("sellers").updateOne({ _id: context.sellerId, ownerUserId: context.userId, privacyDeleting: true }, { $set: { privacyDeleting: true, settings: DEFAULT_SETTINGS } });
    if (!remains) gaps.delete("LOCAL_CLEANUP_PENDING");
  }
  const pending = operation.threads.filter((thread) => !thread.confirmed);
  if (pending.length && process.env.BACKBOARD_API_KEY) {
    const { BackboardClient } = await import("backboard-sdk");
    const client = new BackboardClient({ apiKey: process.env.BACKBOARD_API_KEY, timeout: 5000 });
    for (const thread of pending.slice(0, 5)) {
      try {
        await boundedDeleteThread(client, thread.id);
        thread.confirmed = true;
        // Persist every confirmation; a later crash must not erase confirmed progress.
        await db.collection<StoredOperation>("privacyOperations").updateOne({ _id: operationId, sellerId: context.sellerId, "threads.id": thread.id }, { $set: { "threads.$.confirmed": true } });
      } catch {
        gaps.add("REMOTE_DELETE_UNCONFIRMED");
        break;
      }
    }
  } else if (pending.length) gaps.add("REMOTE_DELETE_UNCONFIRMED");
  const unconfirmed = operation.threads.filter((thread) => !thread.confirmed).length;
  if (!unconfirmed) gaps.delete("REMOTE_DELETE_UNCONFIRMED");
  else gaps.add("REMOTE_DELETE_UNCONFIRMED");
  const state = gaps.has("LOCAL_CLEANUP_PENDING") ? "partial" : gaps.size ? "needs_reconciliation" : "completed";
  const view = privacyOperationSchema.parse({ ...operation.view, state, updatedAt: new Date().toISOString(), counts: { localRecords: localCount, remoteConfirmed: operation.threads.length - unconfirmed, remotePending: unconfirmed }, gaps: [...gaps] });
  await db.collection<StoredOperation>("privacyOperations").updateOne({ _id: operationId, sellerId: context.sellerId, ownerUserId: context.userId }, { $set: { view } });
  return view;
}

export async function getPrivacyOperation(input: PrivacyInput<"getPrivacyOperation">, context: SellerContext): Promise<PrivacyOperation> {
  const db = await getDb();
  await requirePrivacyOwner(db, context);
  const operation = found(await db.collection<StoredOperation>("privacyOperations").findOne({ _id: input.operationId, sellerId: context.sellerId, ownerUserId: context.userId }));
  return privacyOperationSchema.parse(operation.view);
}

export async function getPrivacyOperationByKey(requestKey: string, context: SellerContext): Promise<PrivacyOperation | null> {
  const db = await getDb();
  await requirePrivacyOwner(db, context);
  const operation = await db.collection<StoredOperation>("privacyOperations").findOne({ sellerId: context.sellerId, ownerUserId: context.userId, requestKey });
  return operation ? privacyOperationSchema.parse(operation.view) : null;
}

/** Operator dry-run only: no automatic policy defaults and no deletion side effects. */
export async function dryRunRetention(db: Db, before: string, limit = BATCH_SIZE, sellerId?: string): Promise<{ collection: string; eligible: number; truncated: boolean }[]> {
  if (!timestampSchema.safeParse(before).success || !Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) throw new AppError("VALIDATION_FAILED", "A valid retention cutoff and bounded limit are required.", 422);
  const result = [];
  for (const collection of ["sources", "aiRuns", "classifications", "historyImports"] as const) {
    const ageField = collection === "classifications" ? "computedAt" : "createdAt";
    const rows = await db.collection(collection).find({ [ageField]: { $lt: before }, ...(sellerId ? { sellerId } : {}) }, { projection: { _id: 1 } }).limit(limit + 1).toArray();
    result.push({ collection, eligible: Math.min(rows.length, limit), truncated: rows.length > limit });
  }
  return result;
}

async function requirePrivacyOwner(db: Db, context: SellerContext): Promise<void> {
  if (!await db.collection<Row>("sellers").findOne({ _id: context.sellerId, ownerUserId: context.userId, status: "active" }, { projection: { _id: 1 } })) throw new AppError("FORBIDDEN", "An owner binding is required for privacy progress.", 403);
}

export async function executePrivacyOperation<K extends PrivacyOperationName>(name: K, rawInput: unknown, context: PrivacyContext): Promise<PrivacyOutput<K>> {
  const input = privacyInputSchemas[name].safeParse(rawInput);
  if (!input.success) throw new AppError("VALIDATION_FAILED", "Privacy input is invalid.", 422);
  const result = name === "privacyExport" ? await exportBusiness(context)
    : name === "getPrivacyOperation" ? await getPrivacyOperation(input.data as PrivacyInput<"getPrivacyOperation">, context)
    : await erase(name, input.data as PrivacyInput<"eraseSources"> | PrivacyInput<"eraseSeller">, context);
  const output = privacyOutputSchemas[name].safeParse(result);
  if (!output.success) throw new AppError("INTERNAL_ERROR", "Privacy result is invalid; inspect deletion progress before retrying.", 500);
  return output.data as PrivacyOutput<K>;
}
