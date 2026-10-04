"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArchiveIcon, CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon, EllipsisIcon, PencilIcon, PlusIcon, RotateCcwIcon, SearchIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KitchenPaper as Card, KitchenPaperAction as CardAction, KitchenPaperContent as CardContent, KitchenPaperDescription as CardDescription, KitchenPaperHeader as CardHeader, KitchenPaperTitle as CardTitle } from "@/components/kitchen-paper";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ClientError, getOperation } from "@/lib/client/api";
import { createCustomerMutationOptions, createProposalMutationOptions, newCommandMeta, updateCustomerMutationOptions, updateSettingsMutationOptions } from "@/lib/client/mutations";
import { capabilitiesQueryOptions, customerScheduleQueryOptions, customersQueryOptions, settingsQueryOptions } from "@/lib/client/queries";
import type { BackendOutput } from "@/lib/contracts/backend";
import { settingsSchema, type Settings } from "@/lib/contracts/records";

type Customer = BackendOutput<"listCustomers">["items"][number];
type Schedule = BackendOutput<"getSchedule">;
type CommandOutput = BackendOutput<"createCustomer">;
type CustomerStatus = "active" | "archived";
type ProposalMode = "one_day" | "pause" | "resume" | "recurring";
type PendingCommand = { idempotencyKey: string; label: string; retry: () => Promise<unknown> };

