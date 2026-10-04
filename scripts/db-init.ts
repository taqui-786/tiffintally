import { getClient, getDb } from "../lib/server/db/client";
import { initializeIndexes, checkIndexes } from "../lib/server/db/indexes";
import { initializeRateLimitIndexes, checkRateLimitIndexes } from "../lib/server/rate-limit";
import { AppError } from "../lib/contracts/common";
import { run } from "./run";
import { initializePhase2Indexes, checkPhase2Indexes } from "../lib/server/phase2";

void run(async () => {
  const db = await getDb();
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") throw new AppError("REPLICA_SET_REQUIRED", "Transactions require a replica set or Atlas cluster.", 503);
  await initializeIndexes(db);
  await initializeRateLimitIndexes();
  await initializePhase2Indexes();
  await (await getClient()).withSession((session) => session.withTransaction(async () => {
    await db.collection("sellers").findOne({}, { session });
  }, { readConcern: { level: "snapshot" }, timeoutMS: 15_000 }));
  if (!await checkIndexes(db) || !await checkRateLimitIndexes(db) || !await checkPhase2Indexes()) throw new Error("Index verification failed");
  console.log("Database indexes and snapshot transaction verified. No business records were changed.");
});
