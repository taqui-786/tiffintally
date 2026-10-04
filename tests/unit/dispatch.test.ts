import { describe, expect, it } from "vitest";
import type { CommerceProfile } from "@/lib/contracts/commerce";
import type { SheetRow } from "@/lib/contracts/records";
import { buildDispatch, dispatchRowsMatch } from "@/lib/domain/dispatch";
import { whatsappShareUrl } from "@/lib/client/whatsapp-share";

const row = (customerId: string, alias: string, quantity: number, baseline = quantity): SheetRow => ({ customerId, alias, quantity, baseline, approvalId: null, packingNote: "Packing only: no onions" });
const profile = (routeName = "", routeOrder = 0, deliveryNote = ""): CommerceProfile => ({ routeName, routeOrder, deliveryNote, phone: "", unitPricePaise: null });
function fixture(rows: SheetRow[]): Parameters<typeof buildDispatch>[0] {
  return { serviceDate: "2026-10-04", today: "2026-10-04", rows, latestSheet: { _id: "sheet", revision: 2, rows }, pendingCount: 0, stateRevision: 100, profiles: [], helperPhone: "919876543210" };
}

describe("dispatch docket", () => {
  it("includes baseline-plan meals, preserves unknown routes and sums every positive quantity", () => {
    const rows = [row("b", "Bina", 3), row("a", "Anita", 2), row("c", "Chitra", 1), row("d", "Dev", 2), row("e", "Esha", 4)];
    const input = fixture(rows);
    input.profiles = [
      { customerId: "a", profile: profile("South building", 2, "Leave with the guard") },
      { customerId: "b", profile: profile("South building", 2) },
      { customerId: "c", profile: profile("North building", 1) },
      { customerId: "d", profile: profile("Previously unknown building", 2) },
    ];
    const dispatch = buildDispatch(input);
    expect(dispatch.isReady).toBe(true);
    expect(dispatch.total).toBe(12);
    expect(dispatch.groups.map((group) => [group.routeName, group.total])).toEqual([["North building", 1], ["Previously unknown building", 2], ["South building", 5], ["Unassigned", 4]]);
    expect(dispatch.groups[2].customers.map((customer) => customer.alias)).toEqual(["Anita", "Bina"]);
    expect(dispatch.unroutedCustomerIds).toEqual(["e"]);
    expect(dispatch.message).toContain("Service date: 2026-10-04 | Sheet revision: 2");
    expect(dispatch.message).toContain("Anita: 2 — Leave with the guard");
    expect(dispatch.message).not.toContain("Packing only");
    expect(dispatch.message).not.toContain(input.helperPhone);
    expect(dispatch.groups.reduce((sum, group) => sum + group.customers.reduce((count, customer) => count + customer.quantity, 0), 0)).toBe(dispatch.total);
  });

  it("makes zero-quantity regular cancellations explicit without stops for never-ordered or closed-day zeros", () => {
    const rows = [row("paused", "Paused regular", 0, 2), row("cancelled", "Cancelled regular", 0, 1), row("none", "Never ordered", 0), row("closed", "Closed-day regular", 0), row("active", "Active", 2)];
    const dispatch = buildDispatch(fixture(rows));
    expect(dispatch.groups.flatMap((group) => group.customers).map((customer) => customer.customerId)).toEqual(["active"]);
    expect(dispatch.doNotStop.map((customer) => customer.customerId)).toEqual(["cancelled", "paused"]);
    expect(dispatch.unroutedCustomerIds).toEqual(["active"]);
    expect(dispatch.total).toBe(2);
    expect(dispatch.message).toContain("Do not stop today:");
    expect(dispatch.message).not.toContain("Never ordered");
  });

  it("sorts same-alias members by ID and uses a stable group order independent of input order", () => {
    const input = fixture([row("second", "Same alias", 1), row("first", "Same alias", 2)]);
    input.profiles = input.rows.map((item) => ({ customerId: item.customerId, profile: profile("Building", item.customerId === "first" ? 3 : 5) }));
    const forward = buildDispatch(input);
    const reversed = buildDispatch({ ...input, rows: [...input.rows].reverse(), profiles: [...input.profiles].reverse() });
    expect(forward).toEqual(reversed);
    expect(forward.groups[0].routeOrder).toBe(3);
    expect(forward.groups[0].customers.map((customer) => customer.customerId)).toEqual(["first", "second"]);
  });

  it("blocks missing sheets and relevant pending review, marks previews NOT READY", () => {
    const input = fixture([row("a", "A", 1)]);
    expect(buildDispatch({ ...input, latestSheet: null })).toMatchObject({ isReady: false, sheetId: null });
    const pending = buildDispatch({ ...input, pendingCount: 1 });
    expect(pending).toMatchObject({ isReady: false, pendingCount: 1 });
    expect(pending.message).toContain("NOT READY");
  });

  it.each(["quantity", "baseline", "alias", "packingNote"] as const)("requires fresh finalization when today's %s changes", (field) => {
    const input = fixture([row("a", "A", 2)]);
    const current = { ...input.rows[0], [field]: typeof input.rows[0][field] === "number" ? 3 : "Changed" };
    expect(buildDispatch({ ...input, rows: [current] }).isReady).toBe(false);
    expect(buildDispatch({ ...input, serviceDate: "2026-10-05", rows: [current] }).isReady).toBe(false);
  });

  it("compares full row membership but ignores global revision, approval IDs and row order", () => {
    const input = fixture([row("a", "A", 2), row("b", "B", 3)]);
    expect(buildDispatch({ ...input, stateRevision: 999 }).isReady).toBe(true);
    expect(dispatchRowsMatch(input.rows, [{ ...input.rows[1], approvalId: "new-approval" }, input.rows[0]])).toBe(true);
    expect(buildDispatch({ ...input, rows: [input.rows[0]] }).isReady).toBe(false);
  });

  it("keeps past customer aliases, quantities and cancellations from the latest immutable sheet", () => {
    const input = fixture([row("a", "Frozen alias", 2), row("b", "Frozen cancellation", 0, 3)]);
    const past = buildDispatch({ ...input, today: "2026-10-05", rows: [row("a", "Changed alias", 5)] });
    expect(past).toMatchObject({ isReady: true, total: 2 });
    expect(past.groups[0].customers[0].alias).toBe("Frozen alias");
    expect(past.doNotStop[0].alias).toBe("Frozen cancellation");
    expect(buildDispatch({ ...input, today: "2026-10-05", pendingCount: 1 }).isReady).toBe(false);
  });

  it("bounds long helper messages without dropping customers or full notes from the docket", () => {
    const rows = Array.from({ length: 100 }, (_, index) => row(`customer-${index}`, `Alias ${index} ${"a".repeat(100)}`, 1));
    const input = fixture(rows);
    input.profiles = rows.map((item, index) => ({ customerId: item.customerId, profile: profile(`Building ${index} ${"b".repeat(100)}`, index, "n".repeat(300)) }));
    const dispatch = buildDispatch(input);
    expect(dispatch.message.length).toBeLessThanOrEqual(40_000);
    expect(dispatch.message).toContain("[full note in docket]");
    expect(dispatch.groups.flatMap((group) => group.customers)).toHaveLength(100);
    expect(dispatch.groups[0].customers[0].deliveryNote).toHaveLength(300);
    expect(whatsappShareUrl(dispatch.helperPhone, dispatch.message)).toBeNull();
  });
});
