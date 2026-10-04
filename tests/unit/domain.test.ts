import { afterEach, describe, expect, it, vi } from "vitest";
import { operationSchemas, outputSchemas } from "../../lib/contracts/api";
import { resultSchema } from "../../lib/contracts/common";
import { DEFAULT_SETTINGS, orderOperationSchema, settingsSchema, type Customer, type DailyOverride, type Plan, type Proposal, type Sheet, type Source } from "../../lib/contracts/records";
import { addDays, dateRange, isLateServiceDate, localDateAt, localTimeInstant, relativeServiceDate } from "../../lib/domain/dates";
import { applyOperations, assertOperationalDates, assertProposalReady, baselineQuantity, calculateDay, pendingReviewCount, previewOperations, replaceRecurringPlan, transitionProposal } from "../../lib/domain/orders";
import { safeCsvCell, sheetDelta } from "../../lib/domain/sheets";

const createdAt = "2026-10-01T00:00:00Z";
const record = { sellerId: "seller", schemaVersion: 1 as const, createdAt };
const customers: Customer[] = ["A", "B", "C"].map((_id) => ({ ...record, _id, alias: `Customer ${_id}`, packingNote: "", status: "active", revision: 0 }));
const plans: Plan[] = [2, 1, 3].map((quantity, index) => ({ ...record, _id: `plan_${index}`, customerId: customers[index]._id, startDate: "2026-10-01", endDate: null, quantities: [quantity, quantity, quantity, quantity, quantity, 0, 0], revision: 0, approvalId: `approval_${index}`, supersedesPlanIds: [] }));
const state = { customers, plans, overrides: [] as DailyOverride[] };
let nextId = 0;
const options = { approvalId: "new_approval", createdAt, makeId: () => `new_${++nextId}`, settings: DEFAULT_SETTINGS };
function proposal(changes: Partial<Proposal> = {}): Proposal {
  return { ...record, _id: "proposal", sourceId: null, sourceRevision: null, manualReason: "Customer confirmed by telephone", operations: [{ type: "set_daily_quantity", customerId: "A", serviceDate: "2026-10-05", quantity: 1 }], evidenceSpans: [], missingFields: [], draftRevision: 0, status: "needs_review", deferredDate: null, dispositionReason: null, ...changes };
}
function source(changes: Partial<Source> = {}): Source {
  return { ...record, _id: "source", text: "Please send one on Monday", sentAt: createdAt, receivedAt: createdAt, customerId: "A", revision: 0, status: "needs_review", deferredDate: null, fingerprint: "synthetic", channel: "manual", upstreamId: null, replacesSourceId: null, dispositionReason: null, ...changes };
}

afterEach(() => vi.useRealTimers());
describe("calendar and clock boundaries", () => {
  it("uses original sent time rather than the later import clock for relative dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:00:00Z"));
    const sentAt = "2026-10-04T20:00:00Z";
    expect(localDateAt(new Date().toISOString(), "Asia/Kolkata")).toBe("2026-10-07");
    expect(relativeServiceDate("today", sentAt, "Asia/Kolkata")).toBe("2026-10-05");
    expect(relativeServiceDate("tomorrow", sentAt, "Asia/Kolkata")).toBe("2026-10-06");
  });
  it("uses calendar arithmetic at leap years, month boundaries and inclusive 31-day bounds", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(dateRange("2026-10-01", "2026-10-31")).toHaveLength(31);
    expect(() => dateRange("2026-10-01", "2026-11-01")).toThrow("1–31");
    expect(() => dateRange("2026-10-02", "2026-10-01")).toThrow("1–31");
    for (const invalid of ["2026-02-29", "2026-13-01", "2026-1-01", "2026-10-01T00:00:00Z"]) expect(() => addDays(invalid, 1)).toThrow();
  });
  it("rejects ambiguous and nonexistent local times unless explicitly disambiguated", () => {
    expect(() => localTimeInstant("2026-03-08", "02:30", "America/New_York")).toThrow("disambiguation");
    expect(() => localTimeInstant("2026-11-01", "01:30", "America/New_York")).toThrow("disambiguation");
    expect(localTimeInstant("2026-11-01", "01:30", "America/New_York", "earlier")).toBe("2026-11-01T05:30:00Z");
    expect(localTimeInstant("2026-11-01", "01:30", "America/New_York", "later")).toBe("2026-11-01T06:30:00Z");
    expect(localTimeInstant("2026-03-08", "02:30", "America/New_York", "later")).toBe("2026-03-08T07:30:00Z");
  });
  it("requires acknowledgement at the exact local cutoff", () => {
    expect(isLateServiceDate("2026-10-05", DEFAULT_SETTINGS, "2026-10-05T04:29:59Z")).toBe(false);
    expect(isLateServiceDate("2026-10-05", DEFAULT_SETTINGS, "2026-10-05T04:30:00Z")).toBe(true);
  });
});

