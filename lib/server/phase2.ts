import "server-only";
import { AppError, type SellerContext } from "@/lib/contracts/common";
import { backendInputSchemas, backendOutputSchemas, type BackendOperationName, type BackendOutput } from "@/lib/contracts/backend";
import { operationSchemas } from "@/lib/contracts/api";
import { intelligenceInputSchemas, intelligenceOutputSchemas, type IntelligenceOperationName } from "@/lib/contracts/intelligence";
import { historyInputSchemas, type HistoryOperationName } from "@/lib/contracts/history";
import { privacyInputSchemas, type PrivacyOperationName } from "@/lib/contracts/privacy";
import { executeOperation } from "./operations";
import { executeIntelligenceOperation } from "./ai/analyze";
import { initializeAiIndexes, checkAiIndexes } from "./ai/runs";
import { executeForecastingOperation, initializeForecastIndexes, checkForecastIndexes } from "./forecasting";
import { forecastServiceConfig } from "./forecasting/client";
import { executePrivacyOperation, initializePrivacyIndexes, checkPrivacyIndexes, getPrivacyOperationByKey } from "./privacy";
import { getDb } from "./db/client";
import { withStageSpan } from "./telemetry";
import { aiCapabilityFlags } from "./ai/config";
import { commerceInputSchemas, type CommerceOperationName } from "@/lib/contracts/commerce";
import { executeCommerceOperation } from "./commerce";
import { getDispatch } from "./dispatch";
import { readSnapshot } from "./receipts";

export async function initializePhase2Indexes() {
  const db = await getDb();
  await initializeAiIndexes(db); await initializeForecastIndexes(db); await initializePrivacyIndexes(db);
}
export async function checkPhase2Indexes() {
  const db = await getDb();
  return await checkAiIndexes(db) && await checkForecastIndexes(db) && await checkPrivacyIndexes(db);
}
async function lookupKey(key: string, context: SellerContext) {
  // Privacy progress is accessible even after the owner's deletion tombstone blocks other work.
  const privacy = await getPrivacyOperationByKey(key, context);
  if (privacy) return privacy;
  const db = await getDb();
  if (await db.collection("aiRuns").findOne({ sellerId: context.sellerId, requestKey: key }, { projection: { _id: 1 } })) return executeIntelligenceOperation("getAnalysisByKey", { requestKey: key }, context);
  if (await db.collection("forecastRuns").findOne({ sellerId: context.sellerId, requestKey: key }, { projection: { _id: 1 } })) return executeForecastingOperation("getForecastByKey", { requestKey: key }, context);
  return executeOperation("getReceipt", { idempotencyKey: key }, context);
}
export async function executeBackendOperation<K extends BackendOperationName>(name: K, raw: unknown, context: SellerContext): Promise<BackendOutput<K>> {
  const parsed = backendInputSchemas[name].safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid backend operation input.", 422);
  const result = await withStageSpan("backend.operation", { stage: "backend.operation" }, async () => {
    if (name === "getReceipt") return lookupKey(backendInputSchemas.getReceipt.parse(parsed.data).idempotencyKey, context);
    if (name === "me") {
      const result = await executeOperation("me", parsed.data, context);
      return { ...result, capabilities: { ...result.capabilities, ai: aiCapabilityFlags().ai.configured } };
    }
    if (Object.hasOwn(intelligenceInputSchemas, name)) {
      const output = await executeIntelligenceOperation(name as IntelligenceOperationName, parsed.data, context);
      if (name === "capabilities") return { ...intelligenceOutputSchemas.capabilities.parse(output), forecasting: { configured: !!forecastServiceConfig() } };
      return output;
    }
    if (Object.hasOwn(historyInputSchemas, name)) return executeForecastingOperation(name as HistoryOperationName, parsed.data, context);
    if (Object.hasOwn(privacyInputSchemas, name)) return executePrivacyOperation(name as PrivacyOperationName, parsed.data, context);
    if (name === "getDispatch") return readSnapshot(context, (scope) => getDispatch(commerceInputSchemas.getDispatch.parse(parsed.data), scope));
    if (Object.hasOwn(commerceInputSchemas, name)) return executeCommerceOperation(name as Exclude<CommerceOperationName, "getDispatch">, parsed.data, context);
    if (Object.hasOwn(operationSchemas, name)) return executeOperation(name as keyof typeof operationSchemas, parsed.data, context);
    throw new AppError("NOT_FOUND", "Unknown operation.", 404);
  });
  const output = backendOutputSchemas[name].safeParse(result);
  if (!output.success) throw new AppError("INTERNAL_ERROR", "Invalid backend result; reconcile the operation key before retrying.", 500);
  return output.data as BackendOutput<K>;
}
