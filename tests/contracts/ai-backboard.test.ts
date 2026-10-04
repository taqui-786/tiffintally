import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackboardAPIError, BackboardClient } from "backboard-sdk";
import { callGemma, callJev, mapProviderError, safeAiError } from "@/lib/server/ai/backboard";
import { validateAiConfig } from "@/lib/server/ai/config";
import { JEV_QUESTIONS } from "@/lib/server/ai/classify";
import { intentLabels, type JevResult } from "@/lib/server/ai/schemas";
import { classificationSummary } from "@/lib/server/ai/classify";

// Intercept the installed SDK's HTTP boundary. Its serializer and real response parser still run.
const sdkTransport = BackboardClient.prototype as unknown as { _makeRequest(method: string, endpoint: string, options: { json: Record<string, unknown> }): Promise<unknown> };
const fetchMock = vi.fn<(method: string, endpoint: string, options: { json: Record<string, unknown> }) => Promise<unknown>>();
const config = validateAiConfig({ BACKBOARD_API_KEY: "synthetic-key", GEMMA_PROVIDER: "google", GEMMA_MODEL: "gemma-3-27b-it", JEV_MODEL: "jev-1.13.0" });
const source = { text: "only one tomorrow", sentAt: "2026-10-01T19:00:00Z", timezone: "Asia/Kolkata", alias: "A", schedule: [] };
const extraction = { candidates: [{ kind: "quantity_change" as const, evidence: [{ start: 0, end: source.text.length, quote: source.text }], datePhrase: "tomorrow", endDatePhrase: null, quantity: 1, missingFields: [] }], clarification: null };
export const jevFixture: JevResult = {
  model: "jev-1.13.0", answers: {
    intent: { type: "choice", choice: "quantity_change", probabilities: Object.fromEntries(intentLabels.map((label) => [label, label === "quantity_change" ? 1 : 0])) as JevResult["answers"]["intent"]["probabilities"], confidence: 1 },
    explicitReplacement: { type: "noul", noul: 0 },
    clarity: { type: "score", score: 2, legend: { "0": "Unclear or contradictory", "1": "Some necessary details missing", "2": "Explicit details stated" }, probabilities: { "0": 0, "1": 0, "2": 1 }, confidence: 1 },
  }, usage: { input_tokens: 30, output_tokens: 0 },
};
function response(body: Record<string, unknown>) {
  fetchMock.mockResolvedValueOnce({ thread_id: "private-thread", assistant_id: "private-assistant", message_id: "private-message", run_id: "private-run", role: "assistant", status: "COMPLETED", ...body });
}
function requestBody(index = 0) { return fetchMock.mock.calls[index][2].json; }
beforeEach(() => { fetchMock.mockReset(); vi.spyOn(sdkTransport, "_makeRequest").mockImplementation(fetchMock); });
describe("real Backboard SDK transport and parsing (offline)", () => {
  it("selects Gemma explicitly on an independent memory-off tool-free thread and records IDs before parsing", async () => {
    response({ content: JSON.stringify(extraction), model_provider: "google", model_name: "gemma-resolved-27b", input_tokens: 25, output_tokens: 20 });
    const observe = vi.fn(async () => {});
    const result = await callGemma(source, config, observe);
    expect(result.extraction).toEqual(extraction);
    expect(result.metadata).toMatchObject({ resolvedModel: "gemma-resolved-27b", ids: { threadId: "private-thread", runId: "private-run" }, usage: { inputTokens: 25, outputTokens: 20 } });
    expect(observe).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0].slice(0, 2)).toEqual(["POST", "/threads/messages"]);
    expect(fetchMock.mock.contexts[0]).toMatchObject({ timeout: 20000 });
    expect(requestBody()).toMatchObject({ llm_provider: "google", model_name: config.gemmaModel, stream: false, memory: "off", memory_pro: "off", web_search: "off", tools: [], json_output: true });
    expect(requestBody()).not.toHaveProperty("thread_id");
    expect(requestBody().content).not.toContain("sellerId");
  });
  it("repeats named System One questions, parses answers, and preserves reported zero output tokens", async () => {
    response({ content: "", system_one: jevFixture, model_provider: "typesafe" });
    response({ content: "", system_one: jevFixture, model_provider: "typesafe" });
    const result = await callJev(source, extraction, config);
    await callJev(source, extraction, config);
    expect(result.classification).toEqual(jevFixture);
    expect(result.metadata.usage.outputTokens).toBe(0);
    for (let index = 0; index < 2; index++) {
      expect(requestBody(index)).toMatchObject({ llm_provider: "typesafe", model_name: "jev-1.13.0", stream: false, memory: "off", memory_pro: "off", web_search: "off", system_one: { questions: JEV_QUESTIONS } });
      for (const field of ["tools", "temperature", "max_tokens", "json_output", "thinking", "thread_id"]) expect(requestBody(index)).not.toHaveProperty(field);
    }
  });
  it("accepts fractional JEV Scores within the returned legend and keeps human review", async () => {
    const fractional = { ...jevFixture, answers: { ...jevFixture.answers, clarity: { ...jevFixture.answers.clarity, score: 1.03 } } };
    response({ content: "", system_one: fractional, model_provider: "typesafe" });
    const result = await callJev(source, extraction, config);
    expect(result.classification.answers.clarity.score).toBe(1.03);
    expect(classificationSummary(result.classification, extraction).warnings).toContain("clarity_requires_review");
  });
  it.each([-0.01, 2.01, Infinity])("rejects JEV Scores outside the declared scale: %s", async (score) => {
    response({ content: "", system_one: { ...jevFixture, answers: { ...jevFixture.answers, clarity: { ...jevFixture.answers.clarity, score } } }, model_provider: "typesafe" });
    await expect(callJev(source, extraction, config)).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });
  it.each(["not json", JSON.stringify({ ...extraction, sellerId: "foreign-owner" }), JSON.stringify({ ...extraction, candidates: [{ ...extraction.candidates[0], evidence: [{ start: 0, end: 4, quote: "made up" }] }] })])("rejects malformed/authoritative/hallucinated Gemma output and still keeps IDs", async (content) => {
    response({ content });
    const observe = vi.fn(async () => {});
    await expect(callGemma(source, config, observe)).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
    expect(observe).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each([null, { ...jevFixture, answers: {} }, { ...jevFixture, model: "jev-1.14.0" }, { ...jevFixture, answers: { ...jevFixture.answers, explicitReplacement: { type: "noul", noul: 0.8, confidence: 0.9 } } }])("rejects absent, invalid, wrong-version, and fabricated Noul answers", async (system_one) => {
    response({ content: "pretend classification prose", system_one });
    await expect(callJev(source, extraction, config)).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });
  it.each([[402, "PROVIDER_CREDIT_REQUIRED"], [422, "PROVIDER_CONTRACT_ERROR"], [429, "PROVIDER_RATE_LIMITED"], [500, "PROVIDER_OUTCOME_UNKNOWN"]])("never automatically retries HTTP %s", async (status, code) => {
    fetchMock.mockRejectedValueOnce(new BackboardAPIError("private source / key / connection string", Number(status)));
    await expect(callGemma(source, config)).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("sanitizes nested failures and treats network loss as unknown", () => {
    const mapped = mapProviderError(new BackboardAPIError("private raw source and secret"));
    expect(mapped.unknownOutcome).toBe(true);
    expect(JSON.stringify(safeAiError(mapped))).not.toContain("private");
  });
});
