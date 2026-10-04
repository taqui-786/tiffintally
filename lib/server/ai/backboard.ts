import "server-only";
import type { BackboardAPIError, ChatMessagesResponse, SendMessageOptions } from "backboard-sdk";
import { AppError } from "@/lib/contracts/common";
import type { AnalysisRunView } from "@/lib/contracts/intelligence";
import { JEV_QUESTIONS } from "./classify";
import { getAiConfig, type AiConfig } from "./config";
import { EXTRACTION_PROMPT, gemmaContent, jevContent, type ModelSourceContext } from "./prompts";
import { jevResultSchema, validateExtractionEvidence, type Extraction, type JevResult } from "./schemas";

export interface ProviderIds { assistantId?: string; threadId?: string; messageId?: string; runId?: string }
export interface ProviderMetadata { ids: ProviderIds; resolvedModel: string | null; usage: { inputTokens: number | null; outputTokens: number | null } }
export type ProviderObserver = (metadata: ProviderMetadata) => Promise<void>;
export class AiStageError extends AppError {
  constructor(code: string, status: number, public readonly unknownOutcome = false, public readonly retryAfterSeconds: number | null = null) {
    super(code, "AI stage did not produce a validated result. Review the saved run before an explicit retry.", status);
  }
}
export function safeAiError(error: unknown): NonNullable<AnalysisRunView["error"]> {
  const mapped = error instanceof AiStageError ? error : new AiStageError("PROVIDER_OUTCOME_UNKNOWN", 503, true);
  return { code: mapped.code, message: mapped.message, status: mapped.status, retryAfterSeconds: mapped.retryAfterSeconds };
}
export function mapProviderError(error: unknown): AiStageError {
  if (error instanceof AiStageError) return error;
  if (error instanceof Error && /^Backboard(?:API|Validation|NotFound|RateLimit|Server)Error$/.test(error.name)) {
    const apiError = error as BackboardAPIError;
    if (apiError.statusCode === 402) return new AiStageError("PROVIDER_CREDIT_REQUIRED", 502);
    if ([400, 404, 422].includes(apiError.statusCode ?? 0)) return new AiStageError("PROVIDER_CONTRACT_ERROR", 502);
    if (apiError.statusCode === 429) {
      const header = apiError.response?.headers.get("retry-after");
      const seconds = header && /^\d+$/.test(header) ? Math.min(Number(header), 86400) : null;
      return new AiStageError("PROVIDER_RATE_LIMITED", 429, false, seconds);
    }
  }
  // Network/5xx loss can occur after billing. Never forward nested provider messages.
  return new AiStageError("PROVIDER_OUTCOME_UNKNOWN", 503, true);
}
export function estimateInputTokens(content: string, systemPrompt = ""): number {
  // UTF-8 bytes are a deliberately conservative ceiling, not reported model usage.
  return Buffer.byteLength(content + systemPrompt, "utf8") + 256;
}
export function assertModelInput(content: string, config: AiConfig, systemPrompt = "") {
  if (estimateInputTokens(content, systemPrompt) > config.maxInputTokens) throw new AppError("AI_INPUT_TOO_LARGE", "Source/context exceeds the configured input budget.", 422);
}
export async function boundedStage<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AiStageError("PROVIDER_TIMEOUT", 504, true)), Math.max(1, timeoutMs));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function metadata(response: ChatMessagesResponse): ProviderMetadata {
  const last = response.messages.at(-1);
  const ids: ProviderIds = {};
  for (const [key, value] of Object.entries({ assistantId: response.assistantId ?? last?.assistantId, threadId: response.threadId ?? last?.threadId, messageId: last?.messageId, runId: response.runId ?? last?.runId })) {
    if (typeof value === "string" && value.length > 0 && value.length <= 256) ids[key as keyof ProviderIds] = value;
  }
  const token = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const model = response.systemOne?.model ?? last?.modelName;
  return { ids, resolvedModel: typeof model === "string" && model.length <= 200 && /^[A-Za-z0-9._:/-]+$/.test(model) ? model : null, usage: {
    inputTokens: token(response.systemOne?.usage?.input_tokens ?? last?.inputTokens),
    outputTokens: token(response.systemOne?.usage?.output_tokens ?? last?.outputTokens),
  } };
}
async function send(options: SendMessageOptions, config: AiConfig, observe?: ProviderObserver): Promise<ChatMessagesResponse> {
  // SDK 1.5.19 transport has no retry loop. Its timeout is milliseconds, but node-fetch v3 ignores
  // the legacy timeout option; boundedStage limits waiting, not remote cancellation.
  // ESM-only SDK: lazy import also keeps CJS-transformed tsx operator scripts compatible.
  const { BackboardClient } = await import("backboard-sdk");
  const client = new BackboardClient({ apiKey: config.apiKey, timeout: config.stageTimeoutMs });
  let response: ChatMessagesResponse;
  try {
    const result = await client.sendMessage(options);
    if (!result || !("messages" in result) || !Array.isArray(result.messages)) throw new AiStageError("INVALID_MODEL_OUTPUT", 502);
    response = result;
  } catch (error) { throw mapProviderError(error); }
  if (observe) await observe(metadata(response)); // private IDs first, even if response validation fails
  if (String(response.status).toLowerCase() !== "completed" || response.toolCalls?.length) throw new AiStageError("INVALID_MODEL_OUTPUT", 502);
  return response;
}
function sanitizeLlmExtraction(raw: unknown, text: string): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const clone = JSON.parse(JSON.stringify(raw));
  if (!("clarification" in clone) || clone.clarification === undefined) {
    clone.clarification = null;
  }
  if (Array.isArray(clone.candidates)) {
    for (const c of clone.candidates) {
      if (!c || typeof c !== "object") continue;
      if (!Array.isArray(c.missingFields)) c.missingFields = [];
      if (!("datePhrase" in c) || c.datePhrase === undefined) c.datePhrase = null;
      if (!("endDatePhrase" in c) || c.endDatePhrase === undefined) c.endDatePhrase = null;
      if (typeof c.quantity !== "number") c.quantity = null;

      if (Array.isArray(c.evidence)) {
        for (const ev of c.evidence) {
          if (ev && typeof ev.quote === "string") {
            const idx = text.indexOf(ev.quote);
            if (idx !== -1) {
              ev.start = idx;
              ev.end = idx + ev.quote.length;
            }
          }
        }

        // If datePhrase is verbatim in text but the LLM split evidence into smaller pieces:
        if (typeof c.datePhrase === "string") {
          const hasDateInEvidence = c.evidence.some((ev: { quote?: string }) => typeof ev.quote === "string" && ev.quote.includes(c.datePhrase!));
          if (!hasDateInEvidence) {
            const pIdx = text.indexOf(c.datePhrase);
            if (pIdx !== -1) {
              // The datePhrase is verbatim in text! Add or adjust evidence span so datePhrase is covered
              if (c.evidence.length < 4) {
                c.evidence.push({ start: pIdx, end: pIdx + c.datePhrase.length, quote: c.datePhrase });
              } else if (c.evidence.length === 4) {
                c.evidence[3] = { start: pIdx, end: pIdx + c.datePhrase.length, quote: c.datePhrase };
              }
            }
          }
        }

        // Same for endDatePhrase if verbatim in text:
        if (typeof c.endDatePhrase === "string") {
          const hasEndInEvidence = c.evidence.some((ev: { quote?: string }) => typeof ev.quote === "string" && ev.quote.includes(c.endDatePhrase!));
          if (!hasEndInEvidence) {
            const endIdx = text.indexOf(c.endDatePhrase);
            if (endIdx !== -1) {
              if (c.evidence.length < 4) {
                c.evidence.push({ start: endIdx, end: endIdx + c.endDatePhrase.length, quote: c.endDatePhrase });
              } else if (c.evidence.length === 4) {
                c.evidence[3] = { start: endIdx, end: endIdx + c.endDatePhrase.length, quote: c.endDatePhrase };
              }
            }
          }
        }
      }
    }
  }
  return clone;
}

