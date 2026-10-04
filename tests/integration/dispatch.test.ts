import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SellerContext } from "@/lib/contracts/common";
import type { CommerceProfile } from "@/lib/contracts/commerce";
import { DEFAULT_SETTINGS, type Customer, type OrderOperation, type Seller } from "@/lib/contracts/records";
import { addDays, localDateAt } from "@/lib/domain/dates";
import { closeDb, getDb } from "@/lib/server/db/client";
import { initializeIndexes } from "@/lib/server/db/indexes";
import { getDispatch } from "@/lib/server/dispatch";
import { executeOperation } from "@/lib/server/operations";
import { readSnapshot } from "@/lib/server/receipts";

// This suite owns all identities and its replica set; auth is a local fixture only.
vi.mock("@/lib/server/context", () => ({ requireSellerContext: vi.fn(async () => context) }));
vi.mock("@/lib/server/rate-limit", () => ({ enforceRateLimit: vi.fn(async () => {}) }));
let replica: MongoMemoryReplSet;
let context: SellerContext;
let serviceDate: string;
type ProfileFixture = { _id: string; sellerId: string; customerId: string; revision: number; profile: CommerceProfile };
type SettingsFixture = { _id: string; sellerId: string; settings: { upiId: string; helperPhone: string } };
const call = <K extends import("@/lib/contracts/api").OperationName>(operation: K, input: unknown) => executeOperation(operation, input, context);
const dispatch = (date = serviceDate, who = context) => readSnapshot(who, (scope) => getDispatch({ serviceDate: date }, scope));
async function meta() {
  return { expectedStateRevision: (await call("me", {})).stateRevision, meta: { idempotencyKey: randomUUID() } };
}
async function customer(alias: string) {
  return (await call("createCustomer", { ...await meta(), alias })).resourceIds[0];
}
async function approve(operations: OrderOperation[]) {
  const proposalId = (await call("createProposal", { ...await meta(), sourceId: null, expectedSourceRevision: null, manualReason: "Synthetic dispatch fixture", operations, missingFields: [], evidenceSpans: [] })).resourceIds[0];
  const proposal = await call("getProposal", { proposalId });
  const preview = await call("previewProposal", { proposalId, expectedDraftRevision: proposal.draftRevision });
  return call("approveProposal", {
    ...await meta(), proposalId, expectedDraftRevision: proposal.draftRevision, expectedSourceRevision: null,
    previewHash: preview.previewHash, supersedesApprovalIds: [...new Set(preview.conflicts.map((row) => row.approvalId))], acknowledgeLateChange: true,
  });
}
async function plan(customerId: string, quantity: number) {
  return approve([{ type: "replace_recurring_plan", customerId, startDate: serviceDate, endDate: null, quantities: [quantity, quantity, quantity, quantity, quantity, quantity, quantity] }]);
}
async function finalize(date = serviceDate) {
  const day = await call("getDay", { serviceDate: date });
  return call("finalizeSheet", { ...await meta(), serviceDate: date, expectedPriorSheetId: day.latestSheetId, acknowledgeLateChange: true });
}
async function routing(customerId: string, routeName: string, routeOrder: number, deliveryNote = "") {
  await (await getDb()).collection<ProfileFixture>("customerCommerce").insertOne({
    _id: `${context.sellerId}_${customerId}`, sellerId: context.sellerId, customerId, revision: 0,
    profile: { unitPricePaise: null, phone: "", routeName, routeOrder, deliveryNote },
  });
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({
    binary: { version: "8.0.14", downloadDir: process.env.MONGOMS_DOWNLOAD_DIR ?? join(tmpdir(), "opencode", "tiffin-mongodb-binaries") },
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  vi.stubEnv("MONGODB_URI", replica.getUri());
  vi.stubEnv("MONGODB_DB", `dispatch_${randomUUID().replaceAll("-", "")}`);
  vi.stubEnv("APP_ENV", "test");
  await initializeIndexes(await getDb());
});
beforeEach(async () => {
  context = { sellerId: randomUUID(), userId: randomUUID(), requestId: randomUUID() };
  serviceDate = localDateAt(new Date().toISOString(), "Asia/Kolkata");
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

describe("isolated replica-set dispatch", () => {
  it("requires finalization, includes recurring baseline meals and excludes cancelled and never-ordered stops", async () => {
    const a = await customer("Synthetic Anita");
    const b = await customer("Synthetic Bina");
    await customer("Synthetic never ordered");
    await plan(a, 2); await plan(b, 1);
    await routing(a, "Owner entered building", 2, "Owner entered guard note");
    await routing(b, "Cancelled building", 1);
    await approve([{ type: "pause_interval", customerId: b, fromDate: serviceDate, toDate: serviceDate }]);
    expect(await dispatch()).toMatchObject({ isReady: false, total: 2, sheetId: null, helperPhone: "" });
    const saved = await finalize();
    const ready = await dispatch();
    expect(ready).toMatchObject({ isReady: true, total: 2, sheetId: saved.resourceIds[0], sheetRevision: 1 });
    expect(ready.groups).toHaveLength(1);
    expect(ready.groups[0]).toMatchObject({ routeName: "Owner entered building", total: 2, customers: [{ customerId: a, quantity: 2, deliveryNote: "Owner entered guard note" }] });
    expect(ready.doNotStop.map((item) => item.customerId)).toEqual([b]);
    expect(ready.message).toContain("Do not stop today:");
  });

  it("does not stale on preferences, but does stale after an approved current-day quantity change", async () => {
    const a = await customer("Synthetic regular"); await plan(a, 2); await finalize();
    const db = await getDb();
    await routing(a, "Building", 0, "Owner note");
    await db.collection<SettingsFixture>("commerceSettings").insertOne({ _id: context.sellerId, sellerId: context.sellerId, settings: { upiId: "", helperPhone: "919876543210" } });
    await db.collection<Seller>("sellers").updateOne({ _id: context.sellerId }, { $inc: { stateRevision: 1 } });
    expect(await dispatch()).toMatchObject({ isReady: true, helperPhone: "919876543210" });
    await approve([{ type: "set_daily_quantity", customerId: a, serviceDate, quantity: 3 }]);
    expect(await dispatch()).toMatchObject({ isReady: false, total: 3, sheetRevision: 1 });
    await finalize();
    expect(await dispatch()).toMatchObject({ isReady: true, total: 3, sheetRevision: 2 });
  });

  it("blocks relevant pending input until it is resolved and keeps current alias/packing-note changes stale", async () => {
    const a = await customer("Synthetic original"); await plan(a, 2); await finalize();
    const imported = await call("importSources", { ...await meta(), sources: [{ text: "Synthetic unclear request", customerId: a, sentAt: new Date().toISOString() }] });
    expect(await dispatch()).toMatchObject({ isReady: false, pendingCount: 1 });
    await call("sourceDisposition", { ...await meta(), sourceId: imported.resourceIds[0], expectedSourceRevision: 0, action: "dismiss", reason: "Synthetic fixture resolved" });
    expect((await dispatch()).isReady).toBe(true);
    await (await getDb()).collection<Customer>("customers").updateOne({ _id: a, sellerId: context.sellerId }, { $set: { alias: "Synthetic renamed", packingNote: "Changed packing note" } });
    expect((await dispatch()).isReady).toBe(false);
  });

  it("uses immutable past rows even after an alias update and prefers the latest sheet revision", async () => {
    const a = await customer("Synthetic frozen alias"); await plan(a, 2); await finalize();
    await approve([{ type: "set_daily_quantity", customerId: a, serviceDate, quantity: 4 }]);
    await finalize();
    await (await getDb()).collection<Customer>("customers").updateOne({ _id: a, sellerId: context.sellerId }, { $set: { alias: "Synthetic current alias" } });
    const frozen = await readSnapshot(context, (scope) => getDispatch({ serviceDate }, { ...scope, now: `${addDays(serviceDate, 1)}T12:00:00.000Z` }));
    expect(frozen).toMatchObject({ isReady: true, total: 4, sheetRevision: 2 });
    expect(frozen.groups[0].customers[0].alias).toBe("Synthetic frozen alias");
    expect(frozen.unroutedCustomerIds).toEqual([a]);
  });

  it("enforces owner binding and privacy deletion and scopes all preferences to the owner seller", async () => {
    const a = await customer("Synthetic local"); await plan(a, 1); await finalize();
    await (await getDb()).collection<ProfileFixture>("customerCommerce").insertOne({ _id: `foreign_${a}`, sellerId: "foreign-seller", customerId: a, revision: 0, profile: { unitPricePaise: null, phone: "", routeName: "Foreign building", routeOrder: 0, deliveryNote: "Foreign private note" } });
    await (await getDb()).collection<SettingsFixture>("commerceSettings").insertOne({ _id: "foreign-seller", sellerId: "foreign-seller", settings: { upiId: "", helperPhone: "919999999999" } });
    const own = await dispatch();
    expect(own.groups[0].routeName).toBe("Unassigned");
    expect(own.message).not.toContain("Foreign");
    expect(own.helperPhone).toBe("");
    await expect(dispatch(serviceDate, { ...context, userId: "synthetic-non-owner" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await (await getDb()).collection<Seller>("sellers").updateOne({ _id: context.sellerId }, { $set: { privacyDeleting: true } });
    await expect(dispatch()).rejects.toMatchObject({ code: "PRIVACY_DELETING" });
  });

  it("serves a private/no-store GET docket through the registered HTTP route", async () => {
    const { GET } = await import("@/app/api/v1/days/[serviceDate]/dispatch/route");
    const a = await customer("Synthetic HTTP regular"); await plan(a, 1); await finalize();
    const response = await GET(new Request(`http://localhost:3000/api/v1/days/${serviceDate}/dispatch`), { params: Promise.resolve({ serviceDate }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ ok: true, data: { isReady: true, total: 1, serviceDate } });
  });
});
