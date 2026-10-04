import "server-only";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { MongoNetworkError, MongoServerSelectionError, MongoOperationTimeoutError } from "mongodb";
import { z } from "zod";
import { AppError, type Result } from "@/lib/contracts/common";
import { backendInputSchemas as operationSchemas, backendOutputSchemas as outputSchemas, type BackendOperationName as OperationName, type BackendOutput as OperationOutput } from "@/lib/contracts/backend";
import { MAX_HISTORY_BYTES } from "@/lib/contracts/history";
import { endpointFor, type ActionOperation } from "@/lib/client/endpoints";
import { requireSellerContext } from "@/lib/server/context";
import { getAppOrigin } from "@/lib/server/env";
import { executeBackendOperation as executeOperation } from "@/lib/server/phase2";
import { parseHistoryCsv } from "@/lib/server/forecasting";
import { captureSafeBackendError } from "@/lib/server/telemetry";
import { enforceRateLimit, RateLimitError } from "@/lib/server/rate-limit";

export const MAX_BODY_BYTES = 256 * 1024;
export const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export function assertTrustedOrigin(requestHeaders: Headers): void {
  if (requestHeaders.get("origin") !== getAppOrigin()) {
    throw new AppError("UNTRUSTED_ORIGIN", "A trusted request origin is required.", 403);
  }
}

export async function readBoundedJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Use application/json.", 415);
  }
  const body = await readBoundedBody(request, maxBytes);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError("MALFORMED_JSON", "A valid JSON object is required.", 400);
  }
}

export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new AppError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413);
  }
  if (!request.body) throw new AppError("MALFORMED_JSON", "A JSON object is required.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new AppError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

const queryLimitSchema = z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.int().min(1).max(100));

export function readQuery(url: string): Record<string, unknown> {
  const query: Record<string, unknown> = Object.create(null);
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.hasOwn(query, key)) throw new AppError("MALFORMED_QUERY", "Duplicate query fields are not allowed.", 400);
    query[key] = key === "limit" ? queryLimitSchema.parse(value) : value;
  }
  return query;
}

export function getErrorEnvelope(error: unknown, requestId: string): { status: number; result: Result<never>; retryAfter?: number } {
  unstable_rethrow(error);
  captureSafeBackendError(error, requestId);
  if (error instanceof AppError) {
    return {
      status: error.status,
      result: { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable }, meta: { requestId } },
      ...(error instanceof RateLimitError ? { retryAfter: error.retryAfter } : {}),
    };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 422,
      result: { ok: false, error: { code: "VALIDATION_FAILED", message: "Input validation failed.", retryable: false }, meta: { requestId } },
    };
  }
  const unavailable = error instanceof MongoNetworkError || error instanceof MongoServerSelectionError || error instanceof MongoOperationTimeoutError;
  // A correlation ID and fixed category suffice; never log inputs, driver details or sessions.
  console.error("backend_request_failed", { requestId, category: unavailable ? "dependency" : "unexpected" });
  return {
    status: unavailable ? 503 : 500,
    result: { ok: false, error: { code: unavailable ? "DEPENDENCY_UNAVAILABLE" : "INTERNAL_ERROR", message: unavailable ? "Service temporarily unavailable." : "An unexpected error occurred.", retryable: unavailable }, meta: { requestId } },
  };
}

export function errorResponse(error: unknown, requestId: string): Response {
  const { status, result, retryAfter } = getErrorEnvelope(error, requestId);
  return Response.json(result, { status, headers: { ...privateHeaders, ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } });
}

async function runOperation<K extends OperationName>(operation: K, rawInput: unknown, requestHeaders: Headers, requestId: string): Promise<Result<OperationOutput<K>>> {
  const context = await requireSellerContext(requestHeaders, requestId, operation === "getPrivacyOperation" || operation === "getReceipt");
  const endpoint = endpointFor(operation);
  await enforceRateLimit(context.userId, endpoint.method !== "GET");
  const input = operationSchemas[operation].parse(rawInput);
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > (operation === "stageHistory" ? MAX_HISTORY_BYTES : MAX_BODY_BYTES)) {
    throw new AppError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413);
  }
  const rawOutput = await executeOperation(operation, input, context);
  const parsed = outputSchemas[operation].safeParse(rawOutput);
  if (!parsed.success) throw new Error("Invalid operation output");
  // Operation keys index their matching runtime schema; TS cannot retain that correlation.
  const data = parsed.data as OperationOutput<K>;
  const stateRevision = typeof data === "object" && data !== null && "stateRevision" in data && typeof data.stateRevision === "number" ? data.stateRevision : undefined;
  return { ok: true, data, meta: { requestId, ...(stateRevision === undefined ? {} : { stateRevision }) } };
}