describe("approved fulfillment arithmetic", () => {
  it("totals A=2, B=1, C=3 as six, then five only on the approved override date", () => {
    expect(calculateDay({ ...state, serviceDate: "2026-10-05", settings: DEFAULT_SETTINGS }).total).toBe(6);
    const next = applyOperations(state, proposal().operations, options);
    expect(calculateDay({ ...next, serviceDate: "2026-10-05" }).total).toBe(5);
    expect(calculateDay({ ...next, serviceDate: "2026-10-06" }).total).toBe(6);
    expect(state.overrides).toEqual([]);
    // Draft objects have no path into the calculation inputs.
    proposal({ operations: [{ type: "set_daily_quantity", customerId: "A", serviceDate: "2026-10-05", quantity: 100 }] });
    expect(calculateDay({ ...state, serviceDate: "2026-10-05" }).total).toBe(6);
  });
  it("permits zero and no-plan customers, excludes archived customers, honors weekends", () => {
    const next = applyOperations(state, [{ type: "set_daily_quantity", customerId: "A", serviceDate: "2026-10-05", quantity: 0 }], options);
    expect(calculateDay({ ...next, serviceDate: "2026-10-05" }).total).toBe(4);
    expect(calculateDay({ ...state, plans: [], serviceDate: "2026-10-05" }).total).toBe(0);
    expect(calculateDay({ ...state, customers: customers.map((customer) => ({ ...customer, status: "archived" })), serviceDate: "2026-10-05" }).total).toBe(0);
    expect(calculateDay({ ...state, serviceDate: "2026-10-04", settings: DEFAULT_SETTINGS }).total).toBe(0);
  });
  it("pauses inclusively, expires, and resumes only pause overrides without inventing plans", () => {
    const paused = applyOperations(state, [{ type: "pause_interval", customerId: "A", fromDate: "2026-10-05", toDate: "2026-10-07" }], options);
    expect(calculateDay({ ...paused, serviceDate: "2026-10-07" }).total).toBe(4);
    expect(calculateDay({ ...paused, serviceDate: "2026-10-08" }).total).toBe(6);
    const resumed = applyOperations(paused, [{ type: "resume_interval", customerId: "A", fromDate: "2026-10-06", toDate: "2026-10-07" }], options);
    expect(calculateDay({ ...resumed, serviceDate: "2026-10-05" }).total).toBe(4);
    expect(calculateDay({ ...resumed, serviceDate: "2026-10-06" }).total).toBe(6);
    const overridden = applyOperations(paused, proposal().operations, options);
    expect(() => applyOperations(overridden, [{ type: "resume_interval", customerId: "A", fromDate: "2026-10-05", toDate: "2026-10-05" }], options)).toThrow("existing approved pause");
    expect(calculateDay({ ...overridden, serviceDate: "2026-10-05" }).total).toBe(5);
    expect(() => applyOperations({ ...paused, plans: [] }, [{ type: "resume_interval", customerId: "A", fromDate: "2026-10-05", toDate: "2026-10-07" }], options)).toThrow("recurring baseline");
  });
  it("rejects ambiguous active plans, duplicate overrides, malformed quantities and service caps", () => {
    expect(() => baselineQuantity("A", "2026-10-05", [...plans, { ...plans[0], _id: "overlap" }])).toThrow("overlap");
    const next = applyOperations(state, proposal().operations, options);
    expect(() => calculateDay({ ...next, overrides: [...next.overrides, ...next.overrides], serviceDate: "2026-10-05" })).toThrow("Multiple");
    for (const quantity of [-1, 1.5, 1001, NaN, Infinity]) expect(orderOperationSchema.safeParse({ type: "set_daily_quantity", customerId: "A", serviceDate: "2026-10-05", quantity }).success).toBe(false);
    expect(() => applyOperations(state, [{ type: "set_daily_quantity", customerId: "A", serviceDate: "2026-10-05", quantity: 101 }], options)).toThrow("cap");
    expect(() => applyOperations(state, [{ type: "set_daily_quantity", customerId: "A", serviceDate: "2026-10-04", quantity: 1 }], options)).toThrow("closed");
    expect(() => calculateDay({ ...state, serviceDate: "2026-10-05", settings: { ...DEFAULT_SETTINGS, customerCap: 2 } })).toThrow("cap");
  });
  it("splits a recurring period exactly and retains date overrides", () => {
    const replacement: Plan = { ...plans[0], _id: "replacement", startDate: "2026-10-05", endDate: "2026-10-07", quantities: [4, 4, 4, 4, 4, 0, 0], approvalId: "new" };
    const split = replaceRecurringPlan(plans, replacement, options.makeId);
    expect(split.filter((plan) => plan.customerId === "A").map((plan) => [plan.startDate, plan.endDate])).toEqual([["2026-10-01", "2026-10-04"], ["2026-10-05", "2026-10-07"], ["2026-10-08", null]]);
    expect(baselineQuantity("A", "2026-10-06", split)).toBe(4);
    expect(baselineQuantity("A", "2026-10-08", split)).toBe(2);
    const overridden = applyOperations(state, proposal().operations, options);
    const next = applyOperations(overridden, [{ type: "replace_recurring_plan", customerId: "A", startDate: replacement.startDate, endDate: replacement.endDate, quantities: replacement.quantities }], options);
    expect(calculateDay({ ...next, serviceDate: "2026-10-05" }).rows[0].quantity).toBe(1);
  });
  it("rejects overlapping operations within one draft rather than applying last-write-wins", () => {
    expect(() => applyOperations(state, [proposal().operations[0], { type: "pause_interval", customerId: "A", fromDate: "2026-10-05", toDate: "2026-10-06" }], options)).toThrow("overlap");
  });
});

