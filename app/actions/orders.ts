"use server";

import type { OperationInput } from "@/lib/contracts/api";
import { actionResult } from "@/lib/server/http";

export async function importSourcesAction(input: OperationInput<"importSources">) {
  return actionResult("importSources", input);
}

export async function correctSourceAction(input: OperationInput<"correctSource">) {
  return actionResult("correctSource", input);
}

export async function setSourceDispositionAction(input: OperationInput<"sourceDisposition">) {
  return actionResult("sourceDisposition", input);
}

export async function createProposalAction(input: OperationInput<"createProposal">) {
  return actionResult("createProposal", input);
}

export async function editProposalAction(input: OperationInput<"editProposal">) {
  return actionResult("editProposal", input);
}

export async function previewProposalAction(input: OperationInput<"previewProposal">) {
  return actionResult("previewProposal", input);
}

export async function approveProposalAction(input: OperationInput<"approveProposal">) {
  return actionResult("approveProposal", input);
}

export async function setProposalDispositionAction(input: OperationInput<"proposalDisposition">) {
  return actionResult("proposalDisposition", input);
}