export async function callGemma(source: ModelSourceContext, config: AiConfig = getAiConfig(), observe?: ProviderObserver): Promise<{ extraction: Extraction; metadata: ProviderMetadata }> {
  const content = gemmaContent(source);
  assertModelInput(content, config, EXTRACTION_PROMPT);
  const response = await send({ content, systemPrompt: EXTRACTION_PROMPT, llmProvider: config.gemmaProvider, modelName: config.gemmaModel,
    stream: false, memory: "off", memoryPro: "off", webSearch: "off", tools: [], jsonOutput: true }, config, observe);
  const last = response.messages.at(-1);
  const details = metadata(response);
  if ((last?.modelProvider && last.modelProvider !== config.gemmaProvider) || (details.resolvedModel && !/gemma/i.test(details.resolvedModel))) throw new AiStageError("INVALID_MODEL_OUTPUT", 502);
  try {
    const rawContent = (response.content ?? "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    if (!rawContent || rawContent.length > config.maxOutputChars) throw new Error("Invalid output length");
    const rawJson = JSON.parse(rawContent);
    const sanitized = sanitizeLlmExtraction(rawJson, source.text);
    return { extraction: validateExtractionEvidence(sanitized, source.text), metadata: details };
  } catch (error) {
    console.error("[Gemma Extraction Error]", error, "\nRaw LLM Content:", response.content);
    throw new AiStageError("INVALID_MODEL_OUTPUT", 502);
  }
}
export async function callJev(source: ModelSourceContext, extraction: Extraction, config: AiConfig = getAiConfig(), observe?: ProviderObserver): Promise<{ classification: JevResult; metadata: ProviderMetadata }> {
  const content = jevContent(source, extraction);
  assertModelInput(content, config, JSON.stringify(JEV_QUESTIONS));
  // No generation controls or tools on System One; each independent fresh thread repeats questions.
  const response = await send({ content, llmProvider: "typesafe", modelName: config.jevModel,
    stream: false, memory: "off", memoryPro: "off", webSearch: "off", systemOne: { questions: JEV_QUESTIONS } }, config, observe);
  try {
    const classification = jevResultSchema.parse(response.systemOne);
    if (classification.model !== config.jevModel || (response.messages.at(-1)?.modelProvider && response.messages.at(-1)?.modelProvider !== "typesafe")) throw new Error("Wrong JEV model");
    return { classification, metadata: metadata(response) };
  } catch { throw new AiStageError("INVALID_MODEL_OUTPUT", 502); }
}
