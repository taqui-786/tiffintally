"use client";

import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, CopyIcon, ReceiptTextIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { CommerceSetupPanel, CommerceWriteContext } from "@/components/commerce-setup-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ClientError, getOperation } from "@/lib/client/api";
import { commerceSetupQueryOptions, createInvoiceMutationOptions, invoicesQueryOptions, previewInvoiceMutationOptions } from "@/lib/client/commerce";
import { newCommandMeta } from "@/lib/client/mutations";
import { sellerKey } from "@/lib/client/query-keys";
import { formatINR, rupeesToPaise, whatsappShareUrl } from "@/lib/client/whatsapp-share";
import { billingAdjustmentsSchema, monthSchema, type CommerceInput, type Invoice, type InvoicePreview } from "@/lib/contracts/commerce";

type Adjustment = CommerceInput<"previewInvoice">["adjustments"][number];
type HeldInvoice = { variables: CommerceInput<"createInvoice">; invoiceId?: string };
type ReceiptProof = { operation: string; committedAt: string; stateRevision: number };
const errorText = (error: unknown) => error instanceof Error ? error.message : "This request could not be completed.";
const friendlyError = (raw: string) => {
  if (raw.includes("A seller billing adjustment requires an existing positive finalized row")) {
    return "Billing adjustments can only be applied to dates where this customer had meals delivered in finalized packing sheets. Please pick an active delivery date, or clear adjustments.";
  }
  if (raw.includes("Configure a price before applying a billing adjustment")) {
    return "Please configure the customer’s agreed price per meal in Prices & delivery setup before adding billing adjustments.";
  }
  return raw;
};
const isUncertain = (error: unknown) => error instanceof TypeError || (error instanceof ClientError && (error.code === "COMMIT_UNCERTAIN" || error.code === "INVALID_RESPONSE" || error.retryable || (error.status !== undefined && error.status >= 500)));
const previousMonth = (date: string) => { const [year, month] = date.split("-").map(Number); return `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2, "0")}`; };
const dayLabel = (date: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00Z`));
const timeLabel = (date: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(date));
const monthLabel = (month: string) => new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(new Date(`${month}-01T12:00:00Z`));

export function BillingPanel({ sellerId, serviceDate }: { sellerId: string; serviceDate: string }) {
  const client = useQueryClient();
  const setup = useQuery(commerceSetupQueryOptions(sellerId));
  const previewMutation = useMutation(previewInvoiceMutationOptions(client, sellerId));
  const issueMutation = useMutation(createInvoiceMutationOptions(client, sellerId));
  const [month, setMonth] = useState(() => previousMonth(serviceDate));
  const [customerId, setCustomerId] = useState("");
  const selectedId = customerId || setup.data?.customers[0]?.customerId || "";
  const customer = setup.data?.customers.find((item) => item.customerId === selectedId);
  const validMonth = monthSchema.safeParse(month).success;
  const invoices = useQuery({ ...invoicesQueryOptions(sellerId, month, selectedId || undefined), enabled: validMonth && !!selectedId });
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [issued, setIssued] = useState<Invoice | null>(null);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [adjustmentDate, setAdjustmentDate] = useState("");
  const [charge, setCharge] = useState("");
  const [reason, setReason] = useState("");
  const [adjustmentError, setAdjustmentError] = useState("");
  const [error, setError] = useState("");
  const [revisionConfirmed, setRevisionConfirmed] = useState(false);
  const [view, setView] = useState("ledger");
  const [busy, setBusy] = useState(false);
  const [setupBlocked, setSetupBlocked] = useState(false);
  const [uncertainKey, setUncertainKey] = useState<string | null>(null);
  const [copyHint, setCopyHint] = useState("");
  const [receiptProofs, setReceiptProofs] = useState<Record<string, ReceiptProof>>({});
  const [receiptLoading, setReceiptLoading] = useState<string | null>(null);
  const held = useRef<HeldInvoice | null>(null);
  const id = useId();
  const invoiceLocked = busy || previewMutation.isPending || issueMutation.isPending || !!uncertainKey;
  const locked = invoiceLocked || setupBlocked;
  const activeInvoice = issued && issued.customerId === selectedId && issued.month === month ? issued : null;
  const activePreview = preview && preview.customerId === selectedId && preview.month === month ? preview : null;
  const docket = activeInvoice ?? activePreview;
  const previewStale = !!activePreview && setup.data?.stateRevision !== activePreview.expectedStateRevision;
  const draftAdjustment = !!(adjustmentDate || charge || reason);
  const closedMonth = validMonth && month < serviceDate.slice(0, 7);
  const shareUrl = activeInvoice ? whatsappShareUrl(activeInvoice.phone, activeInvoice.message) : null;

  function invalidate() { setPreview(null); setIssued(null); setRevisionConfirmed(false); setError(""); setCopyHint(""); }
  function changeScope(nextMonth: string, nextCustomer: string) {
    setMonth(nextMonth); setCustomerId(nextCustomer); setAdjustments([]); setAdjustmentDate(""); setCharge(""); setReason(""); setAdjustmentError(""); invalidate();
  }

  function addAdjustment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountPaise = rupeesToPaise(charge);
    if (!adjustmentDate.startsWith(`${month}-`) || amountPaise === null || !reason.trim()) { setAdjustmentError("Choose a date in this month, an absolute charge in rupees (up to two decimal places), and a reason."); return; }
    const next = [...adjustments.filter((item) => item.serviceDate !== adjustmentDate), { serviceDate: adjustmentDate, amountPaise, reason: reason.trim() }].sort((a, b) => a.serviceDate.localeCompare(b.serviceDate));
    const parsed = billingAdjustmentsSchema.safeParse(next);
    if (!parsed.success) { setAdjustmentError(parsed.error.issues[0]?.message ?? "Review the adjustment."); return; }
    setAdjustments(parsed.data); setAdjustmentDate(""); setCharge(""); setReason(""); setAdjustmentError(""); invalidate();
  }

  async function makePreview() {
    if (locked || !validMonth || !selectedId) return;
    if (draftAdjustment) { setAdjustmentError("Add the adjustment, or clear its fields, before previewing."); return; }
    invalidate();
    try { setPreview(await previewMutation.mutateAsync({ customerId: selectedId, month, adjustments })); }
    catch (cause) { setError(errorText(cause)); }
  }

  async function loadIssued(invoiceId: string) {
    const snapshot = await getOperation("getInvoice", { invoiceId });
    setIssued(snapshot); setPreview(null); setView("ledger"); setCopyHint("");
  }

  async function issue() {
    if (locked || held.current || !activePreview || !activePreview.canIssue || activePreview.missingDates.length || !closedMonth || previewStale || draftAdjustment || (activePreview.priorInvoiceId && !revisionConfirmed)) return;
    const variables: CommerceInput<"createInvoice"> = { meta: newCommandMeta(), customerId: selectedId, month, adjustments: [...adjustments], expectedStateRevision: activePreview.expectedStateRevision, expectedBasisHash: activePreview.basisHash, expectedPriorInvoiceId: activePreview.priorInvoiceId };
    const command: HeldInvoice = { variables };
    held.current = command;
    setBusy(true); setError("");
    try {
      let output;
      try { output = await issueMutation.mutateAsync(variables); }
      catch (cause) {
        if (isUncertain(cause)) setUncertainKey(variables.meta.idempotencyKey);
        else { held.current = null; setPreview(null); }
        throw cause;
      }
      command.invoiceId = output.resourceIds[0];
      // A committed command is never re-issued because its subsequent GET failed.
      setUncertainKey(variables.meta.idempotencyKey);
      if (!command.invoiceId) throw new Error("The statement was issued but its ID was missing. Check the receipt first.");
      await loadIssued(command.invoiceId);
      held.current = null; setUncertainKey(null);
      toast.success("Statement issued. Its saved text is ready to share.");
      for (const warning of output.warnings) toast.warning(warning);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function checkReceipt() {
    const command = held.current;
    if (!command || busy) return;
    setBusy(true); setError("");
    try {
      const receipt = await getOperation("getReceipt", { idempotencyKey: command.variables.meta.idempotencyKey });
      if (!("operation" in receipt) || receipt.operation !== "createInvoice") throw new Error("This receipt does not match the statement request.");
      command.invoiceId = receipt.resourceIds[0];
      if (!command.invoiceId) throw new Error("No issued statement is identified in this receipt.");
      await loadIssued(command.invoiceId);
      held.current = null; setUncertainKey(null);
      await client.invalidateQueries({ queryKey: sellerKey(sellerId) });
      toast.success("Issued statement recovered from its receipt.");
    } catch (cause) { setError(`Receipt not confirmed yet. ${errorText(cause)} Further writes remain paused.`); }
    finally { setBusy(false); }
  }

  async function viewExisting(invoiceId: string) {
    if (locked) return;
    setBusy(true); setError(""); setPreview(null); setIssued(null);
    try { await loadIssued(invoiceId); }
    catch (cause) { setError(`Couldn’t open this saved statement. ${errorText(cause)}`); }
    finally { setBusy(false); }
  }

  async function copyStatement() {
    if (!activeInvoice) return;
    try { await navigator.clipboard.writeText(activeInvoice.message); setCopyHint("Statement text copied. Paste it into your chosen conversation."); }
    catch { setView("message"); setCopyHint("Clipboard access was unavailable. Select the saved statement text below and copy it manually."); }
  }

  async function readReceipt(key: string) {
    setReceiptLoading(key);
    try {
      const receipt = await getOperation("getReceipt", { idempotencyKey: key });
      if (!("operation" in receipt)) throw new Error("This is not an approval receipt.");
      setReceiptProofs((current) => ({ ...current, [key]: { operation: receipt.operation, committedAt: receipt.committedAt, stateRevision: receipt.stateRevision } }));
    } catch (cause) { toast.error(`Couldn’t load approval proof. ${errorText(cause)}`); }
    finally { setReceiptLoading(null); }
  }

  const items = (setup.data?.customers ?? []).map((item) => ({ value: item.customerId, label: `${item.alias}${item.status === "archived" ? " · archived" : ""}` }));
  return <CommerceWriteContext.Provider value={{ blocked: invoiceLocked, onSetupBlockedChange: setSetupBlocked }}><section className="flex min-w-0 flex-col gap-7 [overflow-wrap:anywhere] [&_[data-slot=field]]:min-w-0 [&_[data-slot=field-group]]:min-w-0">
    <header className="flex min-w-0 items-start justify-between gap-4"><div className="min-w-0"><p className="mb-3 font-mono text-[10px] tracking-[0.15em] text-muted-foreground">MONTH END / THE BILL BOOK</p><h2 className="font-heading text-[clamp(1.5rem,4vw,1.875rem)] tracking-tight text-balance">Every meal, accounted for.</h2><p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">A statement from finalized kitchen sheets, with a dated trail behind every charge.</p></div><ReceiptTextIcon strokeWidth={1.5} className="mt-1 size-7 shrink-0 text-muted-foreground" /></header>
    {uncertainKey && <Alert variant="destructive"><AlertTitle>Check the receipt before another write</AlertTitle><AlertDescription><p>The statement request may have committed. Its original request key <code className="break-all">{uncertainKey}</code> is held; no charge will be recreated automatically.</p><Button variant="outline" size="sm" disabled={busy} onClick={() => void checkReceipt()}>{busy ? "Checking receipt…" : "Check receipt"}</Button></AlertDescription></Alert>}
    {error && <Alert variant="destructive"><AlertTitle>Billing request needs attention</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    <FieldGroup className="grid min-w-0 gap-5 md:grid-cols-2"><Field data-invalid={!validMonth}><FieldLabel htmlFor={`${id}-month`}>Statement month</FieldLabel><Input id={`${id}-month`} type="month" value={month} min="0001-01" max="9999-12" disabled={locked} aria-invalid={!validMonth} onChange={(event) => { const value = event.target.value; if (!value || monthSchema.safeParse(value).success) changeScope(value, selectedId); }} /><FieldError>{!validMonth ? "Choose a valid month." : null}</FieldError></Field><Field><FieldLabel htmlFor={`${id}-customer`}>Customer</FieldLabel>{setup.isPending ? <Skeleton className="h-11 w-full" /> : <Select items={items} value={selectedId || null} disabled={locked || !items.length || !!setup.error} onValueChange={(value) => changeScope(month, value ?? "")}><SelectTrigger id={`${id}-customer`} className="min-h-11 w-full min-w-0 whitespace-normal data-[size=default]:h-auto [&_[data-slot=select-value]]:line-clamp-none"><SelectValue className="min-w-0 whitespace-normal [overflow-wrap:anywhere]" placeholder="Choose a customer" /></SelectTrigger><SelectContent className="[overflow-wrap:anywhere]"><SelectGroup>{items.map((item) => <SelectItem className="min-h-11 min-w-0 [&>span:first-child]:min-w-0 [&>span:first-child]:shrink [&>span:first-child]:whitespace-normal" key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select>}<FieldDescription>Includes archived regulars for earlier statements.</FieldDescription></Field></FieldGroup>
    {setup.error ? <Alert variant="destructive"><AlertTitle>Couldn’t load the customer book</AlertTitle><AlertDescription><p>{errorText(setup.error)}</p><Button variant="outline" size="sm" onClick={() => void setup.refetch()}>Retry customer book</Button></AlertDescription></Alert> : setup.data && !items.length ? <Empty><EmptyHeader><EmptyTitle>No regulars to bill yet</EmptyTitle><EmptyDescription>Add a customer, then configure their agreed meal price in Prices & delivery setup.</EmptyDescription></EmptyHeader></Empty> : null}
    <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]">
      <div className="flex min-w-0 flex-col gap-6">
        {customer && customer.profile.unitPricePaise === null && <Alert><AlertTitle>Set {customer.alias}’s agreed price first</AlertTitle><AlertDescription>Open Prices & delivery setup alongside this bill book. A missing rate is never replaced with an assumed price.</AlertDescription></Alert>}
        <div className="flex flex-wrap items-center gap-3"><Button disabled={locked || !validMonth || !customer || customer.profile.unitPricePaise === null} onClick={() => void makePreview()}>{previewMutation.isPending ? "Calculating preview…" : "Preview statement"}</Button><span className="text-xs leading-relaxed text-muted-foreground">Preview is a local billing calculation from saved records.</span></div>
        {previewMutation.isPending || busy ? <div aria-busy="true" aria-label="Loading statement" className="flex flex-col gap-4"><Skeleton className="h-20 w-2/3" /><Skeleton className="h-48 w-full" /></div> : docket ? <>
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-y py-6"><div className="min-w-0 max-w-full basis-full sm:flex-1 sm:basis-auto"><p className="text-sm text-muted-foreground">{docket.alias} · {monthLabel(docket.month)}</p><p className="mt-2 max-w-full font-heading text-[clamp(2rem,6vw,3.75rem)] leading-tight tracking-tight tabular-nums">{formatINR(docket.totalPaise)}</p><p className="mt-3 text-xs text-muted-foreground">{docket.unitPricePaise === null ? "Rate not configured" : `${formatINR(docket.unitPricePaise)} / meal`} · {docket.lines.length} dated entries</p></div><div className="flex min-w-0 max-w-full flex-col items-start gap-2"><Badge variant={activeInvoice ? "default" : "secondary"}>{activeInvoice ? `Issued · version ${activeInvoice.version}` : "Unissued preview"}</Badge>{activeInvoice && <p className="max-w-48 text-xs leading-relaxed text-muted-foreground">Issued {timeLabel(activeInvoice.issuedAt)}. Saved snapshot; later changes create a new version.</p>}</div></div>
          <dl className="flex flex-col gap-2 text-sm"><TotalRow label="Baseline meals" amount={docket.baselineSubtotalPaise} /><TotalRow label="Skip credit · already applied" amount={-docket.skipCreditPaise} /><TotalRow label="Reduced quantities · already applied" amount={-docket.reductionCreditPaise} /><TotalRow label="Extra meals" amount={docket.extraChargesPaise} /><TotalRow label="Seller-confirmed adjustments" amount={docket.adjustmentsPaise} /></dl>
          <p className="text-xs leading-relaxed text-muted-foreground">The total already includes credits. Skipped meals are credited once, never subtracted again.</p>
          {(docket.warnings.length > 0 || docket.missingDates.length > 0) && <Alert><AlertTitle>{docket.missingDates.length ? "Partial month · statement cannot be issued" : "Review before issuing"}</AlertTitle><AlertDescription>{docket.warnings.map((warning, index) => <p key={index}>{warning}</p>)}{docket.missingDates.length > 0 && <p>Missing finalized dates: {docket.missingDates.map(dayLabel).join(", ")}.</p>}</AlertDescription></Alert>}
          {activePreview && !closedMonth && <Alert><AlertTitle>This month is still open</AlertTitle><AlertDescription>Preview is available. Issue a statement after the month closes and every required date is finalized.</AlertDescription></Alert>}
          {previewStale && <Alert><AlertTitle>Saved records changed after this preview</AlertTitle><AlertDescription>Preview again to use the latest rate, settings and sheet basis.</AlertDescription></Alert>}
          <FieldGroup><Field><FieldLabel>Statement detail</FieldLabel><ToggleGroup className="min-w-0 flex-wrap" value={[view]} onValueChange={(values) => { if (values[0]) setView(values[0]); }} variant="outline" aria-label="Statement detail"><ToggleGroupItem className="min-h-11" value="ledger">Dated proof</ToggleGroupItem><ToggleGroupItem className="min-h-11" value="message">Statement text</ToggleGroupItem></ToggleGroup></Field></FieldGroup>
          {view === "ledger" ? <div className="min-w-0">
            <p id={`${id}-ledger-scroll`} className="mb-3 text-xs leading-relaxed text-muted-foreground">Swipe table sideways, or focus it and use the arrow keys, to see every charge.</p>
            <div role="region" aria-label="Dated billing proof and charges" aria-describedby={`${id}-ledger-scroll`} tabIndex={0} className="min-w-0 max-w-full overflow-x-auto rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_[data-slot=table-container]]:overflow-visible">
              <Table className="min-w-[34rem]" aria-label="Dated billing proof and charges"><TableHeader><TableRow><TableHead>Date & proof</TableHead><TableHead className="text-right">Base</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Charge</TableHead></TableRow></TableHeader><TableBody>{docket.lines.map((line) => <TableRow key={line.serviceDate}><TableCell className="w-72 min-w-52 whitespace-normal py-4"><p className="font-medium">{dayLabel(line.serviceDate)}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Sheet revision {line.sheetRevision} · finalized {timeLabel(line.finalizedAt)}</p>{line.approvedAt && <p className="mt-1 text-xs text-muted-foreground">Approved {timeLabel(line.approvedAt)}</p>}{line.approvalReceiptKey ? <div className="mt-2 flex min-w-0 flex-col items-start gap-1"><code className="max-w-full break-all text-[10px] text-muted-foreground">Receipt {line.approvalReceiptKey}</code><Button variant="link" size="sm" disabled={!!receiptLoading} onClick={() => void readReceipt(line.approvalReceiptKey!)}>{receiptLoading === line.approvalReceiptKey ? "Loading proof…" : "View approval proof"}</Button>{receiptProofs[line.approvalReceiptKey] && <p className="text-xs leading-relaxed text-muted-foreground">{receiptProofs[line.approvalReceiptKey].operation} · committed {timeLabel(receiptProofs[line.approvalReceiptKey].committedAt)} · state revision {receiptProofs[line.approvalReceiptKey].stateRevision}</p>}</div> : <p className="mt-1 text-xs text-muted-foreground">No linked approval receipt.</p>}{line.adjustmentReason && <p className="mt-2 max-w-72 text-xs leading-relaxed">Seller adjustment: {line.adjustmentReason} ({formatINR(line.adjustmentPaise)})</p>}</TableCell><TableCell className="text-right align-top py-4 tabular-nums">{line.baseline}</TableCell><TableCell className="text-right align-top py-4 tabular-nums">{line.quantity}</TableCell><TableCell className="text-right align-top py-4 tabular-nums">{formatINR(line.amountPaise)}</TableCell></TableRow>)}</TableBody></Table>
            </div>{!docket.lines.length && <Empty><EmptyHeader><EmptyTitle>No finalized meal entries</EmptyTitle><EmptyDescription>Finalize the required kitchen sheets before issuing this month’s statement.</EmptyDescription></EmptyHeader></Empty>}</div> : <FieldGroup><Field><FieldLabel htmlFor={`${id}-message`}>{activeInvoice ? "Immutable issued statement text" : "Preview text · not yet issued"}</FieldLabel><Textarea id={`${id}-message`} readOnly value={docket.message} rows={12} className="min-w-0 resize-y [overflow-wrap:anywhere]" /></Field></FieldGroup>}
          {activePreview && <FieldGroup>{activePreview.priorInvoiceId && <Field orientation="horizontal" className="items-start"><Checkbox id={`${id}-revision`} className="mt-0.5 shrink-0" checked={revisionConfirmed} disabled={locked} onCheckedChange={(checked) => setRevisionConfirmed(checked === true)} /><FieldLabel className="min-w-0" htmlFor={`${id}-revision`}>I understand the previous statement may already have been shared. This issues a revised version.</FieldLabel></Field>}<Button className="w-full self-start sm:w-auto" disabled={locked || !activePreview.canIssue || !!activePreview.missingDates.length || !closedMonth || previewStale || draftAdjustment || (!!activePreview.priorInvoiceId && !revisionConfirmed)} onClick={() => void issue()}>{issueMutation.isPending ? "Issuing statement…" : activePreview.priorInvoiceId ? "Issue revised statement" : "Issue statement"}</Button><FieldDescription>Issuing saves a statement. It does not confirm payment.</FieldDescription></FieldGroup>}
          {activeInvoice && <div className="flex min-w-0 flex-col gap-4 border-t pt-5"><p className="text-sm">UPI: <span className="font-medium">{activeInvoice.upiId || "Not provided on this statement"}</span></p><div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap">{shareUrl && <a href={shareUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "default", className: "w-full sm:w-auto" })}><ArrowUpRightIcon strokeWidth={1.5} data-icon="inline-start" />Open WhatsApp composer</a>}<Button className="w-full sm:w-auto" variant="outline" onClick={() => void copyStatement()}><CopyIcon strokeWidth={1.5} data-icon="inline-start" />Copy statement text</Button></div><p className="text-xs leading-relaxed text-muted-foreground">{shareUrl ? activeInvoice.phone ? "Opens a prefilled conversation. You review and send in WhatsApp." : "No billing number is saved. Choose the recipient in WhatsApp." : "This message cannot use a WhatsApp link. Copy the statement text and paste it into WhatsApp."}</p>{copyHint && <p role="status" className="text-sm">{copyHint}</p>}</div>}
        </> : <Empty><EmptyHeader><EmptyTitle>Your month-end docket starts here</EmptyTitle><EmptyDescription>Choose a regular and month, then preview their finalized meal records. Only issued statements can be shared.</EmptyDescription></EmptyHeader></Empty>}
        <Separator />
        <section className="flex min-w-0 flex-col gap-4" aria-label="Previously issued statements"><h3 className="font-heading text-lg">Filed statements</h3>{!validMonth || !selectedId ? <p className="text-sm text-muted-foreground">Choose a customer and month to load issued statements.</p> : invoices.isPending ? <Skeleton className="h-16 w-full" /> : invoices.error ? <Alert variant="destructive"><AlertTitle>Couldn’t load filed statements</AlertTitle><AlertDescription><p>{errorText(invoices.error)}</p><Button variant="outline" size="sm" onClick={() => void invoices.refetch()}>Retry statements</Button></AlertDescription></Alert> : invoices.data?.items.length ? <><ul className="min-w-0 divide-y">{invoices.data.items.map((invoice) => <li key={invoice._id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0 max-w-full flex-1 basis-56"><p className="text-sm font-medium">{invoice.alias} · version {invoice.version} · {formatINR(invoice.totalPaise)}</p><p className="mt-1 text-xs text-muted-foreground">Issued {timeLabel(invoice.issuedAt)}</p></div><Button className="w-full sm:w-auto" variant="outline" size="sm" disabled={locked} onClick={() => void viewExisting(invoice._id)}>View saved statement</Button></li>)}</ul>{invoices.data.hasMore && <p className="text-xs text-muted-foreground">Showing the first 100 statements in this selection.</p>}</> : <p className="py-2 text-sm text-muted-foreground">No issued statement for this customer and month.</p>}</section>
      </div>
      <aside className="flex min-w-0 flex-col gap-6 xl:border-l xl:pl-7">
        <section className="flex min-w-0 flex-col gap-4"><p className="font-mono text-[10px] tracking-[0.15em] text-muted-foreground">A NOTE IN THE MARGIN</p><h3 className="font-heading text-xl text-balance">Half portion? Agree the charge.</h3><p className="text-xs leading-relaxed text-muted-foreground">Seller-confirmed billing adjustment; does not change packing quantities. Enter the absolute charge for that date, not an amount to subtract.</p><form className="min-w-0" onSubmit={addAdjustment}><FieldGroup>
          <Field data-invalid={!!adjustmentError}><FieldLabel htmlFor={`${id}-adjust-date`}>Meal date</FieldLabel><Input id={`${id}-adjust-date`} type="date" value={adjustmentDate} min={validMonth ? `${month}-01` : undefined} max={validMonth ? `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()}` : undefined} disabled={locked || !validMonth || !customer} aria-invalid={!!adjustmentError} onChange={(event) => { setAdjustmentDate(event.target.value); invalidate(); }} /></Field>
          <Field data-invalid={!!adjustmentError}><FieldLabel htmlFor={`${id}-charge`}>Absolute charge for that day · ₹</FieldLabel><Input id={`${id}-charge`} inputMode="decimal" value={charge} disabled={locked || !customer} aria-invalid={!!adjustmentError} onChange={(event) => { setCharge(event.target.value); invalidate(); }} placeholder="Agreed day’s charge" /></Field>
          <Field data-invalid={!!adjustmentError}><FieldLabel htmlFor={`${id}-reason`}>Seller-confirmed reason</FieldLabel><Textarea id={`${id}-reason`} rows={2} value={reason} maxLength={300} disabled={locked || !customer} aria-invalid={!!adjustmentError} onChange={(event) => { setReason(event.target.value); invalidate(); }} /><FieldError>{adjustmentError}</FieldError></Field>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap"><Button className="w-full sm:w-auto" type="submit" variant="outline" disabled={locked || !validMonth || !customer}>Add / replace date charge</Button>{draftAdjustment && <Button type="button" variant="ghost" disabled={locked} onClick={() => { setAdjustmentDate(""); setCharge(""); setReason(""); setAdjustmentError(""); invalidate(); }}>Clear</Button>}</div>
        </FieldGroup></form>{adjustments.length > 0 && <ul className="min-w-0 divide-y">{adjustments.map((item) => <li key={item.serviceDate} className="flex min-w-0 items-start justify-between gap-2 py-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium">{dayLabel(item.serviceDate)} · {formatINR(item.amountPaise)}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.reason}</p></div><Button className="shrink-0" size="icon-sm" variant="ghost" disabled={locked} aria-label={`Remove adjustment for ${dayLabel(item.serviceDate)}`} onClick={() => { setAdjustments(adjustments.filter((row) => row.serviceDate !== item.serviceDate)); invalidate(); }}><Trash2Icon strokeWidth={1.5} /></Button></li>)}</ul>}</section>
        <Separator /><details className="min-w-0"><summary className="min-h-11 cursor-pointer py-3 font-medium">Prices & delivery setup</summary><div className="min-w-0 pt-5" inert={invoiceLocked || undefined}><CommerceSetupPanel sellerId={sellerId} /></div></details>
      </aside>
    </div>
  </section></CommerceWriteContext.Provider>;
}

function TotalRow({ label, amount }: { label: string; amount: number }) {
  return <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-5"><dt className="min-w-0 text-muted-foreground">{label}</dt><dd className="min-w-0 max-w-full tabular-nums sm:text-right">{formatINR(amount)}</dd></div>;
}
