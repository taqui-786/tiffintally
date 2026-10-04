import "server-only";
import * as Sentry from "@sentry/nextjs";
import { AppError } from "@/lib/contracts/common";

type TransactionEvent = Parameters<NonNullable<Sentry.NodeOptions["beforeSendTransaction"]>>[0];

const stages = new Set(["backend.operation", "backend.request", "analysis", "gemma", "jev", "extraction", "classification", "validation", "persistence", "forecast", "ai.extract", "ai.classify", "ai.validate", "ai.persist", "forecast.inference", "db.approval", "db.finalization"]);
const statuses = new Set(["ok", "error", "running", "succeeded", "failed", "unknown", "obsolete", "needs_review", "unavailable"]);
const codes = new Set(["INTERNAL_ERROR", "COMMIT_UNCERTAIN", "AI_NOT_CONFIGURED", "AI_BUDGET_EXCEEDED", "AI_BUSY", "PROVIDER_CREDIT_REQUIRED", "PROVIDER_CONTRACT_ERROR", "PROVIDER_TIMEOUT", "PROVIDER_OUTCOME_UNKNOWN", "INVALID_MODEL_OUTPUT", "STALE_ANALYSIS", "FORECAST_UNAVAILABLE", "PRIVACY_LIMIT_EXCEEDED", "REMOTE_DELETE_UNCONFIRMED"]);
const numericAttributes = new Set(["duration_ms", "input_tokens", "output_tokens", "total_tokens", "training_rows", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"]);
const traceId = /^[a-f0-9]{32}$/;
const spanId = /^[a-f0-9]{16}$/;
const requestId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function safeStage(value: unknown): string {
  return typeof value === "string" && stages.has(value) ? value : "backend.operation";
}

/** Values as well as keys are allowlisted: an arbitrary string under `stage` is still private data. */
export function safeSpanAttributes(input: Record<string, unknown>): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  const models = new Set(["tabpfn", process.env.GEMMA_MODEL, process.env.JEV_MODEL].filter((model): model is string => !!model && /^[A-Za-z0-9_.:/-]{1,96}$/.test(model)));
  for (const [key, value] of Object.entries(input)) {
    if (numericAttributes.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) output[key] = value;
    if (key === "stage" && typeof value === "string" && stages.has(value)) output[key] = value;
    if (key === "status" && typeof value === "string" && statuses.has(value)) output[key] = value;
    if (key === "error_code" && typeof value === "string" && codes.has(value)) output[key] = value;
    if (["model", "gen_ai.request.model", "gen_ai.response.model"].includes(key) && typeof value === "string" && models.has(value)) output[key] = value;
    if (key === "gen_ai.operation.name" && typeof value === "string" && ["generate_content", "chat", "classify"].includes(value)) output[key] = value;
    if (key === "gen_ai.provider.name" && value === "backboard") output[key] = value;
  }
  return output;
}

function safeTags(input: Sentry.Event["tags"]): Record<string, string> {
  const output: Record<string, string> = {};
  if (typeof input?.error_code === "string" && codes.has(input.error_code)) output.error_code = input.error_code;
  if (typeof input?.request_id === "string" && requestId.test(input.request_id)) output.request_id = input.request_id;
  return output;
}

function safeTrace(trace: Record<string, unknown> | undefined) {
  if (!trace || typeof trace.trace_id !== "string" || !traceId.test(trace.trace_id) || typeof trace.span_id !== "string" || !spanId.test(trace.span_id)) return undefined;
  return {
    trace_id: trace.trace_id, span_id: trace.span_id,
    ...(typeof trace.parent_span_id === "string" && spanId.test(trace.parent_span_id) ? { parent_span_id: trace.parent_span_id } : {}),
    op: "backend.operation",
  };
}

/** Rebuild events instead of recursively blacklisting known sensitive fields. */
export function sanitizeSentryError(event: Sentry.ErrorEvent, hint?: Sentry.EventHint): Sentry.ErrorEvent {
  if (hint) hint.attachments = [];
  const trace = safeTrace(event.contexts?.trace);
  return {
    type: undefined,
    ...(event.event_id && traceId.test(event.event_id) ? { event_id: event.event_id } : {}),
    ...(typeof event.timestamp === "number" && Number.isFinite(event.timestamp) ? { timestamp: event.timestamp } : {}),
    level: "error", platform: "node", tags: safeTags(event.tags),
    exception: { values: [{ type: "BackendOperationError", value: "backend operation failed" }] },
    ...(trace ? { contexts: { trace } } : {}),
  };
}

export function sanitizeSentryTransaction(event: TransactionEvent, hint?: Sentry.EventHint): TransactionEvent {
  if (hint) hint.attachments = [];
  const trace = safeTrace(event.contexts?.trace);
  return {
    type: "transaction", transaction: safeStage(event.transaction), platform: "node",
    ...(event.event_id && traceId.test(event.event_id) ? { event_id: event.event_id } : {}),
    ...(typeof event.timestamp === "number" && Number.isFinite(event.timestamp) ? { timestamp: event.timestamp } : {}),
    ...(typeof event.start_timestamp === "number" && Number.isFinite(event.start_timestamp) ? { start_timestamp: event.start_timestamp } : {}),
    ...(trace ? { contexts: { trace } } : {}),
    spans: (event.spans ?? []).slice(0, 100).filter((span) => traceId.test(span.trace_id) && spanId.test(span.span_id)).map((span) => ({
      trace_id: span.trace_id, span_id: span.span_id,
      ...(span.parent_span_id && spanId.test(span.parent_span_id) ? { parent_span_id: span.parent_span_id } : {}),
      start_timestamp: Number.isFinite(span.start_timestamp) ? span.start_timestamp : 0,
      ...(typeof span.timestamp === "number" && Number.isFinite(span.timestamp) ? { timestamp: span.timestamp } : {}),
      status: statuses.has(span.status) ? span.status : "unknown",
      description: safeStage(span.description), op: "backend.operation", data: safeSpanAttributes(span.data),
    })),
  };
}

export function telemetryOptions(): Parameters<typeof Sentry.init>[0] {
  return {
    dsn: process.env.SENTRY_DSN, enabled: !!process.env.SENTRY_DSN,
    defaultIntegrations: false, integrations: [],
    // SDK 11 streams spans by default; static mode makes beforeSendTransaction a real final boundary.
    traceLifecycle: "static", tracesSampleRate: 0.1, tracePropagationTargets: [],
    includeLocalVariables: false, maxBreadcrumbs: 0,
    dataCollection: {
      userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
      graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
      databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0,
    },
    beforeBreadcrumb: () => null,
    beforeSend: sanitizeSentryError, beforeSendTransaction: sanitizeSentryTransaction,
    beforeSendLog: () => null, beforeSendMetric: () => null,
  };
}

export function initializeTelemetry(): void {
  if (!process.env.SENTRY_DSN) return;
  try { Sentry.init(telemetryOptions()); } catch { /* Telemetry cannot disable the backend. */ }
}

export async function withStageSpan<T>(name: string, attrs: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T> {
  if (!process.env.SENTRY_DSN) return fn();
  // A failing SDK must never repeat a database write or a paid inference callback.
  let task: Promise<T> | undefined;
  const run = () => task ??= Promise.resolve().then(fn);
  try {
    return await Sentry.startSpan({ name: safeStage(name), op: "backend.operation", attributes: safeSpanAttributes(attrs) }, async (span) => {
      const result = await run();
      if (result && typeof result === "object") {
        const output = result as Record<string, unknown>;
        const metadata = output.metadata && typeof output.metadata === "object" ? output.metadata as Record<string, unknown> : {};
        const usage = metadata.usage && typeof metadata.usage === "object" ? metadata.usage as Record<string, unknown> : {};
        for (const [key, value] of Object.entries(safeSpanAttributes({ "gen_ai.usage.input_tokens": usage.inputTokens, "gen_ai.usage.output_tokens": usage.outputTokens, duration_ms: output.durationMs }))) span.setAttribute(key, value);
      }
      return result;
    });
  } catch {
    return run();
  }
}

const captured = new WeakSet<object>();
export function captureSafeBackendError(error: unknown, correlationId: string): void {
  if (!process.env.SENTRY_DSN || (error instanceof AppError && error.status < 500)) return;
  try {
    if (error !== null && typeof error === "object") {
      if (captured.has(error)) return;
      captured.add(error);
    }
    const code = error instanceof AppError && codes.has(error.code) ? error.code : "INTERNAL_ERROR";
    Sentry.withScope((scope) => {
      scope.setUser(null);
      scope.clearBreadcrumbs();
      scope.clearAttachments();
      scope.setTag("error_code", code);
      if (requestId.test(correlationId)) scope.setTag("request_id", correlationId);
      Sentry.captureException(new Error("backend operation failed"));
    });
  } catch { /* Do not expose an SDK error or change the core response. */ }
}
