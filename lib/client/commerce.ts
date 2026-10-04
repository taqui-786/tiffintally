import type { QueryClient } from "@tanstack/react-query";
import { createInvoiceAction, previewInvoiceAction, saveCommerceCustomerAction, saveCommerceSettingsAction } from "@/app/actions/commerce";
import { actionMutationOptions } from "./mutations";
import { operationQueryOptions } from "./queries";

export const commerceSetupQueryOptions = (sellerId: string) => operationQueryOptions(sellerId, "getCommerceSetup", {});
export const invoicesQueryOptions = (sellerId: string, month: string, customerId?: string) => operationQueryOptions(sellerId, "listInvoices", { month, ...(customerId ? { customerId } : {}) });
export const invoiceQueryOptions = (sellerId: string, invoiceId: string) => operationQueryOptions(sellerId, "getInvoice", { invoiceId });
export const dispatchQueryOptions = (sellerId: string, serviceDate: string) => operationQueryOptions(sellerId, "getDispatch", { serviceDate });
export const saveCommerceSettingsMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "saveCommerceSettings", saveCommerceSettingsAction);
export const saveCommerceCustomerMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "saveCommerceCustomer", saveCommerceCustomerAction);
export const previewInvoiceMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "previewInvoice", previewInvoiceAction);
export const createInvoiceMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "createInvoice", createInvoiceAction);
