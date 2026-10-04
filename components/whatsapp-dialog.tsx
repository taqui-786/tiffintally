"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Loader2,
  MessageSquare,
  Phone,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Unplug,
  UserCheck,
  Users,
} from "lucide-react";
import { cn } from "cn";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  addManualWhatsAppContactAction,
  batchImportWhatsAppCustomersAction,
  getWhatsAppWebStatusAction,
  listWhatsAppContactsAction,
  startWhatsAppWebConnectAction,
  stopWhatsAppWebAction,
  updateWhatsAppContactNameAction,
} from "@/app/actions/whatsapp";

type Contact = {
  _id: string;
  waId: string;
  profileName: string;
  lastMessage: string;
  lastMessageAt: string;
  customerId: string | null;
};

type CustomerItem = {
  _id: string;
  alias: string;
};

type WebStatus = {
  status: "disconnected" | "connecting" | "scan_qr" | "connected";
  qrDataUrl: string | null;
  phoneNumber: string | null;
  hasSavedSession: boolean;
};

export function WhatsAppDialog() {
  const [open, setOpen] = useState(false);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [isQrLoading, setIsQrLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  // WhatsApp Web Session State
  const [webStatus, setWebStatus] = useState<WebStatus>({
    status: "disconnected",
    qrDataUrl: null,
    phoneNumber: null,
    hasSavedSession: false,
  });

  // Contacts and Customers
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [customers, setCustomers] = useState<CustomerItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedWaIds, setSelectedWaIds] = useState<Set<string>>(new Set());
  const [editedNames, setEditedNames] = useState<Record<string, string>>({});

  // Manual Contact Add
  const [showAddManual, setShowAddManual] = useState(false);
  const [manualPhone, setManualPhone] = useState("");
  const [manualName, setManualName] = useState("");

  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  const isConnected = webStatus.status === "connected";

  function stopPolling() {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  async function checkWebStatus() {
    try {
      const res = await getWhatsAppWebStatusAction();
      if (res.ok) {
        setWebStatus({
          status: res.status,
          qrDataUrl: res.qrDataUrl,
          phoneNumber: res.phoneNumber,
          hasSavedSession: res.hasSavedSession,
        });

        if (res.status === "connected") {
          stopPolling();
          void loadContacts();
        }
      }
    } catch {
      // silent
    }
  }

  async function handleStartQr() {
    setIsQrLoading(true);
    try {
      const res = await startWhatsAppWebConnectAction();
      if (res.ok) {
        setWebStatus({
          status: res.status,
          qrDataUrl: res.qrDataUrl,
          phoneNumber: res.phoneNumber,
          hasSavedSession: res.hasSavedSession,
        });

        if (res.status === "connected") {
          toast.success(`WhatsApp connected! ${res.phoneNumber ? `(+${res.phoneNumber})` : ""}`);
          stopPolling();
          await loadContacts();
        } else {
          // Poll every 2 seconds while waiting for phone scan
          stopPolling();
          pollTimerRef.current = setInterval(() => {
            void checkWebStatus();
          }, 2000);
        }
      } else {
        toast.error(res.error || "Failed to start WhatsApp session.");
      }
    } finally {
      setIsQrLoading(false);
    }
  }

  async function handleStopWeb() {
    if (!confirm("Are you sure you want to disconnect WhatsApp?")) return;
    setIsQrLoading(true);
    stopPolling();
    try {
      const res = await stopWhatsAppWebAction();
      if (res.ok) {
        setWebStatus({
          status: "disconnected",
          qrDataUrl: null,
          phoneNumber: null,
          hasSavedSession: false,
        });
        toast.success("WhatsApp disconnected.");
      } else {
        toast.error(res.error || "Failed to disconnect.");
      }
    } finally {
      setIsQrLoading(false);
    }
  }

  async function loadContacts() {
    setLoadingContacts(true);
    try {
      const res = await listWhatsAppContactsAction();
      if (res.ok && res.contacts && res.customers) {
        setContacts(res.contacts as Contact[]);
        setCustomers(res.customers as CustomerItem[]);

        // Pre-populate editable names from profileName
        const initialNames: Record<string, string> = {};
        for (const c of res.contacts as Contact[]) {
          initialNames[c.waId] = c.profileName || `Customer +${c.waId}`;
        }
        setEditedNames((prev) => ({ ...initialNames, ...prev }));
      }
    } finally {
      setLoadingContacts(false);
    }
  }

  // Initial status check on mount
  useEffect(() => {
    let active = true;
    void getWhatsAppWebStatusAction().then((res) => {
      if (active && res.ok) {
        setWebStatus({
          status: res.status,
          qrDataUrl: res.qrDataUrl,
          phoneNumber: res.phoneNumber,
          hasSavedSession: res.hasSavedSession,
        });
        if (res.status === "connected") {
          void loadContacts();
        }
      }
    });

    return () => {
      active = false;
      stopPolling();
    };
  }, []);

  // Filtered contacts based on search query
  const filteredContacts = useMemo(() => {
    if (!searchQuery.trim()) return contacts;
    const q = searchQuery.toLowerCase().trim();
    return contacts.filter((c) => {
      const name = (editedNames[c.waId] || c.profileName || "").toLowerCase();
      const phone = c.waId.toLowerCase();
      const msg = (c.lastMessage || "").toLowerCase();
      return name.includes(q) || phone.includes(q) || msg.includes(q);
    });
  }, [contacts, searchQuery, editedNames]);

  // Set of waIds that are already linked as customers
  const alreadyCustomerWaIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts) {
      if (c.customerId) {
        set.add(c.waId);
      } else {
        const found = customers.find((cust) => cust._id === c.customerId);
        if (found) set.add(c.waId);
      }
    }
    return set;
  }, [contacts, customers]);

  function toggleSelectContact(waId: string) {
    setSelectedWaIds((prev) => {
      const next = new Set(prev);
      if (next.has(waId)) next.delete(waId);
      else next.add(waId);
      return next;
    });
  }

  function handleSelectAll() {
    const next = new Set<string>();
    for (const c of filteredContacts) {
      if (!alreadyCustomerWaIds.has(c.waId)) {
        next.add(c.waId);
      }
    }
    setSelectedWaIds(next);
  }

  function handleDeselectAll() {
    setSelectedWaIds(new Set());
  }

  async function handleSaveContactName(waId: string, name: string) {
    try {
      await updateWhatsAppContactNameAction({ waId, name });
      toast.success("Name updated");
    } catch {
      toast.error("Failed to update name");
    }
  }

  async function handleBatchImport() {
    if (selectedWaIds.size === 0) return;
    setImporting(true);
    try {
      const itemsToImport = Array.from(selectedWaIds).map((waId) => ({
        waId,
        alias: (editedNames[waId] || `Customer +${waId}`).trim(),
      }));

      const res = await batchImportWhatsAppCustomersAction(itemsToImport);
      if (res.ok) {
        toast.success(`Successfully added ${res.count} customer${res.count === 1 ? "" : "s"}!`);
        setSelectedWaIds(new Set());
        await loadContacts();
      } else {
        toast.error(res.error || "Failed to add customers.");
      }
    } finally {
      setImporting(false);
    }
  }

  async function handleAddSingleCustomer(contact: Contact) {
    const alias = (editedNames[contact.waId] || contact.profileName || `Customer +${contact.waId}`).trim();
    try {
      const res = await batchImportWhatsAppCustomersAction([{ waId: contact.waId, alias }]);
      if (res.ok) {
        toast.success(`Added "${alias}" as customer!`);
        await loadContacts();
      } else {
        toast.error(res.error || "Failed to add customer.");
      }
    } catch {
      toast.error("Something went wrong.");
    }
  }

  async function handleAddManualContact(e: React.FormEvent) {
    e.preventDefault();
    if (!manualPhone.trim()) return;
    try {
      const res = await addManualWhatsAppContactAction({
        waId: manualPhone.trim(),
        name: manualName.trim() || `+${manualPhone.trim()}`,
      });
      if (res.ok) {
        toast.success("Contact added! You can now select them.");
        setManualPhone("");
        setManualName("");
        setShowAddManual(false);
        await loadContacts();
      } else {
        toast.error(res.error || "Failed to add contact.");
      }
    } catch {
      toast.error("Failed to add contact.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          void checkWebStatus();
          void loadContacts();
        } else {
          stopPolling();
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant={isConnected ? "outline" : "default"}
            size="sm"
            className="gap-2 font-medium shadow-xs [&_[data-slot=badge]]:max-sm:hidden"
          >
            <Phone data-icon="inline-start" strokeWidth={1.5} />
            <span>WhatsApp</span>
            {isConnected ? (
              <Badge variant="default">
                Live
              </Badge>
            ) : (
              <Badge variant="secondary">
                Connect
              </Badge>
            )}
          </Button>
        }
      />

      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-visible p-0 [overflow-wrap:anywhere] sm:max-w-4xl [&_[data-slot=field-label]]:whitespace-normal">
        <DialogHeader className="shrink-0 px-4 py-4 pr-16 sm:px-6 sm:pr-16">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <MessageSquare className="size-5" strokeWidth={1.5} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <DialogTitle className="leading-snug">WhatsApp order automation</DialogTitle>
            </div>
          </div>
        </DialogHeader>
        <Separator className="shrink-0" />

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="grid min-w-0 items-start gap-5 p-4 sm:p-6 lg:grid-cols-[260px_minmax(0,1fr)]">
            <DialogDescription className="lg:col-span-2">
              Connect WhatsApp, select your customers, and let incoming order messages flow into your review queue.
            </DialogDescription>
            <ol aria-label="Set up automatic order intake" className="grid min-w-0 gap-4 border-b pb-5 sm:grid-cols-3 lg:col-span-2">
              {[
                { title: "Connect WhatsApp", description: "Scan the QR code with your kitchen phone." },
                { title: "Choose your customers", description: "Link the contacts whose meal requests you manage." },
                { title: "Orders arrive automatically", description: "Incoming text orders are analysed into drafts when AI is configured." },
              ].map(({ title, description }, index) => <li key={title} className="flex min-w-0 items-start gap-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs text-primary">{index + 1}</span><div className="min-w-0"><p className="text-sm font-medium">{title}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p></div></li>)}
            </ol>
            <aside className="min-w-0" aria-label="WhatsApp connection">
              <Card size="sm">
                <CardHeader>
                  <CardTitle className="flex min-w-0 items-center gap-2">
                    <Phone className="size-4 shrink-0 text-primary" strokeWidth={1.5} />
                    Kitchen phone
                  </CardTitle>
                  <CardDescription>Your connection for incoming customer orders.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div aria-live="polite" role="status">
                    <Badge variant={isConnected ? "default" : "secondary"}>
                      {isConnected ? "Connected" : webStatus.status === "scan_qr" ? "Scan to connect" : webStatus.status === "connecting" || isQrLoading ? "Connecting…" : "Not connected"}
                    </Badge>
                  </div>
                  {isConnected ? (
                    <>
                      <p className="break-words text-sm font-medium">
                        {webStatus.phoneNumber ? `+${webStatus.phoneNumber}` : "Kitchen WhatsApp"}
                      </p>
                      <p className="text-xs leading-relaxed text-muted-foreground">{alreadyCustomerWaIds.size ? `${alreadyCustomerWaIds.size} customers linked. New text orders enter the review queue automatically; AI analysis requires configured models.` : "Your phone is connected. Link your customers to set up automatic analysis of their next text orders."}</p>
                      <div className="flex min-w-0 flex-wrap gap-2">
                        <Button variant="outline" size="sm" onClick={() => void loadContacts()} disabled={loadingContacts}>
                          <RefreshCw data-icon="inline-start" strokeWidth={1.5} className={cn(loadingContacts && "animate-spin")} />
                          Refresh contacts
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void handleStopWeb()} disabled={isQrLoading}>
                          <Unplug data-icon="inline-start" strokeWidth={1.5} />
                          Disconnect
                        </Button>
                      </div>
                    </>
                  ) : webStatus.status === "scan_qr" && webStatus.qrDataUrl ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={webStatus.qrDataUrl} alt="Scan this QR code with WhatsApp to connect your kitchen phone" className="mx-auto aspect-square w-full max-w-56 rounded-xl object-contain" />
                      <ol className="flex list-decimal flex-col gap-2 pl-4 text-sm text-muted-foreground">
                        <li>Open WhatsApp on your phone.</li>
                        <li>Open Settings (iPhone) or More options (Android).</li>
                        <li>Choose <strong className="text-foreground">Linked Devices → Link a Device</strong>.</li>
                        <li>Scan this QR code.</li>
                      </ol>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                          <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
                          Waiting for scan…
                        </span>
                        <Button variant="outline" size="sm" onClick={() => void handleStartQr()} disabled={isQrLoading}>
                          <RefreshCw data-icon="inline-start" strokeWidth={1.5} />
                          Refresh QR
                        </Button>
                      </div>
                    </>
                  ) : webStatus.status === "connecting" || isQrLoading ? (
                    <div className="flex items-start gap-3 py-2" role="status" aria-live="polite">
                      <Loader2 className="size-5 shrink-0 animate-spin text-primary" strokeWidth={1.5} />
                      <div className="flex flex-col gap-1">
                        <p className="text-sm font-medium">Preparing your connection…</p>
                        <p className="text-xs text-muted-foreground">Your QR code will appear here.</p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground">Link your kitchen phone once. Your customers can keep sending their orders on WhatsApp.</p>
                       <Button onClick={() => void handleStartQr()} disabled={isQrLoading} className="min-h-11 w-full">
                        <QrCode data-icon="inline-start" strokeWidth={1.5} />
                        Generate QR code
                      </Button>
                    </>
                  )}
                </CardContent>
              </Card>
            </aside>
            <section className="flex min-w-0 flex-col gap-4" aria-labelledby="whatsapp-contacts-heading">

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 id="whatsapp-contacts-heading" className="flex min-w-0 items-center gap-2 font-medium">
                      <Users className="size-4 shrink-0 text-primary" strokeWidth={1.5} />
                      Select your customers
                    </h3>
                    <Badge variant="secondary">{contacts.length} {contacts.length === 1 ? "contact" : "contacts"}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">Choose and link your customers so their next text orders can be analysed automatically.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setShowAddManual(!showAddManual)} aria-expanded={showAddManual} aria-controls="whatsapp-manual-form">
                  <Plus data-icon="inline-start" strokeWidth={1.5} />
                  Manual number
                </Button>
              </div>

              {showAddManual && (
                <form id="whatsapp-manual-form" onSubmit={handleAddManualContact} className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4">
                  <FieldGroup className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3">
                    <Field className="min-w-0 gap-1.5">
                      <FieldLabel htmlFor="whatsapp-manual-phone">Phone number</FieldLabel>
                       <Input id="whatsapp-manual-phone" type="tel" autoComplete="tel" placeholder="919876543210" value={manualPhone} onChange={(e) => setManualPhone(e.target.value)} className="h-10 min-w-0" required />
                    </Field>
                    <Field className="min-w-0 gap-1.5">
                      <FieldLabel htmlFor="whatsapp-manual-name">Customer name</FieldLabel>
                      <Input id="whatsapp-manual-name" placeholder="Rahul Sharma" value={manualName} onChange={(e) => setManualName(e.target.value)} className="h-10 min-w-0" />
                    </Field>
                  </FieldGroup>
                  <Button type="submit" size="sm" className="self-start">Add to list</Button>
                </form>
              )}

              <div className="relative min-w-0">
                <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground" strokeWidth={1.5} />
                <Input aria-label="Search WhatsApp contacts by name, phone, or message" placeholder="Search name, phone, or message…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="h-10 w-full min-w-0 pl-9" />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">{alreadyCustomerWaIds.size} / {contacts.length} customers linked</p>
                <div className="flex flex-wrap items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={handleSelectAll}>Select all unadded</Button>
                  <Button variant="ghost" size="sm" onClick={handleDeselectAll}>Clear</Button>
                </div>
              </div>

              {loadingContacts ? (
                <div className="divide-y rounded-xl border" role="status" aria-label="Loading WhatsApp contacts">
                  <span className="sr-only">Fetching WhatsApp contacts and chats…</span>
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="flex items-center gap-3 p-3" aria-hidden="true">
                      <Skeleton className="size-4 rounded" />
                      <Skeleton className="size-8 rounded-full" />
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-3 w-28" />
                        <Skeleton className="h-3 w-3/4" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : filteredContacts.length === 0 ? (
                <Empty className="border px-5 py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">{searchQuery ? <Search strokeWidth={1.5} /> : <Users strokeWidth={1.5} />}</EmptyMedia>
                    <EmptyTitle>{searchQuery ? "No matching contacts" : "No contacts yet"}</EmptyTitle>
                    <EmptyDescription>
                      {searchQuery
                        ? "Try a different name, phone number, or message."
                        : isConnected
                          ? "Send or receive a WhatsApp message, or use Manual number to add a contact."
                          : "Connect your kitchen phone to load contacts, or add a number manually."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="min-w-0 divide-y rounded-xl border bg-card">
                  {filteredContacts.map((contact) => {
                    const isCustomer = alreadyCustomerWaIds.has(contact.waId);
                    const isSelected = selectedWaIds.has(contact.waId);
                    const currentName = editedNames[contact.waId] ?? contact.profileName ?? `+${contact.waId}`;

                    return (
                      <div key={contact._id || contact.waId} className={cn("flex min-w-0 items-start gap-3 p-3 transition-colors", isSelected ? "bg-primary/5" : "hover:bg-muted/30")}>
                        <Checkbox className="mt-3" aria-label={`Select ${currentName} (+${contact.waId})`} disabled={isCustomer} checked={isCustomer || isSelected} onCheckedChange={() => toggleSelectContact(contact.waId)} />
                        <Avatar className="mt-1 hidden sm:flex">
                          <AvatarFallback className="uppercase">{currentName.slice(0, 2)}</AvatarFallback>
                        </Avatar>
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                          <Field className="min-w-0 gap-0">
                            <FieldLabel className="sr-only" htmlFor={`whatsapp-name-${contact.waId}`}>Customer name for +{contact.waId}</FieldLabel>
                            <Input
                              id={`whatsapp-name-${contact.waId}`}
                              value={currentName}
                              onChange={(e) => setEditedNames((prev) => ({ ...prev, [contact.waId]: e.target.value }))}
                              onBlur={(e) => void handleSaveContactName(contact.waId, e.target.value)}
                              placeholder="Customer name"
                              className="h-10 min-w-0"
                              title="Click to edit name"
                            />
                          </Field>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="break-all font-mono text-xs text-muted-foreground">+{contact.waId}</span>
                            {isCustomer ? (
                              <Badge variant="secondary"><Check strokeWidth={1.5} />Customer</Badge>
                            ) : (
                              <Button size="sm" variant="secondary" onClick={() => void handleAddSingleCustomer(contact)} aria-label={`Add ${currentName} as a customer`}>
                                <Plus data-icon="inline-start" strokeWidth={1.5} />Add
                              </Button>
                            )}
                          </div>
                          {contact.lastMessage ? <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{contact.lastMessage}</p> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            <p className="text-xs text-muted-foreground lg:col-span-2">With WhatsApp connected and AI configured, linked customers’ text orders become review drafts automatically. You approve changes before packing.</p>
          </div>
        </div>
        <Separator className="shrink-0" />
        <footer className="flex min-w-0 shrink-0 flex-col gap-2 px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium" aria-live="polite">{selectedWaIds.size} selected</span>
              <Button variant="ghost" size="sm" onClick={handleDeselectAll} disabled={selectedWaIds.size === 0}>Clear</Button>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
               <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
               <Button onClick={() => void handleBatchImport()} disabled={selectedWaIds.size === 0 || importing}>
                {importing ? <Loader2 data-icon="inline-start" strokeWidth={1.5} className="animate-spin" /> : <UserCheck data-icon="inline-start" strokeWidth={1.5} />}
                {importing ? "Linking…" : "Link customers"}
              </Button>
            </div>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
