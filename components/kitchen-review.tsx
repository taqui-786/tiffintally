"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowUpRight, ClipboardPen, Inbox } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { BackendOutput } from "@/lib/contracts/backend";
import { formatInstant, uiError } from "@/lib/client/ui-helpers";

type Read<T> = Pick<UseQueryResult<T>, "data" | "isPending" | "error" | "refetch">;
type Props = {
  sources: Read<BackendOutput<"listSources">>;
  proposals: Read<BackendOutput<"listProposals">>;
  customers: Read<BackendOutput<"listCustomers">>;
  capabilities: Read<BackendOutput<"capabilities">>;
  selectedDate: string;
  timezone: string;
  setSourceId: (id: string) => void;
  setProposalId: (id: string) => void;
  setConsentSourceId: (id: string) => void;
  compact?: boolean;
};

function RowsLoading() { return <div className="flex flex-col gap-5 py-5" aria-label="Loading review queue"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>; }
function ErrorNote({ error, retry }: { error: unknown; retry: () => void }) { return <Alert variant="destructive"><AlertTitle>Couldn’t load the queue</AlertTitle><AlertDescription>{uiError(error)}<Button variant="outline" size="sm" onClick={retry}>Retry</Button></AlertDescription></Alert>; }

export function KitchenReview({ sources, proposals, customers, capabilities, selectedDate, timezone, setSourceId, setProposalId, setConsentSourceId, compact = false }: Props) {
  const aliases = new Map(customers.data?.items.map((customer) => [customer._id, customer.alias]) ?? []);
  const sourceRows = compact ? sources.data?.items.slice(0, 3) : sources.data?.items;
  const proposalRows = compact ? proposals.data?.items.slice(0, 3) : proposals.data?.items;
  return <section aria-label="Meal request review" className="grid min-w-0 gap-10 wrap-anywhere xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:gap-12">
    <section aria-labelledby={compact ? "incoming-preview" : "incoming-full"} className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4"><div><p className="mb-2 font-mono text-[10px] tracking-[0.15em] text-muted-foreground">02 / INCOMING REQUESTS</p><h2 id={compact ? "incoming-preview" : "incoming-full"} className="flex items-center gap-2 font-heading text-2xl tracking-tight"><Inbox className="size-5 text-primary" strokeWidth={1.5} aria-hidden="true" />Fresh off the phone</h2></div>{sources.data && !sources.error ? <Badge variant="outline">{sources.data.items.length}{sources.data.nextCursor ? "+" : ""} in review</Badge> : null}</div>
      {sources.isPending ? <RowsLoading /> : sources.error ? <ErrorNote error={sources.error} retry={() => void sources.refetch()} /> : sourceRows?.length ? <ol className="divide-y">{sourceRows.map((source, index) => <li key={source._id} className="flex gap-4 py-5"><span className="pt-1 font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><div className="flex min-w-0 flex-1 flex-col gap-2"><div className="flex flex-wrap items-start justify-between gap-2"><h3 className="font-medium">{source.customerId ? aliases.get(source.customerId) ?? "Assigned customer" : "Customer to be identified"}</h3><Badge variant="secondary">{source.upstreamId?.includes("voice") ? "🎙️ Voice note · WhatsApp" : source.channel === "whatsapp" ? "WhatsApp" : "Pasted message"}</Badge></div><p className="text-xs text-muted-foreground">Received {formatInstant(source.receivedAt, timezone)}</p><div className="mt-1 flex flex-wrap gap-2"><Button variant="outline" className="min-h-10" onClick={() => setSourceId(source._id)}>Read request<ArrowUpRight data-icon="inline-end" strokeWidth={1.5} /></Button><Button variant="ghost" className="min-h-10" disabled={!capabilities.data?.ai.configured} onClick={() => setConsentSourceId(source._id)}>Draft with AI</Button></div></div></li>)}</ol> : <Empty className="px-0 py-8"><EmptyHeader><EmptyTitle>The inbox is clear.</EmptyTitle><EmptyDescription>New customer requests appear here. Nothing changes until it’s reviewed.</EmptyDescription></EmptyHeader></Empty>}
      {compact && (sources.data?.items.length ?? 0) > 3 ? <p className="pt-3 text-xs text-muted-foreground">Showing 3 of {sources.data!.items.length} loaded requests. Open Review for the full loaded queue.</p> : null}
    </section>
    <section aria-labelledby={compact ? "drafts-preview" : "drafts-full"} className="min-w-0 xl:border-l xl:pl-10">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-dashed pb-4"><div><p className="mb-2 font-mono text-[10px] tracking-[0.15em] text-muted-foreground">03 / CHANGE TICKETS</p><h2 id={compact ? "drafts-preview" : "drafts-full"} className="flex items-center gap-2 font-heading text-2xl tracking-tight"><ClipboardPen className="size-5 text-primary" strokeWidth={1.5} aria-hidden="true" />Your call, chef.</h2></div>{proposals.data && !proposals.error ? <Badge variant="outline">{proposals.data.items.length}{proposals.data.nextCursor ? "+" : ""} drafts</Badge> : null}</div>
      {proposals.isPending ? <RowsLoading /> : proposals.error ? <ErrorNote error={proposals.error} retry={() => void proposals.refetch()} /> : proposalRows?.length ? <ol className="divide-y">{proposalRows.map((proposal, index) => {
        const operation = proposal.operations[0];
        const description = operation?.type === "set_daily_quantity" ? `${operation.quantity} meals · ${operation.serviceDate}` : operation?.type === "replace_recurring_plan" ? "Recurring meal plan" : operation?.type === "pause_interval" ? "Pause meals" : operation?.type === "resume_interval" ? "Resume meals" : "Details needed";
        return <li key={proposal._id} className="flex gap-4 py-5"><span className="pt-1 font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><div className="flex min-w-0 flex-1 flex-col gap-2"><div className="flex flex-wrap items-start justify-between gap-2"><h3 className="font-medium">{operation ? aliases.get(operation.customerId) ?? "Customer change" : "Incomplete draft"}</h3><Badge variant="secondary">{proposal.missingFields.length ? "Needs details" : "Preview next"}</Badge></div><p className="text-sm text-muted-foreground">{description}{proposal.operations.length > 1 ? ` · +${proposal.operations.length - 1} more changes` : ""}</p><p className="text-xs text-muted-foreground">{proposal.missingFields.length ? `${proposal.missingFields.length} missing details to resolve` : "Check the before and after, then decide."}</p><Button variant="outline" className="mt-1 min-h-10 self-start" onClick={() => setProposalId(proposal._id)}>Review ticket<ArrowUpRight data-icon="inline-end" strokeWidth={1.5} /></Button></div></li>;
      })}</ol> : <Empty className="px-0 py-8"><EmptyHeader><EmptyTitle>No tickets waiting.</EmptyTitle><EmptyDescription>AI and manual drafts show here for an explicit decision. Kitchen board: {selectedDate}.</EmptyDescription></EmptyHeader></Empty>}
      {compact && (proposals.data?.items.length ?? 0) > 3 ? <p className="pt-3 text-xs text-muted-foreground">Showing 3 of {proposals.data!.items.length} loaded drafts. Open Review for the full loaded queue.</p> : null}
    </section>
  </section>;
}
