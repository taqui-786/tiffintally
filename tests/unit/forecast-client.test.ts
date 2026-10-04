import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURE_NAMES } from "@/lib/contracts/history";
import { forecastServiceConfig, predictTabPfn, predictionRequestSchema, validatePredictionResponse, type PredictionRequest } from "@/lib/server/forecasting/client";
const request: PredictionRequest = { schemaVersion: 1, runId: "run", dataHash: "a".repeat(64), featureSchemaVersion: 1, model: "tabpfn", featureNames: [...FEATURE_NAMES], trainRows: [Array(14).fill(0), Array(14).fill(1)], targets: [1, 2], queryRow: Array(14).fill(null) };
const response = { schemaVersion: 1, runId: request.runId, dataHash: request.dataHash, featureSchemaVersion: 1, modelVersion: "fixture-checkpoint-v1", predictedDelta: 1.5, trainingRows: 2, durationMs: 25 };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("private Python forecasting boundary", () => {
  it("accepts only fixed features/model and finite aligned data", () => {
    expect(predictionRequestSchema.safeParse(request).success).toBe(true);
    for (const invalid of [{ ...request, model: "other" }, { ...request, featureNames: [...FEATURE_NAMES].reverse() }, { ...request, targets: [] }, { ...request, queryRow: [NaN, ...request.queryRow.slice(1)] }]) expect(predictionRequestSchema.safeParse(invalid).success).toBe(false);
  });
  it("rejects foreign run/hash/schema, invalid model version/count and nonfinite output", () => {
    expect(validatePredictionResponse(response, request)).toEqual(response);
    for (const invalid of [{ ...response, runId: "other" }, { ...response, dataHash: "b".repeat(64) }, { ...response, featureSchemaVersion: 2 }, { ...response, schemaVersion: 2 }, { ...response, modelVersion: "" }, { ...response, trainingRows: 3 }, { ...response, predictedDelta: Infinity }, { ...response, predictedDelta: 100001 }, { ...response, extra: true }]) expect(() => validatePredictionResponse(invalid, request)).toThrow();
  });
  it("allows HTTP only for loopback and never accepts URLs from a request", () => {
    const token = "synthetic-service-credential-not-real";
    expect(forecastServiceConfig({ TABPFN_SERVICE_URL: "http://127.0.0.1:8000", TABPFN_SERVICE_TOKEN: token })?.url).toBe("http://127.0.0.1:8000/v1/predict");
    expect(forecastServiceConfig({ TABPFN_SERVICE_URL: "https://private.example", TABPFN_SERVICE_TOKEN: token })?.url).toBe("https://private.example/v1/predict");
    for (const url of ["http://private.example", "https://name:password@private.example", "https://private.example?url=other", "https://private.example/path"]) expect(forecastServiceConfig({ TABPFN_SERVICE_URL: url, TABPFN_SERVICE_TOKEN: token })).toBeNull();
    expect(forecastServiceConfig({})).toBeNull();
    expect(forecastServiceConfig({ TABPFN_SERVICE_URL: "http://localhost:8000", TABPFN_SERVICE_TOKEN: "short" })).toBeNull();
  });
  it("sends aggregates only and treats a transport timeout as unknown without retry", async () => {
    vi.stubEnv("TABPFN_SERVICE_URL", "http://localhost:8000"); vi.stubEnv("TABPFN_SERVICE_TOKEN", "synthetic-service-credential-not-real");
    const fetch = vi.fn().mockRejectedValue(new Error("synthetic timeout")); vi.stubGlobal("fetch", fetch);
    await expect(predictTabPfn(request)).rejects.toMatchObject({ code: "PROVIDER_OUTCOME_UNKNOWN" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(request);
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
  });
  it("bounds and validates the actual fetch response body", async () => {
    vi.stubEnv("TABPFN_SERVICE_URL", "http://localhost:8000"); vi.stubEnv("TABPFN_SERVICE_TOKEN", "synthetic-service-credential-not-real");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response))); vi.stubGlobal("fetch", fetch);
    await expect(predictTabPfn(request)).resolves.toEqual(response);
    fetch.mockResolvedValue(new Response("x".repeat(17000)));
    await expect(predictTabPfn(request)).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });
});
