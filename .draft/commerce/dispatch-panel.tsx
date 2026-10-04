"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { dispatchQueryOptions } from "@/lib/client/commerce";
import { uiError } from "@/lib/client/ui-helpers";
import { whatsappShareUrl } from "@/lib/client/whatsapp-share";

export function DispatchPanel({ sellerId, serviceDate, onSetup }: { sellerId: string; serviceDate: string; onSetup: () => void }) {
  const dispatch = useQuery(dispatchQueryOptions(sellerId, serviceDate));
  const messageId = useId();
  const [copyResult, setCopyResult] = useState<{ payload: string; status: string } | null>(null);
  const [copying, setCopying] = useState(false);
  const data = dispatch.data;
  const canShare = Boolean(data?.isReady && !dispatch.error && !dispatch.isFetching);
  const shareUrl = canShare && data ? whatsappShareUrl(data.helperPhone, data.message) : null;
  async function copyMessage() {
    if (!canShare || !data || copying) return;
    const payload = data.message;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(payload);
      setCopyResult({ payload, status: "Message copied. Review it before sharing." });
    } catch {
      setCopyResult({ payload, status: "Couldn’t copy. Select the message below and copy it manually." });
    } finally {
      setCopying(false);
    }
  }

  return <section aria-labelledby="dispatch-heading" className="flex min-w-0 flex-col gap-7">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="mb-2 font-mono text-[10px] tracking-[0.15em] text-muted-foreground">DISPATCH / KITCHEN DOCKET</p><h2 id="dispatch-heading" className="font-heading text-2xl tracking-tight text-balance">Packed. Grouped. Ready to hand over.</h2><p className="mt-2 text-sm text-muted-foreground">Building/route group order for {serviceDate}.</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" disabled={dispatch.isFetching} onClick={() => { setCopyResult(null); void dispatch.refetch(); }}><RefreshCw data-icon="inline-start" strokeWidth={1.5} />{dispatch.isFetching ? "Refreshing…" : "Refresh"}</Button><Button variant="outline" className="min-h-11" onClick={onSetup}>Routes & helper setup</Button></div>
    </header>

    {dispatch.isPending ? <div aria-label="Loading dispatch" className="flex flex-col gap-5"><Skeleton className="h-24 w-40" /><Skeleton className="h-14 w-full" /><Skeleton className="h-24 w-full" /></div>
      : dispatch.error ? <Alert variant="destructive"><AlertTitle>Couldn’t load dispatch</AlertTitle><AlertDescription>{uiError(dispatch.error)} Use Refresh to read the latest docket.</AlertDescription></Alert>
        : data ? <>
          <div className="flex flex-wrap items-end justify-between gap-5"><div><p className="flex flex-wrap items-baseline gap-3"><span className="font-heading text-[clamp(4rem,8vw,6rem)] leading-none tracking-[-0.07em] tabular-nums">{data.total}</span><span className="text-muted-foreground">meals {data.isReady ? "for dispatch" : "in preview"}</span></p><p className="mt-3 text-xs text-muted-foreground">{data.groups.length} building/route groups · {data.groups.reduce((sum, group) => sum + group.customers.length, 0)} stops · {data.sheetRevision === null ? "No finalized sheet" : `Sheet revision ${data.sheetRevision}`}</p></div><Badge variant="outline">{data.isReady ? "Ready" : "Not ready"}</Badge></div>
          {!data.isReady ? <Alert><AlertTitle>Preview only — dispatch is not ready</AlertTitle><AlertDescription>{data.reason} Sharing and copying are available after finalization and review are clear.</AlertDescription></Alert> : null}
          {data.unroutedCustomerIds.length ? <Alert><AlertTitle>{data.unroutedCustomerIds.length} stops need a route</AlertTitle><AlertDescription>They remain in Unassigned below. Enter building/route names and delivery notes in setup before handing over.</AlertDescription></Alert> : null}
          <Separator />
          {data.groups.length ? <ol aria-label="Building and route groups" className="flex flex-col gap-7">
            {data.groups.map((group, index) => <li key={group.routeName} className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-3">
              <span className="pt-1 font-mono text-xs tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
              <div className="min-w-0"><div className="flex items-baseline justify-between gap-4 border-b pb-3"><h3 className="break-words font-heading text-xl">{group.routeName}</h3><p className="shrink-0 font-medium tabular-nums">{group.total} meals</p></div>
                <ul className="divide-y">{group.customers.map((customer) => <li key={customer.customerId} className="flex items-start justify-between gap-4 py-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{customer.alias}</p>{customer.deliveryNote ? <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{customer.deliveryNote}</p> : null}</div><span className="shrink-0 font-heading text-xl tabular-nums">{customer.quantity}<span className="sr-only"> meals</span></span></li>)}</ul>
              </div>
            </li>)}
          </ol> : <Empty className="items-start px-0 py-6 text-left"><EmptyHeader className="items-start"><EmptyTitle>No delivery stops for this date</EmptyTitle><EmptyDescription>Only positive meal quantities create stops. Paused or cancelled regulars appear separately below.</EmptyDescription></EmptyHeader></Empty>}
          {data.doNotStop.length ? <Alert><AlertTitle>Do not stop today</AlertTitle><AlertDescription><ul className="flex w-full flex-col gap-2">{data.doNotStop.map((customer) => <li key={customer.customerId}><span className="font-medium">{customer.alias}</span> · {customer.routeName}<span className="block text-xs">{customer.reason}</span></li>)}</ul></AlertDescription></Alert> : null}
          <Separator />
          <FieldGroup><Field><FieldLabel htmlFor={messageId}>Helper message {data.isReady ? "" : "— NOT READY preview"}</FieldLabel><Textarea id={messageId} readOnly value={data.message} rows={10} className="max-h-96" /><FieldDescription>{data.helperPhone ? "WhatsApp opens a composer for your configured helper." : "No helper number is configured. Choose a recipient in WhatsApp, or add one in setup."} Review and send yourself; opening the composer does not send or confirm delivery.</FieldDescription></Field></FieldGroup>
          <div className="flex flex-wrap items-center gap-3"><Button variant="outline" className="min-h-11" disabled={!canShare || copying} onClick={() => void copyMessage()}><Copy data-icon="inline-start" strokeWidth={1.5} />{copying ? "Copying…" : "Copy helper message"}</Button>
            {shareUrl ? <Button className="min-h-11" nativeButton={false} render={<a href={shareUrl} target="_blank" rel="noopener noreferrer" />}><ExternalLink data-icon="inline-start" strokeWidth={1.5} />Open WhatsApp composer</Button> : <Button className="min-h-11" disabled>Open WhatsApp composer</Button>}
          </div>
          {canShare && !shareUrl ? <p className="text-sm text-muted-foreground">This message is too long for a WhatsApp link. Copy it and paste it into your helper’s chat.</p> : null}
          <p role="status" className="text-sm text-muted-foreground">{copyResult?.payload === data.message ? copyResult.status : ""}</p>
        </> : null}
  </section>;
}
