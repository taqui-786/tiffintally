import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/contracts/records";
import { privacyInputSchemas, privacyOperationSchema } from "@/lib/contracts/privacy";

type Row = Record<string, unknown> & { _id: string };
const mocks = vi.hoisted(() => ({ db: vi.fn(), client: vi.fn(), deleteThread: vi.fn() }));
vi.mock("@/lib/server/db/client", () => ({ getDb: mocks.db, getClient: mocks.client }));
vi.mock("backboard-sdk", () => ({ BackboardClient: class { deleteThread = mocks.deleteThread; } }));
import { executePrivacyOperation, getPrivacyOperationByKey, privacyExportRecord, reconcilePrivacyOperation, redactSourceSnapshots, requireFreshPrivacySession, SELLER_OWNED_COLLECTIONS } from "@/lib/server/privacy";

let store: Record<string, Row[]>;
let inTransaction = false;
const context = { sellerId: "seller-a", userId: "owner-a", requestId: "request-a" };
const now = "2026-10-04T08:00:00.000Z";
const base = { sellerId: context.sellerId, schemaVersion: 1, createdAt: now };
const source = () => ({ ...base, _id: "source-a", text: "SECRET-source", sentAt: now, receivedAt: now, customerId: "customer-a", revision: 0, status: "needs_review", deferredDate: null, fingerprint: "SECRET-fingerprint", channel: "manual", upstreamId: "SECRET-upstream", replacesSourceId: null, dispositionReason: "SECRET-reason" });
const command = () => ({ meta: { idempotencyKey: "erase-request-a" }, expectedStateRevision: 0, confirm: true, sourceIds: ["source-a"], expectedSourceRevisions: { "source-a": 0 } });
const threadId = "00000000-0000-4000-8000-000000000001";
function run(overrides: Record<string, unknown> = {}): Row {
  return {
    ...base, _id: "run-a", runId: "run-a", requestKey: "analysis-request-a", payloadHash: "a".repeat(64),
    sourceId: "source-a", sourceRevision: 0, expectedStateRevision: 0, stateRevision: null,
    capturedDraftHash: "private-draft-hash", capturedPlanHash: "private-plan-hash",
    state: "succeeded", unknownSpend: false, stage: "complete", updatedAt: now, deadline: now, completedAt: now, retryOfRunId: null,
    proposalIds: [], classificationId: null, providerIds: [{ stage: "gemma", threadId }],
    extraction: { raw: "SECRET-extraction" }, classification: { raw: "SECRET-classification" }, extractionAvailable: true,
    models: { gemmaProvider: "configured", gemmaRequested: "gemma", gemmaResolved: "gemma", jevRequested: "jev", jevResolved: "jev" },
    promptVersion: "v1", usage: { gemma: null, jev: null }, warnings: ["SECRET-warning"], error: null,
    vendorResponse: { raw: "SECRET-response" }, ...overrides,
  };
}

function matches(row: Row, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const actual = key === "threads.id" ? (row.threads as { id: string }[]).map((thread) => thread.id) : row[key];
    if (value && typeof value === "object") {
      const op = value as Record<string, unknown>;
      if ("$in" in op) return Array.isArray(actual) ? actual.some((value) => (op.$in as unknown[]).includes(value)) : (op.$in as unknown[]).includes(actual);
      if ("$ne" in op) return actual !== op.$ne;
      if ("$lt" in op) return typeof actual === "string" && actual < String(op.$lt);
    }
    return Array.isArray(actual) ? actual.includes(value) : actual === value;
  });
}

