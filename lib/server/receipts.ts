import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { MongoError, MongoServerError, type ClientSession, type Db } from "mongodb";
import { AppError, type SellerContext } from "@/lib/contracts/common";
import { receiptSchema, sellerSchema, type Receipt, type Seller } from "@/lib/contracts/records";
import type { CommandOutput, OperationName } from "@/lib/contracts/api";
import { getClient, getDb } from "./db/client";

/** Only validated JSON enters fingerprints; object insertion order is immaterial. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function found<T>(record: T | null): T {
  if (record === null) throw new AppError("NOT_FOUND", "Resource not found.", 404);
  return record;
}

export function assertRevision(actual: number | null, expected: number | null): void {
  if (actual !== expected) throw new AppError("STALE_REVISION", "Refresh the resource and review the change again.", 409);
}

export async function ownerSeller(db: Db, context: SellerContext, session?: ClientSession): Promise<Seller> {
  const seller = await db.collection<Seller>("sellers").findOne({ _id: context.sellerId, ownerUserId: context.userId, status: "active" }, { session });
  if (!seller) throw new AppError("FORBIDDEN", "An active owner binding is required.", 403);
  if (seller.privacyDeleting) throw new AppError("PRIVACY_DELETING", "Seller erasure is in progress.", 409);
  return sellerSchema.parse(seller);
}

export interface ReadScope { db: Db; session: ClientSession; seller: Seller; context: SellerContext; now: string }
export interface MutationScope extends ReadScope { receiptId: string; id: (label: string) => string }
export interface Change {
  before: Receipt["before"];
  after: Receipt["after"];
  resourceIds: string[];
  affectedDates?: string[];
  warnings?: string[];
}

const transactionOptions = { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 5_000, timeoutMS: 15_000 } as const;

export async function readSnapshot<T>(context: SellerContext, read: (scope: ReadScope) => Promise<T>): Promise<T> {
  const db = await getDb();
  const client = await getClient();
  const now = new Date().toISOString();
  return client.withSession((session) => session.withTransaction(async () => {
    const seller = await ownerSeller(db, context, session);
    return read({ db, session, seller, context, now });
  }, transactionOptions));
}

function commandOutput(receipt: Receipt): CommandOutput {
  return { receipt, stateRevision: receipt.stateRevision, resourceIds: receipt.resourceIds, affectedDates: receipt.affectedDates, warnings: receipt.warnings };
}

export async function runCommand(
  name: OperationName | import("@/lib/contracts/commerce").CommerceOperationName,
  input: { expectedStateRevision: number; meta: { idempotencyKey: string } },
  context: SellerContext,
  mutate: (scope: MutationScope) => Promise<Change>,
): Promise<CommandOutput> {
  const db = await getDb();
  const client = await getClient();
  const hash = payloadHash({ operation: name, input });
  const key = input.meta.idempotencyKey;
  const receiptId = randomUUID();
  const now = new Date().toISOString();
  const replay = (receipt: Receipt): CommandOutput => {
    if (receipt.operation !== name || receipt.payloadHash !== hash) throw new AppError("IDEMPOTENCY_CONFLICT", "This operation key already belongs to a different command.", 409);
    return commandOutput(receiptSchema.parse(receipt));
  };
  await ownerSeller(db, context);
  const committed = await db.collection<Receipt>("receipts").findOne({ sellerId: context.sellerId, idempotencyKey: key });
  if (committed) return replay(committed);
  try {
    return await client.withSession((session) => session.withTransaction(async () => {
      const seller = await ownerSeller(db, context, session);
      const previous = await db.collection<Receipt>("receipts").findOne({ sellerId: context.sellerId, idempotencyKey: key }, { session });
      if (previous) return replay(previous);
      for (const field of ["aiRuns", "privacyOperations"]) {
        if (await db.collection(field).findOne({ sellerId: seller._id, requestKey: key }, { session })) throw new AppError("IDEMPOTENCY_CONFLICT", "This key belongs to another backend operation.", 409);
      }
      assertRevision(seller.stateRevision, input.expectedStateRevision);
      if (seller.stateRevision >= Number.MAX_SAFE_INTEGER - 2) throw new AppError("INVALID_STATE", "Seller revision limit reached.", 409);
      // ponytail: one per-seller serialization point fits <=100 customers; partition only after measured contention.
      const lock = await db.collection<Seller>("sellers").updateOne({ _id: seller._id, ownerUserId: context.userId, status: "active", privacyDeleting: { $ne: true }, stateRevision: input.expectedStateRevision }, { $inc: { stateRevision: 1 } }, { session });
      if (lock.modifiedCount !== 1) throw new AppError("STALE_REVISION", "Seller state changed; refresh before retrying.", 409);
      // IDs are deterministic within this command, even when the driver retries its callback.
      const id = (label: string) => {
        const bytes = createHash("sha256").update(`${receiptId}:${label}`).digest();
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = bytes.subarray(0, 16).toString("hex");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      };
      const change = await mutate({ db, session, seller, context, now, receiptId, id });
      const receipt = receiptSchema.parse({
        _id: receiptId, sellerId: seller._id, schemaVersion: 1, createdAt: now, operation: name,
        idempotencyKey: key, payloadHash: hash, actorUserId: context.userId, committedAt: now,
        priorStateRevision: seller.stateRevision, stateRevision: seller.stateRevision + 1,
        resourceIds: [...new Set(change.resourceIds)], affectedDates: [...new Set(change.affectedDates ?? [])].sort(),
        warnings: change.warnings ?? [], before: change.before, after: change.after,
      });
      await db.collection<Receipt>("receipts").insertOne(receipt, { session });
      return commandOutput(receipt);
    }, transactionOptions));
  } catch (error) {
    if (error instanceof MongoError && error.hasErrorLabel("UnknownTransactionCommitResult")) {
      throw new AppError("COMMIT_UNCERTAIN", `Commit could not be confirmed. Look up receipt ${key} before retrying this exact command.`, 503, false);
    }
    if (error instanceof MongoServerError && error.code === 11000) {
      const receipt = await db.collection<Receipt>("receipts").findOne({ sellerId: context.sellerId, idempotencyKey: key });
      if (receipt) return replay(receipt);
      throw new AppError("INVALID_STATE", "A unique record already exists for this command.", 409);
    }
    throw error;
  }
}