describe("preview, evidence and review", () => {
  it("previews exact effects/conflicts and signals the continued plan window", () => {
    const next = applyOperations(state, proposal().operations, options);
    const preview = previewOperations({ ...next, settings: DEFAULT_SETTINGS, now: "2026-10-05T05:00:00Z", operations: [{ type: "pause_interval", customerId: "A", fromDate: "2026-10-05", toDate: "2026-10-06" }] });
    expect(preview.totals).toEqual([{ serviceDate: "2026-10-05", before: 5, after: 4 }, { serviceDate: "2026-10-06", before: 6, after: 4 }]);
    expect(preview.conflicts).toEqual([{ customerId: "A", serviceDate: "2026-10-05", approvalId: "new_approval", kind: "override" }]);
    expect(preview.requiredAcknowledgements).toEqual(["supersession", "late_change"]);
    const recurring = previewOperations({ ...state, settings: DEFAULT_SETTINGS, now: createdAt, operations: [{ type: "replace_recurring_plan", customerId: "A", startDate: "2026-10-05", endDate: null, quantities: [1, 1, 1, 1, 1, 0, 0] }] });
    expect(recurring.affectedDates).toHaveLength(31);
    expect(recurring.continuesBeyondWindow).toBe(true);
    expect(recurring.conflicts[0].approvalId).toBe("approval_0");
  });
  it("requires complete fields, matching source revisions, association and evidence spans", () => {
    expect(() => assertProposalReady(proposal(), null)).not.toThrow();
    expect(() => assertProposalReady(proposal({ missingFields: ["exact date"] }), null)).toThrow("missing");
    const sourced = proposal({ sourceId: "source", sourceRevision: 0, manualReason: null, evidenceSpans: [{ start: 0, end: 15 }] });
    expect(() => assertProposalReady(sourced, source())).not.toThrow();
    expect(() => assertProposalReady(sourced, source({ revision: 1 }))).toThrow("changed");
    expect(() => assertProposalReady(sourced, source({ customerId: null }))).toThrow("customer");
    expect(() => assertProposalReady({ ...sourced, evidenceSpans: [{ start: 0, end: 8000 }] }, source())).toThrow("spans");
    expect(() => assertProposalReady({ ...sourced, evidenceSpans: [] }, source())).toThrow("spans");
    expect(() => assertProposalReady(sourced, source({ sellerId: "other" }))).toThrow("not found");
  });
  it("limits transitions and deferrals to an explicitly supplied date", () => {
    expect(transitionProposal("needs_review", "defer", "2026-10-05")).toBe("deferred");
    expect(transitionProposal("deferred", "reopen")).toBe("needs_review");
    expect(() => transitionProposal("needs_review", "defer")).toThrow("service date");
    expect(() => transitionProposal("approved", "reject")).toThrow("not allowed");
    expect(() => transitionProposal("rejected", "reopen")).toThrow("not allowed");
    expect(pendingReviewCount([source()], [], "2026-10-05")).toBe(1);
    const deferred = source({ status: "deferred", deferredDate: "2026-10-05" });
    expect(pendingReviewCount([deferred], [], "2026-10-05")).toBe(0);
    expect(pendingReviewCount([deferred], [], "2026-10-06")).toBe(1);
    const draft = proposal({ status: "deferred", deferredDate: "2026-10-05", missingFields: ["date"] });
    expect(pendingReviewCount([], [draft], "2026-10-05")).toBe(0);
    expect(pendingReviewCount([], [draft], "2026-10-06")).toBe(1);
  });
  it("will not let a source disposition hide its still-active draft", () => {
    const draft = proposal({ sourceId: "source", sourceRevision: 0, manualReason: null, evidenceSpans: [{ start: 0, end: 5 }] });
    expect(pendingReviewCount([source({ status: "dismissed" })], [draft], "2026-10-05")).toBe(1);
    expect(pendingReviewCount([source()], [draft], "2026-10-05")).toBe(1);
    expect(pendingReviewCount([source()], [draft], "2026-10-06")).toBe(0);
  });
  it("protects past finalized dates even when outside a recurring preview window", () => {
    const sheet: Sheet = { ...record, _id: "sheet", serviceDate: "2026-09-01", revision: 1, rows: [], total: 0, computedFromStateRevision: 1, committedStateRevision: 2, finalizedBy: "owner", finalizedAt: createdAt, previousSheetId: null, delta: [] };
    expect(() => assertOperationalDates([{ type: "replace_recurring_plan", customerId: "A", startDate: "2026-01-01", endDate: null, quantities: [1, 1, 1, 1, 1, 0, 0] }], [sheet], DEFAULT_SETTINGS, createdAt)).toThrow("read-only");
    expect(() => assertOperationalDates(proposal().operations, [sheet], DEFAULT_SETTINGS, createdAt)).not.toThrow();
  });
});

