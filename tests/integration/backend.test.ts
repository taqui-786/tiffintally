import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type SellerContext } from "@/lib/contracts/common";
import { DEFAULT_SETTINGS, type OrderOperation, type Seller, type Sheet, type Source } from "@/lib/contracts/records";
import { type OperationInput, type OperationName } from "@/lib/contracts/api";
import { addDays, localDateAt } from "@/lib/domain/dates";
import { getDb, getClient, closeDb } from "@/lib/server/db/client";
import { checkIndexes, initializeIndexes } from "@/lib/server/db/indexes";
import { executeOperation } from "@/lib/server/operations";
import { checkRateLimitIndexes, enforceRateLimit, initializeRateLimitIndexes } from "@/lib/server/rate-limit";
import { routeHandler } from "@/lib/server/http";

let replica: MongoMemoryReplSet;
let context: SellerContext;
let serviceDate: string;
const call = <K extends OperationName>(operation: K, input: unknown) => executeOperation(operation, input, context);
async function metadata() {
  return { expectedStateRevision: (await call("me", {})).stateRevision, meta: { idempotencyKey: randomUUID() } };
}
async function customer(alias = "Fictional customer") {
  return (await call("createCustomer", { ...await metadata(), alias })).resourceIds[0];
}
async function draft(operations: OrderOperation[], sourceId: string | null = null, sourceRevision: number | null = null) {
  return (await call("createProposal", {
    ...await metadata(), sourceId, expectedSourceRevision: sourceRevision,
    manualReason: sourceId ? null : "Synthetic setup", operations, missingFields: [], evidenceSpans: sourceId ? [{ start: 0, end: 4 }] : [],
  })).resourceIds[0];
}
async function approvalInput(proposalId: string): Promise<OperationInput<"approveProposal">> {
  const proposal = await call("getProposal", { proposalId });
  const preview = await call("previewProposal", { proposalId, expectedDraftRevision: proposal.draftRevision });
  return {
    ...await metadata(), proposalId, expectedDraftRevision: proposal.draftRevision, expectedSourceRevision: proposal.sourceRevision,
    previewHash: preview.previewHash, supersedesApprovalIds: [...new Set(preview.conflicts.map((item) => item.approvalId))], acknowledgeLateChange: true,
  };
}
async function approve(operations: OrderOperation[]) {
  const proposalId = await draft(operations);
  return call("approveProposal", await approvalInput(proposalId));
}
async function recurring(customerId: string, quantity: number) {
  return approve([{ type: "replace_recurring_plan", customerId, startDate: serviceDate, endDate: null, quantities: [quantity, quantity, quantity, quantity, quantity, quantity, quantity] }]);
}
async function sheet() {
  const day = await call("getDay", { serviceDate });
  return call("finalizeSheet", { ...await metadata(), serviceDate, expectedPriorSheetId: day.latestSheetId, acknowledgeLateChange: true });
}

