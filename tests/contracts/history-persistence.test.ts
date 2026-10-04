import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SellerContext } from "@/lib/contracts/common";
import { DEFAULT_SETTINGS, type Seller } from "@/lib/contracts/records";
import { closeDb, getDb } from "@/lib/server/db/client";
import { executeForecastingOperation as execute, initializeForecastIndexes, checkForecastIndexes, currentPolicyHash } from "@/lib/server/forecasting";
import type { HistoryRow } from "@/lib/contracts/history";
let replica: MongoMemoryReplSet;
let context: SellerContext, seller: Seller;
const command = (version = 0) => ({ meta: { idempotencyKey: randomUUID() }, expectedStateRevision: 0, expectedHistoryVersion: version });
function historyRow(date: string, evidenceMode: "real" | "synthetic_demo" = "synthetic_demo"): HistoryRow {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return { schemaVersion: 1, serviceDate: date, timezone: "UTC", policyHash: currentPolicyHash(seller), asOf: `${date}T09:00:00Z`, cutoffAt: `${date}T10:00:00Z`, outcomeAvailableAt: `${date}T10:00:00Z`, confirmedMeals: 10, cutoffTotal: 12, features: [weekday, 60, 10, 10, 2, null, null, null, null, null, 0, null, null, 0], evidenceMode, provenance: { kind: evidenceMode === "real" ? "imported_complete" : "synthetic", reference: "isolated-fixture", complete: true, snapshotEvidenceAt: `${date}T09:00:00Z`, cutoffEvidenceAt: `${date}T10:00:00Z`, messageFeatures: "missing", messageEvidenceAt: null } };
}
async function importRows(rows: HistoryRow[]) {
  const staged = await execute("stageHistory", { ...command(), schemaVersion: 1, evidenceMode: rows[0].evidenceMode, rows }, context);
  await execute("commitHistory", { ...command(), importId: staged._id, digest: staged.digest }, context);
  return (await execute("listHistory", { limit: 100 }, context)).items;
}
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: "8.0.14", downloadDir: process.env.MONGOMS_DOWNLOAD_DIR ?? join(tmpdir(), "opencode", "tiffin-mongodb-binaries") }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  vi.stubEnv("MONGODB_URI", replica.getUri()); vi.stubEnv("MONGODB_DB", `test_history_${randomUUID().replaceAll("-", "")}`); vi.stubEnv("APP_ENV", "test");
  await initializeForecastIndexes(await getDb());
}, 120000);
beforeEach(async () => {
  context = { sellerId: randomUUID(), userId: randomUUID(), requestId: randomUUID() };
  seller = { _id: context.sellerId, ownerUserId: context.userId, schemaVersion: 1, stateRevision: 0, status: "active", createdAt: "2026-01-01T00:00:00Z", settings: { ...DEFAULT_SETTINGS, timezone: "UTC" } };
  await (await getDb()).collection<Seller>("sellers").insertOne(seller);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(async () => { await closeDb(); await replica?.stop(); vi.unstubAllEnvs(); });
describe("isolated replica-set forecasting persistence", () => {
  it("stages separately, commits once, returns snapshot IDs and preserves fulfillment state", async () => {
    expect(await checkForecastIndexes(await getDb())).toBe(true);
    const staged = await execute("stageHistory", { ...command(), schemaVersion: 1, evidenceMode: "synthetic_demo", rows: [historyRow("2026-01-01")] }, context);
    expect((await execute("listHistory", {}, context)).items).toHaveLength(0);
    const input = { ...command(), importId: staged._id, digest: staged.digest };
    const result = await execute("commitHistory", input, context);
    expect(result.historyVersion).toBe(1); expect(await execute("commitHistory", input, context)).toEqual(result);
    const listing = await execute("listHistory", {}, context); expect(listing.items).toHaveLength(1); expect(listing.items[0].snapshotId).toBeTruthy();
    expect((await (await getDb()).collection<Seller>("sellers").findOne({ _id: seller._id }))?.stateRevision).toBe(0);
    expect(await (await getDb()).collection("plans").countDocuments({ sellerId: seller._id })).toBe(0);
    expect(await (await getDb()).collection("sheets").countDocuments({ sellerId: seller._id })).toBe(0);
    await expect(execute("commitHistory", { ...input, digest: "b".repeat(64) }, context)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("requires exact active row/snapshot supersession and appends immutable corrected history", async () => {
    const [old] = await importRows([historyRow("2026-01-01")]);
    const staged = await execute("stageHistory", { ...command(1), schemaVersion: 1, evidenceMode: "synthetic_demo", rows: [{ ...historyRow("2026-01-01"), cutoffTotal: 15 }] }, context);
    await expect(execute("commitHistory", { ...command(1), importId: staged._id, digest: staged.digest, supersedesIds: [old._id] }, context)).rejects.toMatchObject({ code: "HISTORY_CONFLICT" });
    await execute("commitHistory", { ...command(1), importId: staged._id, digest: staged.digest, supersedesIds: [old._id, old.snapshotId] }, context);
    expect((await execute("listHistory", {}, context)).items[0].row.cutoffTotal).toBe(15);
    const previous = await (await getDb()).collection("historyRows").findOne({ _id: old._id as never }); expect(previous?.active).toBe(false); expect(previous?.row.cutoffTotal).toBe(12);
  });
  it("reserves one synthetic dispatch and returns the saved run on concurrent same-key requests", async () => {
    const rows = await importRows([historyRow("2026-01-01"), historyRow("2026-01-02"), historyRow("2026-01-03")]);
    const snapshot = rows.find((row) => row.row.serviceDate === "2026-01-03")!;
    vi.stubEnv("TABPFN_SERVICE_URL", "http://localhost:8000"); vi.stubEnv("TABPFN_SERVICE_TOKEN", "synthetic-service-credential-not-real");
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { const request = JSON.parse(options.body as string); return new Response(JSON.stringify({ schemaVersion: 1, runId: request.runId, dataHash: request.dataHash, featureSchemaVersion: 1, modelVersion: "synthetic-fixture-v1", predictedDelta: 1.2, trainingRows: request.trainRows.length, durationMs: 1 })); });
    vi.stubGlobal("fetch", fetch);
    const input = { ...command(1), snapshotId: snapshot.snapshotId, serviceDate: snapshot.row.serviceDate, experiment: true };
    const [first, second] = await Promise.all([execute("requestForecast", input, context), execute("requestForecast", input, context)]);
    expect(first._id).toBe(second._id); expect(fetch).toHaveBeenCalledTimes(1);
    const read = await execute("getForecastByKey", { requestKey: input.meta.idempotencyKey }, context); expect(read.runState).toBe("succeeded"); expect(read.evidenceMode).toBe("synthetic_demo"); expect(read.result?.predictedDelta).toBe(1.2);
    await execute("requestForecast", input, context); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("captures actual planning now, refuses past capture and accepts only exact imported cutoff evidence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-01-02T09:00:00Z"));
    await expect(execute("capturePlanningSnapshot", { ...command(), serviceDate: "2026-01-01", policyHash: currentPolicyHash(seller) }, context)).rejects.toMatchObject({ code: "OUTSIDE_PLANNING_WINDOW" });
    const snapshot = await execute("capturePlanningSnapshot", { ...command(), serviceDate: "2026-01-02", policyHash: currentPolicyHash(seller) }, context);
    expect(snapshot.asOf).toBe("2026-01-02T09:00:00.000Z");
    vi.setSystemTime(new Date("2026-01-02T10:01:00Z"));
    const row = { ...historyRow("2026-01-02", "real"), asOf: snapshot.asOf, confirmedMeals: 0, cutoffTotal: 5, features: snapshot.features };
    row.provenance.messageFeatures = "as_of"; row.provenance.messageEvidenceAt = snapshot.asOf;
    const evidence = await execute("stageHistory", { ...command(1), schemaVersion: 1, evidenceMode: "real", rows: [row] }, context);
    const outcome = await execute("recordOutcome", { ...command(1), serviceDate: snapshot.serviceDate, snapshotId: snapshot._id, evidenceImportId: evidence._id, evidenceRow: 1, complete: true }, context);
    expect(outcome.cutoffTotal).toBe(5); expect((await execute("listHistory", {}, context)).items[0].row.confirmedMeals).toBe(0);
  });
  it("keeps a timeout unknown, never replays inference and retains its unresolved slot", async () => {
    const rows = await importRows([historyRow("2026-01-01"), historyRow("2026-01-02"), historyRow("2026-01-03")]);
    const snapshot = rows.find((row) => row.row.serviceDate === "2026-01-03")!;
    vi.stubEnv("TABPFN_SERVICE_URL", "http://localhost:8000"); vi.stubEnv("TABPFN_SERVICE_TOKEN", "synthetic-service-credential-not-real");
    const fetch = vi.fn().mockRejectedValue(new Error("synthetic connection lost")); vi.stubGlobal("fetch", fetch);
    const input = { ...command(1), snapshotId: snapshot.snapshotId, serviceDate: snapshot.row.serviceDate, experiment: true };
    const run = await execute("requestForecast", input, context); expect(run.runState).toBe("unknown");
    expect((await execute("requestForecast", input, context))._id).toBe(run._id); expect(fetch).toHaveBeenCalledTimes(1);
    await expect(execute("requestForecast", { ...input, meta: { idempotencyKey: randomUUID() } }, context)).rejects.toMatchObject({ code: "AI_BUSY" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reports insufficient and not-validated real history without a guessed model call", async () => {
    const dates = Array.from({ length: 41 }, (_, index) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10));
    const rows = await importRows(dates.map((date) => historyRow(date, "real")));
    vi.stubEnv("TABPFN_SERVICE_URL", "http://localhost:8000"); vi.stubEnv("TABPFN_SERVICE_TOKEN", "synthetic-service-credential-not-real");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const first = rows.find((row) => row.row.serviceDate === dates[0])!, last = rows.find((row) => row.row.serviceDate === dates[40])!;
    const early = await execute("requestForecast", { ...command(1), snapshotId: first.snapshotId, serviceDate: first.row.serviceDate }, context);
    expect(early.result?.status).toBe("insufficient_history"); expect(early.result?.predictedDelta).toBeNull();
    const later = await execute("requestForecast", { ...command(1), snapshotId: last.snapshotId, serviceDate: last.row.serviceDate }, context);
    expect(later.result?.status).toBe("not_validated"); expect(later.result?.predictedDelta).toBeNull(); expect(fetch).not.toHaveBeenCalled();
    await expect(execute("requestForecast", { ...command(1), snapshotId: last.snapshotId, serviceDate: last.row.serviceDate, experiment: true }, context)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("blocks all seller operations once privacy deletion starts", async () => {
    await (await getDb()).collection<Seller & { privacyDeleting?: boolean }>("sellers").updateOne({ _id: seller._id }, { $set: { privacyDeleting: true } });
    await expect(execute("listHistory", {}, context)).rejects.toMatchObject({ code: "PRIVACY_DELETING" });
    await expect(execute("stageHistory", { ...command(), schemaVersion: 1, evidenceMode: "synthetic_demo", rows: [historyRow("2026-01-01")] }, context)).rejects.toMatchObject({ code: "PRIVACY_DELETING" });
  });
});
