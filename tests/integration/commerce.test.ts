import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SellerContext } from "@/lib/contracts/common";
import type { CommerceOperationName, CommerceProfile, InvoicePreview } from "@/lib/contracts/commerce";
import { DEFAULT_SETTINGS, type Customer, type OrderOperation, type Seller, type Sheet } from "@/lib/contracts/records";
import { billingMonthDates } from "@/lib/domain/billing";
import { localDateAt } from "@/lib/domain/dates";
import { closeDb, getDb } from "@/lib/server/db/client";
import { initializeIndexes } from "@/lib/server/db/indexes";
import { executeOperation } from "@/lib/server/operations";
import { DEFAULT_COMMERCE_PROFILE, executeCommerceOperation } from "@/lib/server/commerce";

let replica: MongoMemoryReplSet;
let context: SellerContext;
let month: string;
let dates: string[];
let customerId: string;
const profile: CommerceProfile = { unitPricePaise: 8000, phone: "919876543210", routeName: "Synthetic east route", routeOrder: 1, deliveryNote: "Fictional front gate" };
type Operation = Exclude<CommerceOperationName, "getDispatch">;
const call = <K extends Operation>(name: K, input: unknown) => executeCommerceOperation(name, input, context);
async function metadata() {
  const seller = await (await getDb()).collection<Seller>("sellers").findOne({ _id: context.sellerId });
  return { expectedStateRevision: seller!.stateRevision, meta: { idempotencyKey: randomUUID() } };
}
async function savePrice(price = 8000) {
  const setup = await call("getCommerceSetup", {});
  const row = setup.customers.find((customer) => customer.customerId === customerId)!;
  return call("saveCommerceCustomer", { ...await metadata(), customerId, expectedProfileRevision: row.revision, profile: { ...profile, unitPricePaise: price } });
}
async function approve(operations: OrderOperation[]) {
  const draft = await executeOperation("createProposal", { ...await metadata(), sourceId: null, expectedSourceRevision: null, manualReason: "Synthetic commerce fixture", operations, missingFields: [], evidenceSpans: [] }, context);
  const proposalId = draft.resourceIds[0];
  const proposal = await executeOperation("getProposal", { proposalId }, context);
  const preview = await executeOperation("previewProposal", { proposalId, expectedDraftRevision: proposal.draftRevision }, context);
  return executeOperation("approveProposal", { ...await metadata(), proposalId, expectedDraftRevision: proposal.draftRevision, expectedSourceRevision: null, previewHash: preview.previewHash, supersedesApprovalIds: [...new Set(preview.conflicts.map((row) => row.approvalId))], acknowledgeLateChange: true }, context);
}
async function finalizedFixture() {
  const approval = await approve([{ type: "replace_recurring_plan", customerId, startDate: dates[0], endDate: dates[1], quantities: [2, 2, 2, 2, 2, 2, 2] }]);
  const override = await approve([{ type: "set_daily_quantity", customerId, serviceDate: dates[1], quantity: 3 }]);
  const sheetIds: string[] = [];
  for (const serviceDate of dates.slice(0, 2)) {
    const result = await executeOperation("finalizeSheet", { ...await metadata(), serviceDate, expectedPriorSheetId: null, acknowledgeLateChange: true }, context);
    sheetIds.push(result.resourceIds[0]);
  }
  return { approval, override, sheetIds };
}
function issueInput(preview: InvoicePreview, idempotencyKey = randomUUID()) {
  return { expectedStateRevision: preview.expectedStateRevision, meta: { idempotencyKey }, customerId, month, adjustments: [], expectedBasisHash: preview.basisHash, expectedPriorInvoiceId: preview.priorInvoiceId };
}

