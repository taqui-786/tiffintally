"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { Check, ChefHat, ClipboardList, CookingPot, NotebookPen, PackageCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { uiError } from "@/lib/client/ui-helpers";
import type { BackendOutput } from "@/lib/contracts/backend";

type Read<T> = Pick<UseQueryResult<T>, "data" | "isPending" | "error" | "refetch">;
type Props = {
  day: Read<BackendOutput<"getDay">>;
  customers: Read<BackendOutput<"listCustomers">>;
  sources: Read<BackendOutput<"listSources">>;
  proposals: Read<BackendOutput<"listProposals">>;
  capabilities: Read<BackendOutput<"capabilities">>;
  forecasts: Read<BackendOutput<"listForecasts">>;
  settings: Read<BackendOutput<"getSettings">>;
  selectedDate: string;
  approvedTotal: number;
  onFinalize: () => void;
  onReview: () => void;
  onCustomers: () => void;
  finalizePending: boolean;
};

function ReadError({ error, retry }: { error: unknown; retry: () => void }) {
  return <Alert variant="destructive"><AlertTitle>Couldn’t load this part</AlertTitle><AlertDescription><span>{uiError(error)}</span><Button variant="outline" size="sm" onClick={retry}>Retry</Button></AlertDescription></Alert>;
}