const uiError = (error: unknown) => error instanceof ClientError ? error.message : "This action could not be completed.";
const isUncertain = (error: unknown) => error instanceof TypeError || (error instanceof ClientError && (error.retryable || (error.status !== undefined && error.status >= 500)));
const serviceToday = (timezone: string) => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); } catch { return ""; } };

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dateAfter = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const formatDate = (date: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${date}T12:00:00Z`));
const receiptText = (output: unknown) => {
  const result = output as Partial<CommandOutput>;
  const warnings = [...(result.warnings ?? []), ...(result.receipt?.warnings ?? [])];
  return warnings.length ? warnings.join(" ") : undefined;
};

function StatusBadge({ status }: { status: string }) {
  return <Badge variant={status === "active" || status === "approved" ? "default" : "secondary"}>{status.replaceAll("_", " ")}</Badge>;
}

function LoadingRows() {
  return <div className="flex flex-col gap-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-4/5" /></div>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <Empty><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>;
}

function ErrorState({ error, retry }: { error: unknown; retry: () => void }) {
  return <Alert variant="destructive"><AlertTitle>Couldn’t load this section</AlertTitle><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>{uiError(error)}</span><Button size="sm" variant="outline" onClick={retry}>Retry</Button></AlertDescription></Alert>;
}

function useCommandGuard(sellerId: string) {
  const [uncertain, setUncertain] = useState<PendingCommand | null>(null);
  const queryClient = useQueryClient();

  const announce = (label: string, output: unknown) => {
    const warning = receiptText(output);
    toast.success(label);
    if (warning) toast.warning(warning);
  };

  async function run<T extends Record<string, unknown>>(label: string, makeVariables: (stateRevision: number, idempotencyKey: string) => T, mutate: (variables: T) => Promise<unknown>) {
    if (uncertain) {
      toast.warning("Reconcile the previous request before making another change.");
      throw new ClientError("COMMIT_UNCERTAIN", "Reconcile the previous request before making another change.");
    }
    const idempotencyKey = newCommandMeta().idempotencyKey;
    const me = await getOperation("me", {});
    const variables = makeVariables(me.stateRevision, idempotencyKey);
    const retry = async () => {
      await getOperation("me", {});
      return mutate(variables);
    };
    try {
      const output = await mutate(variables);
      announce(label, output);
      return output;
    } catch (error) {
      if (isUncertain(error)) setUncertain({ idempotencyKey, label, retry });
      throw error;
    }
  }

  async function reconcile() {
    if (!uncertain) return;
    try {
      const receipt = await getOperation("getReceipt", { idempotencyKey: uncertain.idempotencyKey });
      setUncertain(null);
      announce("Request reconciled", receipt);
      await queryClient.invalidateQueries({ queryKey: ["taptutor", sellerId] });
    } catch (error) {
      toast.error(`Receipt not found yet: ${uiError(error)}`);
    }
  }

  async function retryUncertain() {
    if (!uncertain) return;
    try {
      const output = await uncertain.retry();
      setUncertain(null);
      announce(`${uncertain.label} completed`, output);
      await queryClient.invalidateQueries({ queryKey: ["taptutor", sellerId] });
    } catch (error) {
      if (!isUncertain(error)) setUncertain(null);
      toast.error(uiError(error));
    }
  }

  return { uncertain, run, reconcile, retryUncertain };
}

function UncertainNotice({ guard }: { guard: ReturnType<typeof useCommandGuard> }) {
  if (!guard.uncertain) return null;
  return <Alert variant="destructive"><AlertTitle>Request outcome is uncertain</AlertTitle><AlertDescription className="flex min-w-0 flex-wrap items-center justify-between gap-3 [overflow-wrap:anywhere]"><span>Request key <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{guard.uncertain.idempotencyKey}</code> is being held. Reconcile it before accepting another write.</span><span className="flex min-w-0 flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => void guard.reconcile()}>Check receipt</Button><Button size="sm" onClick={() => void guard.retryUncertain()}>Retry same request</Button></span></AlertDescription></Alert>;
}

function CustomerFormDialog({ open, onOpenChange, customer, onSave, pending }: { open: boolean; onOpenChange: (open: boolean) => void; customer?: Customer; onSave: (alias: string, packingNote: string) => Promise<void>; pending: boolean }) {
  const [alias, setAlias] = useState("");
  const [packingNote, setPackingNote] = useState("");
  const [error, setError] = useState("");
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (open) { setAlias(customer?.alias ?? ""); setPackingNote(customer?.packingNote ?? ""); setError(""); } }, [customer, open]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!alias.trim()) { setError("Add a customer name."); return; }
    if (packingNote.length > 500) { setError("Packing notes must be 500 characters or fewer."); return; }
    setError("");
    try { await onSave(alias.trim(), packingNote); onOpenChange(false); } catch (cause) { setError(uiError(cause)); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 p-4 [overflow-wrap:anywhere] sm:p-6 [&_[data-slot=field]]:min-w-0 [&_[data-slot=field-label]]:whitespace-normal"><DialogHeader className="shrink-0 pr-12"><DialogTitle>{customer ? "Edit customer" : "Add customer"}</DialogTitle><DialogDescription>{customer ? "Update the customer record without changing approved quantities." : "Create a customer for future planning."}</DialogDescription></DialogHeader><form className="flex min-h-0 min-w-0 flex-1 flex-col gap-4" onSubmit={(event) => void submit(event)}><FieldGroup className="min-h-0 min-w-0 overflow-y-auto overscroll-contain"><Field data-invalid={!!error}><FieldLabel htmlFor="customer-alias">Customer name</FieldLabel><Input id="customer-alias" value={alias} onChange={(event) => setAlias(event.target.value)} maxLength={120} aria-invalid={!!error} autoFocus /><FieldError>{error}</FieldError></Field><Field><FieldLabel htmlFor="customer-note">Packing note</FieldLabel><Textarea id="customer-note" value={packingNote} onChange={(event) => setPackingNote(event.target.value)} maxLength={500} rows={4} /><FieldDescription>{packingNote.length}/500 characters</FieldDescription></Field></FieldGroup><DialogFooter className="shrink-0 border-t pt-4"><DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose><Button type="submit" disabled={pending}>{customer ? "Save changes" : "Add customer"}</Button></DialogFooter></form></DialogContent></Dialog>;
}

function ScheduleDialog({ customer, serviceDate, onOpenChange, sellerId }: { customer?: Customer; serviceDate: string; onOpenChange: (open: boolean) => void; sellerId: string }) {
  const schedule = useQuery({ ...customerScheduleQueryOptions(sellerId, { customerId: customer?._id ?? "pending", fromDate: serviceDate, toDate: dateAfter(serviceDate, 6) }), enabled: !!customer });
  return <Dialog open={!!customer} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 p-4 [overflow-wrap:anywhere] sm:max-w-2xl sm:p-6"><DialogHeader className="shrink-0 pr-12"><DialogTitle>Schedule details</DialogTitle></DialogHeader><div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain"><DialogDescription>{customer?.alias} · {formatDate(serviceDate)} through {formatDate(dateAfter(serviceDate, 6))}</DialogDescription>{schedule.isPending ? <LoadingRows /> : schedule.error ? <ErrorState error={schedule.error} retry={() => void schedule.refetch()} /> : schedule.data ? <ScheduleDetails schedule={schedule.data} /> : null}</div><DialogFooter className="shrink-0 border-t pt-4"><DialogClose render={<Button variant="outline" />}>Close</DialogClose></DialogFooter></DialogContent></Dialog>;
}

function ScheduleDetails({ schedule }: { schedule: Schedule }) {
  return <div className="flex min-w-0 flex-col gap-5"><div className="grid min-w-0 gap-3 sm:grid-cols-2">{schedule.days.map((day) => <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-2xl border bg-muted/20 px-4 py-3" key={day.serviceDate}><span className="text-sm">{formatDate(day.serviceDate)}</span><span className="font-semibold tabular-nums">{day.quantity}</span></div>)}</div><div className="grid min-w-0 gap-3 sm:grid-cols-2"><Card><CardHeader><CardTitle className="text-base">Recurring plans</CardTitle></CardHeader><CardContent className="flex flex-col gap-2 text-sm">{schedule.plans.length ? schedule.plans.map((plan) => <div className="min-w-0 rounded-xl bg-muted/30 p-3" key={plan._id}><div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><span>{formatDate(plan.startDate)} → {plan.endDate ? formatDate(plan.endDate) : "ongoing"}</span><Badge className="max-w-full whitespace-normal" variant="outline">{plan.quantities.join(" · ")}</Badge></div></div>) : <p className="text-muted-foreground">No recurring plan in this window.</p>}</CardContent></Card><Card><CardHeader><CardTitle className="text-base">Overrides</CardTitle></CardHeader><CardContent className="flex flex-col gap-2 text-sm">{schedule.overrides.length ? schedule.overrides.map((override) => <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/30 p-3" key={override._id}><span>{formatDate(override.serviceDate)}</span><Badge variant={override.kind === "pause" ? "secondary" : "outline"}>{override.kind === "pause" ? "Paused" : `${override.quantity} meals`}</Badge></div>) : <p className="text-muted-foreground">No one-day overrides in this window.</p>}</CardContent></Card></div></div>;
}

function ManualProposalDialog({ open, onOpenChange, customer, customers, serviceDate, settings, onCreate, pending }: { open: boolean; onOpenChange: (open: boolean) => void; customer?: Customer; customers: Customer[]; serviceDate: string; settings?: Settings; onCreate: (customerId: string, mode: ProposalMode, startDate: string, endDate: string, quantities: [number, number, number, number, number, number, number], reason: string) => Promise<void>; pending: boolean }) {
  const [customerId, setCustomerId] = useState("");
  const [mode, setMode] = useState<ProposalMode>("one_day");
  const [startDate, setStartDate] = useState(serviceDate);
  const [endDate, setEndDate] = useState(serviceDate);
  const [quantities, setQuantities] = useState([0, 0, 0, 0, 0, 0, 0]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const openCustomerId = customer?._id;
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (open) { setCustomerId(openCustomerId ?? customers[0]?._id ?? ""); setMode("one_day"); setStartDate(serviceDate); setEndDate(serviceDate); setQuantities([0, 0, 0, 0, 0, 0, 0]); setReason(""); setError(""); } }, [customers, open, openCustomerId, serviceDate]);
  const openDays = settings?.weekdays ?? [1, 2, 3, 4, 5, 6, 7];
  function setQuantity(index: number, value: string) { const cap = settings?.quantityCap ?? 1000; setQuantities((current) => current.map((quantity, item) => item === index ? (openDays.includes(index + 1) ? Math.min(cap, Math.max(0, Number(value) || 0)) : 0) : quantity)); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customerId) { setError("Choose a customer."); return; }
    if (!reason.trim()) { setError("Add a manual reason for the proposal."); return; }
    if (startDate > endDate) { setError("The end date must be on or after the start date."); return; }
    if ((mode === "one_day" || mode === "recurring") && quantities.every((quantity) => quantity === 0)) { setError("Add at least one meal quantity."); return; }
    setError("");
    try { await onCreate(customerId, mode, startDate, endDate, quantities as [number, number, number, number, number, number, number], reason.trim()); onOpenChange(false); } catch (cause) { setError(uiError(cause)); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 p-4 [overflow-wrap:anywhere] sm:max-w-2xl sm:p-6 [&_[data-slot=field]]:min-w-0 [&_[data-slot=field-set]]:min-w-0 [&_[data-slot=field-label]]:whitespace-normal"><DialogHeader className="shrink-0 pr-12"><DialogTitle>Create manual proposal</DialogTitle><DialogDescription>Creates a draft for the dashboard review queue. Nothing is approved automatically.</DialogDescription></DialogHeader><form className="flex min-h-0 min-w-0 flex-1 flex-col gap-4" onSubmit={(event) => void submit(event)}><FieldGroup className="min-h-0 min-w-0 overflow-y-auto overscroll-contain"><Field><FieldLabel>Customer</FieldLabel><Select value={customerId} onValueChange={(value) => setCustomerId(value ?? "")}><SelectTrigger className="w-full"><SelectValue placeholder="Choose a customer" /></SelectTrigger><SelectContent><SelectGroup>{customers.map((item) => <SelectItem key={item._id} value={item._id}>{item.alias}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel>Change type</FieldLabel><ToggleGroup value={[mode]} onValueChange={(values) => { if (values[0]) setMode(values[0] as ProposalMode); }} variant="outline" className="max-w-full flex-wrap [&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal"><ToggleGroupItem value="one_day">One day</ToggleGroupItem><ToggleGroupItem value="pause">Pause</ToggleGroupItem><ToggleGroupItem value="resume">Resume</ToggleGroupItem><ToggleGroupItem value="recurring">Recurring plan</ToggleGroupItem></ToggleGroup></Field><div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-4"><Field><FieldLabel htmlFor="proposal-start">{mode === "one_day" ? "Service date" : "Start date"}</FieldLabel><Input id="proposal-start" type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); if (mode === "one_day") setEndDate(event.target.value); }} required /></Field>{mode !== "one_day" && <Field><FieldLabel htmlFor="proposal-end">End date</FieldLabel><Input id="proposal-end" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></Field>}</div>{(mode === "one_day" || mode === "recurring") && <FieldSet><FieldLegend variant="label">{mode === "recurring" ? "Monday-first weekly quantities" : "Quantity"}</FieldLegend>{mode === "recurring" ? <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,6rem),1fr))] gap-3">{DAYS.map((day, index) => { const closed = !openDays.includes(index + 1); return <Field key={day} data-disabled={closed}><FieldLabel htmlFor={`quantity-${index}`}>{day}{closed ? " · closed" : ""}</FieldLabel><Input id={`quantity-${index}`} type="number" min={0} max={1000} value={closed ? 0 : quantities[index]} disabled={closed} onChange={(event) => setQuantity(index, event.target.value)} /></Field>; })}</div> : <Input type="number" min={0} max={1000} value={quantities[0]} onChange={(event) => setQuantity(0, event.target.value)} />}</FieldSet>}<Field data-invalid={!!error}><FieldLabel htmlFor="proposal-reason">Manual reason</FieldLabel><Textarea id="proposal-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={3} placeholder="Why should this change be reviewed?" aria-invalid={!!error} required /><FieldDescription>{reason.length}/1000 characters</FieldDescription><FieldError>{error}</FieldError></Field></FieldGroup><DialogFooter className="shrink-0 border-t pt-4"><DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose><Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create draft"}</Button></DialogFooter></form></DialogContent></Dialog>;
}

export function CustomersPanel({ sellerId, serviceDate }: { sellerId: string; serviceDate: string }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<CustomerStatus>("active");
  const [search, setSearch] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCursors, setPageCursors] = useState<Array<string | undefined>>([undefined]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Customer>();
  const [scheduleCustomer, setScheduleCustomer] = useState<Customer>();
  const [proposalCustomer, setProposalCustomer] = useState<Customer>();
  const [proposalOpen, setProposalOpen] = useState(false);
  const customersQuery = useQuery(customersQueryOptions(sellerId, { status, limit: 25, ...(pageCursors[pageIndex] ? { cursor: pageCursors[pageIndex] } : {}) }));
  const settingsQuery = useQuery(settingsQueryOptions(sellerId));
  const createCustomer = useMutation(createCustomerMutationOptions(queryClient, sellerId));
  const updateCustomer = useMutation(updateCustomerMutationOptions(queryClient, sellerId));
  const createProposal = useMutation(createProposalMutationOptions(queryClient, sellerId));
  const guard = useCommandGuard(sellerId);
  const loadedCustomers = useMemo(() => customersQuery.data?.items ?? [], [customersQuery.data?.items]);
  const filteredCustomers = useMemo(() => { const needle = search.trim().toLocaleLowerCase(); return needle ? loadedCustomers.filter((item) => `${item.alias} ${item.packingNote}`.toLocaleLowerCase().includes(needle)) : loadedCustomers; }, [loadedCustomers, search]);

  function changeStatus(next: CustomerStatus) { setStatus(next); setSearch(""); setPageIndex(0); setPageCursors([undefined]); }
  async function saveCustomer(alias: string, packingNote: string) {
    if (editing) {
      const fresh = await getOperation("getCustomer", { customerId: editing._id });
      await guard.run("Customer updated", (stateRevision, idempotencyKey) => ({ meta: { idempotencyKey }, expectedStateRevision: stateRevision, customerId: editing._id, expectedCustomerRevision: fresh.revision, alias, packingNote }), (variables) => updateCustomer.mutateAsync(variables));
    } else {
      await guard.run("Customer added", (stateRevision, idempotencyKey) => ({ meta: { idempotencyKey }, expectedStateRevision: stateRevision, alias, packingNote }), (variables) => createCustomer.mutateAsync(variables));
    }
    setEditing(undefined);
  }
  async function setCustomerStatus(customer: Customer, nextStatus: CustomerStatus) {
    try {
      const fresh = await getOperation("getCustomer", { customerId: customer._id });
      await guard.run(nextStatus === "archived" ? "Customer archived" : "Customer reopened", (stateRevision, idempotencyKey) => ({ meta: { idempotencyKey }, expectedStateRevision: stateRevision, customerId: customer._id, expectedCustomerRevision: fresh.revision, status: nextStatus }), (variables) => updateCustomer.mutateAsync(variables));
    } catch (error) { toast.error(uiError(error)); }
  }
  async function createManualProposal(customerId: string, mode: ProposalMode, startDate: string, endDate: string, quantities: [number, number, number, number, number, number, number], reason: string) {
    const operation = mode === "one_day" ? { type: "set_daily_quantity" as const, customerId, serviceDate: startDate, quantity: quantities[0] } : mode === "recurring" ? { type: "replace_recurring_plan" as const, customerId, startDate, endDate: endDate || null, quantities } : { type: mode === "pause" ? "pause_interval" as const : "resume_interval" as const, customerId, fromDate: startDate, toDate: endDate };
    await guard.run("Manual proposal created", (stateRevision, idempotencyKey) => ({ meta: { idempotencyKey }, expectedStateRevision: stateRevision, sourceId: null, expectedSourceRevision: null, manualReason: reason, operations: [operation], missingFields: [], evidenceSpans: [] }), (variables) => createProposal.mutateAsync(variables));
  }
  const pending = createCustomer.isPending || updateCustomer.isPending || createProposal.isPending;
  return <section className="flex min-w-0 flex-col gap-6 [overflow-wrap:anywhere]">
    <UncertainNotice guard={guard} />
    <Card><CardHeader><CardTitle>Customers</CardTitle><CardDescription>Search and act on records loaded for this page. Customer changes never approve meal proposals.</CardDescription><CardAction><Button onClick={() => { setEditing(undefined); setFormOpen(true); }}><PlusIcon data-icon="inline-start" />Add customer</Button></CardAction></CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex min-w-0 flex-col justify-between gap-3 lg:flex-row lg:items-center">
          <ToggleGroup className="max-w-full flex-wrap [&_button]:min-h-11 [&_button]:whitespace-normal" value={[status]} onValueChange={(values) => { if (values[0]) changeStatus(values[0] as CustomerStatus); }} variant="outline"><ToggleGroupItem value="active">Active</ToggleGroupItem><ToggleGroupItem value="archived">Archived</ToggleGroupItem></ToggleGroup>
          <Field className="min-w-0 lg:max-w-sm"><FieldLabel className="sr-only" htmlFor="customer-search">Search loaded customers</FieldLabel><div className="relative min-w-0"><SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input id="customer-search" className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search loaded customers" /></div></Field>
        </div>
        {customersQuery.isPending ? <LoadingRows /> : customersQuery.error ? <ErrorState error={customersQuery.error} retry={() => void customersQuery.refetch()} /> : filteredCustomers.length ? <>
          <p id="customer-table-scroll-hint" className="text-xs text-muted-foreground">Scroll horizontally to see all customer columns on smaller screens.</p>
          <div role="region" aria-label="Customers" aria-describedby="customer-table-scroll-hint" tabIndex={0} className="min-w-0 max-w-full overflow-x-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&>[data-slot=table-container]]:overflow-visible">
            <Table className="min-w-[36rem] table-fixed [&_th]:whitespace-normal [&_td]:whitespace-normal"><TableHeader><TableRow><TableHead className="w-36">Customer</TableHead><TableHead>Packing note</TableHead><TableHead className="w-28">Status</TableHead><TableHead className="w-20 text-right">Actions</TableHead></TableRow></TableHeader><TableBody>
              {filteredCustomers.map((customer) => <TableRow key={customer._id}>
                <TableCell className="font-medium">{customer.alias}</TableCell><TableCell className="whitespace-pre-wrap text-muted-foreground">{customer.packingNote || "—"}</TableCell><TableCell><StatusBadge status={customer.status} /></TableCell>
                <TableCell className="text-right"><DropdownMenu>
                  <DropdownMenuTrigger render={<Button size="icon" variant="ghost" aria-label={`Actions for ${customer.alias}`} />}><EllipsisIcon /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end"><DropdownMenuGroup>
                    <DropdownMenuLabel>Customer actions</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => { setEditing(customer); setFormOpen(true); }}><PencilIcon data-icon="inline-start" />Edit</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setScheduleCustomer(customer)}><CalendarDaysIcon data-icon="inline-start" />Schedule details</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => { setProposalCustomer(customer); setProposalOpen(true); }}><PlusIcon data-icon="inline-start" />Manual proposal</DropdownMenuItem>
                  </DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuGroup>
                    <DropdownMenuItem variant={customer.status === "active" ? "destructive" : "default"} onClick={() => void setCustomerStatus(customer, customer.status === "active" ? "archived" : "active")}><>{customer.status === "active" ? <ArchiveIcon data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}</>{customer.status === "active" ? "Archive" : "Reopen"}</DropdownMenuItem>
                  </DropdownMenuGroup></DropdownMenuContent>
                </DropdownMenu></TableCell>
              </TableRow>)}
            </TableBody></Table>
          </div>
        </> : <EmptyState title={search ? "No loaded matches" : `No ${status} customers`} description={search ? "Search only covers the records currently loaded on this page." : status === "active" ? "Add a customer to begin planning." : "Archived customers will appear here."} />}
        {(pageIndex > 0 || customersQuery.data?.nextCursor) && <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-muted-foreground">Page {pageIndex + 1}</p><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={pageIndex === 0} onClick={() => setPageIndex((value) => value - 1)}><ChevronLeftIcon data-icon="inline-start" />Previous</Button><Button variant="outline" size="sm" disabled={!customersQuery.data?.nextCursor} onClick={() => { if (customersQuery.data?.nextCursor) { setPageCursors((values) => [...values, customersQuery.data?.nextCursor ?? undefined]); setPageIndex((value) => value + 1); } }}><ChevronRightIcon data-icon="inline-end" />Next</Button></div></div>}
      </CardContent>
    </Card>
    <CustomerFormDialog open={formOpen} onOpenChange={(open) => { setFormOpen(open); if (!open) setEditing(undefined); }} customer={editing} onSave={saveCustomer} pending={pending} />
    <ScheduleDialog customer={scheduleCustomer} serviceDate={serviceDate} onOpenChange={(open) => { if (!open) setScheduleCustomer(undefined); }} sellerId={sellerId} />
    <ManualProposalDialog open={proposalOpen} onOpenChange={(open) => { setProposalOpen(open); if (!open) setProposalCustomer(undefined); }} customer={proposalCustomer} customers={loadedCustomers.filter((item) => item.status === "active")} serviceDate={serviceDate} settings={settingsQuery.data?.settings} onCreate={createManualProposal} pending={pending} />
  </section>;
}

function settingErrors(result: ReturnType<typeof settingsSchema.safeParse>) {
  if (result.success) return { form: "", fields: {} as Partial<Record<keyof Settings, string>> };
  const fields: Partial<Record<keyof Settings, string>> = {};
  result.error.issues.forEach((issue) => { const field = issue.path[0] as keyof Settings | undefined; if (field && !fields[field]) fields[field] = issue.message; });
  return { form: result.error.issues.find((issue) => issue.path.length === 0)?.message ?? "Review the highlighted settings.", fields };
}

export function SettingsPanel({ sellerId }: { sellerId: string }) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(settingsQueryOptions(sellerId));
  const capabilitiesQuery = useQuery(capabilitiesQueryOptions(sellerId));
  const updateSettings = useMutation(updateSettingsMutationOptions(queryClient, sellerId));
  const guard = useCommandGuard(sellerId);
  const [form, setForm] = useState<Settings>();
  const [errors, setErrors] = useState<{ form: string; fields: Partial<Record<keyof Settings, string>> }>({ form: "", fields: {} });
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (settingsQuery.data?.settings) setForm(settingsQuery.data.settings); }, [settingsQuery.data]);
  function update<K extends keyof Settings>(key: K, value: Settings[K]) { setForm((current) => current ? { ...current, [key]: value } : current); setErrors({ form: "", fields: {} }); }
  function toggleWeekday(day: number, checked: boolean) { const weekdays = form?.weekdays ?? []; update("weekdays", checked ? [...weekdays, day].sort((a, b) => a - b) : weekdays.filter((value) => value !== day)); }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    const parsed = settingsSchema.safeParse(form);
    const nextErrors = settingErrors(parsed);
    if (!parsed.success) { setErrors(nextErrors); return; }
    setErrors({ form: "", fields: {} });
    try {
      await guard.run("Settings saved", (stateRevision, idempotencyKey) => ({ meta: { idempotencyKey }, expectedStateRevision: stateRevision, settings: parsed.data }), (variables) => updateSettings.mutateAsync(variables));
    } catch (error) { toast.error(uiError(error)); }
  }
  const field = (key: keyof Settings) => errors.fields[key];
  return <section className="flex min-w-0 flex-col gap-6 [overflow-wrap:anywhere]"><UncertainNotice guard={guard} /><div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]"><Card><CardHeader><CardTitle>Planning settings</CardTitle><CardDescription>Validated policy values used by planning and cutoff checks.</CardDescription></CardHeader><CardContent>{settingsQuery.isPending || !form ? <LoadingRows /> : settingsQuery.error ? <ErrorState error={settingsQuery.error} retry={() => void settingsQuery.refetch()} /> : <form className="flex min-w-0 flex-col gap-6" onSubmit={(event) => void save(event)}><FieldGroup><Field data-invalid={!!field("timezone")}><FieldLabel htmlFor="settings-timezone">Timezone</FieldLabel><Input id="settings-timezone" value={form.timezone} onChange={(event) => update("timezone", event.target.value)} aria-invalid={!!field("timezone")} /><FieldError>{field("timezone")}</FieldError></Field><FieldSet><FieldLegend variant="label">Open weekdays</FieldLegend><div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,6rem),1fr))] gap-3">{DAYS.map((day, index) => <Field key={day} className="min-h-11" orientation="horizontal" data-invalid={!!field("weekdays")}><Checkbox id={`weekday-${index + 1}`} checked={form.weekdays.includes(index + 1)} onCheckedChange={(checked) => toggleWeekday(index + 1, checked === true)} aria-invalid={!!field("weekdays")} /><FieldLabel className="min-h-11 items-center" htmlFor={`weekday-${index + 1}`}>{day}</FieldLabel></Field>)}</div><FieldError>{field("weekdays")}</FieldError></FieldSet><div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-4"><Field data-invalid={!!field("quantityCap")}><FieldLabel htmlFor="quantity-cap">Quantity cap</FieldLabel><Input id="quantity-cap" type="number" min={1} max={1000} value={form.quantityCap} onChange={(event) => update("quantityCap", Number(event.target.value))} aria-invalid={!!field("quantityCap")} /><FieldError>{field("quantityCap")}</FieldError></Field><Field data-invalid={!!field("customerCap")}><FieldLabel htmlFor="customer-cap">Customer cap</FieldLabel><Input id="customer-cap" type="number" min={1} max={100} value={form.customerCap} onChange={(event) => update("customerCap", Number(event.target.value))} aria-invalid={!!field("customerCap")} /><FieldError>{field("customerCap")}</FieldError></Field></div><div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-4"><Field data-invalid={!!field("planningTime")}><FieldLabel htmlFor="planning-time">Planning time</FieldLabel><Input id="planning-time" type="time" value={form.planningTime} onChange={(event) => update("planningTime", event.target.value)} aria-invalid={!!field("planningTime")} /><FieldError>{field("planningTime")}</FieldError></Field><Field data-invalid={!!field("cutoffTime")}><FieldLabel htmlFor="cutoff-time">Cutoff time</FieldLabel><Input id="cutoff-time" type="time" value={form.cutoffTime} onChange={(event) => update("cutoffTime", event.target.value)} aria-invalid={!!field("cutoffTime")} /><FieldError>{field("cutoffTime")}</FieldError></Field></div><FieldError>{errors.form}</FieldError></FieldGroup><Button type="submit" disabled={updateSettings.isPending}>{updateSettings.isPending ? "Saving…" : "Save settings"}</Button></form>}</CardContent></Card><div className="flex min-w-0 flex-col gap-6"><Card><CardHeader><CardTitle>Connected capabilities</CardTitle><CardDescription>Configured status reported by the backend, not a live health claim.</CardDescription></CardHeader><CardContent>{capabilitiesQuery.isPending ? <LoadingRows /> : capabilitiesQuery.error ? <ErrorState error={capabilitiesQuery.error} retry={() => void capabilitiesQuery.refetch()} /> : <div className="flex flex-col gap-3 text-sm">{Object.entries(capabilitiesQuery.data ?? {}).map(([name, value]) => { const configured = typeof value === "boolean" ? value : value.configured; return <div className="flex min-w-0 flex-wrap items-center justify-between gap-4" key={name}><span className="capitalize">{name}</span><StatusBadge status={configured ? "configured" : "not configured"} /></div>; })}</div>}</CardContent></Card><Card><CardHeader><CardTitle>Privacy</CardTitle><CardDescription>Export your workspace data through the authenticated privacy endpoint.</CardDescription></CardHeader><CardContent><a className="inline-flex min-h-11 max-w-full items-center justify-center whitespace-normal rounded-2xl border px-4 py-2 text-center text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30" href="/api/v1/privacy/export">Export workspace data</a><p className="mt-3 text-xs text-muted-foreground">Advanced source and seller erasure actions are intentionally unavailable in this panel.</p></CardContent></Card></div></div><p className="sr-only" aria-live="polite">{serviceToday(form?.timezone ?? "UTC")} · {settingsQuery.data?.stateRevision ?? ""}</p></section>;
}
