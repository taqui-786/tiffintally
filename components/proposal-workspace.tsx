"use client";

/* The compact indexed editor intentionally uses expression handlers inside its field list. */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  MessageSquare,
  Sparkles,
  User,
  Utensils,
  AlertCircle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KitchenPaper as Card, KitchenPaperContent as CardContent, KitchenPaperDescription as CardDescription, KitchenPaperHeader as CardHeader, KitchenPaperTitle as CardTitle } from "@/components/kitchen-paper";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatInstant, isUncertain, uiError } from "@/lib/client/ui-helpers";
import { getOperation } from "@/lib/client/api";
import { editProposalMutationOptions, newCommandMeta, approveProposalMutationOptions, previewProposalMutationOptions, proposalDispositionMutationOptions } from "@/lib/client/mutations";
import { customersQueryOptions, proposalQueryOptions, sourceQueryOptions } from "@/lib/client/queries";
import { isAdvisoryField } from "@/lib/domain/orders";
import type { BackendOutput } from "@/lib/contracts/backend";
import type { OrderOperation, Proposal, Source } from "@/lib/contracts/records";

type Preview = BackendOutput<"previewProposal">;
type Draft = Pick<Proposal, "operations" | "missingFields" | "evidenceSpans">;
type Snapshot = { me: BackendOutput<"me">; proposal: Proposal; source: BackendOutput<"getSource"> | null };

export type PreviewSafetyInput = {
  preview: Pick<Preview, "proposalId" | "expectedStateRevision" | "expectedDraftRevision" | "sourceRevision">;
  proposal: Pick<Proposal, "_id" | "draftRevision" | "sourceRevision" | "status">;
  stateRevision: number;
  serviceDate: string;
};

/** Pure gate kept small so the approval invariants are easy to test without rendering the dialog. */
export function previewSafe(input: PreviewSafetyInput & { previewServiceDate: string }): boolean {
  return input.preview.proposalId === input.proposal._id
    && input.preview.expectedStateRevision === input.stateRevision
    && input.preview.expectedDraftRevision === input.proposal.draftRevision
    && input.preview.sourceRevision === input.proposal.sourceRevision
    && input.serviceDate === input.previewServiceDate
    && input.proposal.status === "needs_review";
}

export function uniqueApprovalIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function approvalGate(input: {
  preview: Pick<Preview, "proposalId" | "expectedStateRevision" | "expectedDraftRevision" | "sourceRevision" | "missingFields" | "requiredAcknowledgements"> | null;
  proposal: Pick<Proposal, "_id" | "draftRevision" | "sourceRevision" | "status" | "missingFields"> | null;
  stateRevision: number | null;
  serviceDate: string;
  supersessionAcknowledged: boolean;
  lateChangeAcknowledged: boolean;
}): { allowed: boolean; reason?: string } {
  if (!input.proposal || !input.preview) return { allowed: false, reason: "Create a fresh preview first." };
  if (input.proposal.status !== "needs_review") return { allowed: false, reason: "Only drafts in review can be approved." };
  if (input.proposal.missingFields.length || input.preview.missingFields.length) return { allowed: false, reason: "Resolve every missing field before approval." };
  if (input.stateRevision === null || !previewSafe({ preview: input.preview, proposal: input.proposal, stateRevision: input.stateRevision, serviceDate: input.serviceDate, previewServiceDate: input.serviceDate })) return { allowed: false, reason: "The preview is stale. Refresh it before approval." };
  if (input.preview.requiredAcknowledgements.includes("supersession") && !input.supersessionAcknowledged) return { allowed: false, reason: "Acknowledge the approvals being superseded." };
  if (input.preview.requiredAcknowledgements.includes("late_change") && !input.lateChangeAcknowledged) return { allowed: false, reason: "Acknowledge this late change." };
  return { allowed: true };
}

