"use server";

import type { OperationInput } from "@/lib/contracts/api";
import { actionResult } from "@/lib/server/http";

export async function finalizeSheetAction(input: OperationInput<"finalizeSheet">) {
  return actionResult("finalizeSheet", input);
}
