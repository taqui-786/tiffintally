"use client";

import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2Icon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ClientError, getOperation } from "@/lib/client/api";
import { commerceSetupQueryOptions, saveCommerceCustomerMutationOptions, saveCommerceSettingsMutationOptions } from "@/lib/client/commerce";
import { newCommandMeta } from "@/lib/client/mutations";
import { rupeesToPaise } from "@/lib/client/whatsapp-share";
import { commerceProfileSchema, commerceSettingsSchema, type CommerceInput, type CommerceOutput, type CommerceProfile } from "@/lib/contracts/commerce";

type Setup = CommerceOutput<"getCommerceSetup">;
type Customer = Setup["customers"][number];
type Settings = Setup["settings"];
type HeldCommand = { operation: "saveCommerceSettings"; variables: CommerceInput<"saveCommerceSettings"> } | { operation: "saveCommerceCustomer"; variables: CommerceInput<"saveCommerceCustomer"> };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Couldn’t save these details. Please try again.";
const isUncertain = (error: unknown) => error instanceof TypeError || (error instanceof ClientError && (error.code === "COMMIT_UNCERTAIN" || error.code === "INVALID_RESPONSE" || error.retryable || (error.status !== undefined && error.status >= 500)));
const priceText = (paise: number | null) => paise === null ? "" : `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;

export function CommerceSetupPanel({ sellerId }: { sellerId: string }) {
  const client = useQueryClient();
  const setup = useQuery(commerceSetupQueryOptions(sellerId));
  const settingsMutation = useMutation(saveCommerceSettingsMutationOptions(client, sellerId));
  const customerMutation = useMutation(saveCommerceCustomerMutationOptions(client, sellerId));
  const held = useRef<HeldCommand | null>(null);
  const [uncertainKey, setUncertainKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [reload, setReload] = useState(0);
  const id = useId();
  const selectedId = customerId || setup.data?.customers[0]?.customerId || "";
  const customer = setup.data?.customers.find((item) => item.customerId === selectedId);

  async function saveSettings(settings: Settings, original: Settings) {
    if (held.current || busy) throw new Error("Check the previous request’s receipt before saving again.");
    setBusy(true);
    try {
      await getOperation("me", {});
      const fresh = await getOperation("getCommerceSetup", {});
      if (JSON.stringify(fresh.settings) !== JSON.stringify(original)) throw new Error("Payment or helper details changed since you opened this form. Your edits are kept. Refresh saved values before trying again.");
      const command: HeldCommand = { operation: "saveCommerceSettings", variables: { meta: newCommandMeta(), expectedStateRevision: fresh.stateRevision, settings } };
      held.current = command;
      try { await settingsMutation.mutateAsync(command.variables); }
      catch (error) { if (isUncertain(error)) setUncertainKey(command.variables.meta.idempotencyKey); else held.current = null; throw error; }
      held.current = null;
      toast.success("Payment & helper details saved");
    } finally { setBusy(false); }
  }

  async function saveProfile(profile: CommerceProfile, original: Customer) {
    if (held.current || busy) throw new Error("Check the previous request’s receipt before saving again.");
    setBusy(true);
    try {
      await getOperation("me", {});
      const fresh = await getOperation("getCommerceSetup", {});
      const current = fresh.customers.find((item) => item.customerId === original.customerId);
      if (!current || current.revision !== original.revision || JSON.stringify(current.profile) !== JSON.stringify(original.profile)) throw new Error("This customer’s saved profile changed. Your edits are kept. Refresh saved values before trying again.");
      const command: HeldCommand = { operation: "saveCommerceCustomer", variables: { meta: newCommandMeta(), expectedStateRevision: fresh.stateRevision, customerId: original.customerId, expectedProfileRevision: current.revision, profile } };
      held.current = command;
      try { await customerMutation.mutateAsync(command.variables); }
      catch (error) { if (isUncertain(error)) setUncertainKey(command.variables.meta.idempotencyKey); else held.current = null; throw error; }
      held.current = null;
      toast.success(`Saved ${original.alias}’s billing & delivery details`);
    } finally { setBusy(false); }
  }

  async function checkReceipt() {
    if (!held.current || busy) return;
    setBusy(true);
    try {
      const receipt = await getOperation("getReceipt", { idempotencyKey: held.current.variables.meta.idempotencyKey });
      if (receipt.operation !== held.current.operation) throw new Error("The receipt does not match this request.");
      held.current = null;
      setUncertainKey(null);
      await client.invalidateQueries({ queryKey: ["taptutor", sellerId] });
      toast.success("Saved request confirmed. Refresh saved values to see it.");
    } catch (error) { toast.error(`Receipt not confirmed yet. ${errorText(error)}`); }
    finally { setBusy(false); }
  }

  async function refresh() {
    if (busy || held.current) return;
    const result = await setup.refetch();
    if (result.error) toast.error(errorText(result.error));
    else setReload((value) => value + 1);
  }

  if (setup.isPending) return <section aria-label="Loading prices and delivery setup" aria-busy="true" className="flex flex-col gap-4"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-32 w-full" /><Skeleton className="h-32 w-full" /></section>;
  if (setup.error || !setup.data) return <Alert variant="destructive"><AlertTitle>Couldn’t load prices & delivery setup</AlertTitle><AlertDescription><p>{errorText(setup.error)}</p><Button variant="outline" size="sm" onClick={() => void setup.refetch()}>Retry setup</Button></AlertDescription></Alert>;
  const locked = busy || !!uncertainKey;
  const items = setup.data.customers.map((item) => ({ value: item.customerId, label: `${item.alias}${item.status === "archived" ? " · archived" : ""}` }));
  return <section className="flex min-w-0 flex-col gap-6" aria-label="Prices & delivery setup">
    <header className="flex items-start justify-between gap-4"><div><p className="mb-2 font-mono text-[10px] tracking-[0.15em] text-muted-foreground">HOUSE BOOK / SETUP</p><h2 className="font-heading text-xl tracking-tight">Prices & delivery setup</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Your agreed prices, payment address and delivery instructions.</p></div><Settings2Icon strokeWidth={1.5} className="mt-1 size-5 shrink-0 text-muted-foreground" /></header>
    {uncertainKey && <Alert variant="destructive"><AlertTitle>Save outcome is uncertain</AlertTitle><AlertDescription><p>Further saves are paused. Check the receipt for request <code className="break-all">{uncertainKey}</code> first.</p><Button size="sm" variant="outline" disabled={busy} onClick={() => void checkReceipt()}>{busy ? "Checking receipt…" : "Check receipt"}</Button></AlertDescription></Alert>}
    <details open className="group"><summary className="cursor-pointer py-2 font-medium">Payment & delivery helper</summary><div className="pt-4"><SettingsForm key={`settings-${reload}`} initial={setup.data.settings} disabled={locked} busy={busy} onSave={saveSettings} /></div></details>
    <Separator />
    <details open><summary className="cursor-pointer py-2 font-medium">Customer price & route</summary><div className="flex flex-col gap-5 pt-4">
      {items.length ? <><FieldGroup><Field><FieldLabel htmlFor={`${id}-customer`}>Customer · including archived regulars</FieldLabel><Select items={items} value={selectedId} disabled={locked} onValueChange={(value) => setCustomerId(value ?? "")}><SelectTrigger id={`${id}-customer`} className="w-full"><SelectValue placeholder="Choose a customer" /></SelectTrigger><SelectContent><SelectGroup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field></FieldGroup>{customer && <ProfileForm key={`${customer.customerId}-${reload}`} initial={customer} disabled={locked} busy={busy} onSave={saveProfile} />}</> : <Empty><EmptyHeader><EmptyTitle>No customers yet</EmptyTitle><EmptyDescription>Add a regular in Customers, then agree their price here.</EmptyDescription></EmptyHeader></Empty>}
    </div></details>
    <Button type="button" variant="ghost" size="sm" className="self-start" disabled={locked || setup.isFetching} onClick={() => void refresh()}>{setup.isFetching ? "Refreshing…" : "Refresh saved values (replaces form edits)"}</Button>
  </section>;
}

function SettingsForm({ initial, disabled, busy, onSave }: { initial: Settings; disabled: boolean; busy: boolean; onSave: (settings: Settings, original: Settings) => Promise<void> }) {
  const id = useId();
  const [original, setOriginal] = useState(initial);
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = commerceSettingsSchema.safeParse(form);
    setError("");
    if (!parsed.success) { setErrors(Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.path[0] === "helperPhone" ? "Use country code and digits only, without +, or leave blank." : "Enter a valid UPI address, or leave blank."]))); return; }
    setErrors({});
    try { await onSave(parsed.data, original); setOriginal(parsed.data); }
    catch (cause) { setError(errorText(cause)); }
  }
  return <form onSubmit={(event) => void submit(event)} aria-busy={busy}><FieldGroup>
    <Field data-invalid={!!errors.upiId}><FieldLabel htmlFor={`${id}-upi`}>UPI ID</FieldLabel><Input id={`${id}-upi`} value={form.upiId} maxLength={120} disabled={disabled} autoComplete="off" aria-invalid={!!errors.upiId} onChange={(event) => setForm({ ...form, upiId: event.target.value })} placeholder="name@bank" /><FieldDescription>Printed on issued statements; optional.</FieldDescription><FieldError>{errors.upiId}</FieldError></Field>
    <Field data-invalid={!!errors.helperPhone}><FieldLabel htmlFor={`${id}-helper`}>Delivery helper’s WhatsApp number</FieldLabel><Input id={`${id}-helper`} type="tel" inputMode="numeric" value={form.helperPhone} maxLength={15} disabled={disabled} autoComplete="off" aria-invalid={!!errors.helperPhone} onChange={(event) => setForm({ ...form, helperPhone: event.target.value })} /><FieldDescription>Country code + number, digits only without the + sign. Optional.</FieldDescription><FieldError>{errors.helperPhone}</FieldError></Field>
    <FieldError>{error}</FieldError><Button type="submit" disabled={disabled} className="self-start">{busy ? "Saving…" : "Save payment & helper"}</Button>
  </FieldGroup></form>;
}

function ProfileForm({ initial, disabled, busy, onSave }: { initial: Customer; disabled: boolean; busy: boolean; onSave: (profile: CommerceProfile, original: Customer) => Promise<void> }) {
  const id = useId();
  const [original, setOriginal] = useState(initial);
  const [form, setForm] = useState(initial.profile);
  const [price, setPrice] = useState(priceText(initial.profile.unitPricePaise));
  const [routeOrder, setRouteOrder] = useState(String(initial.profile.routeOrder));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const unitPricePaise = price.trim() ? rupeesToPaise(price) : null;
    if (price.trim() && unitPricePaise === null) { setErrors({ unitPricePaise: "Enter a non-negative price in rupees with up to two decimal places." }); return; }
    const parsed = commerceProfileSchema.safeParse({ ...form, unitPricePaise, routeOrder: /^\d+$/.test(routeOrder) ? Number(routeOrder) : NaN });
    if (!parsed.success) { setErrors(Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.path[0] === "phone" ? "Use country code and digits only, without +, or leave blank." : issue.message]))); return; }
    setErrors({});
    try {
      await onSave(parsed.data, original);
      // Load the committed revision; a concurrent edit still cannot silently overwrite this form.
      const fresh = await getOperation("getCommerceSetup", {});
      const saved = fresh.customers.find((item) => item.customerId === initial.customerId);
      if (saved && JSON.stringify(saved.profile) === JSON.stringify(parsed.data)) setOriginal(saved);
    } catch (cause) { setError(errorText(cause)); }
  }
  return <form onSubmit={(event) => void submit(event)} aria-busy={busy}><FieldGroup>
    <Field data-invalid={!!errors.unitPricePaise}><FieldLabel htmlFor={`${id}-price`}>Agreed price per meal · ₹</FieldLabel><Input id={`${id}-price`} inputMode="decimal" value={price} disabled={disabled} aria-invalid={!!errors.unitPricePaise} onChange={(event) => setPrice(event.target.value)} placeholder="Not configured" /><FieldDescription>Blank means no configured rate. No price is assumed.</FieldDescription><FieldError>{errors.unitPricePaise}</FieldError></Field>
    <Field data-invalid={!!errors.phone}><FieldLabel htmlFor={`${id}-phone`}>Billing WhatsApp number · optional</FieldLabel><Input id={`${id}-phone`} type="tel" inputMode="numeric" maxLength={15} value={form.phone} disabled={disabled} autoComplete="off" aria-invalid={!!errors.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /><FieldDescription>Country code and digits only, without +.</FieldDescription><FieldError>{errors.phone}</FieldError></Field>
    <Field data-invalid={!!errors.routeName}><FieldLabel htmlFor={`${id}-route`}>Route name</FieldLabel><Input id={`${id}-route`} maxLength={120} value={form.routeName} disabled={disabled} aria-invalid={!!errors.routeName} onChange={(event) => setForm({ ...form, routeName: event.target.value })} /><FieldError>{errors.routeName}</FieldError></Field>
    <Field data-invalid={!!errors.routeOrder}><FieldLabel htmlFor={`${id}-order`}>Route order</FieldLabel><Input id={`${id}-order`} type="number" min={0} max={9999} step={1} value={routeOrder} disabled={disabled} aria-invalid={!!errors.routeOrder} onChange={(event) => setRouteOrder(event.target.value)} /><FieldError>{errors.routeOrder}</FieldError></Field>
    <Field data-invalid={!!errors.deliveryNote}><FieldLabel htmlFor={`${id}-note`}>Delivery note</FieldLabel><Textarea id={`${id}-note`} rows={3} maxLength={300} value={form.deliveryNote} disabled={disabled} aria-invalid={!!errors.deliveryNote} onChange={(event) => setForm({ ...form, deliveryNote: event.target.value })} /><FieldError>{errors.deliveryNote}</FieldError></Field>
    <FieldError>{error}</FieldError><Button type="submit" disabled={disabled} className="self-start">{busy ? "Saving…" : "Save customer setup"}</Button>
  </FieldGroup></form>;
}
