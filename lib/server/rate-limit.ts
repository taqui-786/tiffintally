import "server-only";

import { RateLimiterMongo, RateLimiterRes } from "rate-limiter-flexible";
import type { Db } from "mongodb";
import { AppError } from "@/lib/contracts/common";
import { getClient } from "@/lib/server/db/client";
import { getDatabaseConfig } from "@/lib/server/env";

export class RateLimitError extends AppError {
  constructor(readonly retryAfter: number) {
    super("RATE_LIMITED", "Too many requests.", 429, true);
  }
}

let limiters: Promise<{ read: RateLimiterMongo; write: RateLimiterMongo }> | undefined;

async function getLimiters() {
  limiters ??= (async () => {
    const { dbName } = getDatabaseConfig();
    const storeClient = await getClient();
    if (!await checkRateLimitIndexes(storeClient.db(dbName))) throw new Error("Rate limit indexes are not initialized");
    const options = { storeClient, dbName, tableName: "rateLimits", duration: 60, disableIndexesCreation: true };
    return {
      read: new RateLimiterMongo({ ...options, keyPrefix: "read", points: 120 }),
      write: new RateLimiterMongo({ ...options, keyPrefix: "write", points: 30 }),
    };
  })().catch((error: unknown) => {
    limiters = undefined;
    throw error;
  });
  return limiters;
}

/** Called by explicit database initialization, never by a request. */
export async function initializeRateLimitIndexes(): Promise<void> {
  const { dbName } = getDatabaseConfig();
  const limiter = new RateLimiterMongo({ storeClient: await getClient(), dbName, tableName: "rateLimits", duration: 60, points: 120, disableIndexesCreation: true });
  await limiter.createIndexes();
}

export async function checkRateLimitIndexes(db: Db): Promise<boolean> {
  if (!await db.listCollections({ name: "rateLimits" }, { nameOnly: true }).hasNext()) return false;
  const indexes = await db.collection("rateLimits").listIndexes().toArray();
  return indexes.some((index) => index.unique === true && Object.keys(index.key).length === 1 && index.key.key === 1)
    && indexes.some((index) => index.expireAfterSeconds === 0 && Object.keys(index.key).length === 1 && index.key.expire === -1);
}

export async function enforceRateLimit(ownerId: string, write: boolean): Promise<void> {
  try {
    const limiter = (await getLimiters())[write ? "write" : "read"];
    await limiter.consume(ownerId);
  } catch (error) {
    if (error instanceof RateLimiterRes) {
      throw new RateLimitError(Math.max(1, Math.ceil(error.msBeforeNext / 1000)));
    }
    // No in-memory insurance limiter: a shared-store outage must fail closed.
    throw new AppError("RATE_LIMIT_UNAVAILABLE", "Request limiting is unavailable.", 503, true);
  }
}
