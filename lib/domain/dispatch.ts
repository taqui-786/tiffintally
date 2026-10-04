import { dispatchSchema, type CommerceProfile, type Dispatch } from "../contracts/commerce";
import type { Sheet, SheetRow } from "../contracts/records";

export type DispatchProfile = { customerId: string; profile: CommerceProfile };
type DispatchInput = {
  serviceDate: string; today: string; stateRevision: number; pendingCount: number;
  rows: SheetRow[]; latestSheet: Pick<Sheet, "_id" | "revision" | "rows"> | null;
  profiles: DispatchProfile[]; helperPhone: string;
};
const compare = (a: string, b: string) => a.localeCompare(b, "en");
const byCustomer = (a: { alias: string; customerId: string }, b: { alias: string; customerId: string }) => compare(a.alias, b.alias) || compare(a.customerId, b.customerId);
const singleLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

/** Preferences advance the seller revision too; readiness compares fulfillment facts. */
export function dispatchRowsMatch(frozen: SheetRow[], current: SheetRow[]): boolean {
  if (frozen.length !== current.length) return false;
  const indexed = new Map(current.map((row) => [row.customerId, row]));
  return frozen.every((row) => {
    const other = indexed.get(row.customerId);
    return other !== undefined && row.quantity === other.quantity && row.baseline === other.baseline && row.alias === other.alias && row.packingNote === other.packingNote;
  });
}

export function buildDispatch(input: DispatchInput): Dispatch {
  const { latestSheet, pendingCount } = input;
  const past = input.serviceDate < input.today;
  const reason = !latestSheet ? "Finalize a packing sheet before dispatch."
    : pendingCount > 0 ? "Resolve relevant pending requests before dispatch."
      : !past && !dispatchRowsMatch(latestSheet.rows, input.rows) ? "Approved packing facts changed. Finalize a fresh sheet before dispatch."
        : null;
  const rows = past && latestSheet ? latestSheet.rows : input.rows;
  const profiles = new Map(input.profiles.map((row) => [row.customerId, row.profile]));
  const groupsByName = new Map<string, Dispatch["groups"][number]>();
  const doNotStop: Dispatch["doNotStop"] = [];
  const unroutedCustomerIds: string[] = [];
  for (const row of rows) {
    const profile = profiles.get(row.customerId);
    const routeName = profile?.routeName.trim() || "Unassigned";
    if (row.quantity === 0) {
      if (row.baseline > 0) doNotStop.push({ customerId: row.customerId, alias: row.alias, routeName, reason: "Paused or cancelled for this service date" });
      continue;
    }
    if (!profile?.routeName.trim()) unroutedCustomerIds.push(row.customerId);
    const routeOrder = profile?.routeName.trim() ? profile.routeOrder : 9999;
    let group = groupsByName.get(routeName);
    if (!group) {
      group = { routeName, routeOrder, total: 0, customers: [] };
      groupsByName.set(routeName, group);
    }
    group.routeOrder = Math.min(group.routeOrder, routeOrder);
    group.total += row.quantity;
    group.customers.push({ customerId: row.customerId, alias: row.alias, quantity: row.quantity, deliveryNote: profile?.deliveryNote ?? "" });
  }
  const groups = [...groupsByName.values()].sort((a, b) => a.routeOrder - b.routeOrder || compare(a.routeName, b.routeName));
  for (const group of groups) group.customers.sort(byCustomer);
  doNotStop.sort((a, b) => compare(a.routeName, b.routeName) || byCustomer(a, b));
  unroutedCustomerIds.sort(compare);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  const messageFor = (noteLimit: number) => [
    reason ? `NOT READY — ${reason}` : "Dispatch ready",
    `Service date: ${input.serviceDate} | Sheet revision: ${latestSheet?.revision ?? "not finalized"}`,
    `Total: ${total} meals`,
    "Building/route group order:",
    ...groups.flatMap((group, index) => [
      `\n${index + 1}. ${singleLine(group.routeName)} — ${group.total} meals`,
      ...group.customers.map((customer) => {
        const note = singleLine(customer.deliveryNote);
        const bounded = note.length > noteLimit ? `${note.slice(0, noteLimit)}… [full note in docket]` : note;
        return `- ${singleLine(customer.alias)}: ${customer.quantity}${bounded ? ` — ${bounded}` : ""}`;
      }),
    ]),
    ...(doNotStop.length ? ["\nDo not stop today:", ...doNotStop.map((row) => `- ${singleLine(row.alias)} (${singleLine(row.routeName)}) — ${row.reason}`)] : []),
  ].join("\n");
  let message = messageFor(300);
  // The full docket retains notes; exceptionally long messages abbreviate notes explicitly.
  if (message.length > 40_000) message = messageFor(80);
  return dispatchSchema.parse({
    serviceDate: input.serviceDate, sheetId: latestSheet?._id ?? null, sheetRevision: latestSheet?.revision ?? null,
    stateRevision: input.stateRevision, isReady: reason === null, reason, pendingCount, total,
    helperPhone: input.helperPhone, groups, doNotStop, unroutedCustomerIds, message,
  });
}
