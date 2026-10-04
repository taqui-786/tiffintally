"use client";

/* Legacy component definitions remain available while the richer management panels own these tabs. */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { createAuthClient } from "better-auth/react";
import { CookingPot, NotebookPen } from "lucide-react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AuthState } from "@/components/auth-state";
import { CustomersPanel, SettingsPanel as ManagementSettingsPanel } from "@/components/workspace-management";
import { WhatsAppDialog } from "@/components/whatsapp-dialog";
import { ProposalWorkspace } from "@/components/proposal-workspace";
import { KitchenOverview } from "@/components/kitchen-overview";
import { KitchenReview } from "@/components/kitchen-review";
import { BillingPanel } from "@/components/billing-panel";
import { DispatchPanel } from "@/components/dispatch-panel";
import { CommerceSetupPanel } from "@/components/commerce-setup-panel";
import { kitchenIdentity } from "@/lib/client/kitchen-presentation";
import { serviceToday } from "@/lib/client/ui-helpers";
import { dateSchema } from "@/lib/contracts/common";
import { ClientError } from "@/lib/client/api";
import type { BackendOutput } from "@/lib/contracts/backend";
import type { ForecastRun } from "@/lib/contracts/history";
import { newCommandMeta, analyzeSourceMutationOptions, finalizeSheetMutationOptions, importSourcesMutationOptions, sourceDispositionMutationOptions } from "@/lib/client/mutations";
import { capabilitiesQueryOptions, customersQueryOptions, dayQueryOptions, forecastsQueryOptions, proposalsQueryOptions, settingsQueryOptions, sourceQueryOptions, sourcesQueryOptions } from "@/lib/client/queries";

