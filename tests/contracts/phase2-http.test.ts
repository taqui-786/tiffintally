import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), context: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/server/phase2", () => ({ executeBackendOperation: mocks.execute }));
vi.mock("@/lib/server/context", () => ({ requireSellerContext: mocks.context }));
vi.mock("@/lib/server/rate-limit", async () => {
  const { AppError } = await import("@/lib/contracts/common");
  return { enforceRateLimit: mocks.limit, RateLimitError: class extends AppError {} };
});
import { routeHandler } from "@/lib/server/http";
import { FEATURE_NAMES } from "@/lib/contracts/history";
import { stringify } from "csv-stringify/sync";
const now = "2026-01-01T09:00:00Z";
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("APP_ORIGIN", "https://example.test");
  mocks.context.mockResolvedValue({ sellerId: "seller", userId: "owner", requestId: "r" });
  mocks.execute.mockResolvedValue({ _id: "import", sellerId: "seller", schemaVersion: 1, createdAt: now, idempotencyKey: "history-key-0001", payloadHash: "a".repeat(64), digest: "b".repeat(64), format: "csv", evidenceMode: "synthetic_demo", status: "staged", rowCount: 1, validRowCount: 1, errors: [], committedAt: null, committedBy: null, historyVersion: null });
});
afterEach(() => vi.unstubAllEnvs());
function csvRequest(headers: Record<string, string> = {}) {
  const row = { schemaVersion: 1, serviceDate: "2026-01-01", timezone: "UTC", policyHash: "a".repeat(64), asOf: now, cutoffAt: "2026-01-01T10:00:00Z", outcomeAvailableAt: "2026-01-01T10:00:00Z", confirmedMeals: 10, cutoffTotal: 12, features: JSON.stringify(FEATURE_NAMES.map(() => null)), evidenceMode: "synthetic_demo", provenance: JSON.stringify({ kind: "synthetic" }) };
  return new Request("https://example.test/api/v1/history/imports", { method: "POST", headers: { origin: "https://example.test", "content-type": "text/csv", "Idempotency-Key": "history-key-0001", "X-Evidence-Mode": "synthetic_demo", "X-Expected-State-Revision": "0", "X-Expected-History-Version": "0", ...headers }, body: stringify([row], { header: true }) });
}
it("imports bounded strict CSV with header revisions/key, without accepting a second body authority", async () => {
  const response = await routeHandler("stageHistory")(csvRequest());
  expect(response.status).toBe(200);
  expect(mocks.execute).toHaveBeenCalledWith("stageHistory", expect.objectContaining({ format: "csv", expectedHistoryVersion: 0, meta: { idempotencyKey: "history-key-0001" }, rows: [expect.objectContaining({ features: Array(14).fill(null) })] }), expect.objectContaining({ sellerId: "seller" }));
});
it("rejects missing CSV provenance headers, foreign origins and oversize bodies before dispatch", async () => {
  const invalidHeaders: Record<string, string>[] = [{ "X-Evidence-Mode": "" }, { origin: "https://foreign.test" }, { "content-length": String(2 * 1024 * 1024 + 1) }];
  for (const headers of invalidHeaders) {
    const response = await routeHandler("stageHistory")(csvRequest(headers));
    expect(response.status).toBeGreaterThanOrEqual(400);
  }
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("exports an attachment rather than a query envelope and forbids caching", async () => {
  const json = JSON.stringify({ schemaVersion: 1, sources: [] });
  mocks.execute.mockResolvedValue({ filename: "seller-business-data.json", contentType: "application/json; charset=utf-8", json, bytes: Buffer.byteLength(json) });
  const response = await routeHandler("privacyExport")(new Request("https://example.test/api/v1/privacy/export"));
  expect(await response.text()).toBe(json);
  expect(response.headers.get("content-disposition")).toContain("attachment;");
  expect(response.headers.get("cache-control")).toContain("no-store");
});
it("grants deletion-progress context only to status/key lookups", async () => {
  mocks.execute.mockResolvedValue({ operationId: "id", receiptId: "id", kind: "seller_erasure", state: "needs_reconciliation", createdAt: now, updatedAt: now, stateRevision: 1, counts: { localRecords: 1, remoteConfirmed: 0, remotePending: 0 }, gaps: ["AUTH_SESSIONS_RETAINED"] });
  await routeHandler("getPrivacyOperation")(new Request("https://example.test/api/v1/privacy/operations/id"), { params: Promise.resolve({ operationId: "id" }) });
  expect(mocks.context).toHaveBeenLastCalledWith(expect.any(Headers), expect.any(String), true);
  mocks.execute.mockResolvedValue({ ai: { configured: false, gemmaConfigured: false, jevConfigured: false, mode: "bounded_sync", requiresConsent: true }, forecasting: { configured: false }, privacyExport: true });
  const response = await routeHandler("capabilities")(new Request("https://example.test/api/v1/capabilities"));
  expect(response.status).toBe(200);
  expect(mocks.context).toHaveBeenLastCalledWith(expect.any(Headers), expect.any(String), false);
});
