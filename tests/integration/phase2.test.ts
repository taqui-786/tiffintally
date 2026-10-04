import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { BackboardAPIError, BackboardClient } from "backboard-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Customer, type Seller, type Source, type Receipt } from "@/lib/contracts/records";
import type { SellerContext } from "@/lib/contracts/common";
import { getDb, closeDb } from "@/lib/server/db/client";
import { initializeIndexes } from "@/lib/server/db/indexes";
import { executeBackendOperation as execute, initializePhase2Indexes, checkPhase2Indexes } from "@/lib/server/phase2";
import { SELLER_OWNED_COLLECTIONS } from "@/lib/server/privacy";

let replica: MongoMemoryReplSet, context: SellerContext, source: Source;
const transport = vi.fn();
const sdk = BackboardClient.prototype as unknown as { _makeRequest: (...args: unknown[]) => Promise<unknown> };
const command = (revision = 0) => ({ meta: { idempotencyKey: randomUUID() }, expectedStateRevision: revision });
const text = "only one tomorrow";
const extraction = { candidates: [{ kind: "quantity_change", evidence: [{ start: 0, end: text.length, quote: text }], datePhrase: "tomorrow", endDatePhrase: null, quantity: 1, missingFields: [] }], clarification: null };
function gemmaResponse() { return { thread_id: randomUUID(), assistant_id: randomUUID(), message_id: randomUUID(), status: "COMPLETED", model_name: "gemma-3-27b-it", content: JSON.stringify(extraction) }; }
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: "8.0.14", downloadDir: "/tmp/opencode/tiffin-mongodb-binaries" }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  vi.stubEnv("MONGODB_URI", replica.getUri()); vi.stubEnv("MONGODB_DB", `test_phase2_${randomUUID().replaceAll("-", "")}`);
  await initializeIndexes(await getDb()); await initializePhase2Indexes();
});
beforeEach(async () => {
  transport.mockReset(); vi.spyOn(sdk, "_makeRequest").mockImplementation(transport);
  for (const [key, value] of Object.entries({ BACKBOARD_API_KEY: "synthetic-only", GEMMA_PROVIDER: "google", GEMMA_MODEL: "gemma-3-27b-it", JEV_MODEL: "jev-1.13.0", SENTRY_DSN: "", TABPFN_SERVICE_URL: "", TABPFN_SERVICE_TOKEN: "" })) vi.stubEnv(key, value);
  context = { sellerId: randomUUID(), userId: randomUUID(), requestId: randomUUID(), sessionCreatedAt: new Date().toISOString() };
  const now = new Date().toISOString(), customerId = randomUUID(), db = await getDb();
  await db.collection<Seller>("sellers").insertOne({ _id: context.sellerId, ownerUserId: context.userId, stateRevision: 0, status: "active", schemaVersion: 1, createdAt: now, settings: DEFAULT_SETTINGS });
  await db.collection<Customer>("customers").insertOne({ _id: customerId, sellerId: context.sellerId, alias: "Fictional A", packingNote: "", status: "active", revision: 0, schemaVersion: 1, createdAt: now });
  source = { _id: randomUUID(), sellerId: context.sellerId, schemaVersion: 1, createdAt: now, receivedAt: now, sentAt: now, text, customerId, revision: 0, status: "needs_review", deferredDate: null, fingerprint: randomUUID(), channel: "manual", upstreamId: null, replacesSourceId: null, dispositionReason: null };
  await db.collection<Source>("sources").insertOne(source);
});
afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await closeDb(); await replica?.stop(); });

