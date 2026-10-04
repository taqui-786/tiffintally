import type { BackendOperationName } from "@/lib/contracts/backend";

/** Shared with the OpenAPI generator; contains no server imports or credentials. */
export const routeRegistry = [
  { operation: "getCommerceSetup", method: "GET", path: "/api/v1/commerce/setup", mutation: false },
  { operation: "saveCommerceSettings", method: "PATCH", path: "/api/v1/commerce/settings", mutation: true },
  { operation: "saveCommerceCustomer", method: "PATCH", path: "/api/v1/customers/{customerId}/commerce", mutation: true },
  { operation: "previewInvoice", method: "POST", path: "/api/v1/invoices/preview", mutation: false },
  { operation: "createInvoice", method: "POST", path: "/api/v1/invoices", mutation: true },
  { operation: "listInvoices", method: "GET", path: "/api/v1/invoices", mutation: false },
  { operation: "getInvoice", method: "GET", path: "/api/v1/invoices/{invoiceId}", mutation: false },
  { operation: "getDispatch", method: "GET", path: "/api/v1/days/{serviceDate}/dispatch", mutation: false },
  { operation: "me", method: "GET", path: "/api/v1/me", mutation: false },
  { operation: "getSettings", method: "GET", path: "/api/v1/settings", mutation: false },
  { operation: "updateSettings", method: "PATCH", path: "/api/v1/settings", mutation: true },
  { operation: "listCustomers", method: "GET", path: "/api/v1/customers", mutation: false },
  { operation: "createCustomer", method: "POST", path: "/api/v1/customers", mutation: true },
  { operation: "getCustomer", method: "GET", path: "/api/v1/customers/{customerId}", mutation: false },
  { operation: "updateCustomer", method: "PATCH", path: "/api/v1/customers/{customerId}", mutation: true },
  { operation: "getSchedule", method: "GET", path: "/api/v1/customers/{customerId}/schedule", mutation: false },
  { operation: "listSources", method: "GET", path: "/api/v1/sources", mutation: false },
  { operation: "importSources", method: "POST", path: "/api/v1/sources", mutation: true },
  { operation: "getSource", method: "GET", path: "/api/v1/sources/{sourceId}", mutation: false },
  { operation: "correctSource", method: "PATCH", path: "/api/v1/sources/{sourceId}", mutation: true },
  { operation: "sourceDisposition", method: "POST", path: "/api/v1/sources/{sourceId}/disposition", mutation: true },
  { operation: "listProposals", method: "GET", path: "/api/v1/proposals", mutation: false },
  { operation: "createProposal", method: "POST", path: "/api/v1/proposals", mutation: true },
  { operation: "getProposal", method: "GET", path: "/api/v1/proposals/{proposalId}", mutation: false },
  { operation: "editProposal", method: "PATCH", path: "/api/v1/proposals/{proposalId}", mutation: true },
  { operation: "previewProposal", method: "POST", path: "/api/v1/proposals/{proposalId}/preview", mutation: false },
  { operation: "approveProposal", method: "POST", path: "/api/v1/proposals/{proposalId}/approve", mutation: true },
  { operation: "proposalDisposition", method: "POST", path: "/api/v1/proposals/{proposalId}/disposition", mutation: true },
  { operation: "getDay", method: "GET", path: "/api/v1/days/{serviceDate}", mutation: false },
  { operation: "listSheets", method: "GET", path: "/api/v1/days/{serviceDate}/sheets", mutation: false },
  { operation: "finalizeSheet", method: "POST", path: "/api/v1/days/{serviceDate}/sheets", mutation: true },
  { operation: "getSheet", method: "GET", path: "/api/v1/sheets/{sheetId}", mutation: false },
  { operation: "exportSheet", method: "GET", path: "/api/v1/sheets/{sheetId}/export", mutation: false },
  { operation: "getReceipt", method: "GET", path: "/api/v1/operations/{idempotencyKey}", mutation: false },
  { operation: "capabilities", method: "GET", path: "/api/v1/capabilities", mutation: false },
  { operation: "analyzeSource", method: "POST", path: "/api/v1/sources/{sourceId}/analyses", mutation: true },
  { operation: "getAnalysis", method: "GET", path: "/api/v1/analyses/{runId}", mutation: false },
  { operation: "getAnalysisByKey", method: "GET", path: "/api/v1/analyses/by-key/{requestKey}", mutation: false },
  { operation: "retryAnalysis", method: "POST", path: "/api/v1/analyses/{runId}/retry", mutation: true },
  { operation: "stageHistory", method: "POST", path: "/api/v1/history/imports", mutation: true },
  { operation: "getHistoryImport", method: "GET", path: "/api/v1/history/imports/{importId}", mutation: false },
  { operation: "commitHistory", method: "POST", path: "/api/v1/history/imports/{importId}/commit", mutation: true },
  { operation: "listHistory", method: "GET", path: "/api/v1/history", mutation: false },
  { operation: "capturePlanningSnapshot", method: "POST", path: "/api/v1/days/{serviceDate}/planning-snapshots", mutation: true },
  { operation: "recordOutcome", method: "POST", path: "/api/v1/days/{serviceDate}/outcomes", mutation: true },
  { operation: "requestForecast", method: "POST", path: "/api/v1/days/{serviceDate}/forecasts", mutation: true },
  { operation: "listForecasts", method: "GET", path: "/api/v1/days/{serviceDate}/forecasts", mutation: false },
  { operation: "getForecast", method: "GET", path: "/api/v1/forecasts/{forecastId}", mutation: false },
  { operation: "getForecastByKey", method: "GET", path: "/api/v1/forecasts/by-key/{requestKey}", mutation: false },
  { operation: "privacyExport", method: "GET", path: "/api/v1/privacy/export", mutation: false },
  { operation: "eraseSources", method: "POST", path: "/api/v1/privacy/source-erasures", mutation: true },
  { operation: "eraseSeller", method: "POST", path: "/api/v1/privacy/seller-erasure", mutation: true },
  { operation: "getPrivacyOperation", method: "GET", path: "/api/v1/privacy/operations/{operationId}", mutation: false },
] as const satisfies ReadonlyArray<{ operation: BackendOperationName; method: "GET" | "POST" | "PATCH"; path: string; mutation: boolean }>;

export type ReadOperation = Extract<typeof routeRegistry[number], { method: "GET" }> ["operation"];
export type ActionOperation = Exclude<BackendOperationName, ReadOperation>;

export function endpointFor(operation: BackendOperationName) {
  const endpoint = routeRegistry.find((entry) => entry.operation === operation);
  if (!endpoint) throw new Error("Unknown operation");
  return endpoint;
}
