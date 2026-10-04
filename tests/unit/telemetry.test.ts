import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/contracts/common";

const sdk = vi.hoisted(() => ({ init: vi.fn(), startSpan: vi.fn(), captureException: vi.fn(), withScope: vi.fn(), scope: { setUser: vi.fn(), clearBreadcrumbs: vi.fn(), clearAttachments: vi.fn(), setTag: vi.fn() } }));
vi.mock("@sentry/nextjs", () => sdk);
import { captureSafeBackendError, initializeTelemetry, safeSpanAttributes, sanitizeSentryError, sanitizeSentryTransaction, telemetryOptions, withStageSpan } from "@/lib/server/telemetry";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SENTRY_DSN", "");
  vi.stubEnv("GEMMA_MODEL", "gemma-configured");
  sdk.withScope.mockImplementation((fn) => fn(sdk.scope));
  sdk.startSpan.mockImplementation((_, fn) => fn());
});
afterEach(() => vi.unstubAllEnvs());

describe("metadata-only monitoring", () => {
  it("rebuilds exceptions without request, user, nested errors, frames, queries or breadcrumbs", () => {
    const event = {
      type: undefined, event_id: "a".repeat(32), message: "SECRET-message", request: { url: "https://private/?q=SECRET-query", cookies: { session: "SECRET-cookie" }, headers: { authorization: "SECRET-token" }, data: { source: "SECRET-body" } },
      user: { email: "SECRET-email" }, extra: { nested: { response: "SECRET-provider" } }, breadcrumbs: [{ message: "SECRET-log" }],
      exception: { values: [{ value: "SECRET-exception", stacktrace: { frames: [{ filename: "SECRET-path", vars: { password: "SECRET-var" }, context_line: "SECRET-source" }] } }] },
      contexts: { trace: { trace_id: "b".repeat(32), span_id: "c".repeat(16), data: { db: "SECRET-db" }, description: "SECRET-desc" }, provider: { response: "SECRET-response" } },
      tags: { error_code: "INTERNAL_ERROR", request_id: "00000000-0000-4000-8000-000000000000", prompt: "SECRET-prompt", model: "SECRET-model" },
    };
    const hint = { attachments: [{ filename: "SECRET-attachment", data: "SECRET-bytes" }] };
    const clean = sanitizeSentryError(event, hint);
    expect(hint.attachments).toEqual([]);
    expect(JSON.stringify(clean)).not.toContain("SECRET");
    expect(clean.exception?.values).toEqual([{ type: "BackendOperationError", value: "backend operation failed" }]);
    expect(clean.contexts?.trace?.trace_id).toBe("b".repeat(32));
    expect(Object.keys(clean)).not.toEqual(expect.arrayContaining(["request", "user", "extra", "breadcrumbs"]));
  });

  it("removes unknown keys AND unsafe values in nested transaction span data", () => {
    const event = {
      type: "transaction", transaction: "/customers/SECRET-name?phone=SECRET-phone", start_timestamp: 1, timestamp: 2,
      request: { data: "SECRET-body" }, extra: { nested: "SECRET-extra" }, tags: { error_code: "SECRET-code" },
      contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16), data: { statement: "SECRET-sql" } } },
      spans: [{ trace_id: "a".repeat(32), span_id: "c".repeat(16), start_timestamp: 1, timestamp: 2, status: "ok", description: "SECRET-name", op: "SECRET-op", data: { stage: "SECRET-stage", model: "SECRET-model", "db.query.text": "SECRET-sql", vendor: { response: "SECRET-nested" }, input_tokens: 12, output_tokens: 0, "gen_ai.request.model": "gemma-configured" } }],
    } as unknown as Parameters<typeof sanitizeSentryTransaction>[0];
    const clean = sanitizeSentryTransaction(event);
    expect(JSON.stringify(clean)).not.toContain("SECRET");
    expect(clean.transaction).toBe("backend.operation");
    expect(clean.spans?.[0].data).toEqual({ input_tokens: 12, output_tokens: 0, "gen_ai.request.model": "gemma-configured" });
    expect(safeSpanAttributes({ input_tokens: NaN, output_tokens: Infinity, duration_ms: -1, stage: "gemma", model: "tabpfn", status: "failed" })).toEqual({ stage: "gemma", model: "tabpfn", status: "failed" });
  });

  it("uses SDK 11 static traces and collection controls, with no automatic integrations", () => {
    const options = telemetryOptions();
    expect(options.defaultIntegrations).toBe(false);
    expect(options.traceLifecycle).toBe("static");
    expect(options.tracesSampleRate).toBe(0.1);
    expect(options.tracePropagationTargets).toEqual([]);
    expect(options.dataCollection).toEqual({ userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false }, databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0 });
    expect(options.beforeSendLog?.({} as never)).toBeNull();
    expect(options.beforeSendMetric?.({} as never)).toBeNull();
    initializeTelemetry();
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("captures a synthetic error once, ignores expected 4xx and never throws on SDK failure", () => {
    vi.stubEnv("SENTRY_DSN", "https://public@example.invalid/1");
    const error = new AppError("PROVIDER_TIMEOUT", "SECRET-provider-error", 504);
    captureSafeBackendError(error, "00000000-0000-4000-8000-000000000000");
    captureSafeBackendError(error, "00000000-0000-4000-8000-000000000000");
    captureSafeBackendError(new AppError("FORBIDDEN", "SECRET", 403), "SECRET-request");
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
    expect(sdk.captureException.mock.calls[0][0].message).toBe("backend operation failed");
    expect(sdk.scope.setTag).toHaveBeenCalledWith("error_code", "PROVIDER_TIMEOUT");
    sdk.captureException.mockImplementation(() => { throw new Error("SECRET-sdk"); });
    expect(() => captureSafeBackendError(new Error("SECRET"), "SECRET")).not.toThrow();
    sdk.init.mockImplementation(() => { throw new Error("SECRET-sdk"); });
    expect(initializeTelemetry).not.toThrow();
  });

  it("never repeats core work if instrumentation fails before or after invoking it", async () => {
    vi.stubEnv("SENTRY_DSN", "https://public@example.invalid/1");
    const work = vi.fn(async () => "committed");
    sdk.startSpan.mockImplementationOnce(() => { throw new Error("SDK failure before callback"); });
    expect(await withStageSpan("gemma", {}, work)).toBe("committed");
    expect(work).toHaveBeenCalledTimes(1);
    work.mockClear();
    sdk.startSpan.mockImplementationOnce(async (_, fn) => { await fn(); throw new Error("SDK failure after callback"); });
    expect(await withStageSpan("gemma", { prompt: "SECRET" }, work)).toBe("committed");
    expect(work).toHaveBeenCalledTimes(1);
    const failed = vi.fn(async () => { throw new AppError("COMMIT_UNCERTAIN", "core failed", 503); });
    await expect(withStageSpan("gemma", {}, failed)).rejects.toMatchObject({ code: "COMMIT_UNCERTAIN" });
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("records numeric model usage without copying provider output into spans", async () => {
    vi.stubEnv("SENTRY_DSN", "https://public@example.invalid/1");
    const setAttribute = vi.fn();
    sdk.startSpan.mockImplementation((_, fn) => fn({ setAttribute }));
    await withStageSpan("gemma", {}, async () => ({ metadata: { usage: { inputTokens: 12, outputTokens: 3 }, ids: { threadId: "SECRET" } }, content: "SECRET" }));
    expect(setAttribute.mock.calls).toEqual([["gen_ai.usage.input_tokens", 12], ["gen_ai.usage.output_tokens", 3]]);
  });
});