export function KitchenOverview({ day, customers, sources, proposals, capabilities, forecasts, settings, selectedDate, approvedTotal, onFinalize, onReview, onCustomers, finalizePending }: Props) {
  const rows = day.data?.rows.filter((row) => row.approvalId !== null) ?? [];
  const ready = Boolean(day.data && !day.error && day.data.pendingCount === 0);
  const forecast = forecasts.data?.items.find((run) => run.runState === "succeeded" && run.result?.status === "available");
  const forecastDelta = forecast?.result?.roundedDelta;

  return <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_260px] lg:gap-12">
    <div className="flex min-w-0 flex-col gap-8">
      <section aria-labelledby="meal-count-heading" className="grid gap-6 border-b pb-8 sm:grid-cols-[1fr_1fr] sm:items-end">
        <div><h2 id="meal-count-heading" className="flex items-center gap-2 text-sm font-medium"><CookingPot className="size-4 text-primary" strokeWidth={1.5} aria-hidden="true" />On the stove today</h2>
          {day.isPending ? <Skeleton className="mt-4 h-24 w-36" /> : day.error ? <p className="mt-4 text-5xl text-muted-foreground">—</p> : <p className="mt-2 flex flex-wrap items-baseline gap-3"><span className="font-heading text-[clamp(4.5rem,9vw,7rem)] leading-none tracking-[-0.08em] tabular-nums">{approvedTotal}</span><span className="pb-2 text-base text-muted-foreground">approved meals</span></p>}
          <p className="mt-3 text-xs text-muted-foreground">{day.data && !day.error ? `${rows.length} customer${rows.length === 1 ? "" : "s"} on the approved plan` : "Confirmed quantities appear after the board loads."}</p>
        </div>
        <dl className="grid grid-cols-2 gap-6 sm:border-l sm:pl-7">
          <div><dt className="text-xs text-muted-foreground">Active regulars</dt><dd className="mt-2 font-heading text-3xl tabular-nums">{customers.isPending || customers.error ? "—" : `${customers.data?.items.length ?? 0}${customers.data?.nextCursor ? "+" : ""}`}</dd><dd className="mt-1"><Button variant="link" className="min-h-10 px-0" onClick={onCustomers}>Customer book</Button></dd></div>
          <div><dt className="text-xs text-muted-foreground">Changes pending</dt><dd className="mt-2 font-heading text-3xl tabular-nums">{day.isPending || day.error ? "—" : day.data?.pendingCount ?? 0}</dd><dd className="mt-1"><Button variant="link" className="min-h-10 px-0" onClick={onReview}>Review requests</Button></dd></div>
        </dl>
      </section>

      <section aria-labelledby="packing-ledger-heading" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="mb-2 font-mono text-[10px] tracking-[0.15em] text-muted-foreground">01 / PACKING LEDGER</p><h2 id="packing-ledger-heading" className="font-heading text-2xl tracking-tight">Every name. The right number.</h2><p className="mt-2 text-sm text-muted-foreground">Approved quantities and the little details that matter at packing time.</p></div><Badge variant="outline">{day.isPending ? "Loading" : day.error ? "Unavailable" : ready ? "Review clear" : "Review pending"}</Badge></div>
        {day.isPending ? <div className="flex flex-col gap-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div> : day.error ? <ReadError error={day.error} retry={() => void day.refetch()} /> : rows.length ? <Table><TableHeader><TableRow><TableHead className="w-12">No.</TableHead><TableHead>Customer / packing note</TableHead><TableHead className="text-right">Meals</TableHead></TableRow></TableHeader><TableBody>{rows.map((row, index) => <TableRow key={row.customerId}><TableCell className="align-top py-5 font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</TableCell><TableCell className="py-4"><span className="block font-medium">{row.alias}</span><span className="mt-1 block max-w-lg whitespace-normal text-xs leading-relaxed text-muted-foreground">{row.packingNote || "No special packing note"}</span></TableCell><TableCell className="py-4 text-right font-heading text-2xl tabular-nums">{row.quantity}</TableCell></TableRow>)}</TableBody></Table> : <Empty className="items-start px-0 py-8 text-left"><EmptyHeader className="items-start"><EmptyTitle>The sheet is still blank.</EmptyTitle><EmptyDescription>Add your regulars and approve a meal plan. Confirmed quantities will appear here.</EmptyDescription></EmptyHeader><Button variant="outline" className="min-h-10" onClick={onCustomers}>Open customer book</Button></Empty>}
        <div className="flex flex-wrap items-center justify-between gap-4 border-y border-dashed py-4"><div><p className="text-sm font-medium">{day.data?.latestSheetId ? "A packing revision is on file" : "Ready when you are"}</p><p className="mt-1 text-xs text-muted-foreground">{day.data?.pendingCount ? "Review pending changes before finalising." : "Finalising saves an immutable packing sheet."}</p></div><Button className="min-h-11" onClick={onFinalize} disabled={finalizePending || !ready}><PackageCheck data-icon="inline-start" strokeWidth={1.5} />Finalize sheet</Button></div>
      </section>
    </div>

    <aside aria-label="Kitchen preparation notes" className="flex min-w-0 flex-col gap-8 lg:pt-1">
      <section className="relative border-y border-dashed bg-muted/30 px-5 py-6"><ChefHat className="mb-5 size-8 text-primary" strokeWidth={1.5} aria-hidden="true" /><h2 className="font-heading text-xl tracking-tight">The prep list</h2><p className="mt-2 text-xs leading-relaxed text-muted-foreground">A small order of operations before the lids go on.</p><ol className="mt-6 flex flex-col gap-5">
        <li className="flex items-start gap-3"><NotebookPen className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={1.5} aria-hidden="true" /><div><p className="text-sm font-medium">Read the requests</p><p className="mt-1 text-xs text-muted-foreground">{sources.isPending || sources.error ? "Inbox count unavailable" : `${sources.data?.items.length ?? 0}${sources.data?.nextCursor ? "+" : ""} messages in review`}</p></div></li>
        <li className="flex items-start gap-3"><ClipboardList className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={1.5} aria-hidden="true" /><div><p className="text-sm font-medium">Check the changes</p><p className="mt-1 text-xs text-muted-foreground">{proposals.isPending || proposals.error ? "Draft count unavailable" : `${proposals.data?.items.length ?? 0}${proposals.data?.nextCursor ? "+" : ""} drafts awaiting a decision`}</p></div></li>
        <li className="flex items-start gap-3"><Check className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={1.5} aria-hidden="true" /><div><p className="text-sm font-medium">Seal the sheet</p><p className="mt-1 text-xs text-muted-foreground">{day.data?.latestSheetId ? "A revision has been finalised" : "Your final approval comes first"}</p></div></li>
      </ol></section>
      <section className="flex flex-col gap-4"><div><h2 className="font-heading text-lg tracking-tight">A note for planning</h2><p className="mt-1 text-xs text-muted-foreground">Advisory only. Never added to the packing total.</p></div>
        {capabilities.isPending ? <Skeleton className="h-20 w-full" /> : capabilities.error ? <ReadError error={capabilities.error} retry={() => void capabilities.refetch()} /> : !capabilities.data?.forecasting.configured ? <p className="text-sm leading-relaxed text-muted-foreground">Forecasting isn’t configured. Work from your approved plan.</p> : forecasts.isPending ? <Skeleton className="h-20 w-full" /> : forecasts.error ? <ReadError error={forecasts.error} retry={() => void forecasts.refetch()} /> : forecast && typeof forecastDelta === "number" ? <div><p className="font-heading text-3xl tabular-nums">{forecastDelta > 0 ? "+" : ""}{forecastDelta}<span className="ml-2 text-sm text-muted-foreground">meals vs baseline</span></p><p className="mt-2 text-xs text-muted-foreground">Model estimate from {forecast.result!.trainingRows} training rows.</p></div> : <p className="text-sm leading-relaxed text-muted-foreground">No available forecast for this service date.</p>}
        <Separator /><p className="text-xs leading-relaxed text-muted-foreground">Service date: {selectedDate}<br />Kitchen timezone: {settings.data?.settings.timezone ?? "Loading…"}</p>
      </section>
    </aside>
  </div>;
}