beforeAll(async () => {
  // No existing URI is ever consumed: this suite owns its temporary replica set.
  replica = await MongoMemoryReplSet.create({
    binary: { version: "8.0.14", downloadDir: process.env.MONGOMS_DOWNLOAD_DIR ?? join(tmpdir(), "opencode", "tiffin-mongodb-binaries") },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  vi.stubEnv("MONGODB_URI", replica.getUri());
  vi.stubEnv("MONGODB_DB", `test_tiffin_${randomUUID().replaceAll("-", "")}`);
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-test-only-secret-not-a-real-credential-2026");
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client-not-used-for-oauth");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret-not-used-for-oauth");
  await initializeIndexes(await getDb());
  await initializeRateLimitIndexes();
});
beforeEach(async () => {
  context = { sellerId: randomUUID(), userId: randomUUID(), requestId: randomUUID() };
  serviceDate = addDays(localDateAt(new Date().toISOString(), "Asia/Kolkata"), 1);
  await (await getDb()).collection<Seller>("sellers").insertOne({
    _id: context.sellerId, ownerUserId: context.userId, stateRevision: 0, status: "active", schemaVersion: 1,
    createdAt: new Date().toISOString(), settings: { ...DEFAULT_SETTINGS, weekdays: [1, 2, 3, 4, 5, 6, 7] },
  });
});
afterAll(async () => {
  await closeDb();
  await replica?.stop();
  vi.unstubAllEnvs();
});

describe("real replica-set order backend", () => {
  it("enforces actual indexes and shared rate limiting", async () => {
    expect(await checkIndexes(await getDb())).toBe(true);
    expect(await checkRateLimitIndexes(await getDb())).toBe(true);
    const owner = randomUUID();
    for (let index = 0; index < 30; index++) await enforceRateLimit(owner, true);
    await expect(enforceRateLimit(owner, true)).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
  });

  it("runs A/B/C from approved plans through source review, idempotent approval and sheets", async () => {
    const a = await customer("A"); const b = await customer("B"); const c = await customer("C");
    await recurring(a, 2); await recurring(b, 1); await recurring(c, 3);
    expect((await call("getDay", { serviceDate })).total).toBe(6);
    const imported = await call("importSources", { ...await metadata(), sources: [{ text: "Only one tomorrow", customerId: a, sentAt: new Date().toISOString() }] });
    const sourceId = imported.resourceIds[0];
    const proposalId = await draft([{ type: "set_daily_quantity", customerId: a, serviceDate, quantity: 1 }], sourceId, 0);
    const input = await approvalInput(proposalId);
    const receipt = await call("approveProposal", input);
    expect(await call("approveProposal", input)).toEqual(receipt);
    expect((await call("getDay", { serviceDate })).total).toBe(5);
    expect((await call("getDay", { serviceDate: addDays(serviceDate, 1) })).total).toBe(6);
    const first = await sheet();
    const saved = await call("getSheet", { sheetId: first.resourceIds[0] });
    await approve([{ type: "set_daily_quantity", customerId: a, serviceDate, quantity: 2 }]);
    const second = await sheet();
    const amended = await call("getSheet", { sheetId: second.resourceIds[0] });
    expect(amended).toMatchObject({ revision: 2, total: 6, previousSheetId: saved._id });
    expect(await call("getSheet", { sheetId: saved._id })).toEqual(saved);
    expect((await call("exportSheet", { sheetId: saved._id })).csv).toContain(serviceDate);
    const freshClient = await new MongoClient(replica.getUri()).connect();
    try {
      expect((await freshClient.db(process.env.MONGODB_DB).collection<Sheet>("sheets").findOne({ _id: amended._id }))?.total).toBe(6);
    } finally { await freshClient.close(); }
  });

  it("serializes racing writes and rolls back rejected revisions", async () => {
    const meta = await metadata();
    const results = await Promise.allSettled([
      call("createCustomer", { ...meta, alias: "One" }),
      call("createCustomer", { ...meta, meta: { idempotencyKey: randomUUID() }, alias: "Two" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await call("listCustomers", {})).items).toHaveLength(1);
    expect((await call("me", {})).stateRevision).toBe(1);
    const db = await getDb();
    expect(await db.collection("receipts").countDocuments({ sellerId: context.sellerId })).toBe(1);
  });

  it("concurrent identical commands return one receipt; changed payload conflicts", async () => {
    const input = { ...await metadata(), alias: "One" };
    const [first, second] = await Promise.all([call("createCustomer", input), call("createCustomer", input)]);
    expect(first).toEqual(second);
    await expect(call("createCustomer", { ...input, alias: "Changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await call("listCustomers", {})).items).toHaveLength(1);
  });

  it("requires fresh review and exact acknowledgement to supersede an override", async () => {
    const a = await customer(); await recurring(a, 2);
    await approve([{ type: "set_daily_quantity", customerId: a, serviceDate, quantity: 1 }]);
    const proposalId = await draft([{ type: "set_daily_quantity", customerId: a, serviceDate, quantity: 3 }]);
    const input = await approvalInput(proposalId);
    await expect(call("approveProposal", { ...input, supersedesApprovalIds: [] })).rejects.toMatchObject({ code: "OVERLAPPING_CHANGE" });
    expect((await call("me", {})).stateRevision).toBe(input.expectedStateRevision);
    await call("approveProposal", input);
    expect((await call("getDay", { serviceDate })).total).toBe(3);
  });

  it("blocks pending sources, scopes deferrals to one date and invalidates corrected evidence", async () => {
    const a = await customer(); await recurring(a, 2);
    const sourceId = (await call("importSources", { ...await metadata(), sources: [{ text: "Skip tomorrow", customerId: a, sentAt: new Date().toISOString() }] })).resourceIds[0];
    await expect(sheet()).rejects.toMatchObject({ code: "PENDING_REVIEW" });
    await call("sourceDisposition", { ...await metadata(), sourceId, expectedSourceRevision: 0, action: "defer", serviceDate, reason: "Seller will clarify" });
    expect((await call("getDay", { serviceDate })).pendingCount).toBe(0);
    expect((await call("getDay", { serviceDate: addDays(serviceDate, 1) })).pendingCount).toBe(1);
    await call("sourceDisposition", { ...await metadata(), sourceId, expectedSourceRevision: 1, action: "reopen", reason: "Clarified" });
    const proposalId = await draft([{ type: "pause_interval", customerId: a, fromDate: serviceDate, toDate: serviceDate }], sourceId, 2);
    const corrected = await call("correctSource", { ...await metadata(), sourceId, expectedSourceRevision: 2, text: "Only one tomorrow", reason: "Corrected pasted text" });
    expect((await call("getProposal", { proposalId })).status).toBe("obsolete");
    const old = await call("getSource", { sourceId });
    expect(old.source.text).toBe("Skip tomorrow");
    expect(old.source.status).toBe("superseded");
    expect(corrected.resourceIds).not.toEqual([sourceId]);
    await expect(call("approveProposal", { ...await metadata(), proposalId, expectedDraftRevision: 0, expectedSourceRevision: 2, previewHash: "0".repeat(64), supersedesApprovalIds: [], acknowledgeLateChange: false })).rejects.toMatchObject({ code: "STALE_REVISION" });
  });

  it("supports pause/resume and refuses resumes with no known baseline", async () => {
    const a = await customer(); await recurring(a, 2);
    await approve([{ type: "pause_interval", customerId: a, fromDate: serviceDate, toDate: addDays(serviceDate, 1) }]);
    expect((await call("getDay", { serviceDate })).total).toBe(0);
    await approve([{ type: "resume_interval", customerId: a, fromDate: serviceDate, toDate: serviceDate }]);
    expect((await call("getDay", { serviceDate })).total).toBe(2);
    expect((await call("getDay", { serviceDate: addDays(serviceDate, 1) })).total).toBe(0);
    const b = await customer();
    await approve([{ type: "pause_interval", customerId: b, fromDate: serviceDate, toDate: serviceDate }]);
    const noBaseline = await draft([{ type: "resume_interval", customerId: b, fromDate: serviceDate, toDate: serviceDate }]);
    await expect(call("previewProposal", { proposalId: noBaseline, expectedDraftRevision: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects cross-seller access and unknown fields at the actual service boundary", async () => {
    const a = await customer();
    await expect(executeOperation("getCustomer", { customerId: a }, { ...context, userId: "not-the-owner" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call("getCustomer", { customerId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call("createCustomer", { ...await metadata(), alias: "unsafe", sellerId: "forged" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("createCustomer", { ...await metadata(), alias: { $ne: null } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("bounds and scopes pagination, detects duplicates and rolls back batch uniqueness errors", async () => {
    await customer("A"); await customer("B");
    const first = await call("listCustomers", { limit: 1 });
    const next = await call("listCustomers", { limit: 1, cursor: first.nextCursor });
    expect(next.items[0]._id).not.toBe(first.items[0]._id);
    await expect(call("listCustomers", { status: "active", cursor: first.nextCursor })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const entry = { text: "Information", customerId: null, sentAt: new Date().toISOString() };
    await call("importSources", { ...await metadata(), sources: [entry] });
    const duplicate = await call("importSources", { ...await metadata(), sources: [entry] });
    expect(duplicate.warnings).toHaveLength(1);
    const before = (await call("me", {})).stateRevision;
    const upstreamId = "same-external-id";
    await expect(call("importSources", { ...await metadata(), sources: [{ ...entry, upstreamId }, { ...entry, upstreamId }] })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await call("me", {})).stateRevision).toBe(before);
    expect(await (await getDb()).collection<Source>("sources").countDocuments({ sellerId: context.sellerId, upstreamId })).toBe(0);
  });

  it("serializes source intake against sheet finalization", async () => {
    const meta = await metadata();
    const results = await Promise.allSettled([
      call("finalizeSheet", { ...meta, serviceDate, expectedPriorSheetId: null, acknowledgeLateChange: true }),
      call("importSources", { ...meta, meta: { idempotencyKey: randomUUID() }, sources: [{ text: "Unclear future request", customerId: null, sentAt: new Date().toISOString() }] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await call("me", {})).stateRevision).toBe(1);
  });

  it("authenticates real signed sessions through the production route adapter without a mock auth guard", async () => {
    // Test-only credential sign-up creates a genuine library session; production enables Google only.
    const testAuth = betterAuth({
      logger: { disabled: true }, baseURL: process.env.BETTER_AUTH_URL, secret: process.env.BETTER_AUTH_SECRET,
      trustedOrigins: ["http://localhost:3000"], database: mongodbAdapter(await getDb(), { client: await getClient() }),
      emailAndPassword: { enabled: true },
    });
    const signedIn = await testAuth.handler(new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "Synthetic tester", email: `${randomUUID()}@example.invalid`, password: "synthetic-test-password-only-2026" }),
    }));
    expect(signedIn.status).toBe(200);
    const signedUser = await signedIn.json();
    const cookie = signedIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");
    const meRoute = routeHandler("me");
    expect((await meRoute(new Request("http://localhost:3000/api/v1/me"))).status).toBe(401);
    expect((await meRoute(new Request("http://localhost:3000/api/v1/me", { headers: { Cookie: cookie } }))).status).toBe(403);
    await (await getDb()).collection<Seller>("sellers").updateOne({ _id: context.sellerId }, { $set: { ownerUserId: signedUser.user.id } });
    const response = await meRoute(new Request("http://localhost:3000/api/v1/me", { headers: { Cookie: cookie } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).data.seller._id).toBe(context.sellerId);
    const commandHeaders = { Cookie: cookie, Origin: "http://localhost:3000", "Content-Type": "application/json", "Idempotency-Key": randomUUID() };
    const createRoute = routeHandler("createCustomer");
    const createRequest = () => new Request("http://localhost:3000/api/v1/customers", { method: "POST", headers: commandHeaders, body: JSON.stringify({ expectedStateRevision: 0, alias: "HTTP synthetic customer" }) });
    const first = await (await createRoute(createRequest())).json();
    const replay = await (await createRoute(createRequest())).json();
    expect(first.ok).toBe(true);
    expect(replay.data.receipt._id).toBe(first.data.receipt._id);
    const forbidden = await createRoute(new Request("http://localhost:3000/api/v1/customers", { method: "POST", headers: { ...commandHeaders, Origin: "https://untrusted.invalid" }, body: "{}" }));
    expect(forbidden.status).toBe(403);
  });
});
