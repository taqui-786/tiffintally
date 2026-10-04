"use server";
import type { BackendInput } from "@/lib/contracts/backend";
import { actionResult } from "@/lib/server/http";

export async function analyzeSourceAction(input: BackendInput<"analyzeSource">) { return actionResult("analyzeSource", input); }
export async function retryAnalysisAction(input: BackendInput<"retryAnalysis">) { return actionResult("retryAnalysis", input); }
export async function stageHistoryAction(input: BackendInput<"stageHistory">) {
  return actionResult("stageHistory", input);
}
export async function commitHistoryAction(input: BackendInput<"commitHistory">) { return actionResult("commitHistory", input); }
export async function capturePlanningSnapshotAction(input: BackendInput<"capturePlanningSnapshot">) { return actionResult("capturePlanningSnapshot", input); }
export async function recordOutcomeAction(input: BackendInput<"recordOutcome">) { return actionResult("recordOutcome", input); }
export async function requestForecastAction(input: BackendInput<"requestForecast">) { return actionResult("requestForecast", input); }
