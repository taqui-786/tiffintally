"use server";

import type { OperationInput } from "@/lib/contracts/api";
import { actionResult } from "@/lib/server/http";

export async function createCustomerAction(input: OperationInput<"createCustomer">) {
  return actionResult("createCustomer", input);
}

export async function updateCustomerAction(input: OperationInput<"updateCustomer">) {
  return actionResult("updateCustomer", input);
}

export async function updateSettingsAction(input: OperationInput<"updateSettings">) {
  return actionResult("updateSettings", input);
}
