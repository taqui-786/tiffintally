import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), execute: vi.fn(), limit: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/server/context", () => ({ requireSellerContext: mocks.context }));
vi.mock("@/lib/server/operations", () => ({ executeOperation: mocks.execute }));
vi.mock("@/lib/server/rate-limit", async () => {
  const { AppError } = await import("@/lib/contracts/common");
  return { enforceRateLimit: mocks.limit, RateLimitError: class extends AppError {} };
});
vi.mock("next/headers", () => ({ headers: mocks.headers }));

import { AppError } from "@/lib/contracts/common";
import { getErrorEnvelope, MAX_BODY_BYTES, readBoundedJson, readQuery, routeHandler } from "@/lib/server/http";
import { getDatabaseConfig, validateCoreConfig } from "@/lib/server/env";

const origin = "https://example.test";
const request = (body: string, extra: Record<string, string> = {}) => new Request(`${origin}/api/v1/customers`, {
  method: "POST", headers: { origin, "content-type": "application/json", "Idempotency-Key": "logical-key-0001", ...extra }, body,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", origin);
  mocks.context.mockResolvedValue({ sellerId: "seller-a", userId: "owner-a", requestId: "req-a" });
  mocks.limit.mockResolvedValue(undefined);
});

describe("request boundary", () => {
  it("enforces byte bounds for streamed bodies even with a false Content-Length", async () => {
    const oversized = request(JSON.stringify({ text: "é".repeat(MAX_BODY_BYTES / 2) }), { "content-length": "2" });
    await expect(readBoundedJson(oversized)).rejects.toMatchObject({ status: 413 });
    await expect(readBoundedJson(request("{}", { "content-length": String(MAX_BODY_BYTES + 1) }))).rejects.toMatchObject({ status: 413 });
  });

  it("rejects malformed/non-object JSON and unsupported media types", async () => {
    for (const body of ["{", "[]", "null", "42"]) await expect(readBoundedJson(request(body))).rejects.toMatchObject({ status: 400 });
    await expect(readBoundedJson(request("{}", { "content-type": "text/plain" }))).rejects.toMatchObject({ status: 415 });
  });

  it("rejects absent/untrusted Origin before dispatch", async () => {
    for (const bad of ["", "https://evil.test", "null"]) {
      const response = await routeHandler("createCustomer")(request("{}", { origin: bad }));
      expect(response.status).toBe(403);
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects unknown inputs, Mongo operators and missing HTTP idempotency keys", async () => {
    for (const input of [
      { alias: "A", expectedStateRevision: 0, sellerId: "seller-b" },
      { alias: { $gt: "" }, expectedStateRevision: 0 },
      { alias: "A", expectedStateRevision: 0, meta: { admin: true } },
    ]) expect((await routeHandler("createCustomer")(request(JSON.stringify(input)))).status).toBe(422);
    const missingKey = request(JSON.stringify({ alias: "A", expectedStateRevision: 0, meta: { idempotencyKey: "body-only-key" } }));
    missingKey.headers.delete("Idempotency-Key");
    expect((await routeHandler("createCustomer")(missingKey)).status).toBe(422);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("treats the Idempotency-Key header as authoritative", async () => {
    mocks.execute.mockRejectedValue(new AppError("PENDING_REVIEW", "Review required.", 409));
    const response = await routeHandler("createCustomer")(request(JSON.stringify({ alias: " A ", expectedStateRevision: 0, meta: { idempotencyKey: "body-ignored-key" } })));
    expect(response.status).toBe(409);
    expect(mocks.execute).toHaveBeenCalledWith("createCustomer", { alias: "A", packingNote: "", expectedStateRevision: 0, meta: { idempotencyKey: "logical-key-0001" } }, expect.objectContaining({ sellerId: "seller-a" }));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("parses native URL query limits without allowing duplicate or numeric tricks", () => {
    expect(readQuery(`${origin}?limit=25&status=active`)).toEqual({ limit: 25, status: "active" });
    expect(() => readQuery(`${origin}?limit=1&limit=2`)).toThrow();
    for (const limit of ["0", "101", "1e2", "2.5", "", "-1"]) expect(() => readQuery(`${origin}?limit=${limit}`)).toThrow();
  });

  it("awaits dynamic path parameters and validates route ID spoofing", async () => {
    mocks.execute.mockRejectedValue(new AppError("NOT_FOUND", "Not found.", 404));
    const route = routeHandler("getCustomer");
    const response = await route(new Request(`${origin}/api/v1/customers/customer-a`), { params: Promise.resolve({ customerId: "customer-a" }) });
    expect(response.status).toBe(404);
    expect(mocks.execute).toHaveBeenCalledWith("getCustomer", { customerId: "customer-a" }, expect.any(Object));
    expect((await route(new Request(`${origin}/api/v1/customers/customer-a?customerId=customer-b`), { params: Promise.resolve({ customerId: "customer-a" }) })).status).toBe(422);
  });

  it("fails closed if persistent rate limiting is unavailable", async () => {
    mocks.limit.mockRejectedValue(new AppError("RATE_LIMIT_UNAVAILABLE", "Request limiting is unavailable.", 503, true));
    expect((await routeHandler("me")(new Request(`${origin}/api/v1/me`))).status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("handles Next's static route context with absent params", async () => {
    mocks.context.mockRejectedValue(new AppError("CONFIGURATION_UNAVAILABLE", "Service is not configured.", 503));
    const response = await routeHandler("me")(new Request(`${origin}/api/v1/me`), { params: Promise.resolve(undefined) } as unknown as import("@/lib/server/http").RouteParams);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("CONFIGURATION_UNAVAILABLE");
  });

  it("maps unsupported methods and rejects write query fields", async () => {
    expect((await routeHandler("me")(new Request(`${origin}/api/v1/me`, { method: "DELETE" }))).status).toBe(405);
    expect((await routeHandler("createCustomer")(new Request(`${origin}/api/v1/customers?admin=true`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" }))).status).toBe(400);
  });
});

describe("safe errors and lazy config", () => {
  it("redacts unexpected errors and logs only a safe diagnostic", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const mapped = getErrorEnvelope(new Error("synthetic-secret-do-not-expose"), "correlation-id");
    expect(mapped.status).toBe(500);
    expect(JSON.stringify(mapped)).not.toContain("synthetic-secret");
    expect(log).toHaveBeenCalledExactlyOnceWith("backend_request_failed", { requestId: "correlation-id", category: "unexpected" });
    log.mockRestore();
  });

  it("preserves framework redirect control flow", () => {
    const error = Object.assign(new Error("redirect"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    expect(() => getErrorEnvelope(error, "request-id")).toThrow(error);
  });

  it("empty configuration returns a generic safe 503 without naming secrets", () => {
    vi.stubEnv("MONGODB_URI", "");
    vi.stubEnv("MONGODB_DB", "");
    expect(() => getDatabaseConfig()).toThrow(AppError);
    try { validateCoreConfig(); } catch (error) {
      const mapped = getErrorEnvelope(error, "request-id");
      expect(mapped.status).toBe(503);
      expect(JSON.stringify(mapped)).not.toContain("MONGODB");
    }
  });
});
