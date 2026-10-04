import { randomUUID } from "node:crypto";
import { AppError } from "../lib/contracts/common";
import { DEFAULT_SETTINGS, sellerSchema, type Seller } from "../lib/contracts/records";
import { getDb } from "../lib/server/db/client";
import { checkIndexes } from "../lib/server/db/indexes";
import { run } from "./run";

void run(async () => {
  const [flag, userId, confirmation, ...extra] = process.argv.slice(2);
  if (flag !== "--user-id" || !userId || userId.length > 256 || confirmation !== "--confirm" || extra.length) {
    throw new AppError("USAGE", "Use: pnpm owner:provision --user-id <verified-session-user-id> --confirm", 422);
  }
  const db = await getDb();
  if (!await checkIndexes(db)) throw new AppError("INDEXES_REQUIRED", "Run pnpm db:init first.", 503);
  const existing = await db.collection<Seller>("sellers").findOne({ ownerUserId: userId });
  if (existing) { console.log(`Owner already provisioned. Seller: ${existing._id}`); return; }
  const seller = sellerSchema.parse({ _id: randomUUID(), ownerUserId: userId, settings: DEFAULT_SETTINGS, stateRevision: 0, status: "active", schemaVersion: 1, createdAt: new Date().toISOString() });
  await db.collection<Seller>("sellers").insertOne(seller);
  console.log(`Owner provisioned. Seller: ${seller._id}. Confirm the provisional lunch settings before real orders.`);
});
