"use client";

/* The compact indexed editor intentionally uses expression handlers inside its field list. */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  if (operation.type === "set_daily_quantity") return `${index + 1}. ${customer} · ${operation.serviceDate} · ${operation.quantity}`;
  if (operation.type === "replace_recurring_plan") return `${index + 1}. ${customer} · recurring plan`;
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
  return <><DialogTitle className="text-xl">Review proposed change</DialogTitle><DialogDescription>Check the original evidence, edit each indexed operation, preview every effect, then choose an explicit decision.</DialogDescription></>;
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
  const [reconciliation, setReconciliation] = useState<{ idempotencyKey: string; operation: string; variables: unknown } | null>(null);
  const [reconciling, setReconciling] = useState(false);

  // The query revision is the draft identity; refetching the same revision must not erase local edits.
  useEffect(() => {
    if (!proposalQuery.data) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft({ operations: proposalQuery.data.operations, missingFields: proposalQuery.data.missingFields, evidenceSpans: proposalQuery.data.evidenceSpans });
    setSelectedOperation(0);
    setResolvedFields(new Set());
    setPreview(null);
    setPreviewServiceDate(null);
    setStateRevisionAtPreview(null);
    setSupersessionAcknowledged(false);
    setLateChangeAcknowledged(false);
    // Deliberately key resets by server revision rather than object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposalQuery.data?._id, proposalQuery.data?.draftRevision, proposalQuery.data?.sourceRevision]);

  const aliases = useMemo(() => new Map((customersQuery.data?.items ?? []).map((customer) => [customer._id, customer.alias])), [customersQuery.data?.items]);
  const effectiveMissingFields = useMemo(() => draft?.missingFields.filter((field) => !resolvedFields.has(field)) ?? [], [draft?.missingFields, resolvedFields]);
  const currentProposal = proposalQuery.data;
  const selected = draft?.operations[selectedOperation];
  const source = sourceQuery.data?.source;
  const evidence = validEvidence(draft?.evidenceSpans ?? [], source);
  const draftChanged = Boolean(draft && currentProposal && JSON.stringify(draft) !== JSON.stringify({ operations: currentProposal.operations, missingFields: currentProposal.missingFields, evidenceSpans: currentProposal.evidenceSpans }));
  const previewIsSafe = Boolean(preview && currentProposal && stateRevisionAtPreview !== null && previewServiceDate === serviceDate && previewSafe({ preview, proposal: currentProposal, stateRevision: stateRevisionAtPreview, serviceDate, previewServiceDate: previewServiceDate ?? serviceDate }));
  const gate = approvalGate({ preview, proposal: currentProposal ? { ...currentProposal, missingFields: effectiveMissingFields } : null, stateRevision: stateRevisionAtPreview, serviceDate, supersessionAcknowledged, lateChangeAcknowledged });
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

  async function editDraft() {
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
      setInlineError("");
      await refreshQueries();
    } catch (error) {
      onWriteError(error, meta.idempotencyKey, "editProposal", logicalVariables);
    }
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
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-visible p-4 [overflow-wrap:anywhere] sm:max-w-5xl sm:p-6 [&_[data-slot=field]]:min-w-0 [&_[data-slot=field-group]]:min-w-0 [&_[data-slot=field-set]]:min-w-0 [&_[data-slot=field-label]]:whitespace-normal">
      <DialogHeader className="shrink-0 border-b pb-4 pr-10"><TitleDescription /></DialogHeader>
      <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain py-4">
      {inlineError ? <Alert variant="destructive" role="alert"><AlertTitle>Action could not be completed</AlertTitle><AlertDescription>{inlineError}</AlertDescription></Alert> : null}
      {reconciliation ? <Alert variant="destructive" role="alert"><AlertTitle>{reconciliation.operation} needs reconciliation</AlertTitle><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>Writes are paused until the server confirms the original command.</span><Button variant="outline" size="sm" onClick={() => void reconcile()} disabled={reconciling}>{reconciling ? "Checking receipt…" : "Check receipt"}</Button></AlertDescription></Alert> : null}
      {staleMessage ? <Alert role="status"><AlertTitle>Refresh required</AlertTitle><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>{staleMessage}</span><Button variant="outline" size="sm" onClick={() => void refreshQueries()}>Refresh</Button></AlertDescription></Alert> : null}
       {/* The indexed editor intentionally keeps all operations visible in one compact workspace. */}
       {proposalQuery.isPending ? <ReadSkeleton /> : proposalQuery.error ? <Alert variant="destructive"><AlertTitle>Couldn’t load proposal</AlertTitle><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>{uiError(proposalQuery.error)}</span><Button variant="outline" size="sm" onClick={() => void refreshQueries()}>Refresh</Button></AlertDescription></Alert> : currentProposal && draft ? <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <section aria-labelledby="original-evidence" className="flex min-w-0 flex-col gap-4 border-t border-dashed py-5"><div><h2 id="original-evidence" className="text-sm font-semibold">Original evidence</h2><p className="text-xs text-muted-foreground">The source is read in its current revision; offsets are validated before display.</p></div>{sourceId ? sourceQuery.isPending ? <ReadSkeleton /> : sourceQuery.error ? <Alert variant="destructive"><AlertTitle>Couldn’t load source</AlertTitle><AlertDescription>{uiError(sourceQuery.error)}</AlertDescription></Alert> : source ? <><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">Revision {source.revision}</Badge><span className="text-xs text-muted-foreground">Received {formatInstant(source.receivedAt, "UTC")} UTC</span></div><p className="whitespace-pre-wrap rounded-xl border bg-background p-3 text-sm leading-6">{source.text}</p><div className="flex flex-col gap-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Highlighted quotes</h3>{evidence.length ? evidence.map((span) => <blockquote key={`${span.start}-${span.end}`} className="rounded-xl border-l-2 border-primary bg-primary/5 px-3 py-2 text-sm leading-6"><mark className="bg-primary/15">{source.text.slice(span.start, span.end)}</mark><span className="mt-1 block text-xs text-muted-foreground">Source offsets {span.start}–{span.end}</span></blockquote>) : <p className="text-sm text-muted-foreground">No validated evidence spans are attached.</p>}</div></> : null : <Card><CardHeader><CardTitle className="text-sm">Manual draft</CardTitle><CardDescription>No source text is fetched for manual proposals.</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><p className="whitespace-pre-wrap text-sm leading-6">{currentProposal.manualReason ?? "No manual reason supplied."}</p><p className="text-xs text-muted-foreground">Created {formatInstant(currentProposal.createdAt, "UTC")} UTC</p></CardContent></Card>}</section>
        <section aria-labelledby="proposed-change" className="flex min-w-0 flex-col gap-5 border-t border-dashed py-5"><div><h2 id="proposed-change" className="text-sm font-semibold">Proposed changes</h2><p className="text-xs text-muted-foreground">Edit only the selected indexed operation. Every other operation is preserved.</p></div><div className="flex flex-wrap items-center justify-between gap-3"><Badge variant={currentProposal.status === "needs_review" ? "secondary" : "outline"}>{currentProposal.status.replaceAll("_", " ")}</Badge><span className="text-xs text-muted-foreground">Draft revision {currentProposal.draftRevision}</span></div><Field><FieldLabel htmlFor="operation-index">Operation editor</FieldLabel><Select value={String(selectedOperation)} onValueChange={(value) => setSelectedOperation(Number(value))}><SelectTrigger id="operation-index" className="w-full"><SelectValue placeholder="Choose an operation" /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>All operations ({draft.operations.length})</SelectLabel>{draft.operations.map((operation, index) => <SelectItem key={index} value={String(index)}>{operationName(operation, index, aliases)}</SelectItem>)}</SelectGroup></SelectContent></Select><FieldDescription>Indexed editors prevent an edit from dropping sibling operations.</FieldDescription></Field>{selected ? <OperationEditor operation={selected} aliases={aliases} onChange={changeSelectedOperation} /> : <Alert><AlertTitle>No operations</AlertTitle><AlertDescription>This draft contains no proposed operations.</AlertDescription></Alert>}<FieldSet><FieldLegend variant="label">Missing fields</FieldLegend><FieldDescription>Resolve a field only after explicitly acknowledging it. Unresolved fields block preview and approval.</FieldDescription><div className="flex flex-col gap-2">{draft.missingFields.map((field) => <label key={field} className="flex min-w-0 items-start gap-3 rounded-xl border p-3 text-sm"><Checkbox checked={resolvedFields.has(field)} onCheckedChange={(checked) => { const next = new Set(resolvedFields); checked === true ? next.add(field) : next.delete(field); setResolvedFields(next); setPreview(null); }} /><span className="min-w-0">{field}<span className="mt-1 block text-xs text-muted-foreground">Mark as resolved</span></span></label>)}<div className="flex min-w-0 flex-wrap gap-2"><Input className="min-w-0 flex-1 basis-40" aria-label="Add missing field" value={newMissingField} onChange={(event) => setNewMissingField(event.target.value)} placeholder="Add a required detail" maxLength={200} /><Button type="button" variant="outline" onClick={addMissingField}>Add</Button></div>{effectiveMissingFields.length ? <p className="text-xs font-medium text-destructive">{effectiveMissingFields.length} unresolved field{effectiveMissingFields.length === 1 ? "" : "s"} still block approval.</p> : <p className="text-xs text-muted-foreground">All listed fields are explicitly acknowledged as resolved.</p>}</div></FieldSet><div className="flex flex-wrap items-center gap-2"><Button onClick={() => void editDraft()} disabled={writesBlocked || writesPending || !draftChanged}>{editMutation.isPending ? "Saving draft…" : "Save draft"}</Button><Button variant="outline" onClick={() => void previewDraft()} disabled={writesBlocked || writesPending || previewMutation.isPending || draftChanged || currentProposal.status !== "needs_review" || effectiveMissingFields.length > 0}>{previewMutation.isPending ? "Previewing…" : "Create fresh preview"}</Button></div>{preview ? <PreviewPanel preview={preview} aliases={aliases} supersessionAcknowledged={supersessionAcknowledged} lateChangeAcknowledged={lateChangeAcknowledged} onSupersession={setSupersessionAcknowledged} onLateChange={setLateChangeAcknowledged} /> : null}{preview && !previewIsSafe ? <Alert variant="destructive"><AlertTitle>Preview is stale</AlertTitle><AlertDescription>Refresh the proposal and create a new preview before approving.</AlertDescription></Alert> : null}<Card><CardHeader><CardTitle className="text-sm">Decision</CardTitle><CardDescription>Every disposition needs a reason. Defer also needs a service date.</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3"><Field><FieldLabel htmlFor="decision">Action</FieldLabel><Select value={decision} onValueChange={(value) => setDecision(value as typeof decision)}><SelectTrigger id="decision" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Decision</SelectLabel><SelectItem value="reject">Reject</SelectItem><SelectItem value="defer">Defer</SelectItem><SelectItem value="reopen">Reopen</SelectItem></SelectGroup></SelectContent></Select></Field>{decision === "defer" ? <Field><FieldLabel htmlFor="defer-date">Defer until</FieldLabel><Input id="defer-date" type="date" value={deferDate} onChange={(event) => setDeferDate(event.target.value)} required /></Field> : null}</div><Field><FieldLabel htmlFor="decision-reason">Reason</FieldLabel><Textarea id="decision-reason" value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} placeholder="Explain this decision" maxLength={1000} required /></Field><Button variant="outline" onClick={() => void dispose()} disabled={writesBlocked || writesPending || !decisionReason.trim() || (decision === "defer" && !deferDate)}>{dispositionMutation.isPending ? "Saving decision…" : `${decision[0].toUpperCase()}${decision.slice(1)} proposal`}</Button></CardContent></Card></section>
      </div> : null}
      </div>
      <DialogFooter className="shrink-0 border-t bg-popover pt-4"><Button variant="outline" onClick={onClose}>Close</Button><Button onClick={() => void approve()} disabled={writesBlocked || writesPending || approveMutation.isPending || !gate.allowed || !previewIsSafe}>{approveMutation.isPending ? "Approving…" : "Approve change"}</Button></DialogFooter>
      <p className="sr-only" aria-live="polite">{writesPending ? "Saving proposal" : writesBlocked ? "Waiting for command reconciliation" : preview ? `${preview.effects.length} effects and ${preview.totals.length} totals in preview` : "Proposal workspace ready"}</p>
    </DialogContent>
  </Dialog>;
}

function OperationEditor({ operation, aliases, onChange }: { operation: OrderOperation; aliases: Map<string, string>; onChange: (patch: Partial<OrderOperation>) => void }) {
  const customers = [...aliases.entries()];
  const customerField = <Field><FieldLabel>Customer</FieldLabel><Select value={operation.customerId} onValueChange={(value) => onChange({ customerId: value ?? operation.customerId })}><SelectTrigger className="w-full"><SelectValue>{aliases.get(operation.customerId) ?? operation.customerId}</SelectValue></SelectTrigger><SelectContent><SelectGroup><SelectLabel>Customers</SelectLabel>{customers.map(([id, alias]) => <SelectItem key={id} value={id}>{alias}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>;
  if (operation.type === "set_daily_quantity") return <FieldGroup><div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3">{customerField}<Field><FieldLabel htmlFor="operation-date">Service date</FieldLabel><Input id="operation-date" type="date" value={operation.serviceDate} onChange={(event) => onChange({ serviceDate: event.target.value })} /></Field></div><Field><FieldLabel htmlFor="operation-quantity">Quantity</FieldLabel><Input id="operation-quantity" type="number" min={0} max={1000} value={operation.quantity} onChange={(event) => onChange({ quantity: Math.min(1000, Math.max(0, Number(event.target.value) || 0)) })} /></Field></FieldGroup>;
  if (operation.type === "replace_recurring_plan") return <FieldGroup>{customerField}<div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3"><Field><FieldLabel htmlFor="plan-start">Start date</FieldLabel><Input id="plan-start" type="date" value={operation.startDate} onChange={(event) => onChange({ startDate: event.target.value })} /></Field><Field><FieldLabel htmlFor="plan-end">End date</FieldLabel><Input id="plan-end" type="date" value={operation.endDate ?? ""} onChange={(event) => onChange({ endDate: event.target.value || null })} /></Field></div><Field><FieldLabel>Seven-day quantities</FieldLabel><div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,6rem),1fr))] gap-2">{operation.quantities.map((quantity, index) => <Input key={index} aria-label={`Recurring quantity day ${index + 1}`} type="number" min={0} max={1000} value={quantity} onChange={(event) => { const quantities = [...operation.quantities] as [number, number, number, number, number, number, number]; quantities[index] = Math.min(1000, Math.max(0, Number(event.target.value) || 0)); onChange({ quantities }); }} />)}</div></Field></FieldGroup>;
  return <FieldGroup>{customerField}<div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3"><Field><FieldLabel htmlFor="interval-from">From date</FieldLabel><Input id="interval-from" type="date" value={operation.fromDate} onChange={(event) => onChange({ fromDate: event.target.value })} /></Field><Field><FieldLabel htmlFor="interval-to">To date</FieldLabel><Input id="interval-to" type="date" value={operation.toDate} onChange={(event) => onChange({ toDate: event.target.value })} /></Field></div><p className="text-xs text-muted-foreground">{operation.type === "pause_interval" ? "Pause quantities for this interval." : "Resume quantities for this interval."}</p></FieldGroup>;
}

function PreviewPanel({ preview, aliases, supersessionAcknowledged, lateChangeAcknowledged, onSupersession, onLateChange }: { preview: Preview; aliases: Map<string, string>; supersessionAcknowledged: boolean; lateChangeAcknowledged: boolean; onSupersession: (checked: boolean) => void; onLateChange: (checked: boolean) => void }) {
  const conflicts = preview.conflicts;
  return <Card className="bg-muted/20"><CardHeader><CardTitle className="text-sm">Fresh preview</CardTitle><CardDescription>{preview.affectedDates.length} affected dates · {preview.effects.length} effects · {preview.totals.length} totals{preview.continuesBeyondWindow ? " · more dates continue beyond this view" : ""}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4"><div className="min-w-0 rounded-xl border bg-background p-3"><div className="flex flex-col gap-4"><section><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">All totals ({preview.totals.length})</h3><div className="flex flex-col gap-2">{preview.totals.map((total) => <div key={total.serviceDate} className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b pb-2 text-sm"><span>{displayDate(total.serviceDate)}</span><span className="font-medium tabular-nums">{total.before} → {total.after}</span></div>)}</div></section><section><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">All customer effects ({preview.effects.length})</h3><div className="flex flex-col gap-2">{preview.effects.map((effect, index) => <div key={`${effect.customerId}-${effect.serviceDate}-${index}`} className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b pb-2 text-sm"><span>{aliases.get(effect.customerId) ?? effect.customerId} · {displayDate(effect.serviceDate)}</span><span className="font-medium tabular-nums">{effect.before} → {effect.after}</span></div>)}</div></section></div></div>{conflicts.length ? <Alert><AlertTitle>Supersession conflicts ({conflicts.length})</AlertTitle><AlertDescription className="flex flex-col gap-3"><p>These current approvals will be replaced only with your explicit acknowledgement.</p><div className="flex flex-col gap-2">{conflicts.map((conflict, index) => <div key={`${conflict.approvalId}-${conflict.serviceDate}-${index}`} className="rounded-xl border bg-background p-3 text-sm"><span className="font-medium">{aliases.get(conflict.customerId) ?? conflict.customerId}</span><span className="text-muted-foreground"> · {displayDate(conflict.serviceDate)} · current approval {conflict.approvalId} · {conflict.kind}</span></div>)}</div><label className="flex min-w-0 items-start gap-3 rounded-xl border p-3 text-sm"><Checkbox checked={supersessionAcknowledged} onCheckedChange={(checked) => onSupersession(checked === true)} /><span className="min-w-0">I acknowledge every listed current approval will be superseded.</span></label></AlertDescription></Alert> : null}{preview.requiredAcknowledgements.includes("late_change") ? <label className="flex min-w-0 items-start gap-3 rounded-xl border p-3 text-sm"><Checkbox checked={lateChangeAcknowledged} onCheckedChange={(checked) => onLateChange(checked === true)} /><span className="min-w-0">I acknowledge this change is late for the service date.</span></label> : null}</CardContent></Card>;
}