describe("combined Phase 2 persistence boundary", () => {
  it("initializes all indexes and reads nonsecret capabilities without any model call", async () => {
    expect(await checkPhase2Indexes()).toBe(true);
    expect(await execute("capabilities", {}, context)).toMatchObject({ ai: { configured: true }, forecasting: { configured: false } });
    expect(transport).not.toHaveBeenCalled();
  });
  it("resolves analysis keys to saved run status and rejects cross-family reuse", async () => {
    transport.mockResolvedValueOnce(gemmaResponse()).mockRejectedValueOnce(new BackboardAPIError("fixture credit failure", 402));
    const input = { ...command(), sourceId: source._id, expectedSourceRevision: 0, consentAcknowledged: true };
    const run = await execute("analyzeSource", input, context);
    expect(run.state).toBe("needs_review"); expect(run.proposalIds).toHaveLength(1);
    expect(await execute("getReceipt", { idempotencyKey: input.meta.idempotencyKey }, context)).toEqual(run);
    await expect(execute("createCustomer", { ...command(1), meta: input.meta, alias: "Duplicate key" }, context)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(execute("stageHistory", { ...command(1), meta: input.meta, expectedHistoryVersion: 0, schemaVersion: 1, evidenceMode: "synthetic_demo", rows: [{}] }, context)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("erases originals and receipt copies atomically, keeps numeric orders and blocks source reuse", async () => {
    const db = await getDb();
    await db.collection<Receipt>("receipts").insertOne({ _id: randomUUID(), sellerId: context.sellerId, schemaVersion: 1, createdAt: source.createdAt, operation: "importSources", idempotencyKey: randomUUID(), payloadHash: "a".repeat(64), actorUserId: context.userId, committedAt: source.createdAt, priorStateRevision: 0, stateRevision: 0, resourceIds: [source._id], affectedDates: [], warnings: [], before: null, after: { source } });
    await db.collection<{ _id: string; sellerId: string; quantity: number }>("plans").insertOne({ _id: randomUUID(), sellerId: context.sellerId, quantity: 3 });
    const before = await db.collection("plans").find({ sellerId: context.sellerId }).toArray();
    const input = { ...command(), confirm: true, sourceIds: [source._id], expectedSourceRevisions: { [source._id]: 0 } };
    const erasure = await execute("eraseSources", input, context);
    expect(erasure.state).toBe("completed");
    expect(await execute("getReceipt", { idempotencyKey: input.meta.idempotencyKey }, context)).toEqual(erasure);
    const original = await execute("getSource", { sourceId: source._id }, context);
    expect(original.source).toMatchObject({ text: "[erased]", erasurePending: true });
    expect(JSON.stringify(await db.collection("receipts").find({ sellerId: context.sellerId }).toArray())).not.toContain(text);
    expect(await db.collection("plans").find({ sellerId: context.sellerId }).toArray()).toEqual(before);
    await expect(execute("correctSource", { ...command(1), sourceId: source._id, expectedSourceRevision: 1, text: "restore text", sentAt: source.sentAt, reason: "fictional correction" }, context)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
  it("late provider content cannot restore evidence after actual source erasure", async () => {
    let release!: (value: unknown) => void;
    let dispatched!: () => void;
    const entered = new Promise<void>((resolve) => { dispatched = resolve; });
    transport.mockImplementationOnce(() => { dispatched(); return new Promise((resolve) => { release = resolve; }); });
    const pending = execute("analyzeSource", { ...command(), sourceId: source._id, expectedSourceRevision: 0, consentAcknowledged: true }, context);
    await entered;
    vi.stubEnv("BACKBOARD_API_KEY", "");
    const erasure = await execute("eraseSources", { ...command(), confirm: true, sourceIds: [source._id], expectedSourceRevisions: { [source._id]: 0 } }, context);
    expect(erasure.gaps).toContain("INFLIGHT_PROVIDER_CALL");
    release(gemmaResponse());
    expect((await pending).state).toBe("obsolete");
    const db = await getDb();
    expect(await db.collection("proposals").countDocuments({ sellerId: context.sellerId })).toBe(0);
    expect((await db.collection("aiRuns").findOne({ sellerId: context.sellerId }))?.extraction).toBeNull();
    expect((await execute("getSource", { sourceId: source._id }, context)).source.text).toBe("[erased]");
  });
  it("requires fresh authentication, deletes owned collections and retains owner-only progress", async () => {
    const input = { ...command(), confirm: true, sellerId: context.sellerId };
    await expect(execute("eraseSeller", input, { ...context, sessionCreatedAt: "2020-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "FRESH_AUTH_REQUIRED" });
    const status = await execute("eraseSeller", input, context);
    expect(status.gaps).toContain("AUTH_SESSIONS_RETAINED");
    expect(status.gaps).not.toContain("LOCAL_CLEANUP_PENDING");
    for (const collection of SELLER_OWNED_COLLECTIONS) expect(await (await getDb()).collection(collection).countDocuments({ sellerId: context.sellerId })).toBe(0);
    expect(await execute("getReceipt", { idempotencyKey: input.meta.idempotencyKey }, context)).toEqual(status);
    await expect(execute("getSettings", {}, context)).rejects.toMatchObject({ code: "PRIVACY_DELETING" });
    await expect(execute("getPrivacyOperation", { operationId: status.operationId }, { ...context, userId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
