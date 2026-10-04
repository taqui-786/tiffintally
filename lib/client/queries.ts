import { queryOptions } from "@tanstack/react-query";
import type { z } from "zod";
import { backendInputSchemas as operationSchemas } from "@/lib/contracts/backend";
import { getOperation, retryRead } from "@/lib/client/api";
import type { ReadOperation } from "@/lib/client/endpoints";
import { resourceKey } from "@/lib/client/query-keys";

type QueryOperation = Exclude<ReadOperation, "exportSheet" | "privacyExport">;
type QueryInput<K extends QueryOperation> = z.input<(typeof operationSchemas)[K]>;

export function operationQueryOptions<K extends QueryOperation>(sellerId: string, operation: K, rawInput: QueryInput<K>) {
  const input = operationSchemas[operation].parse(rawInput);
  return queryOptions({
    queryKey: resourceKey(sellerId, operation, input),
    queryFn: ({ signal }) => getOperation(operation, input, signal),
    staleTime: operation === "getSheet" || operation === "getReceipt" ? 5 * 60_000 : 5_000,
    retry: retryRead,
  });
}

export const meQueryOptions = (sellerId: string) => operationQueryOptions(sellerId, "me", {});
export const settingsQueryOptions = (sellerId: string) => operationQueryOptions(sellerId, "getSettings", {});
export const customersQueryOptions = (sellerId: string, input: QueryInput<"listCustomers"> = {}) => operationQueryOptions(sellerId, "listCustomers", input);
export const customerQueryOptions = (sellerId: string, input: QueryInput<"getCustomer">) => operationQueryOptions(sellerId, "getCustomer", input);
export const customerScheduleQueryOptions = (sellerId: string, input: QueryInput<"getSchedule">) => operationQueryOptions(sellerId, "getSchedule", input);
export const sourcesQueryOptions = (sellerId: string, input: QueryInput<"listSources"> = {}) => operationQueryOptions(sellerId, "listSources", input);
export const sourceQueryOptions = (sellerId: string, input: QueryInput<"getSource">) => operationQueryOptions(sellerId, "getSource", input);
export const proposalsQueryOptions = (sellerId: string, input: QueryInput<"listProposals"> = {}) => operationQueryOptions(sellerId, "listProposals", input);
export const proposalQueryOptions = (sellerId: string, input: QueryInput<"getProposal">) => operationQueryOptions(sellerId, "getProposal", input);
export const dayQueryOptions = (sellerId: string, input: QueryInput<"getDay">) => operationQueryOptions(sellerId, "getDay", input);
export const sheetsQueryOptions = (sellerId: string, input: QueryInput<"listSheets">) => operationQueryOptions(sellerId, "listSheets", input);
export const sheetQueryOptions = (sellerId: string, input: QueryInput<"getSheet">) => operationQueryOptions(sellerId, "getSheet", input);
export const receiptQueryOptions = (sellerId: string, input: QueryInput<"getReceipt">) => operationQueryOptions(sellerId, "getReceipt", input);

export const capabilitiesQueryOptions = (sellerId: string) => operationQueryOptions(sellerId, "capabilities", {});
export const analysisQueryOptions = (sellerId: string, input: QueryInput<"getAnalysis">) => operationQueryOptions(sellerId, "getAnalysis", input);
export const analysisByKeyQueryOptions = (sellerId: string, input: QueryInput<"getAnalysisByKey">) => operationQueryOptions(sellerId, "getAnalysisByKey", input);
export const historyQueryOptions = (sellerId: string, input: QueryInput<"listHistory"> = {}) => operationQueryOptions(sellerId, "listHistory", input);
export const historyImportQueryOptions = (sellerId: string, input: QueryInput<"getHistoryImport">) => operationQueryOptions(sellerId, "getHistoryImport", input);
export const forecastsQueryOptions = (sellerId: string, input: QueryInput<"listForecasts">) => operationQueryOptions(sellerId, "listForecasts", input);
export const forecastQueryOptions = (sellerId: string, input: QueryInput<"getForecast">) => operationQueryOptions(sellerId, "getForecast", input);
export const forecastByKeyQueryOptions = (sellerId: string, input: QueryInput<"getForecastByKey">) => operationQueryOptions(sellerId, "getForecastByKey", input);
export const privacyProgressQueryOptions = (sellerId: string, input: QueryInput<"getPrivacyOperation">) => operationQueryOptions(sellerId, "getPrivacyOperation", input);
