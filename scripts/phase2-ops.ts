import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { AppError, idempotencyKeySchema, idSchema, timestampSchema } from "../lib/contracts/common";
import { getDb } from "../lib/server/db/client";
import { getDatabaseConfig } from "../lib/server/env";
import { dryRunRetention, reconcilePrivacyOperation } from "../lib/server/privacy";
import { executeBackendOperation } from "../lib/server/phase2";
import { evaluateHistory } from "../lib/server/forecasting";
import { ownerSeller } from "../lib/server/receipts";
import { run } from "./run";

void run(async () => {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    database: { type: "string" }, "seller-id": { type: "string" }, "user-id": { type: "string" }, key: { type: "string" }, "operation-id": { type: "string" }, "snapshot-id": { type: "string" }, before: { type: "string" },
    "dry-run": { type: "boolean" }, confirm: { type: "boolean" }, "allow-provider-spend": { type: "boolean" }, "acknowledge-remote-uncertainty": { type: "boolean" }, "state-revision": { type: "string" }, "history-version": { type: "string" },
  } });
  const [mode] = positionals;
  if (positionals.length !== 1 || !["status", "privacy", "retention", "evaluate"].includes(mode)) throw new AppError("USAGE", "Modes: status --key, privacy --operation-id --confirm --acknowledge-remote-uncertainty, retention --before --dry-run, evaluate --snapshot-id --state-revision --history-version --confirm --allow-provider-spend. Every mode requires --database, --seller-id and --user-id.", 422);
  if (!values.database || values.database !== getDatabaseConfig().dbName) throw new AppError("DATABASE_CONFIRMATION_REQUIRED", "The explicit --database must exactly match the configured database.", 422);
  const context = { sellerId: idSchema.parse(values["seller-id"]), userId: idSchema.parse(values["user-id"]), requestId: randomUUID() };
  const db = await getDb();
  if (mode === "status") {
    const result = await executeBackendOperation("getReceipt", { idempotencyKey: values.key }, context);
    const safe = Object.fromEntries(Object.entries(result).filter(([key]) => ["_id", "runId", "operationId", "operation", "state", "runState", "stage", "stateRevision", "historyVersion", "unknownSpend", "completedAt", "counts", "gaps", "failureCode"].includes(key)));
    console.log(JSON.stringify(safe)); return;
  }
  if (mode === "privacy") {
    if (!values.confirm || !values["acknowledge-remote-uncertainty"]) throw new AppError("CONFIRMATION_REQUIRED", "Reconciliation can dispatch deletion again; confirm and explicitly acknowledge remote uncertainty.", 422);
    console.log(JSON.stringify(await reconcilePrivacyOperation(db, idSchema.parse(values["operation-id"]), context))); return;
  }
  await ownerSeller(db, context);
  if (mode === "retention") {
    if (!values["dry-run"]) throw new AppError("RETENTION_POLICY_REQUIRED", "Retention is dry-run only until an agreed policy is recorded. Use confirmed owner erasure endpoints for actual deletion.", 422);
    console.log(JSON.stringify(await dryRunRetention(db, timestampSchema.parse(values.before), 100, context.sellerId))); return;
  }
  if (!values.confirm || !values["allow-provider-spend"]) throw new AppError("CONFIRMATION_REQUIRED", "Evaluation performs up to 20 TabPFN calls and writes an evaluation receipt; explicit confirmation required.", 422);
  const revision = (raw: string | undefined) => { if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new AppError("VALIDATION_FAILED", "Explicit integer revisions required.", 422); return Number(raw); };
  const result = await evaluateHistory({ meta: { idempotencyKey: idempotencyKeySchema.parse(values.key) }, snapshotId: idSchema.parse(values["snapshot-id"]), expectedStateRevision: revision(values["state-revision"]), expectedHistoryVersion: revision(values["history-version"]) }, context);
  console.log(JSON.stringify(result));
});