const today = () => new Date().toISOString().slice(0, 10);
const authClient = createAuthClient();
const shortDate = (date: string) => new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`));
const shortTime = (date: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(date));
const safeError = (error: unknown) => error instanceof ClientError ? error.message : "This section could not be loaded.";
type Me = BackendOutput<"me">;
type SettingsData = BackendOutput<"getSettings">;
type DayData = BackendOutput<"getDay">;
type CustomersData = BackendOutput<"listCustomers">;
type SourcesData = BackendOutput<"listSources">;
type ProposalsData = BackendOutput<"listProposals">;
type CapabilitiesData = BackendOutput<"capabilities">;
type QueryState<T> = Pick<UseQueryResult<T>, "data" | "isPending" | "error" | "refetch">;

function StatusBadge({ status }: { status: string }) {
  const tone = status === "needs_review" ? "secondary" : status === "approved" || status === "resolved" ? "default" : "outline";
  return <Badge variant={tone}>{status.replaceAll("_", " ")}</Badge>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed bg-muted/20 px-6 py-10 text-center"><p className="font-medium">{title}</p><p className="max-w-sm text-sm text-muted-foreground">{description}</p></div>;
}

function ErrorState({ error, retry }: { error: unknown; retry: () => void }) {
  return <Alert variant="destructive"><AlertTitle>Couldn’t load this section</AlertTitle><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>{safeError(error)}</span><Button variant="outline" size="sm" onClick={retry}>Retry</Button></AlertDescription></Alert>;
}

function DashboardContent({ auth }: { auth: Me }) {
  const sellerId = auth.seller._id;
  const [selectedDate, setSelectedDate] = useState(() => serviceToday(auth.seller.settings.timezone) || today());
  const [activeTab, setActiveTab] = useState("overview");
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [consentSourceId, setConsentSourceId] = useState<string | null>(null);
  const [intakeText, setIntakeText] = useState("");
  const [intakeSentAt, setIntakeSentAt] = useState(new Date().toISOString().slice(0, 16));
  const [intakeCustomerId, setIntakeCustomerId] = useState<string | null>(null);
  const [intakeError, setIntakeError] = useState("");
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [acknowledgeLateChange, setAcknowledgeLateChange] = useState(false);
  const queryClient = useQueryClient();
  const profile = authClient.useSession();
  const identity = kitchenIdentity(profile.error ? null : profile.data?.user.name);
  const pageIntro: Record<string, [string, string]> = {
    overview: ["Let’s put lunch in order.", "A clear count, a few good notes, and one plan to pack from."],
    review: ["A little change. Your final say.", "Read the request. Check the difference. Only then approve."],
    customers: ["The people at your table.", "Your regulars, their routines, and the details you remember."],
    billing: ["A clear bill. A calmer first.", "Dated meal records, agreed charges, and a statement ready to share."],
    dispatch: ["Ramesh Mode. No wrong stops.", "A building-by-building handover from your finalized packing plan."],
    settings: ["The way your kitchen runs.", "Your service rules, agreed prices, payment details and delivery routes."],
  };

  const settings = useQuery(settingsQueryOptions(sellerId));
  const day = useQuery(dayQueryOptions(sellerId, { serviceDate: selectedDate }));
  const customers = useQuery(customersQueryOptions(sellerId, { status: "active" }));
  const sources = useQuery(sourcesQueryOptions(sellerId, { status: "needs_review" }));
  const proposals = useQuery(proposalsQueryOptions(sellerId, { status: "needs_review" }));
  const capabilities = useQuery(capabilitiesQueryOptions(sellerId));
  const forecasts = useQuery({ ...forecastsQueryOptions(sellerId, { serviceDate: selectedDate }), enabled: capabilities.data?.forecasting.configured === true });
  const sourceDetail = useQuery({ ...sourceQueryOptions(sellerId, { sourceId: sourceId ?? "pending" }), enabled: !!sourceId });

  const importMutation = useMutation(importSourcesMutationOptions(queryClient, sellerId));
  const analyzeMutation = useMutation(analyzeSourceMutationOptions(queryClient, sellerId));
  const sourceDisposition = useMutation(sourceDispositionMutationOptions(queryClient, sellerId));
  const finalizeMutation = useMutation(finalizeSheetMutationOptions(queryClient, sellerId));

  const approvedRows = useMemo(() => (day.data?.rows ?? []).filter((row) => row.approvalId !== null), [day.data?.rows]);
  const approvedTotal = useMemo(() => approvedRows.reduce((total, row) => total + row.quantity, 0), [approvedRows]);
  const reviewCount = (sources.data?.items.length ?? 0) + (proposals.data?.items.length ?? 0);
  const selectedSource = sourceDetail.data?.source ?? sources.data?.items.find((item) => item._id === sourceId);
  const forecast = forecasts.data?.items.find((run) => run.runState === "succeeded" && run.result?.status === "available");

  async function importSource(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!intakeText.trim()) { setIntakeError("Paste a customer message before importing."); return; }
    setIntakeError("");
    try {
      await importMutation.mutateAsync({
        meta: newCommandMeta(), expectedStateRevision: auth.stateRevision,
        sources: [{ text: intakeText.trim(), sentAt: new Date(intakeSentAt).toISOString(), customerId: intakeCustomerId, channel: "manual", upstreamId: null }],
      });
      toast.success("Message added to review");
      setIntakeText(""); setIntakeCustomerId(null); setIntakeOpen(false);
    } catch (error) { setIntakeError(safeError(error)); toast.error("Message could not be added"); }
  }

  async function analyzeSource() {
    if (!selectedSource) return;
    try {
      await analyzeMutation.mutateAsync({
        meta: newCommandMeta(), expectedStateRevision: auth.stateRevision, expectedSourceRevision: selectedSource.revision,
        expectedDraftRevisions: (proposals.data?.items ?? []).filter((proposal) => proposal.sourceId === selectedSource._id).map((proposal) => ({ proposalId: proposal._id, draftRevision: proposal.draftRevision })),
        consentAcknowledged: true, sourceId: selectedSource._id,
      });
      toast.success("Analysis started"); setConsentSourceId(null);
    } catch (error) { toast.error(safeError(error)); }
  }

  async function dispositionSource(action: "dismiss" | "reopen" | "defer") {
    if (!selectedSource) return;
    try {
      await sourceDisposition.mutateAsync({ meta: newCommandMeta(), expectedStateRevision: auth.stateRevision, expectedSourceRevision: selectedSource.revision, sourceId: selectedSource._id, action, ...(action === "defer" ? { serviceDate: selectedDate } : {}), reason: action === "dismiss" ? "Dismissed from seller review" : action === "defer" ? "Deferred for a later service date" : "Reopened for review" });
      toast.success(`Source ${action === "dismiss" ? "dismissed" : action === "defer" ? "deferred" : "reopened"}`); setSourceId(null);
    } catch (error) { toast.error(safeError(error)); }
  }

  async function finalizeSheet() {
    if (!day.data) return;
    try {
      await finalizeMutation.mutateAsync({ meta: newCommandMeta(), expectedStateRevision: day.data.stateRevision, serviceDate: selectedDate, expectedPriorSheetId: day.data.latestSheetId, acknowledgeLateChange });
      toast.success("Packing sheet finalized"); setFinalizeOpen(false); setAcknowledgeLateChange(false);
    } catch (error) { toast.error(safeError(error)); }
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8">
          <Link href="/" aria-label="TiffinTally home" className="flex min-w-0 items-center gap-2.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"><CookingPot className="size-5" strokeWidth={1.5} aria-hidden="true" /></span><div className="hidden min-w-0 min-[380px]:block"><p className="truncate font-heading text-lg font-semibold tracking-tight">TiffinTally<span className="text-primary">.</span></p><p className="text-[10px] text-muted-foreground">The kitchen desk</p></div></Link>
          <div className="flex items-center gap-3"><WhatsAppDialog /><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="size-11" size="icon" aria-label="Open account menu"><Avatar><AvatarFallback>{identity.initials || <CookingPot className="size-4" strokeWidth={1.5} aria-hidden="true" />}</AvatarFallback></Avatar></Button>} /><DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuLabel>{identity.fullName || "Your workspace"}</DropdownMenuLabel><DropdownMenuItem onClick={() => setActiveTab("settings")}>Kitchen settings</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onClick={() => window.location.reload()}>Refresh workspace</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu></div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 pb-10 pt-8 sm:px-6 lg:px-8 lg:pt-10">
        <div className="grid items-center gap-6 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex min-w-0 items-center gap-6"><div className="min-w-0"><p className="mb-3 text-sm font-medium text-primary">Good day{identity.firstName ? `, ${identity.firstName}` : ""}.</p><h1 className="font-heading text-3xl leading-tight tracking-[-0.045em] text-balance sm:text-4xl">{pageIntro[activeTab]?.[0]}</h1><p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">{pageIntro[activeTab]?.[1]}</p></div><figure className="hidden shrink-0 border bg-muted p-1.5 md:block md:rotate-[-3deg]"><Image src="/landing/tiffin-lunchboxes.jpg" alt="Colourful tiffin lunchboxes packed with Indian meals and snacks" width={100} height={80} className="h-20 w-24 object-cover" /><figcaption className="pt-1.5 text-center font-mono text-[8px] tracking-[0.14em] text-muted-foreground">MADE WITH CARE</figcaption></figure></div>
          <div className="flex flex-wrap items-end gap-3 md:max-w-[210px] md:justify-end"><Field className="w-auto gap-1.5"><FieldLabel htmlFor="service-date">Service date</FieldLabel><Input id="service-date" type="date" value={selectedDate} onChange={(event) => { if (dateSchema.safeParse(event.target.value).success) setSelectedDate(event.target.value); }} className="h-11 w-auto" /></Field><Button className="min-h-11" onClick={() => setIntakeOpen(true)}><NotebookPen data-icon="inline-start" strokeWidth={1.5} />Add message</Button></div>
        </div>
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value)} className="min-w-0 gap-8">
          <TabsList variant="line" aria-label="Kitchen workspace sections" className="h-auto! w-full justify-start gap-5 overflow-x-auto border-b p-0"><TabsTrigger className="h-12 flex-none px-0" value="overview">Kitchen</TabsTrigger><TabsTrigger className="h-12 flex-none px-0" value="review">Review{reviewCount ? ` · ${reviewCount}` : ""}</TabsTrigger><TabsTrigger className="h-12 flex-none px-0" value="billing">Bill book</TabsTrigger><TabsTrigger className="h-12 flex-none px-0" value="dispatch">Ramesh Mode</TabsTrigger><TabsTrigger className="h-12 flex-none px-0" value="customers">Customers</TabsTrigger><TabsTrigger className="h-12 flex-none px-0" value="settings">Settings</TabsTrigger></TabsList>
          <TabsContent value="overview" className="flex flex-col gap-10"><KitchenOverview {...{ day, sources, proposals, customers, approvedTotal, selectedDate, settings, capabilities, forecasts }} onFinalize={() => setFinalizeOpen(true)} finalizePending={finalizeMutation.isPending} onReview={() => setActiveTab("review")} onCustomers={() => setActiveTab("customers")} /><KitchenReview {...{ sources, proposals, customers, selectedDate, setSourceId, setProposalId, capabilities, setConsentSourceId }} timezone={settings.data?.settings.timezone ?? auth.seller.settings.timezone} compact /><Button variant="link" className="min-h-11 self-start px-0" onClick={() => setActiveTab("review")}>Open the full review desk</Button></TabsContent>
          <TabsContent value="review" className="flex flex-col gap-6"><KitchenReview {...{ sources, proposals, customers, selectedDate, setSourceId, setProposalId, capabilities, setConsentSourceId }} timezone={settings.data?.settings.timezone ?? auth.seller.settings.timezone} /></TabsContent>
           <TabsContent value="customers"><CustomersPanel sellerId={sellerId} serviceDate={selectedDate} /></TabsContent>
           <TabsContent value="billing"><BillingPanel sellerId={sellerId} serviceDate={selectedDate} /></TabsContent>
           <TabsContent value="dispatch"><DispatchPanel sellerId={sellerId} serviceDate={selectedDate} onSetup={() => setActiveTab("settings")} /></TabsContent>
           <TabsContent value="settings" className="flex flex-col gap-10"><CommerceSetupPanel sellerId={sellerId} /><Separator /><ManagementSettingsPanel sellerId={sellerId} /></TabsContent>
        </Tabs>
      </main>

      <Sheet open={intakeOpen} onOpenChange={setIntakeOpen}><SheetContent side="right" className="gap-0 sm:max-w-lg"><SheetHeader><SheetTitle>Add a customer message</SheetTitle><SheetDescription>Capture the original message for review. Nothing is approved automatically.</SheetDescription></SheetHeader><form className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5" onSubmit={importSource}><Field><FieldLabel htmlFor="intake-message">Message</FieldLabel><Textarea id="intake-message" value={intakeText} onChange={(event) => setIntakeText(event.target.value)} placeholder="Paste the customer’s message" rows={7} maxLength={8000} required /><FieldDescription>{intakeText.length}/8000 characters</FieldDescription></Field><Field><FieldLabel htmlFor="intake-sent-at">Sent at</FieldLabel><Input id="intake-sent-at" type="datetime-local" value={intakeSentAt} onChange={(event) => setIntakeSentAt(event.target.value)} required /></Field><Field><FieldLabel>Customer</FieldLabel><Select value={intakeCustomerId} onValueChange={(value) => setIntakeCustomerId(value)}><SelectTrigger className="w-full"><SelectValue placeholder="Unassigned" /></SelectTrigger><SelectContent>{(customers.data?.items ?? []).map((customer) => <SelectItem key={customer._id} value={customer._id}>{customer.alias}</SelectItem>)}</SelectContent></Select></Field>{intakeError ? <p className="text-sm text-destructive" role="alert">{intakeError}</p> : null}<SheetFooter className="px-0"><SheetClose render={<Button type="button" variant="outline" />}>Cancel</SheetClose><Button type="submit" disabled={importMutation.isPending}>{importMutation.isPending ? "Adding…" : "Add to review"}</Button></SheetFooter></form></SheetContent></Sheet>

      <Dialog open={!!consentSourceId} onOpenChange={(open) => { if (!open) setConsentSourceId(null); }}><DialogContent><DialogHeader><DialogTitle>Analyze this message?</DialogTitle><DialogDescription>AI analysis will create a bounded draft for review. It will not approve orders. Current source and draft revisions will be checked before work begins.</DialogDescription></DialogHeader><DialogFooter><DialogClose render={<Button variant="outline" />} >Cancel</DialogClose><Button onClick={() => void analyzeSource()} disabled={analyzeMutation.isPending}>{analyzeMutation.isPending ? "Analyzing…" : "I consent, analyze"}</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={!!sourceId} onOpenChange={(open) => { if (!open) setSourceId(null); }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Source detail</DialogTitle><DialogDescription>Original messages stay visible so every review decision has context.</DialogDescription></DialogHeader>{sourceDetail.isPending ? <p className="text-sm text-muted-foreground">Loading source…</p> : sourceDetail.error ? <ErrorState error={sourceDetail.error} retry={() => void sourceDetail.refetch()} /> : selectedSource ? <div className="flex flex-col gap-4"><div className="flex flex-wrap items-center gap-2"><StatusBadge status={selectedSource.status} /><span className="text-sm text-muted-foreground">Received {shortTime(selectedSource.receivedAt)}</span></div><p className="whitespace-pre-wrap rounded-2xl bg-muted/40 p-4 text-sm leading-6">{sourceDetail.data?.source.text ?? "Message text is available after loading."}</p><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void dispositionSource("dismiss")} disabled={sourceDisposition.isPending}>Dismiss</Button><Button variant="outline" onClick={() => void dispositionSource("defer")} disabled={sourceDisposition.isPending}>Defer to {shortDate(selectedDate)}</Button><Button onClick={() => setConsentSourceId(selectedSource._id)} disabled={!capabilities.data?.ai.configured || analyzeMutation.isPending}>{capabilities.data?.ai.configured ? "Analyze with AI" : "AI unavailable"}</Button></div></div> : null}</DialogContent></Dialog>
       {proposalId ? <ProposalWorkspace sellerId={sellerId} proposalId={proposalId} serviceDate={selectedDate} onClose={() => setProposalId(null)} /> : null}
       <Dialog open={finalizeOpen} onOpenChange={setFinalizeOpen}><DialogContent><DialogHeader><DialogTitle>Finalize packing sheet</DialogTitle><DialogDescription>This freezes the approved quantities for {shortDate(selectedDate)} into an immutable sheet revision.</DialogDescription></DialogHeader><div className="flex flex-col gap-4"><div className="rounded-xl bg-muted/40 p-4"><p className="text-sm text-muted-foreground">Approved meals</p><p className="text-3xl font-semibold tabular-nums">{approvedTotal}</p></div><label className="flex items-start gap-3 rounded-xl border p-3 text-sm"><Checkbox checked={acknowledgeLateChange} onCheckedChange={(checked) => setAcknowledgeLateChange(checked === true)} /><span>I understand that later approved changes require a visible amendment.</span></label></div><DialogFooter><DialogClose render={<Button variant="outline" />}>Cancel</DialogClose><Button onClick={() => void finalizeSheet()} disabled={finalizeMutation.isPending || day.data?.pendingCount !== 0}>{finalizeMutation.isPending ? "Finalizing…" : "Finalize sheet"}</Button></DialogFooter></DialogContent></Dialog>
       <p className="sr-only" aria-live="polite">{importMutation.isPending || analyzeMutation.isPending || sourceDisposition.isPending || finalizeMutation.isPending ? "Saving your change" : `${reviewCount} items need review`}</p>
    </div>
  );
}

function Overview({ day, sources, proposals, customers, approvedRows, approvedTotal, reviewCount, selectedDate, settings, capabilities, forecast, onFinalize, finalizePending }: { day: QueryState<DayData>; sources: QueryState<SourcesData>; proposals: QueryState<ProposalsData>; customers: QueryState<CustomersData>; approvedRows: DayData["rows"]; approvedTotal: number; reviewCount: number; selectedDate: string; settings: QueryState<SettingsData>; capabilities: QueryState<CapabilitiesData>; forecast?: ForecastRun; onFinalize: () => void; finalizePending: boolean }) {
  return <div className="flex flex-col gap-6"><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric title="Approved meals" value={approvedTotal} note={`${approvedRows.length} customers on ${shortDate(selectedDate)}`} /><Metric title="Active customers" value={customers.data?.items.length ?? 0} note={customers.isPending ? "Loading customers" : "Ready for planning"} /><Metric title="Needs review" value={reviewCount} note={`${sources.data?.items.length ?? 0} messages · ${proposals.data?.items.length ?? 0} drafts`} /><Metric title="Planning status" value={day.data?.pendingCount ?? 0} note={day.data?.pendingCount ? "Changes still pending" : "No pending changes"} /> </div><div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.85fr)]"><DailyBoard day={day} selectedDate={selectedDate} onFinalize={onFinalize} finalizePending={finalizePending} /><ForecastPanel capabilities={capabilities} forecast={forecast} /></div>{settings.data ? <p className="text-xs text-muted-foreground">Planning timezone: {settings.data.settings.timezone} · Quantities shown are approved for the selected date only.</p> : null}</div>;
}

function Metric({ title, value, note }: { title: string; value: string | number; note: string }) { return <Card><CardHeader><CardDescription>{title}</CardDescription><CardTitle className="text-3xl tabular-nums">{value}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">{note}</p></CardContent></Card>; }

function DailyBoard({ day, selectedDate, onFinalize, finalizePending }: { day: QueryState<DayData>; selectedDate: string; onFinalize: () => void; finalizePending: boolean }) {
  const rows = day.data?.rows.filter((row) => row.approvalId !== null) ?? [];
  return <Card><CardHeader><CardTitle>Daily board</CardTitle><CardDescription>Approved quantities for {shortDate(selectedDate)}.</CardDescription><CardAction><Badge variant={day.data?.pendingCount ? "secondary" : "outline"}>{day.data?.pendingCount ? `${day.data.pendingCount} pending` : "Ready"}</Badge></CardAction></CardHeader><CardContent className="flex flex-col gap-4">{day.isPending ? <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading approved quantities…</div> : day.error ? <ErrorState error={day.error} retry={() => void day.refetch()} /> : rows.length ? <Table><TableHeader><TableRow><TableHead>Customer</TableHead><TableHead>Note</TableHead><TableHead className="text-right">Approved</TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.customerId}><TableCell className="font-medium">{row.alias}</TableCell><TableCell className="max-w-[220px] truncate text-muted-foreground">{row.packingNote || "—"}</TableCell><TableCell className="text-right font-semibold tabular-nums">{row.quantity}</TableCell></TableRow>)}</TableBody></Table> : <EmptyState title="No approved quantities yet" description="Approved rows for this date will appear here after review." />}<div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{day.data?.latestSheetId ? "A finalized revision exists for this date." : "No sheet revision finalized yet."}</p><Button onClick={onFinalize} disabled={finalizePending || day.isPending || !!day.error || day.data?.pendingCount !== 0}>Finalize sheet</Button></div></CardContent></Card>;
}

function ForecastPanel({ capabilities, forecast }: { capabilities: QueryState<CapabilitiesData>; forecast?: ForecastRun }) {
  const configured = capabilities.data?.forecasting.configured;
  return <Card><CardHeader><CardTitle>Planning signal</CardTitle><CardDescription>Observed forecast status, when configured.</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">{capabilities.isPending ? <p className="text-sm text-muted-foreground">Checking capabilities…</p> : capabilities.error ? <ErrorState error={capabilities.error} retry={() => void capabilities.refetch()} /> : !configured ? <Alert><AlertTitle>Forecasting unavailable</AlertTitle><AlertDescription>No forecast is shown because the forecasting service is not configured.</AlertDescription></Alert> : forecast ? <><div className="flex items-end justify-between gap-4"><div><p className="text-3xl font-semibold tabular-nums">{forecast.result?.roundedDelta ?? 0}</p><p className="text-sm text-muted-foreground">meals vs baseline</p></div><Badge>Available</Badge></div><Progress value={100} aria-label="Forecast result available" /><p className="text-xs text-muted-foreground">Model result from {forecast.result?.trainingRows ?? 0} training rows.</p></> : <EmptyState title="No forecast run" description="A forecast will appear here only after a policy-bound run has completed." />}</CardContent></Card>;
}

function ReviewQueue({ sources, proposals, selectedDate, setSourceId, setProposalId, capabilities, setConsentSourceId }: { sources: QueryState<SourcesData>; proposals: QueryState<ProposalsData>; selectedDate: string; setSourceId: (value: string) => void; setProposalId: (value: string) => void; capabilities: QueryState<CapabilitiesData>; setConsentSourceId: (value: string) => void }) {
  return <section className="grid gap-6 xl:grid-cols-2"><Card><CardHeader><CardTitle>Messages to review</CardTitle><CardDescription>Incoming messages awaiting a seller decision.</CardDescription></CardHeader><CardContent>{sources.isPending ? <p className="text-sm text-muted-foreground">Loading messages…</p> : sources.error ? <ErrorState error={sources.error} retry={() => void sources.refetch()} /> : sources.data?.items.length ? <ScrollArea className="h-80 pr-3"><div className="flex flex-col gap-3">{sources.data.items.map((source) => <div className="rounded-2xl border p-4" key={source._id}><div className="flex items-start justify-between gap-3"><div><p className="line-clamp-2 text-sm font-medium">Message received {shortTime(source.receivedAt)}</p><p className="mt-1 text-xs text-muted-foreground">{source.customerId ? "Assigned customer" : "Unassigned"}</p></div><StatusBadge status={source.status} /></div><div className="mt-4 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setSourceId(source._id)}>Open</Button><Button size="sm" onClick={() => setConsentSourceId(source._id)} disabled={!capabilities.data?.ai.configured}>Analyze</Button></div></div>)}</div></ScrollArea> : <EmptyState title="Inbox is clear" description="New imported messages will appear here." />}</CardContent></Card><Card><CardHeader><CardTitle>Drafts to review</CardTitle><CardDescription>AI or manually created proposals that need a decision.</CardDescription></CardHeader><CardContent>{proposals.isPending ? <p className="text-sm text-muted-foreground">Loading drafts…</p> : proposals.error ? <ErrorState error={proposals.error} retry={() => void proposals.refetch()} /> : proposals.data?.items.length ? <ScrollArea className="h-80 pr-3"><div className="flex flex-col gap-3">{proposals.data.items.map((proposal) => <div className="rounded-2xl border p-4" key={proposal._id}><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium">{proposal.operations.length} proposed change{proposal.operations.length === 1 ? "" : "s"}</p><p className="mt-1 text-xs text-muted-foreground">{proposal.missingFields.length ? `${proposal.missingFields.length} missing field${proposal.missingFields.length === 1 ? "" : "s"}` : "Ready for preview"}</p></div><StatusBadge status={proposal.status} /></div><Button className="mt-4" size="sm" variant="outline" onClick={() => setProposalId(proposal._id)}>Review draft</Button></div>)}</div></ScrollArea> : <EmptyState title="No drafts waiting" description={`Drafts for ${shortDate(selectedDate)} will be shown here when available.`} />}</CardContent></Card></section>;
}

function Customers({ customers }: { customers: QueryState<CustomersData> }) { return <Card><CardHeader><CardTitle>Active customers</CardTitle><CardDescription>Current customer roster for intake and planning.</CardDescription></CardHeader><CardContent>{customers.isPending ? <p className="text-sm text-muted-foreground">Loading customers…</p> : customers.error ? <ErrorState error={customers.error} retry={() => void customers.refetch()} /> : customers.data?.items.length ? <Table><TableHeader><TableRow><TableHead>Customer</TableHead><TableHead>Packing note</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{customers.data.items.map((customer) => <TableRow key={customer._id}><TableCell className="font-medium">{customer.alias}</TableCell><TableCell className="text-muted-foreground">{customer.packingNote || "—"}</TableCell><TableCell><StatusBadge status={customer.status} /></TableCell></TableRow>)}</TableBody></Table> : <EmptyState title="No active customers" description="Add customers before assigning imported messages." />}</CardContent></Card>; }

function SettingsPanel({ settings, capabilities }: { settings: QueryState<SettingsData>; capabilities: QueryState<CapabilitiesData> }) { return <div className="grid gap-6 md:grid-cols-2"><Card><CardHeader><CardTitle>Planning settings</CardTitle><CardDescription>Policy values currently used by the workspace.</CardDescription></CardHeader><CardContent>{settings.isPending ? <p className="text-sm text-muted-foreground">Loading settings…</p> : settings.error ? <ErrorState error={settings.error} retry={() => void settings.refetch()} /> : <div className="flex flex-col gap-3 text-sm"><div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">Timezone</span><span>{settings.data?.settings.timezone}</span></div><Separator /><div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">Planning time</span><span>{settings.data?.settings.planningTime}</span></div><Separator /><div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">Cutoff time</span><span>{settings.data?.settings.cutoffTime}</span></div><Separator /><div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">Quantity cap</span><span>{settings.data?.settings.quantityCap}</span></div></div>}</CardContent></Card><Card><CardHeader><CardTitle>Connected capabilities</CardTitle><CardDescription>Honest availability from the backend.</CardDescription></CardHeader><CardContent>{capabilities.isPending ? <p className="text-sm text-muted-foreground">Checking capabilities…</p> : capabilities.error ? <ErrorState error={capabilities.error} retry={() => void capabilities.refetch()} /> : <div className="flex flex-col gap-3"><div className="flex items-center justify-between gap-4"><span>AI analysis</span><StatusBadge status={capabilities.data?.ai.configured ? "available" : "unavailable"} /></div><div className="flex items-center justify-between gap-4"><span>Forecasting</span><StatusBadge status={capabilities.data?.forecasting.configured ? "available" : "unavailable"} /></div><p className="text-xs text-muted-foreground">AI requests require explicit consent and always produce drafts for review.</p></div>}</CardContent></Card></div>; }

export default function DashboardApp() { return <AuthState>{(auth) => <DashboardContent auth={auth} />}</AuthState>; }