describe("contracts and immutable sheet data", () => {
  it("rejects unknown/operator fields and invalid dates, bounds pages, and validates settings", () => {
    expect(operationSchemas.listCustomers.parse({})).toEqual({ limit: 25 });
    for (const value of [{ limit: 101 }, { limit: "25" }, { $where: "anything" }, { sellerId: "spoofed" }]) expect(operationSchemas.listCustomers.safeParse(value).success).toBe(false);
    expect(operationSchemas.getSchedule.safeParse({ customerId: "A", fromDate: "2026-10-01", toDate: "2026-11-01" }).success).toBe(false);
    expect(operationSchemas.getDay.safeParse({ serviceDate: "2026-02-30" }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, timezone: "Not/AZone" }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, planningTime: "11:00" }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, weekdays: [1, 1] }).success).toBe(false);
    expect(resultSchema(outputSchemas.getCustomer).safeParse({ ok: false, error: { code: "NOT_FOUND", message: "Absent", retryable: false }, meta: { requestId: "request" } }).success).toBe(true);
  });
  it("computes deterministic sheet amendments without mutating old rows", () => {
    const oldRows = calculateDay({ ...state, serviceDate: "2026-10-05" }).rows;
    const saved = JSON.stringify(oldRows);
    const nextRows = calculateDay({ ...applyOperations(state, proposal().operations, options), serviceDate: "2026-10-05" }).rows;
    expect(sheetDelta(oldRows, nextRows)).toEqual([{ customerId: "A", before: 2, after: 1, difference: -1 }]);
    expect(JSON.stringify(oldRows)).toBe(saved);
    expect(sheetDelta([...oldRows].reverse(), [...nextRows].reverse())).toEqual(sheetDelta(oldRows, nextRows));
  });
  it("neutralizes formulas behind whitespace/control characters and preserves ordinary CSV text", () => {
    for (const cell of ["=SUM(A1)", "+1", "-1", "@SUM(A1)", " \t\r=1", "\u0000\u001b+1", "\u00a0-1", "\ufeff@x", "\u200b=1"]) expect(safeCsvCell(cell)).toBe(`'${cell}`);
    for (const cell of ["ordinary", 'a,"quote"\nline', "", "Customer A"]) expect(safeCsvCell(cell)).toBe(cell);
  });
});