export type RouteParams = { params: Promise<Record<string, string>> };

export function routeHandler(operation: OperationName) {
  const endpoint = endpointFor(operation);
  return async (request: Request, route?: RouteParams): Promise<Response> => {
    const requestId = crypto.randomUUID();
    try {
      if (request.method !== endpoint.method) throw new AppError("METHOD_NOT_ALLOWED", "Method not allowed.", 405);
      const params = (route ? await route.params : undefined) ?? {};
      let rawInput: Record<string, unknown>;
      if (endpoint.method === "GET") {
        rawInput = readQuery(request.url);
      } else {
        assertTrustedOrigin(request.headers);
        // Query fields on commands are not silently ignored.
        if (new URL(request.url).search) throw new AppError("MALFORMED_QUERY", "This command does not accept query fields.", 400);
        if (operation === "stageHistory" && request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "text/csv") {
          const rawText = new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request, MAX_HISTORY_BYTES));
          const headers = request.headers;
          const integer = (name: string) => z.string().regex(/^\d+$/).transform(Number).parse(headers.get(name));
          rawInput = { schemaVersion: 1, format: "csv", evidenceMode: headers.get("X-Evidence-Mode"), expectedStateRevision: integer("X-Expected-State-Revision"), expectedHistoryVersion: integer("X-Expected-History-Version"), rows: parseHistoryCsv(rawText) };
        } else rawInput = await readBoundedJson(request, operation === "stageHistory" ? MAX_HISTORY_BYTES : MAX_BODY_BYTES);
        if (endpoint.mutation) {
          const meta = rawInput.meta;
          if (meta !== undefined && (!meta || typeof meta !== "object" || Array.isArray(meta))) {
            throw new AppError("VALIDATION_FAILED", "Invalid command metadata.", 422);
          }
          rawInput.meta = { ...(meta as Record<string, unknown> | undefined), idempotencyKey: request.headers.get("Idempotency-Key") };
        }
      }
      for (const [key, value] of Object.entries(params)) {
        if (Object.hasOwn(rawInput, key)) throw new AppError("VALIDATION_FAILED", "Path parameters must not be repeated in the payload.", 422);
        rawInput[key] = value;
      }
      const result = await runOperation(operation, rawInput, request.headers, requestId);
      if (operation === "exportSheet" && result.ok) {
        const csv = outputSchemas.exportSheet.parse(result.data);
        const filename = csv.filename.replace(/[^A-Za-z0-9_.-]/g, "_");
        return new Response(csv.csv, { headers: { ...privateHeaders, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` } });
      }
      if (operation === "privacyExport" && result.ok) {
        const exported = outputSchemas.privacyExport.parse(result.data);
        return new Response(exported.json, { headers: { ...privateHeaders, "Content-Type": exported.contentType, "Content-Disposition": 'attachment; filename="seller-business-data.json"' } });
      }
      return Response.json(result, { headers: privateHeaders });
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}

export async function actionResult<K extends ActionOperation>(operation: K, rawInput: unknown): Promise<Result<OperationOutput<K>>> {
  const requestId = crypto.randomUUID();
  try {
    const requestHeaders = await headers();
    assertTrustedOrigin(requestHeaders);
    if (operation === "stageHistory" && operationSchemas.stageHistory.parse(rawInput).format !== "json") throw new AppError("VALIDATION_FAILED", "CSV imports use the HTTP endpoint.", 422);
    return await runOperation(operation, rawInput, requestHeaders, requestId);
  } catch (error) {
    return getErrorEnvelope(error, requestId).result;
  }
}
