import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { BackboardAPIError, BackboardClient } from "backboard-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Customer, type Proposal, type Seller, type Source } from "@/lib/contracts/records";
import type { SellerContext } from "@/lib/contracts/common";
import { closeDb, getDb } from "@/lib/server/db/client";
import { executeIntelligenceOperation } from "@/lib/server/ai/analyze";
import { checkAiIndexes, initializeAiIndexes, type AiRunRecord } from "@/lib/server/ai/runs";
import { intentLabels } from "@/lib/server/ai/schemas";

const sdkTransport = BackboardClient.prototype as unknown as { _makeRequest(method: string, endpoint: string, options: { json: Record<string, unknown> }): Promise<unknown> };
const transport = vi.fn<(method: string, endpoint: string, options: { json: Record<string, unknown> }) => Promise<unknown>>();
let replica: MongoMemoryReplSet;
let context: SellerContext;
let sourceId: string;
const sourceText = "only one tomorrow";
const extraction = { candidates: [{ kind: "quantity_change", evidence: [{ start: 0, end: sourceText.length, quote: sourceText }], datePhrase: "tomorrow", endDatePhrase: null, quantity: 1, missingFields: [] }], clarification: null };
const jev = { model: "jev-1.13.0", answers: {
  intent: { type: "choice", choice: "quantity_change", confidence: 1, probabilities: Object.fromEntries(intentLabels.map((label) => [label, label === "quantity_change" ? 1 : 0])) },
  explicitReplacement: { type: "noul", noul: 0 },
  clarity: { type: "score", score: 2, legend: { "0": "Unclear or contradictory", "1": "Some necessary details missing", "2": "Explicit details stated" }, probabilities: { "0": 0, "1": 0, "2": 1 }, confidence: 1 },
}, usage: { input_tokens: 30, output_tokens: 0 } };
function providerResponse(stage: "gemma" | "jev") { return { thread_id: `private-${stage}-thread`, assistant_id: `private-${stage}-assistant`, message_id: `private-${stage}-message`, status: "COMPLETED", content: stage === "gemma" ? JSON.stringify(extraction) : "", ...(stage === "gemma" ? { model_name: "gemma-3-27b-it" } : { system_one: jev }) }; }
function input(key = randomUUID()) { return { sourceId, expectedStateRevision: 0, expectedSourceRevision: 0, consentAcknowledged: true as const, meta: { idempotencyKey: key } }; }
beforeAll(async () => {
  // This suite owns its replica set and never consumes an existing Atlas connection.
  replica = await MongoMemoryReplSet.create({ binary: { version: "8.0.14", downloadDir: process.env.MONGOMS_DOWNLOAD_DIR ?? join("/tmp/opencode", "tiffin-mongodb-binaries") }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  vi.stubEnv("MONGODB_URI", replica.getUri());
  vi.stubEnv("MONGODB_DB", `test_ai_${randomUUID().replaceAll("-", "")}`);
  await initializeAiIndexes(await getDb());
}, 60000);
beforeEach(async () => {
  transport.mockReset();
  vi.spyOn(sdkTransport, "_makeRequest").mockImplementation(transport);
  for (const [name, value] of Object.entries({ BACKBOARD_API_KEY: "synthetic-only", GEMMA_PROVIDER: "google", GEMMA_MODEL: "gemma-3-27b-it", JEV_MODEL: "jev-1.13.0", AI_DAILY_REQUEST_LIMIT: "8", AI_DAILY_INPUT_TOKEN_LIMIT: "128000", AI_MAX_INPUT_TOKENS: "16000", AI_STAGE_TIMEOUT_MS: "20000", AI_TOTAL_TIMEOUT_MS: "45000", AI_MAX_SOURCE_CHARS: "8000", AI_MAX_OUTPUT_CHARS: "12000" })) vi.stubEnv(name, value);
  context = { sellerId: randomUUID(), userId: randomUUID(), requestId: randomUUID() };
  sourceId = randomUUID();
  const now = new Date().toISOString();
  const db = await getDb();
  await db.collection<Seller>("sellers").insertOne({ _id: context.sellerId, ownerUserId: context.userId, stateRevision: 0, status: "active", schemaVersion: 1, createdAt: now, settings: { ...DEFAULT_SETTINGS, weekdays: [1, 2, 3, 4, 5, 6, 7] } });
  await db.collection<Customer>("customers").insertOne({ _id: `customer-${context.sellerId}`, sellerId: context.sellerId, alias: "Synthetic A", packingNote: "", status: "active", revision: 0, schemaVersion: 1, createdAt: now });
  await db.collection<Source>("sources").insertOne({ _id: sourceId, sellerId: context.sellerId, schemaVersion: 1, createdAt: now, receivedAt: now, sentAt: now, text: sourceText, customerId: `customer-${context.sellerId}`, revision: 0, status: "needs_review", deferredDate: null, fingerprint: sourceId, channel: "manual", upstreamId: null, replacesSourceId: null, dispositionReason: null });
});
afterAll(async () => { await closeDb(); await replica?.stop(); vi.unstubAllEnvs(); });
describe("durable AI reservations and atomic drafts on an isolated replica set", () => {
  it("checks indexes and concurrent identical keys dispatch only one Gemma/JEV pair", async () => {
    expect(await checkAiIndexes(await getDb())).toBe(true);
    transport.mockResolvedValueOnce(providerResponse("gemma")).mockResolvedValueOnce(providerResponse("jev"));
    const command = input();
    const results = await Promise.all([executeIntelligenceOperation("analyzeSource", command, context), executeIntelligenceOperation("analyzeSource", command, context)]);
    expect(results[0].runId).toBe(results[1].runId);
    expect(transport).toHaveBeenCalledTimes(2);
    const repeat = await executeIntelligenceOperation("analyzeSource", command, context);
    expect(repeat.state).toBe("succeeded");
    expect(repeat.proposalIds).toHaveLength(1);
    expect(repeat.stateRevision).toBe(1);
    expect(transport).toHaveBeenCalledTimes(2);
    await expect(executeIntelligenceOperation("analyzeSource", { ...command, expectedStateRevision: 1 }, context)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const db = await getDb();
    const draft = await db.collection<Proposal>("proposals").findOne({ _id: repeat.proposalIds[0] });
    expect(draft?.status).toBe("needs_review");
    expect(await db.collection("classifications").countDocuments({ sellerId: context.sellerId })).toBe(1);
    for (const collection of ["plans", "dailyOverrides", "sheets"]) expect(await db.collection(collection).countDocuments({ sellerId: context.sellerId })).toBe(0);
    expect(await db.collection("receipts").findOne({ sellerId: context.sellerId })).toMatchObject({ operation: "analyzeSource", stateRevision: 0, after: { runId: repeat.runId } });
  });
  it("preserves valid extraction and incomplete drafts when JEV credit fails", async () => {
    transport.mockResolvedValueOnce(providerResponse("gemma")).mockRejectedValueOnce(new BackboardAPIError("private error", 402));
    const run = await executeIntelligenceOperation("analyzeSource", input(), context);
    expect(run.state).toBe("needs_review");
    expect(run.error?.code).toBe("PROVIDER_CREDIT_REQUIRED");
    expect(run.extractionAvailable).toBe(true);
    expect(run.classificationId).toBeNull();
    const db = await getDb();
    const stored = await db.collection<AiRunRecord>("aiRuns").findOne({ _id: run.runId });
    expect(stored?.extraction).toEqual(extraction);
    expect(stored?.providerIds[0]).toMatchObject({ stage: "gemma", threadId: "private-gemma-thread" });
    const proposal = await db.collection<Proposal>("proposals").findOne({ _id: run.proposalIds[0] });
    expect(proposal?.missingFields).toContain("classification_unavailable");
  });
  it("budget refusal reserves neither a run nor a lease and performs no provider dispatch", async () => {
    vi.stubEnv("AI_DAILY_INPUT_TOKEN_LIMIT", "100");
    await expect(executeIntelligenceOperation("analyzeSource", input(), context)).rejects.toMatchObject({ code: "AI_BUDGET_EXCEEDED", status: 429 });
    expect(transport).not.toHaveBeenCalled();
    const db = await getDb();
    expect(await db.collection("aiRuns").countDocuments({ sellerId: context.sellerId })).toBe(0);
    expect(await db.collection("aiAdmissions").countDocuments({ sellerId: context.sellerId })).toBe(0);
  });
  it("unknown key lookup and invalid configuration never dispatch inference", async () => {
    await expect(executeIntelligenceOperation("getAnalysisByKey", { requestKey: "absent-key" }, context)).rejects.toMatchObject({ code: "NOT_FOUND" });
    vi.stubEnv("GEMMA_MODEL", "");
    await expect(executeIntelligenceOperation("analyzeSource", input(), context)).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED", status: 503 });
    expect(transport).not.toHaveBeenCalled();
    expect(await (await getDb()).collection("aiRuns").countDocuments({ sellerId: context.sellerId })).toBe(0);
  });
  it("a late timed-out response records only provider provenance and never starts JEV or creates drafts", async () => {
    vi.stubEnv("AI_STAGE_TIMEOUT_MS", "10");
    let release!: (value: unknown) => void;
    transport.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const run = await executeIntelligenceOperation("analyzeSource", input(), context);
    expect(run.state).toBe("unknown");
    expect(run.error?.code).toBe("PROVIDER_TIMEOUT");
    expect(run.unknownSpend).toBe(true);
    expect(run.proposalIds).toEqual([]);
    release(providerResponse("gemma"));
    const db = await getDb();
    await vi.waitFor(async () => expect((await db.collection<AiRunRecord>("aiRuns").findOne({ _id: run.runId }))?.providerIds).toHaveLength(1));
    const stored = await db.collection<AiRunRecord>("aiRuns").findOne({ _id: run.runId });
    expect(stored?.state).toBe("unknown");
    expect(stored?.extraction).toBeNull();
    expect(stored?.classification).toBeNull();
    expect(transport).toHaveBeenCalledOnce();
    expect(await db.collection("proposals").countDocuments({ sellerId: context.sellerId })).toBe(0);
  });
  it("blocks overlapping seller analysis while a durable lease is held", async () => {
    let release!: (value: unknown) => void;
    let dispatched!: () => void;
    const entered = new Promise<void>((resolve) => { dispatched = resolve; });
    transport.mockImplementationOnce(async () => { dispatched(); return new Promise((resolve) => { release = resolve; }); }).mockResolvedValueOnce(providerResponse("jev"));
    const first = executeIntelligenceOperation("analyzeSource", input(), context);
    await entered;
    await expect(executeIntelligenceOperation("analyzeSource", input(), context)).rejects.toMatchObject({ code: "AI_BUSY", status: 429 });
    release(providerResponse("gemma"));
    expect((await first).state).toBe("succeeded");
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("late results cannot replace a manual draft after seller state changes", async () => {
    let release!: (value: unknown) => void;
    let dispatched!: () => void;
    const entered = new Promise<void>((resolve) => { dispatched = resolve; });
    transport.mockResolvedValueOnce(providerResponse("gemma")).mockImplementationOnce(async () => { dispatched(); return new Promise((resolve) => { release = resolve; }); });
    const pending = executeIntelligenceOperation("analyzeSource", input(), context);
    await entered;
    const db = await getDb();
    await db.collection<Seller>("sellers").updateOne({ _id: context.sellerId }, { $inc: { stateRevision: 1 } });
    const manual = { _id: randomUUID(), sellerId: context.sellerId, sourceId, draftRevision: 3, status: "needs_review", operations: [], missingFields: ["manual edit preserved"] };
    await db.collection<{ _id: string }>("proposals").insertOne(manual);
    release(providerResponse("jev"));
    const run = await pending;
    expect(run.state).toBe("obsolete");
    expect(run.proposalIds).toEqual([]);
    expect(await db.collection<{ _id: string }>("proposals").findOne({ _id: manual._id })).toEqual(manual);
    expect(await db.collection("classifications").countDocuments({ sellerId: context.sellerId })).toBe(0);
  });
  it("erasure flags block admission and prevent late results from restoring derivative evidence", async () => {
    const db = await getDb();
    await db.collection<Source>("sources").updateOne({ _id: sourceId }, { $set: { erasurePending: true } });
    await expect(executeIntelligenceOperation("analyzeSource", input(), context)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(transport).not.toHaveBeenCalled();
    await db.collection<Source>("sources").updateOne({ _id: sourceId }, { $unset: { erasurePending: "" } });
    let release!: (value: unknown) => void;
    let dispatched!: () => void;
    const entered = new Promise<void>((resolve) => { dispatched = resolve; });
    transport.mockResolvedValueOnce(providerResponse("gemma")).mockImplementationOnce(async () => { dispatched(); return new Promise((resolve) => { release = resolve; }); });
    const pending = executeIntelligenceOperation("analyzeSource", input(), context);
    await entered;
    await db.collection<Seller>("sellers").updateOne({ _id: context.sellerId }, { $set: { privacyDeleting: true } });
    release(providerResponse("jev"));
    const run = await pending;
    expect(run.state).toBe("obsolete");
    expect(run.extractionAvailable).toBe(false);
    expect(await db.collection("proposals").countDocuments({ sellerId: context.sellerId })).toBe(0);
    expect((await db.collection<AiRunRecord>("aiRuns").findOne({ _id: run.runId }))?.extraction).toBeNull();
  });
  it("expired reads are side-effect-free and unknown retry requires fresh acknowledged spend", async () => {
    transport.mockRejectedValueOnce(new BackboardAPIError("connection lost"));
    const failed = await executeIntelligenceOperation("analyzeSource", input(), context);
    expect(failed.state).toBe("unknown");
    const db = await getDb();
    await db.collection<AiRunRecord>("aiRuns").updateOne({ _id: failed.runId }, { $set: { state: "running", deadline: "2026-01-01T00:00:00Z" } });
    const before = await db.collection<AiRunRecord>("aiRuns").findOne({ _id: failed.runId });
    const view = await executeIntelligenceOperation("getAnalysis", { runId: failed.runId }, context);
    expect(view.state).toBe("unknown");
    expect(await db.collection<AiRunRecord>("aiRuns").findOne({ _id: failed.runId })).toEqual(before);
    const retry = { runId: failed.runId, expectedStateRevision: 0, expectedSourceRevision: 0, consentAcknowledged: true, meta: { idempotencyKey: randomUUID() } };
    await expect(executeIntelligenceOperation("retryAnalysis", retry, context)).rejects.toMatchObject({ code: "UNKNOWN_SPEND_ACKNOWLEDGEMENT_REQUIRED" });
    transport.mockResolvedValueOnce(providerResponse("gemma")).mockResolvedValueOnce(providerResponse("jev"));
    const result = await executeIntelligenceOperation("retryAnalysis", { ...retry, acknowledgeUnknownSpend: true }, context);
    expect(result.runId).not.toBe(failed.runId);
    expect(result.retryOfRunId).toBe(failed.runId);
    expect(result.state).toBe("succeeded");
    expect((await db.collection<AiRunRecord>("aiRuns").findOne({ _id: failed.runId }))?.state).toBe("unknown");
  });
}, 15000);
