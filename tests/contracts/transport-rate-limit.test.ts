import { beforeEach, expect, it, vi } from "vitest";
import { RateLimiterRes } from "rate-limiter-flexible";

const mocks = vi.hoisted(() => ({ consume: vi.fn(), construct: vi.fn(), indexes: vi.fn(), getClient: vi.fn(), listCollections: vi.fn(), listIndexes: vi.fn(), db: vi.fn() }));
vi.mock("rate-limiter-flexible", async (original) => {
  const actual = await original<typeof import("rate-limiter-flexible")>();
  return { ...actual, RateLimiterMongo: class {
    constructor(options: unknown) { mocks.construct(options); }
    consume = mocks.consume;
    createIndexes = mocks.indexes;
  } };
});
vi.mock("@/lib/server/db/client", () => ({ getClient: mocks.getClient }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("MONGODB_URI", "mongodb://localhost:27017");
  vi.stubEnv("MONGODB_DB", "test_transport");
  mocks.getClient.mockResolvedValue({ db: mocks.db });
  mocks.db.mockReturnValue({ listCollections: mocks.listCollections, collection: () => ({ listIndexes: mocks.listIndexes }) });
  mocks.listCollections.mockReturnValue({ hasNext: async () => true });
  mocks.listIndexes.mockReturnValue({ toArray: async () => [{ key: { key: 1 }, unique: true }, { key: { expire: -1 }, expireAfterSeconds: 0 }] });
  mocks.consume.mockResolvedValue(new RateLimiterRes(119, 60_000, 1, true));
});

it("constructs shared Mongo-backed read/write limits and never creates indexes on requests", async () => {
  const { enforceRateLimit } = await import("@/lib/server/rate-limit");
  await enforceRateLimit("owner-a", false);
  await enforceRateLimit("owner-a", true);
  expect(mocks.construct).toHaveBeenCalledWith(expect.objectContaining({ dbName: "test_transport", tableName: "rateLimits", points: 120, duration: 60, keyPrefix: "read", disableIndexesCreation: true, storeClient: { db: mocks.db } }));
  expect(mocks.construct).toHaveBeenCalledWith(expect.objectContaining({ points: 30, keyPrefix: "write" }));
  expect(mocks.consume).toHaveBeenCalledWith("owner-a");
  expect(mocks.indexes).not.toHaveBeenCalled();
});

it("returns a bounded Retry-After for exhausted limits", async () => {
  const { enforceRateLimit } = await import("@/lib/server/rate-limit");
  mocks.consume.mockRejectedValue(new RateLimiterRes(0, 1_501, 121, false));
  await expect(enforceRateLimit("owner-a", false)).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED", retryAfter: 2 });
});

it("fails closed for unavailable storage and missing required indexes", async () => {
  const { enforceRateLimit } = await import("@/lib/server/rate-limit");
  mocks.getClient.mockRejectedValueOnce(new Error("synthetic connection details"));
  await expect(enforceRateLimit("owner-a", false)).rejects.toMatchObject({ status: 503, code: "RATE_LIMIT_UNAVAILABLE" });
  mocks.listCollections.mockReturnValue({ hasNext: async () => false });
  await expect(enforceRateLimit("owner-a", false)).rejects.toMatchObject({ status: 503 });
  expect(mocks.consume).not.toHaveBeenCalled();
});

it("initializes library indexes only through the explicit maintenance operation", async () => {
  const { initializeRateLimitIndexes } = await import("@/lib/server/rate-limit");
  await initializeRateLimitIndexes();
  expect(mocks.indexes).toHaveBeenCalledOnce();
  expect(mocks.consume).not.toHaveBeenCalled();
});