function collection(name: string) {
  const rows = () => store[name] ??= [];
  return {
    findOne: async (filter: Record<string, unknown>) => structuredClone(rows().find((row) => matches(row, filter)) ?? null),
    find: (filter: Record<string, unknown>) => {
      let limit = Infinity;
      const cursor = {
        sort: () => cursor, limit: (size: number) => { limit = size; return cursor; }, close: async () => {},
        toArray: async () => structuredClone(rows().filter((row) => matches(row, filter)).slice(0, limit)),
        [Symbol.asyncIterator]: async function* () { for (const row of rows().filter((row) => matches(row, filter)).slice(0, limit)) yield structuredClone(row); },
      };
      return cursor;
    },
    insertOne: async (row: Row) => { rows().push(structuredClone(row)); return { insertedId: row._id }; },
    updateOne: async (filter: Record<string, unknown>, update: { $set?: Record<string, unknown>; $inc?: Record<string, number> }) => {
      const row = rows().find((item) => matches(item, filter));
      if (!row) return { modifiedCount: 0 };
      for (const [key, value] of Object.entries(update.$set ?? {})) {
        if (key === "threads.$.confirmed") (row.threads as { id: string; confirmed: boolean }[]).find((thread) => thread.id === filter["threads.id"])!.confirmed = Boolean(value);
        else row[key] = structuredClone(value);
      }
      for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = Number(row[key]) + value;
      return { modifiedCount: 1 };
    },
    replaceOne: async (filter: Record<string, unknown>, replacement: Row) => { const index = rows().findIndex((row) => matches(row, filter)); if (index >= 0) rows()[index] = structuredClone(replacement); return { modifiedCount: index >= 0 ? 1 : 0 }; },
    deleteMany: async (filter: Record<string, unknown>) => { const before = rows().length; store[name] = rows().filter((row) => !matches(row, filter)); return { deletedCount: before - store[name].length }; },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BACKBOARD_API_KEY", "");
  store = { sellers: [{ _id: context.sellerId, ownerUserId: context.userId, status: "active", schemaVersion: 1, createdAt: now, stateRevision: 0, settings: DEFAULT_SETTINGS }], sources: [source()] };
  mocks.db.mockResolvedValue({ collection });
  mocks.client.mockResolvedValue({ withSession: async (work: (session: object) => Promise<unknown>) => work({ withTransaction: async (fn: () => Promise<unknown>) => {
    const before = structuredClone(store);
    inTransaction = true;
    try { return await fn(); } catch (error) { store = before; throw error; } finally { inTransaction = false; }
  } }) });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("privacy contracts and boundaries", () => {
  it("includes billing and route records in export and erasure inventory with explicit safe fields", async () => {
    for (const name of ["commerceSettings", "customerCommerce", "invoices"]) expect(SELLER_OWNED_COLLECTIONS).toContain(name);
    store.commerceSettings = [{ _id: context.sellerId, sellerId: context.sellerId, settings: { upiId: "fictional@upi", helperPhone: "919876543210" }, vendorToken: "do-not-export" }];
    store.customerCommerce = [{ _id: "profile-a", sellerId: context.sellerId, customerId: "customer-a", profile: { unitPricePaise: 10000, phone: "", routeName: "Fictional building", routeOrder: 1, deliveryNote: "Front gate" }, revision: 0 }];
    store.invoices = [{ _id: "invoice-a", sellerId: context.sellerId, customerId: "customer-a", month: "2026-09", totalPaise: 20000, lines: [{ serviceDate: "2026-09-01", quantity: 2, amountPaise: 20000, sheetId: "sheet-a", sheetRevision: 1 }], message: "Fictional statement", issuedAt: now, version: 1 }];
    const exported = await executePrivacyOperation("privacyExport", {}, context);
    const data = JSON.parse(exported.json);
    expect(data.commerceSettings[0].settings.upiId).toBe("fictional@upi");
    expect(data.customerCommerce[0].profile.routeName).toBe("Fictional building");
    expect(data.invoices[0].lines[0]).toMatchObject({ amountPaise: 20000, sheetId: "sheet-a" });
    expect(exported.json).not.toContain("do-not-export");
  });
  it("requires literal confirmation, exact distinct source revisions and no client session freshness field", () => {
    expect(privacyInputSchemas.eraseSources.safeParse(command()).success).toBe(true);
    for (const input of [{ ...command(), confirm: false }, { ...command(), sourceIds: ["source-a", "source-a"] }, { ...command(), expectedSourceRevisions: {} }, { ...command(), expectedSourceRevisions: { "source-a": 0, unrelated: 0 } }, { ...command(), sessionCreatedAt: now }]) expect(privacyInputSchemas.eraseSources.safeParse(input).success).toBe(false);
    expect(() => requireFreshPrivacySession(context)).toThrow(expect.objectContaining({ code: "FRESH_AUTH_REQUIRED" }));
    expect(() => requireFreshPrivacySession({ ...context, sessionCreatedAt: now }, Date.parse(now) + 300001)).toThrow(expect.objectContaining({ code: "FRESH_AUTH_REQUIRED" }));
    expect(() => requireFreshPrivacySession({ ...context, sessionCreatedAt: now }, Date.parse(now) - 1)).toThrow(expect.objectContaining({ code: "FRESH_AUTH_REQUIRED" }));
    expect(() => requireFreshPrivacySession({ ...context, sessionCreatedAt: now }, Date.parse(now) + 300000)).not.toThrow();
  });

  it("redacts nested originals and derivative evidence, preserving approved numeric order facts", () => {
    const data = { original: source(), nested: [{ sourceId: "source-a", draftRevision: 1, quote: "SECRET-quote", vendor: { response: "SECRET-response" }, evidenceSpans: [{ start: 0, end: 6 }], operations: [{ type: "set_daily_quantity", customerId: "customer-a", serviceDate: "2026-10-05", quantity: 2 }] }], unrelated: { _id: "source-b", text: "KEEP-other-source" } };
    const clean = redactSourceSnapshots(data, new Set(["source-a"])) as typeof data;
    expect(JSON.stringify(clean)).not.toContain("SECRET");
    expect(clean.nested[0].operations).toEqual(data.nested[0].operations);
    expect(clean.original.text).toBe("[erased]");
    expect(clean.unrelated.text).toBe("KEEP-other-source");
  });

  it("atomically redacts source, proposal, classifications, AI extraction and all receipt copies", async () => {
    store.proposals = [{ ...base, _id: "proposal-a", sourceId: "source-a", sourceRevision: 0, draftRevision: 0, evidenceSpans: [{ start: 0, end: 6 }], manualReason: "SECRET-evidence", missingFields: [], dispositionReason: "SECRET-disposition", status: "needs_review", deferredDate: null, operations: [] }];
    store.classifications = [{ _id: "classification-a", sellerId: context.sellerId, sourceId: "source-a", evidence: "SECRET-classification" }];
    store.planningSnapshots = [{ _id: "snapshot-a", sellerId: context.sellerId, features: Array(14).fill(0), featureInputs: { classifications: [{ sourceId: "source-a", reviewedLabels: ["SECRET-reviewed"], model: "SECRET-model", sourceRevision: 0 }] } }];
    store.receipts = [{ _id: "receipt-old", sellerId: context.sellerId, before: { source: source() }, after: { original: source(), proposal: store.proposals[0] } }];
    const result = await executePrivacyOperation("eraseSources", command(), context);
    expect(result.state).toBe("needs_reconciliation");
    expect(result.gaps).toEqual(expect.arrayContaining(["PROVIDER_IDENTIFIERS_UNAVAILABLE", "PROVIDER_RETENTION_UNVERIFIED"]));
    expect(result.stateRevision).toBe(1);
    expect(store.sources[0]).toMatchObject({ text: "[erased]", revision: 1, status: "superseded", erasurePending: true, upstreamId: null });
    expect(store.proposals[0]).toMatchObject({ status: "obsolete", draftRevision: 1, evidenceSpans: [] });
    expect(store.classifications).toEqual([]);
    expect(store.planningSnapshots[0].features).toEqual(Array(14).fill(0));
    expect(JSON.stringify(store)).not.toContain("SECRET");
    const repeated = await executePrivacyOperation("eraseSources", command(), context);
    expect(repeated).toEqual(result);
    expect(store.sellers[0].stateRevision).toBe(1);
    await expect(executePrivacyOperation("eraseSources", { ...command(), expectedStateRevision: 1 }, context)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await getPrivacyOperationByKey(command().meta.idempotencyKey, context)).toEqual(result);
  });

  it("rejects foreign ownership, stale source revisions and overlarge atomic scopes", async () => {
    await expect(executePrivacyOperation("eraseSources", command(), { ...context, userId: "owner-b" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(executePrivacyOperation("eraseSources", { ...command(), expectedSourceRevisions: { "source-a": 1 } }, context)).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(store.sources[0].text).toBe("SECRET-source");
    store.receipts = Array.from({ length: 1001 }, (_, index) => ({ _id: `receipt-${index}`, sellerId: context.sellerId, before: null, after: null }));
    await expect(executePrivacyOperation("eraseSources", command(), context)).rejects.toMatchObject({ code: "PRIVACY_LIMIT_EXCEEDED" });
    expect(store.sellers[0].stateRevision).toBe(0);
    expect(store.sources[0].revision).toBe(0);
  });

  it("exports only the owner business data, without DB keys, provider IDs or nested credentials", async () => {
    store.sources.push({ ...source(), _id: "foreign-source", sellerId: "seller-b", text: "FOREIGN-secret" });
    store.aiRuns = [{ _id: "run-a", sellerId: context.sellerId, providerIds: [{ threadId: "PROVIDER-private" }], models: { gemmaRequested: "gemma-model", authorization: "TOKEN-private" }, usage: { gemma: { inputTokens: 7, response: "PROVIDER-response" } } }];
    const result = await executePrivacyOperation("privacyExport", {}, context);
    expect(result.json).toContain("SECRET-source");
    for (const secret of ["FOREIGN", "PROVIDER", "TOKEN", '"_id"', '"ownerUserId"']) expect(result.json).not.toContain(secret);
    expect(result.bytes).toBe(Buffer.byteLength(result.json));
    expect(privacyExportRecord({ _id: "source-a", provider: { text: "provider-private" }, request: { text: "request-private" }, text: "authorized" })).toEqual({ id: "source-a", text: "authorized" });
    store.sources = [{ ...source(), text: "x".repeat(2 * 1024 * 1024) }];
    await expect(executePrivacyOperation("privacyExport", {}, context)).rejects.toMatchObject({ code: "PRIVACY_LIMIT_EXCEEDED" });
  });

  it("retains remote references without credentials and never claims provider-wide erasure", async () => {
    store.aiRuns = [run()];
    const result = await executePrivacyOperation("eraseSources", command(), context);
    expect(result.state).toBe("needs_reconciliation");
    expect(result.gaps).toEqual(expect.arrayContaining(["PROVIDER_RETENTION_UNVERIFIED", "REMOTE_DELETE_UNCONFIRMED"]));
    expect(result.counts.remotePending).toBe(1);
    expect(mocks.deleteThread).not.toHaveBeenCalled();
    expect(store.aiRuns[0]).toMatchObject({ extraction: null, classification: null, extractionAvailable: false, state: "obsolete" });
    expect(JSON.stringify(store.aiRuns)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain(threadId);
    expect((store.privacyOperations[0].threads as { id: string }[])[0].id).toBe(threadId);
  });

  it("deletes only known threads outside transactions, validates the acknowledgement, and does not redispatch on replay", async () => {
    vi.stubEnv("BACKBOARD_API_KEY", "configured-server-credential");
    store.aiRuns = [run()];
    mocks.deleteThread.mockImplementation(async (id) => {
      expect(inTransaction).toBe(false);
      return { thread_id: id, deleted_at: now, message: "SECRET-provider-message" };
    });
    const result = await executePrivacyOperation("eraseSources", command(), context);
    expect(mocks.deleteThread).toHaveBeenCalledExactlyOnceWith(threadId);
    expect(result.state).toBe("needs_reconciliation");
    expect(result.gaps).toEqual(["PROVIDER_RETENTION_UNVERIFIED"]);
    expect(result.counts).toMatchObject({ remoteConfirmed: 1, remotePending: 0 });
    expect(JSON.stringify(store)).not.toContain("SECRET");
    expect(await executePrivacyOperation("eraseSources", command(), context)).toEqual(result);
    expect(mocks.deleteThread).toHaveBeenCalledTimes(1);
  });

  it("treats malformed delete responses and missing identifiers as uncertainty, preserving late IDs for explicit reconciliation", async () => {
    vi.stubEnv("BACKBOARD_API_KEY", "configured-server-credential");
    store.aiRuns = [run({ state: "running", stage: "gemma", providerIds: [] })];
    const result = await executePrivacyOperation("eraseSources", command(), context);
    expect(result.gaps).toEqual(expect.arrayContaining(["INFLIGHT_PROVIDER_CALL", "PROVIDER_IDENTIFIERS_UNAVAILABLE"]));
    expect(mocks.deleteThread).not.toHaveBeenCalled();
    store.aiRuns[0].providerIds = [{ stage: "gemma", threadId }];
    mocks.deleteThread.mockResolvedValue({ message: "SECRET-unverified" });
    const updated = await reconcilePrivacyOperation(await mocks.db(), result.operationId, context);
    expect(updated.gaps).toContain("REMOTE_DELETE_UNCONFIRMED");
    expect(updated.counts.remotePending).toBe(1);
    expect(updated.counts.remoteConfirmed).toBe(0);
    expect((store.privacyOperations[0].threads as { id: string }[])[0].id).toBe(threadId);
    expect(JSON.stringify(updated)).not.toContain("SECRET");
  });

  it("does not dispatch remote deletion when a concurrent request already reserved the same key", async () => {
    store.aiRuns = [run()];
    const result = await executePrivacyOperation("eraseSources", command(), context);
    const committed = structuredClone(store);
    store = { sellers: [{ _id: context.sellerId, ownerUserId: context.userId, status: "active", schemaVersion: 1, createdAt: now, stateRevision: 0, settings: DEFAULT_SETTINGS }], sources: [source()] };
    vi.stubEnv("BACKBOARD_API_KEY", "configured-server-credential");
    mocks.client.mockResolvedValue({ withSession: async (work: (session: object) => Promise<unknown>) => {
      store = committed;
      return work({ withTransaction: async (fn: () => Promise<unknown>) => fn() });
    } });
    expect(await executePrivacyOperation("eraseSources", command(), context)).toEqual(result);
    expect(mocks.deleteThread).not.toHaveBeenCalled();
  });

  it("bounds the wait for remote deletion and preserves uncertainty without automatic retries", async () => {
    vi.useFakeTimers();
    vi.stubEnv("BACKBOARD_API_KEY", "configured-server-credential");
    store.aiRuns = [run()];
    mocks.deleteThread.mockImplementation(() => new Promise(() => {}));
    const task = executePrivacyOperation("eraseSources", command(), context);
    await vi.advanceTimersByTimeAsync(5001);
    const result = await task;
    expect(result.state).toBe("needs_reconciliation");
    expect(result.gaps).toContain("REMOTE_DELETE_UNCONFIRMED");
    expect(result.counts.remotePending).toBe(1);
    expect(mocks.deleteThread).toHaveBeenCalledTimes(1);
    expect(await executePrivacyOperation("eraseSources", command(), context)).toEqual(result);
    expect(mocks.deleteThread).toHaveBeenCalledTimes(1);
  });

  it("keeps owner deletion status available, reports retained sessions and isolates other owners", async () => {
    store.customers = [{ _id: "own-customer", sellerId: context.sellerId }, { _id: "foreign-customer", sellerId: "seller-b", alias: "FOREIGN" }];
    store.sessions = [{ _id: "auth-session", userId: context.userId, token: "AUTH-secret" }];
    store.historyRows = [{ _id: "own-history", sellerId: context.sellerId }];
    const input = { meta: { idempotencyKey: "erase-seller-a" }, expectedStateRevision: 0, confirm: true, sellerId: context.sellerId };
    await expect(executePrivacyOperation("eraseSeller", input, context)).rejects.toMatchObject({ code: "FRESH_AUTH_REQUIRED" });
    await expect(executePrivacyOperation("eraseSeller", { ...input, sellerId: "seller-b" }, { ...context, sessionCreatedAt: new Date().toISOString() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const result = await executePrivacyOperation("eraseSeller", input, { ...context, sessionCreatedAt: new Date().toISOString() });
    expect(result.state).toBe("needs_reconciliation");
    expect(result.gaps).toEqual(["AUTH_SESSIONS_RETAINED"]);
    expect(store.sellers[0].privacyDeleting).toBe(true);
    expect(store.customers).toEqual([{ _id: "foreign-customer", sellerId: "seller-b", alias: "FOREIGN" }]);
    expect(store.sessions[0].token).toBe("AUTH-secret");
    for (const collection of SELLER_OWNED_COLLECTIONS) expect((store[collection] ?? []).some((row) => row.sellerId === context.sellerId)).toBe(false);
    expect(await executePrivacyOperation("getPrivacyOperation", { operationId: result.operationId }, context)).toEqual(result);
    await expect(executePrivacyOperation("getPrivacyOperation", { operationId: result.operationId }, { ...context, userId: "owner-b" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(privacyOperationSchema.safeParse({ ...result, threads: ["private"] }).success).toBe(false);
  });

  it("reports bounded seller cleanup as partial and only advances it on an explicit reconciliation command", async () => {
    store.sources = Array.from({ length: 101 }, (_, index) => ({ ...source(), _id: `source-${index}` }));
    const result = await executePrivacyOperation("eraseSeller", { meta: { idempotencyKey: "erase-seller-a" }, expectedStateRevision: 0, confirm: true, sellerId: context.sellerId }, { ...context, sessionCreatedAt: new Date().toISOString() });
    expect(result.state).toBe("partial");
    expect(result.gaps).toContain("LOCAL_CLEANUP_PENDING");
    expect(store.sources).toHaveLength(1);
    expect(await executePrivacyOperation("getPrivacyOperation", { operationId: result.operationId }, context)).toEqual(result);
    expect(store.sources).toHaveLength(1);
    const updated = await reconcilePrivacyOperation(await mocks.db(), result.operationId, context);
    expect(store.sources).toHaveLength(0);
    expect(updated.state).toBe("needs_reconciliation");
    expect(updated.gaps).toEqual(["AUTH_SESSIONS_RETAINED"]);
    expect(updated.counts.localRecords).toBe(result.counts.localRecords + 1);
  });
});
