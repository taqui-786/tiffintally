import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AppError } from "../lib/contracts/common";
import { callGemma, callJev, boundedStage, type ProviderMetadata } from "../lib/server/ai/backboard";
import { getAiConfig } from "../lib/server/ai/config";
import { PROMPT_VERSION } from "../lib/server/ai/prompts";
import { run } from "./run";

void run(async () => {
  if (process.argv.slice(2).join(" ") !== "--allow-provider-spend") throw new AppError("USAGE", "Use pnpm test:ai:live --allow-provider-spend after confirming models, credits and retention. This sends only a fixed fictional source; it is not an authenticated API test.", 422);
  const config = getAiConfig(), id = randomUUID(), path = `.private/ai-live-${id}.json`;
  const source = { text: "only one tomorrow", sentAt: new Date().toISOString(), timezone: "Asia/Kolkata", alias: "Fictional A", schedule: [{ startDate: "2026-01-01", endDate: null, quantities: [2, 2, 2, 2, 2, 2, 2] }] };
  const manifest: { createdAt: string; promptVersion: string; stages: { stage: string; metadata: ProviderMetadata }[]; verified: boolean } = { createdAt: new Date().toISOString(), promptVersion: PROMPT_VERSION, stages: [], verified: false };
  await mkdir(".private", { recursive: true, mode: 0o700 });
  const persist = () => writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
  await persist();
  const observe = (stage: string) => async (metadata: ProviderMetadata) => { manifest.stages.push({ stage, metadata }); await persist(); };
  // No retries: private manifest retains known thread references if a later stage fails/times out.
  const gemma = await boundedStage(callGemma(source, config, observe("gemma")), config.stageTimeoutMs);
  if (!gemma.metadata.resolvedModel || !gemma.metadata.ids.threadId) throw new AppError("LIVE_PROOF_INCOMPLETE", "Resolved Gemma model/thread provenance missing. Inspect the private manifest; do not repeat automatically.", 502);
  const jev = await boundedStage(callJev(source, gemma.extraction, config, observe("jev")), config.stageTimeoutMs);
  if (!jev.metadata.ids.threadId) throw new AppError("LIVE_PROOF_INCOMPLETE", "JEV thread provenance missing. Inspect the private manifest before any repeat.", 502);
  manifest.verified = true; await persist();
  console.log(`Synthetic Backboard Gemma/JEV contracts verified; ${gemma.extraction.candidates.length} review candidates. Private provenance: ${path}. Remote retention remains unverified; no orders or approvals were created.`);
});
