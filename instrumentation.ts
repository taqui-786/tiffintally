import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try { await import("./sentry.server.config"); } catch { /* Optional monitoring must not prevent startup. */ }
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error) => {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.SENTRY_DSN) return;
  try {
    const { captureSafeBackendError } = await import("./lib/server/telemetry");
    // Never pass Next's request, URL, headers or render context to the SDK.
    captureSafeBackendError(error, crypto.randomUUID());
  } catch { /* Optional monitoring. */ }
};
