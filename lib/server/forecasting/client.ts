import "server-only";
import { z } from "zod";
import { AppError } from "@/lib/contracts/common";
import { FEATURE_NAMES, featureRowSchema, hashSchema } from "@/lib/contracts/history";
import { withStageSpan } from "@/lib/server/telemetry";

export const predictionRequestSchema = z.strictObject({ schemaVersion: z.literal(1), runId: z.string().min(1).max(128), dataHash: hashSchema, featureSchemaVersion: z.literal(1), model: z.literal("tabpfn"), featureNames: z.array(z.string()).length(14).refine((names) => names.join() === FEATURE_NAMES.join(), "Feature order mismatch"), trainRows: z.array(featureRowSchema).min(2).max(2000), targets: z.array(z.number().finite().min(-100000).max(100000)).min(2).max(2000), queryRow: featureRowSchema }).refine((input) => input.trainRows.length === input.targets.length, "Target count mismatch");
export const predictionResponseSchema = z.strictObject({ schemaVersion: z.literal(1), runId: z.string().min(1).max(128), dataHash: hashSchema, featureSchemaVersion: z.literal(1), modelVersion: z.string().min(1).max(256), predictedDelta: z.number().finite().min(-100000).max(100000), trainingRows: z.int().min(1).max(2000), durationMs: z.number().finite().min(0).max(86400000) });
export type PredictionRequest = z.infer<typeof predictionRequestSchema>;
export type PredictionResponse = z.infer<typeof predictionResponseSchema>;
export function validatePredictionResponse(raw: unknown, request: PredictionRequest): PredictionResponse {
  const parsed = predictionResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.runId !== request.runId || parsed.data.dataHash !== request.dataHash || parsed.data.trainingRows !== request.trainRows.length || request.queryRow[3] !== null && parsed.data.predictedDelta + request.queryRow[3] < 0) throw new AppError("INVALID_MODEL_OUTPUT", "Forecast service returned an invalid result.", 502);
  return parsed.data;
}
export function forecastServiceConfig(env: Record<string, string | undefined> = process.env): { url: string; token: string } | null {
  if (!env.TABPFN_SERVICE_URL || !env.TABPFN_SERVICE_TOKEN) return null;
  let url: URL;
  try { url = new URL(env.TABPFN_SERVICE_URL); } catch { return null; }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const tokenBytes = Buffer.byteLength(env.TABPFN_SERVICE_TOKEN, "utf8");
  if ((!loopback && url.protocol !== "https:") || (loopback && !["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash || !["/", ""].includes(url.pathname) || tokenBytes < 32 || tokenBytes > 4096 || /[\r\n]/.test(env.TABPFN_SERVICE_TOKEN)) return null;
  return { url: `${url.origin}/v1/predict`, token: env.TABPFN_SERVICE_TOKEN };
}
/** Single dispatch: a timeout cannot establish whether Python completed its computation. */
async function dispatchPrediction(raw: PredictionRequest): Promise<PredictionResponse> {
  const request = predictionRequestSchema.parse(raw);
  const config = forecastServiceConfig();
  if (!config) throw new AppError("FORECAST_UNAVAILABLE", "Forecast runtime is not configured.", 503);
  let response: Response;
  try { response = await fetch(config.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` }, body: JSON.stringify(request), signal: AbortSignal.timeout(30000), cache: "no-store" }); }
  catch { throw new AppError("PROVIDER_OUTCOME_UNKNOWN", "Forecast dispatch outcome is unknown; read the saved run before requesting a new attempt.", 504); }
  if (!response.ok) throw new AppError(response.status >= 500 ? "PROVIDER_OUTCOME_UNKNOWN" : "FORECAST_UNAVAILABLE", "Forecast service did not return a prediction.", response.status >= 500 ? 502 : 503);
  // Never retain/log a raw provider body. Bound response consumption before parsing.
  const reader = response.body?.getReader();
  if (!reader) throw new AppError("INVALID_MODEL_OUTPUT", "Forecast response is missing.", 502);
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 16384) { await reader.cancel(); throw new Error("oversize"); } chunks.push(next.value); }
    const body = Buffer.concat(chunks).toString("utf8");
    return validatePredictionResponse(JSON.parse(body), request);
  } catch (error) { if (error instanceof AppError) throw error; if (error instanceof Error && ["AbortError", "TimeoutError", "TypeError"].includes(error.name)) throw new AppError("PROVIDER_OUTCOME_UNKNOWN", "Forecast response transport outcome is unknown.", 504); throw new AppError("INVALID_MODEL_OUTPUT", "Forecast service returned an invalid result.", 502); }
}

export async function predictTabPfn(raw: PredictionRequest): Promise<PredictionResponse> {
  return withStageSpan("forecast.inference", { stage: "forecast.inference", model: "tabpfn", training_rows: raw.trainRows.length }, () => dispatchPrediction(raw));
}
