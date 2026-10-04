import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { createCustomerAction, updateCustomerAction, updateSettingsAction } from "@/app/actions/customers";
import { approveProposalAction, correctSourceAction, createProposalAction, editProposalAction, importSourcesAction, previewProposalAction, setProposalDispositionAction, setSourceDispositionAction } from "@/app/actions/orders";
import { finalizeSheetAction } from "@/app/actions/sheets";
import { analyzeSourceAction, retryAnalysisAction, stageHistoryAction, commitHistoryAction, capturePlanningSnapshotAction, recordOutcomeAction, requestForecastAction } from "@/app/actions/intelligence";
import { backendInputSchemas as operationSchemas, type BackendInput as OperationInput, type BackendOutput as OperationOutput } from "@/lib/contracts/backend";
import type { Result } from "@/lib/contracts/common";
import type { ActionOperation } from "@/lib/client/endpoints";
import { unwrapResult } from "@/lib/client/api";
import { sellerKey } from "@/lib/client/query-keys";

/** Call once when composing a new logical command; reuse its variables on retry. */
export const newCommandMeta = () => ({ idempotencyKey: crypto.randomUUID() });

export function actionMutationOptions<K extends ActionOperation>(
  queryClient: QueryClient,
  sellerId: string,
  operation: K,
  action: (input: OperationInput<K>) => Promise<Result<OperationOutput<K>>>,
) {
  return mutationOptions({
    mutationKey: [...sellerKey(sellerId), operation],
    retry: false,
    mutationFn: async (variables: OperationInput<K>): Promise<OperationOutput<K>> => {
      // Runtime schemas select business arguments; TanStack's context is never forwarded.
      const validated = operationSchemas[operation].parse(variables) as OperationInput<K>;
      return unwrapResult(operation, await action(validated));
    },
    onSuccess: async () => {
      if (["stageHistory", "commitHistory", "capturePlanningSnapshot", "recordOutcome", "requestForecast"].includes(operation)) {
        await Promise.all(["listHistory", "getHistoryImport", "listForecasts", "getForecast", "getForecastByKey", "getReceipt"].map((read) => queryClient.invalidateQueries({ queryKey: [...sellerKey(sellerId), read] })));
        return;
      }
      if (operation !== "previewProposal" && operation !== "previewInvoice") await queryClient.invalidateQueries({ queryKey: sellerKey(sellerId) });
    },
  });
}

export const createCustomerMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "createCustomer", createCustomerAction);
export const updateCustomerMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "updateCustomer", updateCustomerAction);
export const updateSettingsMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "updateSettings", updateSettingsAction);
export const importSourcesMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "importSources", importSourcesAction);
export const correctSourceMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "correctSource", correctSourceAction);
export const sourceDispositionMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "sourceDisposition", setSourceDispositionAction);
export const createProposalMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "createProposal", createProposalAction);
export const editProposalMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "editProposal", editProposalAction);
export const previewProposalMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "previewProposal", previewProposalAction);
export const approveProposalMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "approveProposal", approveProposalAction);
export const proposalDispositionMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "proposalDisposition", setProposalDispositionAction);
export const finalizeSheetMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "finalizeSheet", finalizeSheetAction);

export const analyzeSourceMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "analyzeSource", analyzeSourceAction);
export const retryAnalysisMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "retryAnalysis", retryAnalysisAction);
export const stageHistoryMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "stageHistory", stageHistoryAction);
export const commitHistoryMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "commitHistory", commitHistoryAction);
export const planningSnapshotMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "capturePlanningSnapshot", capturePlanningSnapshotAction);
export const recordOutcomeMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "recordOutcome", recordOutcomeAction);
export const requestForecastMutationOptions = (client: QueryClient, sellerId: string) => actionMutationOptions(client, sellerId, "requestForecast", requestForecastAction);
