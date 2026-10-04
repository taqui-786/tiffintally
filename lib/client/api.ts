import { backendOutputSchemas as outputSchemas, type BackendOperationName as OperationName, type BackendOutput as OperationOutput } from "@/lib/contracts/backend";
import { resultSchema } from "@/lib/contracts/common";
import { endpointFor, type ReadOperation } from "@/lib/client/endpoints";

export class ClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

export function unwrapResult<K extends OperationName>(operation: K, raw: unknown, status?: number): OperationOutput<K> {
  const parsed = resultSchema(outputSchemas[operation]).safeParse(raw);
  if (!parsed.success) throw new ClientError("INVALID_RESPONSE", "The server returned an invalid response.", false, status);
  if (!parsed.data.ok) {
    const { error, meta } = parsed.data;
    throw new ClientError(error.code, error.message, error.retryable, status, meta.requestId);
  }
  // The schema indexed by K validates the data associated with that same operation.
  return parsed.data.data as OperationOutput<K>;
}

export function operationUrl(operation: ReadOperation, input: Record<string, unknown>): string {
  const endpoint = endpointFor(operation);
  const query = new URLSearchParams();
  const pathKeys = new Set<string>();
  const path = endpoint.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    pathKeys.add(key);
    if (typeof input[key] !== "string") throw new ClientError("INVALID_INPUT", "Missing path parameter.");
    return encodeURIComponent(input[key]);
  });
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (!pathKeys.has(key) && value !== undefined) query.set(key, String(value));
  }
  return path + (query.size ? `?${query}` : "");
}

export async function getOperation<K extends Exclude<ReadOperation, "exportSheet" | "privacyExport">>(operation: K, input: Record<string, unknown>, signal?: AbortSignal): Promise<OperationOutput<K>> {
  const response = await fetch(operationUrl(operation, input), { method: "GET", credentials: "same-origin", cache: "no-store", signal, headers: { Accept: "application/json" } });
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new ClientError("INVALID_RESPONSE", "The server returned an invalid response.", false, response.status); }
  const data = unwrapResult(operation, body, response.status);
  if (!response.ok) throw new ClientError("INVALID_RESPONSE", "The server returned an invalid response.", false, response.status);
  return data;
}

export function retryRead(failureCount: number, error: Error): boolean {
  if (failureCount >= 1 || error.name === "AbortError") return false;
  if (error instanceof ClientError) {
    if (error.status !== undefined && [400, 401, 403, 404, 409, 413, 415, 422].includes(error.status)) return false;
    return error.retryable;
  }
  return error instanceof TypeError; // fetch network errors only
}