beforeAll(async () => {
  // Always own an isolated replica set; never consume an existing database URI.
  replica = await MongoMemoryReplSet.create({ binary: { version: "8.0.14", downloadDir: process.env.MONGOMS_DOWNLOAD_DIR ?? join(tmpdir(), "opencode", "tiffin-mongodb-binaries") }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  vi.stubEnv("MONGODB_URI", replica.getUri());
  vi.stubEnv("MONGODB_DB", `test_commerce_${randomUUID().replaceAll("-", "")}`);
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-test-only-secret-not-a-real-credential-2026");
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client-not-used-for-oauth");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret-not-used-for-oauth");
  await initializeIndexes(await getDb());
});
beforeEach(async () => {
  context = { sellerId: randomUUID(), userId: randomUUID(), requestId: randomUUID() };
  month = Temporal.PlainYearMonth.from(localDateAt(new Date().toISOString(), "Asia/Kolkata").slice(0, 7)).subtract({ months: 1 }).toString();
  dates = billingMonthDates(month);
  await (await getDb()).collection<Seller>("sellers").insertOne({ _id: context.sellerId, ownerUserId: context.userId, stateRevision: 0, status: "active", schemaVersion: 1, createdAt: `${dates[0]}T00:00:00Z`, settings: { ...DEFAULT_SETTINGS, weekdays: [1, 2, 3, 4, 5, 6, 7] } });
  customerId = (await executeOperation("createCustomer", { ...await metadata(), alias: "Fictional billing customer" }, context)).resourceIds[0];
  // Synthetic historical membership predates this month; no live customer records are used.
  await (await getDb()).collection<Customer>("customers").updateOne({ _id: customerId }, { $set: { createdAt: `${dates[0]}T00:00:00Z` } });
});
afterAll(async () => {
  await closeDb();
  await replica?.stop();
  vi.unstubAllEnvs();
});

describe("isolated replica-set commerce backend", () => {
  it("persists explicit settings and prices, audits changes and replays identical commands", async () => {
    const defaults = await call("getCommerceSetup", {});
    expect(defaults.settings).toEqual({ upiId: "", helperPhone: "" });
    expect(defaults.customers[0]).toMatchObject({ profile: DEFAULT_COMMERCE_PROFILE, revision: null });
    const settingsInput = { ...await metadata(), settings: { upiId: "fictional@upi", helperPhone: "919876543211" } };
    const settingsResult = await call("saveCommerceSettings", settingsInput);
    expect(await call("saveCommerceSettings", settingsInput)).toEqual(settingsResult);
    const input = { ...await metadata(), customerId, expectedProfileRevision: null, profile };
    const saved = await call("saveCommerceCustomer", input);
    expect(await call("saveCommerceCustomer", input)).toEqual(saved);
    expect(saved.receipt).toMatchObject({ before: null, after: { customerId, profile, revision: 0 } });
    expect((await call("getCommerceSetup", {})).customers[0]).toMatchObject({ profile, revision: 0 });
    const client = await new MongoClient(replica.getUri()).connect();
    try {
      const db = client.db(process.env.MONGODB_DB);
      expect(await db.collection<{ _id: string }>("customerCommerce").findOne({ _id: `${context.sellerId}_${customerId}` })).toMatchObject({ sellerId: context.sellerId, customerId, profile, revision: 0 });
      expect(await db.collection<{ _id: string }>("commerceSettings").findOne({ _id: context.sellerId })).toMatchObject({ settings: settingsInput.settings });
      expect(await db.collection("receipts").countDocuments({ sellerId: context.sellerId, operation: "saveCommerceCustomer" })).toBe(1);
    } finally { await client.close(); }
    await expect(call("saveCommerceCustomer", { ...input, profile: { ...profile, unitPricePaise: 9000 } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("refuses stale state/profile revisions and foreign owners or customer IDs", async () => {
    const stale = await metadata();
    await savePrice();
    await expect(call("saveCommerceCustomer", { ...stale, customerId, expectedProfileRevision: 0, profile })).rejects.toMatchObject({ code: "STALE_REVISION" });
    const fresh = await metadata();
    await expect(call("saveCommerceCustomer", { ...fresh, customerId, expectedProfileRevision: null, profile })).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect((await metadata()).expectedStateRevision).toBe(fresh.expectedStateRevision);
    await expect(executeCommerceOperation("getCommerceSetup", {}, { ...context, userId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(executeCommerceOperation("saveCommerceCustomer", { ...await metadata(), customerId, expectedProfileRevision: 0, profile }, { ...context, userId: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call("saveCommerceCustomer", { ...await metadata(), customerId: randomUUID(), expectedProfileRevision: null, profile })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call("getInvoice", { invoiceId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("blocks missing finalized dates, missing rates and a month without customer rows", async () => {
    await (await getDb()).collection<Customer>("customers").updateOne({ _id: customerId }, { $set: { createdAt: new Date().toISOString() } });
    await approve([{ type: "replace_recurring_plan", customerId, startDate: dates[0], endDate: dates[1], quantities: [2, 2, 2, 2, 2, 2, 2] }]);
    const preview = await call("previewInvoice", { customerId, month });
    expect(preview).toMatchObject({ missingDates: dates.slice(0, 2), canIssue: false, unitPricePaise: null, lines: [] });
    expect(preview.warnings.join(" ")).toContain("No finalized ordered rows");
    await expect(call("createInvoice", issueInput(preview))).rejects.toMatchObject({ code: "INVALID_STATE" });
    await savePrice();
    await executeOperation("finalizeSheet", { ...await metadata(), serviceDate: dates[0], expectedPriorSheetId: null, acknowledgeLateChange: true }, context);
    const partial = await call("previewInvoice", { customerId, month });
    expect(partial).toMatchObject({ canIssue: false, missingDates: [dates[1]], totalPaise: 16000 });
    await expect(call("createInvoice", issueInput(partial))).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await (await getDb()).collection("invoices").countDocuments({ sellerId: context.sellerId })).toBe(0);
  });

  it("bills latest finalized revisions once and freezes issued snapshots across price changes", async () => {
    await savePrice();
    const fixture = await finalizedFixture();
    const db = await getDb();
    const previous = (await db.collection<Sheet>("sheets").findOne({ _id: fixture.sheetIds[1] }))!;
    // Historical immutable amendment fixture: both versions contain approved quantities.
    const amended: Sheet = { ...previous, _id: randomUUID(), revision: 2, previousSheetId: previous._id };
    await db.collection<Sheet>("sheets").insertOne(amended);
    const preview = await call("previewInvoice", { customerId, month });
    expect(preview).toMatchObject({ canIssue: true, missingDates: [], baselineSubtotalPaise: 32000, extraChargesPaise: 8000, totalPaise: 40000 });
    expect(preview.lines).toHaveLength(2);
    expect(preview.lines[0]).toMatchObject({ quantity: 2, approvalReceiptId: fixture.approval.receipt._id, approvalReceiptKey: fixture.approval.receipt.idempotencyKey });
    expect(preview.lines[1]).toMatchObject({ sheetId: amended._id, sheetRevision: 2, quantity: 3, approvalReceiptId: fixture.override.receipt._id });
    const input = issueInput(preview);
    const issued = await call("createInvoice", input);
    expect(await call("createInvoice", input)).toEqual(issued);
    const invoiceId = issued.resourceIds[0];
    const invoice = await call("getInvoice", { invoiceId });
    expect(invoice).toMatchObject({ version: 1, status: "issued", unitPricePaise: 8000, totalPaise: 40000, previousInvoiceId: null });
    expect(invoice).not.toHaveProperty("sellerId");
    expect(issued.receipt.after).toEqual(invoice);
    expect(issued.affectedDates).toEqual(dates.slice(0, 2));
    await savePrice(9000);
    expect(await call("getInvoice", { invoiceId })).toEqual(invoice);
    const next = await call("previewInvoice", { customerId, month });
    expect(next).toMatchObject({ totalPaise: 45000, priorInvoiceId: invoiceId });
    const corrected = await call("createInvoice", issueInput(next));
     expect(await call("getInvoice", { invoiceId: corrected.resourceIds[0] })).toMatchObject({ version: 2, previousInvoiceId: invoiceId, totalPaise: 45000 });
     expect((await call("getInvoice", { invoiceId: corrected.resourceIds[0] })).message).toContain("Do not pay both statements.");
    const list = await call("listInvoices", { customerId, month });
    expect(list.items).toHaveLength(2);
    expect(list.hasMore).toBe(false);
  });

  it("refuses changed invoice basis and prior invoice, and preserves command rollback", async () => {
    await savePrice(); await finalizedFixture();
    const old = await call("previewInvoice", { customerId, month });
    await savePrice(9000);
    const fresh = await metadata();
    await expect(call("createInvoice", { ...issueInput(old), ...fresh })).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect((await metadata()).expectedStateRevision).toBe(fresh.expectedStateRevision);
    const current = await call("previewInvoice", { customerId, month });
    await expect(call("createInvoice", { ...issueInput(current), expectedPriorInvoiceId: randomUUID() })).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(await (await getDb()).collection("invoices").countDocuments({ sellerId: context.sellerId })).toBe(0);
  });

  it("blocks relevant pending review without copying messages into statement proof", async () => {
    await savePrice(); await finalizedFixture();
    const raw = "Synthetic private source text must stay out of statements";
    await executeOperation("importSources", { ...await metadata(), sources: [{ text: raw, customerId, sentAt: `${dates[0]}T08:00:00Z` }] }, context);
    const preview = await call("previewInvoice", { customerId, month });
    expect(preview.canIssue).toBe(false);
    expect(preview.warnings.join(" ")).toContain("pending orders");
    expect(JSON.stringify(preview)).not.toContain(raw);
    await expect(call("createInvoice", issueInput(preview))).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("validates current/future months and adjustment dates at the service boundary", async () => {
    await savePrice(); await finalizedFixture();
    const adjusted = await call("previewInvoice", { customerId, month, adjustments: [{ serviceDate: dates[0], amountPaise: 12000, reason: "Seller half-portion billing adjustment" }] });
    expect(adjusted).toMatchObject({ canIssue: true, adjustmentsPaise: -4000, totalPaise: 36000 });
    expect(adjusted.message).toContain("seller billing adjustment");
    const issued = await call("createInvoice", { ...issueInput(adjusted), adjustments: [{ serviceDate: dates[0], amountPaise: 12000, reason: "Seller half-portion billing adjustment" }] });
    expect((await call("getInvoice", { invoiceId: issued.resourceIds[0] })).lines[0]).toMatchObject({ quantity: 2, amountPaise: 12000, adjustmentPaise: -4000, adjustmentReason: "Seller half-portion billing adjustment" });
    const currentMonth = localDateAt(new Date().toISOString(), "Asia/Kolkata").slice(0, 7);
    expect((await call("previewInvoice", { customerId, month: currentMonth })).warnings).toContain("Current month is not closed.");
    const future = Temporal.PlainYearMonth.from(currentMonth).add({ months: 1 }).toString();
    await expect(call("previewInvoice", { customerId, month: future })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("previewInvoice", { customerId, month: "0000-01" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("previewInvoice", { customerId, month, adjustments: [{ serviceDate: dates[2], amountPaise: 1, reason: "No finalized row" }] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("allows archived customer statement reads while retaining seller ownership", async () => {
    await savePrice(); await finalizedFixture();
    const preview = await call("previewInvoice", { customerId, month });
    const result = await call("createInvoice", issueInput(preview));
    await executeOperation("updateCustomer", { ...await metadata(), customerId, expectedCustomerRevision: 0, status: "archived" }, context);
    expect((await call("getInvoice", { invoiceId: result.resourceIds[0] })).totalPaise).toBe(40000);
    expect((await call("previewInvoice", { customerId, month })).canIssue).toBe(true);
    expect((await call("getCommerceSetup", {})).customers[0].status).toBe("archived");
    const foreignContext = { sellerId: randomUUID(), userId: randomUUID(), requestId: randomUUID() };
    await (await getDb()).collection<Seller>("sellers").insertOne({ _id: foreignContext.sellerId, ownerUserId: foreignContext.userId, stateRevision: 0, status: "active", schemaVersion: 1, createdAt: new Date().toISOString(), settings: DEFAULT_SETTINGS });
    await expect(executeCommerceOperation("getInvoice", { invoiceId: result.resourceIds[0] }, foreignContext)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(executeCommerceOperation("previewInvoice", { customerId, month }, foreignContext)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses historical approval snapshots when the original recurring plan is no longer current", async () => {
    await savePrice();
    const fixture = await finalizedFixture();
    await (await getDb()).collection("plans").deleteMany({ sellerId: context.sellerId, customerId });
    const preview = await call("previewInvoice", { customerId, month });
    expect(preview).toMatchObject({ canIssue: true, totalPaise: 40000 });
    expect(preview.lines[0].approvalReceiptId).toBe(fixture.approval.receipt._id);
  });

   it("treats a finalized sheet without the expected customer row as incomplete", async () => {
    await savePrice();
    const fixture = await finalizedFixture();
    await (await getDb()).collection<Sheet>("sheets").updateOne({ _id: fixture.sheetIds[1] }, { $set: { rows: [], total: 0 } });
    const preview = await call("previewInvoice", { customerId, month });
    expect(preview).toMatchObject({ canIssue: false, missingDates: [dates[1]], totalPaise: 16000 });
    await expect(call("createInvoice", issueInput(preview))).rejects.toMatchObject({ code: "INVALID_STATE" });
   });

   it("does not hide a missing historical date when current plan documents are unavailable", async () => {
     await savePrice();
     await finalizedFixture();
     const db = await getDb();
     await db.collection("sheets").deleteMany({ sellerId: context.sellerId, serviceDate: dates[0] });
     await db.collection("plans").deleteMany({ sellerId: context.sellerId, customerId });
     const preview = await call("previewInvoice", { customerId, month });
     expect(preview).toMatchObject({ canIssue: false, missingDates: [dates[0]] });
     await expect(call("createInvoice", issueInput(preview))).rejects.toMatchObject({ code: "INVALID_STATE" });
   });

  it("refuses oversized customer and monthly sheet-version histories rather than truncating", async () => {
    const db = await getDb();
    const customer = (await db.collection<Customer>("customers").findOne({ _id: customerId }))!;
    await db.collection<Customer>("customers").insertMany(Array.from({ length: 100 }, () => ({ ...customer, _id: randomUUID(), status: "archived" as const })));
    await expect(call("getCommerceSetup", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
    await db.collection<Customer>("customers").deleteMany({ sellerId: context.sellerId, _id: { $ne: customerId } });
    await savePrice();
    const fixture = await finalizedFixture();
    const sheet = (await db.collection<Sheet>("sheets").findOne({ _id: fixture.sheetIds[0] }))!;
    await db.collection<Sheet>("sheets").insertMany(Array.from({ length: 309 }, (_, index) => ({ ...sheet, _id: randomUUID(), revision: index + 2, previousSheetId: sheet._id })));
    await expect(call("previewInvoice", { customerId, month })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("bounds invoice lists at 100 plus a hasMore sentinel and strips storage ownership fields", async () => {
    await savePrice(); await finalizedFixture();
    const issued = await call("createInvoice", issueInput(await call("previewInvoice", { customerId, month })));
    const db = await getDb();
    const invoice = (await db.collection<{ _id: string; sellerId: string; version: number }>("invoices").findOne({ _id: issued.resourceIds[0] }))!;
    await db.collection<{ _id: string; sellerId: string; version: number }>("invoices").insertMany(Array.from({ length: 100 }, (_, index) => ({ ...invoice, _id: randomUUID(), version: index + 2 })));
    const result = await call("listInvoices", { month, customerId });
    expect(result.hasMore).toBe(true);
    expect(result.items).toHaveLength(100);
    expect(result.items.every((row) => !("sellerId" in row))).toBe(true);
  });
});
