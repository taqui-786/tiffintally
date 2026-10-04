"use server";

import type { CommerceInput } from "@/lib/contracts/commerce";
import { actionResult } from "@/lib/server/http";

export async function saveCommerceSettingsAction(input: CommerceInput<"saveCommerceSettings">) { return actionResult("saveCommerceSettings", input); }
export async function saveCommerceCustomerAction(input: CommerceInput<"saveCommerceCustomer">) { return actionResult("saveCommerceCustomer", input); }
export async function previewInvoiceAction(input: CommerceInput<"previewInvoice">) { return actionResult("previewInvoice", input); }
export async function createInvoiceAction(input: CommerceInput<"createInvoice">) { return actionResult("createInvoice", input); }