function operationName(operation: OrderOperation, index: number, aliases: Map<string, string>) {
  const customer = aliases.get(operation.customerId) ?? operation.customerId;
  if (operation.type === "set_daily_quantity") return `${index + 1}. ${customer} · ${operation.serviceDate} · ${operation.quantity} meals`;
  if (operation.type === "replace_recurring_plan") return `${index + 1}. ${customer} · weekly plan`;
  return `${index + 1}. ${customer} · ${operation.type.replace("_", " ")}`;
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function validEvidence(spans: Proposal["evidenceSpans"], source: Source | undefined) {
  if (!source) return [];
  return spans.filter((span) => Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.start < span.end && span.end <= source.text.length);
}

function updateOperation(operations: OrderOperation[], index: number, patch: Partial<OrderOperation>): OrderOperation[] {
  return operations.map((operation, operationIndex) => operationIndex === index ? { ...operation, ...patch } as OrderOperation : operation);
}

function TitleDescription() {
  return (
    <>
      <DialogTitle className="text-xl font-semibold">Review customer request</DialogTitle>
      <DialogDescription className="text-xs text-muted-foreground">
        Check what the customer asked, verify the meal count, and approve or update the change.
      </DialogDescription>
    </>
  );
}

function ReadSkeleton() {
  return <div className="flex flex-col gap-3" aria-label="Loading proposal"><Skeleton className="h-5 w-32" /><Skeleton className="h-24 w-full" /><Skeleton className="h-5 w-3/4" /></div>;
}

export function ProposalWorkspace({ sellerId, proposalId, serviceDate, onClose }: { sellerId: string; proposalId: string; serviceDate: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const proposalQuery = useQuery(proposalQueryOptions(sellerId, { proposalId }));
  const sourceId = proposalQuery.data?.sourceId;
  const sourceQuery = useQuery({ ...sourceQueryOptions(sellerId, { sourceId: sourceId ?? "manual" }), enabled: Boolean(sourceId) });
  const customersQuery = useQuery(customersQueryOptions(sellerId, { limit: 100 }));
  const editMutation = useMutation(editProposalMutationOptions(queryClient, sellerId));
  const previewMutation = useMutation(previewProposalMutationOptions(queryClient, sellerId));
  const approveMutation = useMutation(approveProposalMutationOptions(queryClient, sellerId));
  const dispositionMutation = useMutation(proposalDispositionMutationOptions(queryClient, sellerId));

  const [draft, setDraft] = useState<Draft | null>(null);
  const [selectedOperation, setSelectedOperation] = useState(0);
  const [resolvedFields, setResolvedFields] = useState<Set<string>>(new Set());
  const [newMissingField, setNewMissingField] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewServiceDate, setPreviewServiceDate] = useState<string | null>(null);
  const [stateRevisionAtPreview, setStateRevisionAtPreview] = useState<number | null>(null);
  const [supersessionAcknowledged, setSupersessionAcknowledged] = useState(false);
  const [lateChangeAcknowledged, setLateChangeAcknowledged] = useState(false);
  const [decision, setDecision] = useState<"reject" | "defer" | "reopen">("reject");
  const [decisionReason, setDecisionReason] = useState("");
  const [deferDate, setDeferDate] = useState(serviceDate);
  const [inlineError, setInlineError] = useState("");
  const [staleMessage, setStaleMessage] = useState("");
  const [showOtherActions, setShowOtherActions] = useState(false);
  const [reconciliation, setReconciliation] = useState<{ idempotencyKey: string; operation: string; variables: unknown } | null>(null);
  const [reconciling, setReconciling] = useState(false);

  // The query revision is the draft identity; refetching the same revision must not erase local edits.
  useEffect(() => {
    if (!proposalQuery.data) return;
    setDraft({ operations: proposalQuery.data.operations, missingFields: proposalQuery.data.missingFields, evidenceSpans: proposalQuery.data.evidenceSpans });
    setSelectedOperation(0);
    setResolvedFields(new Set());
    setPreview(null);
    setPreviewServiceDate(null);
    setStateRevisionAtPreview(null);
    setSupersessionAcknowledged(false);
    setLateChangeAcknowledged(false);
  }, [proposalQuery.data?._id, proposalQuery.data?.draftRevision, proposalQuery.data?.sourceRevision]);

  const aliases = useMemo(() => new Map((customersQuery.data?.items ?? []).map((customer) => [customer._id, customer.alias])), [customersQuery.data?.items]);
  
  // Filter out advisory AI flags (e.g. clarity_requires_review) so they don't block the kitchen operator with checkboxes
  const effectiveMissingFields = useMemo(
    () => (draft?.missingFields ?? []).filter((field) => !isAdvisoryField(field) && !resolvedFields.has(field)),
    [draft?.missingFields, resolvedFields]
  );
  
  const currentProposal = proposalQuery.data;
  const selected = draft?.operations[selectedOperation];
  const source = sourceQuery.data?.source;
  const evidence = validEvidence(draft?.evidenceSpans ?? [], source);
  const draftChanged = Boolean(draft && currentProposal && JSON.stringify(draft) !== JSON.stringify({ operations: currentProposal.operations, missingFields: currentProposal.missingFields, evidenceSpans: currentProposal.evidenceSpans }));
  const previewIsSafe = Boolean(preview && currentProposal && stateRevisionAtPreview !== null && previewServiceDate === serviceDate && previewSafe({ preview, proposal: currentProposal, stateRevision: stateRevisionAtPreview, serviceDate, previewServiceDate: previewServiceDate ?? serviceDate }));
  
  const gate = approvalGate({
    preview: preview ? { ...preview, missingFields: preview.missingFields.filter((f) => !isAdvisoryField(f)) } : null,
    proposal: currentProposal ? { ...currentProposal, missingFields: effectiveMissingFields } : null,
    stateRevision: stateRevisionAtPreview,
    serviceDate,
    supersessionAcknowledged,
    lateChangeAcknowledged,
  });
  
  const writesBlocked = Boolean(reconciliation);
  const writesPending = editMutation.isPending || approveMutation.isPending || dispositionMutation.isPending;

  function onWriteError(error: unknown, idempotencyKey: string, operation: string, variables: unknown) {
    const message = uiError(error);
    setInlineError(message);
    if (isUncertain(error)) setReconciliation({ idempotencyKey, operation, variables });
  }

  async function refreshQueries(message?: string) {
    setPreview(null);
    setPreviewServiceDate(null);
    setStateRevisionAtPreview(null);
    setStaleMessage(message ?? "");
    await Promise.all([proposalQuery.refetch(), sourceId ? sourceQuery.refetch() : Promise.resolve(), customersQuery.refetch()]);
  }

  async function reconcile() {
    if (!reconciliation) return;
    setReconciling(true);
    try {
      await getOperation("getReceipt", { idempotencyKey: reconciliation.idempotencyKey });
      setReconciliation(null);
      setInlineError("");
      await refreshQueries();
    } catch (error) {
      setInlineError(`Reconciliation is still pending: ${uiError(error)}`);
    } finally {
      setReconciling(false);
    }
  }

  async function freshSnapshot(): Promise<Snapshot | null> {
    if (!currentProposal) return null;
    const [me, proposal] = await Promise.all([getOperation("me", {}), getOperation("getProposal", { proposalId })]);
    const freshSource = proposal.sourceId ? await getOperation("getSource", { sourceId: proposal.sourceId }) : null;
    return { me, proposal, source: freshSource };
  }

  function matchesLoadedSnapshot(snapshot: Snapshot) {
    if (!currentProposal || snapshot.proposal._id !== currentProposal._id || snapshot.proposal.draftRevision !== currentProposal.draftRevision || snapshot.proposal.sourceRevision !== currentProposal.sourceRevision) return false;
    return !source || snapshot.source?.source.revision === source.revision;
  }

  async function previewDraft() {
    if (!currentProposal || draftChanged || writesBlocked || currentProposal.status !== "needs_review" || effectiveMissingFields.length) return;
    try {
      const snapshot = await freshSnapshot();
      if (!snapshot || !matchesLoadedSnapshot(snapshot)) { await refreshQueries("This draft changed elsewhere. Refresh before previewing."); return; }
      const result = await previewMutation.mutateAsync({ proposalId, expectedDraftRevision: snapshot.proposal.draftRevision });
      setPreview(result);
      setPreviewServiceDate(serviceDate);
      setStateRevisionAtPreview(snapshot.me.stateRevision);
      setSupersessionAcknowledged(false);
      setLateChangeAcknowledged(false);
      setInlineError("");
      setStaleMessage("");
    } catch (error) {
      setInlineError(uiError(error));
    }
  }

  // Auto-generate preview on load so "Approve change" is immediately ready for 1-click approval
  useEffect(() => {
    if (
      !currentProposal ||
      !draft ||
      draftChanged ||
      writesBlocked ||
      currentProposal.status !== "needs_review" ||
      effectiveMissingFields.length > 0 ||
      preview !== null ||
      previewMutation.isPending
    ) return;
    void previewDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProposal?._id, currentProposal?.draftRevision, preview, effectiveMissingFields.length]);

  async function saveAndPreview() {
    if (!draft || !currentProposal || writesBlocked) return;
    if (sourceId && !source) { setInlineError("Load the current source before saving evidence edits."); return; }
    const meta = newCommandMeta();
    let logicalVariables: unknown = { meta };
    try {
      const snapshot = await freshSnapshot();
      if (!snapshot || !matchesLoadedSnapshot(snapshot)) { await refreshQueries("This draft changed elsewhere. Refresh before saving your edits."); return; }
      const variables = { meta, expectedStateRevision: snapshot.me.stateRevision, expectedSourceRevision: snapshot.proposal.sourceRevision, expectedDraftRevision: snapshot.proposal.draftRevision, proposalId, operations: draft.operations, missingFields: effectiveMissingFields, evidenceSpans: source ? evidence : [] };
      logicalVariables = variables;
      await editMutation.mutateAsync(variables);
      const nextRevision = snapshot.proposal.draftRevision + 1;
      const freshMe = await getOperation("me", {});
      const result = await previewMutation.mutateAsync({ proposalId, expectedDraftRevision: nextRevision });
      setPreview(result);
      setPreviewServiceDate(serviceDate);
      setStateRevisionAtPreview(freshMe.stateRevision);
      setSupersessionAcknowledged(false);
      setLateChangeAcknowledged(false);
      setInlineError("");
      setStaleMessage("");
      await Promise.all([proposalQuery.refetch(), customersQuery.refetch()]);
    } catch (error) {
      onWriteError(error, meta.idempotencyKey, "saveAndPreview", logicalVariables);
    }
  }

  async function approve() {
    if (!preview || !currentProposal || writesBlocked || !gate.allowed || !previewIsSafe) return;
    const meta = newCommandMeta();
    let logicalVariables: unknown = { meta };
    try {
      const snapshot = await freshSnapshot();
      if (!snapshot || !matchesLoadedSnapshot(snapshot) || snapshot.me.stateRevision !== preview.expectedStateRevision || snapshot.proposal.draftRevision !== preview.expectedDraftRevision || snapshot.proposal.sourceRevision !== preview.sourceRevision) {
        await refreshQueries("The approval preview is stale. Refresh the draft and create a new preview.");
        return;
      }
      const variables = { meta, expectedStateRevision: preview.expectedStateRevision, expectedSourceRevision: preview.sourceRevision, expectedDraftRevision: preview.expectedDraftRevision, proposalId, previewHash: preview.previewHash, supersedesApprovalIds: uniqueApprovalIds(preview.conflicts.map((conflict) => conflict.approvalId)), acknowledgeLateChange: lateChangeAcknowledged };
      logicalVariables = variables;
      await approveMutation.mutateAsync(variables);
      setInlineError("");
      setPreview(null);
      onClose();
    } catch (error) {
      onWriteError(error, meta.idempotencyKey, "approveProposal", logicalVariables);
    }
  }

  async function dispose() {
    if (!currentProposal || writesBlocked || !decisionReason.trim() || (decision === "defer" && !deferDate)) return;
    const meta = newCommandMeta();
    let logicalVariables: unknown = { meta };
    try {
      const snapshot = await freshSnapshot();
      if (!snapshot || !matchesLoadedSnapshot(snapshot)) { await refreshQueries("This draft changed elsewhere. Refresh before deciding."); return; }
      const variables = { meta, expectedStateRevision: snapshot.me.stateRevision, expectedSourceRevision: snapshot.proposal.sourceRevision, expectedDraftRevision: snapshot.proposal.draftRevision, proposalId, action: decision, reason: decisionReason.trim(), ...(decision === "defer" ? { serviceDate: deferDate } : {}) };
      logicalVariables = variables;
      await dispositionMutation.mutateAsync(variables);
      setInlineError("");
      onClose();
    } catch (error) {
      onWriteError(error, meta.idempotencyKey, "proposalDisposition", logicalVariables);
    }
  }

  function changeSelectedOperation(patch: Partial<OrderOperation>) {
    setDraft((previous) => previous ? { ...previous, operations: updateOperation(previous.operations, selectedOperation, patch) } : previous);
    setPreview(null);
  }

  function addMissingField() {
    const field = newMissingField.trim();
    if (!field || !draft || draft.missingFields.includes(field)) return;
    setDraft({ ...draft, missingFields: [...draft.missingFields, field] });
    setNewMissingField("");
    setPreview(null);
  }

  return <Dialog open={Boolean(proposalId)} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-visible p-4 [overflow-wrap:anywhere] sm:max-w-4xl sm:p-6">
      <DialogHeader className="shrink-0 border-b pb-4 pr-10">
        <TitleDescription />
      </DialogHeader>

      <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain py-4">
        {inlineError ? <Alert variant="destructive" role="alert"><AlertTitle>Action could not be completed</AlertTitle><AlertDescription>{inlineError}</AlertDescription></Alert> : null}
        {reconciliation ? <Alert variant="destructive" role="alert"><AlertTitle>{reconciliation.operation} needs reconciliation</AlertTitle><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>Writes are paused until the server confirms the original command.</span><Button variant="outline" size="sm" onClick={() => void reconcile()} disabled={reconciling}>{reconciling ? "Checking receipt…" : "Check receipt"}</Button></AlertDescription></Alert> : null}
        {staleMessage ? <Alert role="status"><AlertTitle>Refresh required</AlertTitle><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>{staleMessage}</span><Button variant="outline" size="sm" onClick={() => void refreshQueries()}>Refresh</Button></AlertDescription></Alert> : null}

        {proposalQuery.isPending ? <ReadSkeleton /> : proposalQuery.error ? <Alert variant="destructive"><AlertTitle>Couldn’t load proposal</AlertTitle><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>{uiError(proposalQuery.error)}</span><Button variant="outline" size="sm" onClick={() => void refreshQueries()}>Refresh</Button></AlertDescription></Alert> : currentProposal && draft ? (
          <div className="grid min-w-0 gap-6 lg:grid-cols-2">
            {/* Left Column: Customer's Original Message */}
            <section aria-label="Customer message" className="flex min-w-0 flex-col gap-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                    <MessageSquare className="h-4 w-4 text-emerald-600" />
                    Customer message
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {source ? `Received ${formatInstant(source.receivedAt, "UTC")}` : "Manual entry"}
                  </p>
                </div>
                {source?.upstreamId?.includes("voice") ? (
                  <Badge variant="secondary" className="gap-1 bg-amber-50 text-amber-700 border-amber-200">
                    🎙️ Voice Note
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 text-emerald-700 border-emerald-200 bg-emerald-50 text-xs">
                    WhatsApp
                  </Badge>
                )}
              </div>

              {sourceId ? (
                sourceQuery.isPending ? <ReadSkeleton /> : sourceQuery.error ? <Alert variant="destructive"><AlertTitle>Couldn’t load message</AlertTitle><AlertDescription>{uiError(sourceQuery.error)}</AlertDescription></Alert> : source ? (
                  <div className="rounded-2xl border bg-muted/20 p-4 space-y-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <User className="h-3.5 w-3.5 text-emerald-600" />
                      <span>{aliases.get(source.customerId ?? "") ?? "Customer"}</span>
                    </div>
                    <div className="rounded-xl border bg-background p-4 shadow-2xs">
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground font-normal">
                        "{source.text}"
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-emerald-700 font-medium pt-1">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                      <span>Verified directly from customer WhatsApp message</span>
                    </div>
                  </div>
                ) : null
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Manual note</CardTitle>
                    <CardDescription>Created manually in the kitchen workspace.</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <p className="whitespace-pre-wrap text-sm leading-6">{currentProposal.manualReason ?? "No manual reason supplied."}</p>
                    <p className="text-xs text-muted-foreground">Created {formatInstant(currentProposal.createdAt, "UTC")}</p>
                  </CardContent>
                </Card>
              )}
            </section>

            {/* Right Column: Proposed Change & Quick Approval */}
            <section aria-label="Proposed changes" className="flex min-w-0 flex-col gap-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
                    <Utensils className="h-4 w-4 text-primary" />
                    Proposed order update
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Confirm customer, date, and meal quantity.
                  </p>
                </div>
                <Badge variant={currentProposal.status === "needs_review" ? "secondary" : "outline"} className="capitalize">
                  {currentProposal.status.replaceAll("_", " ")}
                </Badge>
              </div>

              {/* Multi-operation selector if more than 1 operation */}
              {draft.operations.length > 1 && (
                <Field>
                  <FieldLabel htmlFor="operation-index">Choose change to edit</FieldLabel>
                  <Select value={String(selectedOperation)} onValueChange={(value) => setSelectedOperation(Number(value))}>
                    <SelectTrigger id="operation-index" className="w-full">
                      <SelectValue placeholder="Choose an operation" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>All changes ({draft.operations.length})</SelectLabel>
                        {draft.operations.map((operation, index) => (
                          <SelectItem key={index} value={String(index)}>
                            {operationName(operation, index, aliases)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              )}

              {/* Friendly Operation Editor */}
              {selected ? (
                <OperationEditor operation={selected} aliases={aliases} onChange={changeSelectedOperation} />
              ) : (
                <Alert>
                  <AlertTitle>No operations</AlertTitle>
                  <AlertDescription>This draft contains no proposed operations.</AlertDescription>
                </Alert>
              )}

              {/* Status / Missing details notice */}
              {effectiveMissingFields.length > 0 ? (
                <FieldSet className="rounded-xl border border-amber-200 bg-amber-50/50 p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-amber-800">
                    <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                    <span>Please provide missing details before approving:</span>
                  </div>
                  <div className="flex flex-col gap-2 mt-2">
                    {effectiveMissingFields.map((field) => (
                      <label key={field} className="flex min-w-0 items-start gap-3 rounded-lg border bg-background p-2.5 text-xs">
                        <Checkbox
                          checked={resolvedFields.has(field)}
                          onCheckedChange={(checked) => {
                            const next = new Set(resolvedFields);
                            checked === true ? next.add(field) : next.delete(field);
                            setResolvedFields(next);
                            setPreview(null);
                          }}
                        />
                        <span className="min-w-0 font-medium">
                          {field === "exact_service_dates" ? "Delivery date is needed" : field === "confirmed_customer" ? "Confirm customer assignment" : field === "explicit_quantity" ? "Meal quantity is needed" : field.replaceAll("_", " ")}
                        </span>
                      </label>
                    ))}
                  </div>
                </FieldSet>
              ) : (
                <div className="flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200/80 p-3 text-xs text-emerald-800">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                  <span>All order details verified. Ready for immediate approval.</span>
                </div>
              )}

              {/* Live Preview / Kitchen Impact */}
              {previewMutation.isPending ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground p-3 border rounded-xl bg-muted/20 animate-pulse">
                  <Clock className="h-4 w-4 animate-spin text-primary" />
                  <span>Calculating kitchen meal tally...</span>
                </div>
              ) : preview ? (
                <PreviewPanel
                  preview={preview}
                  aliases={aliases}
                  supersessionAcknowledged={supersessionAcknowledged}
                  lateChangeAcknowledged={lateChangeAcknowledged}
                  onSupersession={setSupersessionAcknowledged}
                  onLateChange={setLateChangeAcknowledged}
                />
              ) : null}

              {preview && !previewIsSafe ? (
                <Alert variant="destructive">
                  <AlertTitle>Preview updated</AlertTitle>
                  <AlertDescription>Please refresh the preview before approving.</AlertDescription>
                </Alert>
              ) : null}

              {/* If user made local edits, offer 1-click "Update preview" */}
              {draftChanged && (
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    onClick={() => void saveAndPreview()}
                    disabled={writesBlocked || writesPending}
                  >
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    {editMutation.isPending ? "Updating preview…" : "Update preview with your edits"}
                  </Button>
                </div>
              )}

              {/* Discreet "Reject / Postpone" Option */}
              <div className="border-t pt-3">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowOtherActions((prev) => !prev)}
                >
                  {showOtherActions ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  <span>Need to reject or postpone this request?</span>
                </button>

                {showOtherActions && (
                  <div className="mt-3 rounded-xl border bg-muted/20 p-3 space-y-3">
                    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2">
                      <Field>
                        <FieldLabel htmlFor="decision" className="text-xs">Action</FieldLabel>
                        <Select value={decision} onValueChange={(value) => setDecision(value as typeof decision)}>
                          <SelectTrigger id="decision" className="w-full h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="reject">Reject</SelectItem>
                              <SelectItem value="defer">Postpone / Defer</SelectItem>
                              <SelectItem value="reopen">Reopen</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      {decision === "defer" ? (
                        <Field>
                          <FieldLabel htmlFor="defer-date" className="text-xs">Defer until</FieldLabel>
                          <Input id="defer-date" type="date" value={deferDate} onChange={(event) => setDeferDate(event.target.value)} className="h-8 text-xs" required />
                        </Field>
                      ) : null}
                    </div>
                    <Field>
                      <FieldLabel htmlFor="decision-reason" className="text-xs">Reason</FieldLabel>
                      <Textarea id="decision-reason" value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} placeholder="Reason for rejecting or postponing" maxLength={1000} className="text-xs min-h-[60px]" required />
                    </Field>
                    <Button variant="outline" size="sm" onClick={() => void dispose()} disabled={writesBlocked || writesPending || !decisionReason.trim() || (decision === "defer" && !deferDate)}>
                      {dispositionMutation.isPending ? "Saving…" : `${decision[0].toUpperCase()}${decision.slice(1)} request`}
                    </Button>
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : null}
      </div>

      <DialogFooter className="shrink-0 border-t bg-popover pt-4 flex flex-row items-center justify-between sm:justify-between">
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        <div className="flex items-center gap-2">
          {draftChanged && (
            <Button
              variant="outline"
              size="default"
              onClick={() => void saveAndPreview()}
              disabled={writesBlocked || writesPending}
            >
              {editMutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          )}
          <Button
            className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium shadow-sm gap-2 px-5"
            onClick={() => void approve()}
            disabled={writesBlocked || writesPending || approveMutation.isPending || !gate.allowed || !previewIsSafe}
          >
            {approveMutation.isPending ? "Approving…" : (
              <>
                <Check className="h-4 w-4" />
                Approve change
              </>
            )}
          </Button>
        </div>
      </DialogFooter>
      <p className="sr-only" aria-live="polite">{writesPending ? "Saving proposal" : writesBlocked ? "Waiting for command reconciliation" : preview ? `${preview.effects.length} effects in preview` : "Proposal workspace ready"}</p>
    </DialogContent>
  </Dialog>;
}

function OperationEditor({ operation, aliases, onChange }: { operation: OrderOperation; aliases: Map<string, string>; onChange: (patch: Partial<OrderOperation>) => void }) {
  const customers = [...aliases.entries()];
  const customerField = (
    <Field>
      <FieldLabel className="text-xs">Customer</FieldLabel>
      <Select value={operation.customerId} onValueChange={(value) => onChange({ customerId: value ?? operation.customerId })}>
        <SelectTrigger className="w-full">
          <SelectValue>{aliases.get(operation.customerId) ?? operation.customerId}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Customers</SelectLabel>
            {customers.map(([id, alias]) => (
              <SelectItem key={id} value={id}>{alias}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );

  if (operation.type === "set_daily_quantity") {
    return (
      <FieldGroup className="rounded-xl border bg-background p-4 space-y-3">
        {customerField}
        <div className="grid min-w-0 grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="operation-date" className="text-xs">Delivery date</FieldLabel>
            <Input id="operation-date" type="date" value={operation.serviceDate} onChange={(event) => onChange({ serviceDate: event.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="operation-quantity" className="text-xs">Meal count (tiffins)</FieldLabel>
            <Input
              id="operation-quantity"
              type="number"
              min={0}
              max={1000}
              value={operation.quantity}
              onChange={(event) => onChange({ quantity: Math.min(1000, Math.max(0, Number(event.target.value) || 0)) })}
            />
          </Field>
        </div>
      </FieldGroup>
    );
  }

  if (operation.type === "replace_recurring_plan") {
    const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return (
      <FieldGroup className="rounded-xl border bg-background p-4 space-y-3">
        {customerField}
        <div className="grid min-w-0 grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="plan-start" className="text-xs">Start date</FieldLabel>
            <Input id="plan-start" type="date" value={operation.startDate} onChange={(event) => onChange({ startDate: event.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="plan-end" className="text-xs">End date (optional)</FieldLabel>
            <Input id="plan-end" type="date" value={operation.endDate ?? ""} onChange={(event) => onChange({ endDate: event.target.value || null })} />
          </Field>
        </div>
        <Field>
          <FieldLabel className="text-xs">Weekly schedule (meals per day)</FieldLabel>
          <div className="grid grid-cols-7 gap-1.5 pt-1">
            {operation.quantities.map((quantity, index) => (
              <div key={index} className="flex flex-col items-center gap-1">
                <span className="text-[10px] text-muted-foreground font-medium">{dayNames[index]}</span>
                <Input
                  aria-label={`Recurring quantity for ${dayNames[index]}`}
                  type="number"
                  min={0}
                  max={1000}
                  className="h-8 px-1 text-center text-xs"
                  value={quantity}
                  onChange={(event) => {
                    const quantities = [...operation.quantities] as [number, number, number, number, number, number, number];
                    quantities[index] = Math.min(1000, Math.max(0, Number(event.target.value) || 0));
                    onChange({ quantities });
                  }}
                />
              </div>
            ))}
          </div>
        </Field>
      </FieldGroup>
    );
  }

  return (
    <FieldGroup className="rounded-xl border bg-background p-4 space-y-3">
      {customerField}
      <div className="grid min-w-0 grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="interval-from" className="text-xs">Pause from</FieldLabel>
          <Input id="interval-from" type="date" value={operation.fromDate} onChange={(event) => onChange({ fromDate: event.target.value })} />
        </Field>
        <Field>
          <FieldLabel htmlFor="interval-to" className="text-xs">Resume on</FieldLabel>
          <Input id="interval-to" type="date" value={operation.toDate} onChange={(event) => onChange({ toDate: event.target.value })} />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        {operation.type === "pause_interval" ? "Pause meal deliveries during this date range." : "Resume meal deliveries during this date range."}
      </p>
    </FieldGroup>
  );
}

function PreviewPanel({ preview, aliases, supersessionAcknowledged, lateChangeAcknowledged, onSupersession, onLateChange }: { preview: Preview; aliases: Map<string, string>; supersessionAcknowledged: boolean; lateChangeAcknowledged: boolean; onSupersession: (checked: boolean) => void; onLateChange: (checked: boolean) => void }) {
  const conflicts = preview.conflicts;
  return (
    <Card className="border-emerald-200/90 bg-emerald-50/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-emerald-600" />
          Live Kitchen Impact
        </CardTitle>
        <CardDescription className="text-xs">
          {preview.effects.length} customer order{preview.effects.length === 1 ? "" : "s"} updated
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Customer Effect Box */}
        <div className="space-y-2">
          {preview.effects.map((effect, index) => (
            <div key={`${effect.customerId}-${effect.serviceDate}-${index}`} className="flex items-center justify-between rounded-xl border bg-background p-3 text-sm shadow-2xs">
              <div>
                <p className="font-medium text-foreground">{aliases.get(effect.customerId) ?? effect.customerId}</p>
                <p className="text-xs text-muted-foreground">{displayDate(effect.serviceDate)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-mono line-through">{effect.before}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 font-mono">
                  {effect.after} meal{effect.after === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Day Total */}
        {preview.totals.map((total) => (
          <div key={total.serviceDate} className="flex items-center justify-between text-xs text-muted-foreground px-1 border-t pt-2">
            <span>Kitchen total for {displayDate(total.serviceDate)}:</span>
            <span className="font-mono font-medium text-foreground">
              {total.before} → <span className="font-semibold text-emerald-700">{total.after} tiffins</span>
            </span>
          </div>
        ))}

        {/* Conflicts / Warnings */}
        {conflicts.length ? (
          <Alert className="border-amber-200 bg-amber-50">
            <AlertTitle className="text-xs font-semibold text-amber-900">Replaces previous approval</AlertTitle>
            <AlertDescription className="flex flex-col gap-2 text-xs text-amber-800 mt-1">
              <label className="flex items-start gap-2 cursor-pointer">
                <Checkbox checked={supersessionAcknowledged} onCheckedChange={(checked) => onSupersession(checked === true)} className="mt-0.5" />
                <span>I confirm replacing the existing approval for this date.</span>
              </label>
            </AlertDescription>
          </Alert>
        ) : null}

        {preview.requiredAcknowledgements.includes("late_change") ? (
          <Alert className="border-amber-200 bg-amber-50">
            <AlertTitle className="text-xs font-semibold text-amber-900">Late order notice</AlertTitle>
            <AlertDescription className="text-xs text-amber-800 mt-1">
              <label className="flex items-start gap-2 cursor-pointer">
                <Checkbox checked={lateChangeAcknowledged} onCheckedChange={(checked) => onLateChange(checked === true)} className="mt-0.5" />
                <span>I acknowledge this request was received after the kitchen cutoff time.</span>
              </label>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
