import { AppError, quantitySchema } from "../contracts/common";
import type { Preview } from "../contracts/api";
import { customerSchema, dailyOverrideSchema, orderOperationSchema, planSchema, settingsSchema, type Customer, type DailyOverride, type OrderOperation, type Plan, type Proposal, type Settings, type Sheet, type SheetRow, type Source } from "../contracts/records";
import { addDays, dateRange, isLateServiceDate, isServiceDate, localDateAt, parseDate } from "./dates";

export interface OrderState { customers: Customer[]; plans: Plan[]; overrides: DailyOverride[] }
const overlaps = (a: Pick<Plan, "startDate" | "endDate">, b: Pick<Plan, "startDate" | "endDate">) => (a.endDate === null || b.startDate <= a.endDate) && (b.endDate === null || a.startDate <= b.endDate);
export function assertNonOverlappingPlans(plans: Plan[]): void {
  const sorted = plans.map((plan) => planSchema.parse(plan)).sort((a, b) => a.customerId.localeCompare(b.customerId) || a.startDate.localeCompare(b.startDate));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].customerId === sorted[i].customerId && overlaps(sorted[i - 1], sorted[i])) throw new AppError("OVERLAPPING_CHANGE", "Recurring plans overlap", 409);
  }
}
export function baselineQuantity(customerId: string, serviceDate: string, plans: Plan[]): number {
  const date = parseDate(serviceDate);
  const customerPlans = plans.filter((plan) => plan.customerId === customerId);
  assertNonOverlappingPlans(customerPlans);
  const plan = customerPlans.find((plan) => plan.startDate <= serviceDate && (plan.endDate === null || plan.endDate >= serviceDate));
  return plan ? plan.quantities[date.dayOfWeek - 1] : 0;
}
export function calculateDay(input: OrderState & { serviceDate: string; settings?: Settings }): { rows: SheetRow[]; total: number } {
  const { customers, plans, overrides, serviceDate, settings } = input;
  parseDate(serviceDate);
  if (settings) settingsSchema.parse(settings);
  assertNonOverlappingPlans(plans);
  const active = customers.map((customer) => customerSchema.parse(customer)).filter((customer) => customer.status === "active");
  if (active.length > (settings?.customerCap ?? 100)) throw new AppError("VALIDATION_FAILED", "Active customer cap exceeded", 422);
  if (new Set(active.map((customer) => customer._id)).size !== active.length) throw new AppError("OVERLAPPING_CHANGE", "Duplicate customer", 409);
  const rows = active.sort((a, b) => a._id.localeCompare(b._id)).map((customer): SheetRow => {
    const baseline = settings && !isServiceDate(serviceDate, settings.weekdays) ? 0 : baselineQuantity(customer._id, serviceDate, plans);
    const matches = overrides.filter((override) => override.customerId === customer._id && override.serviceDate === serviceDate).map((override) => dailyOverrideSchema.parse(override));
    if (matches.length > 1) throw new AppError("OVERLAPPING_CHANGE", "Multiple active daily overrides", 409);
    const override = matches[0];
    const quantity = override?.quantity ?? baseline;
    if (quantity > (settings?.quantityCap ?? 1000) || (quantity > 0 && settings && !isServiceDate(serviceDate, settings.weekdays))) throw new AppError("VALIDATION_FAILED", "Quantity violates the service policy", 422);
    return { customerId: customer._id, alias: customer.alias, packingNote: customer.packingNote, baseline, quantity, approvalId: override?.approvalId ?? null };
  });
  return { rows, total: rows.reduce((total, row) => total + row.quantity, 0) };
}

export function operationDates(operation: OrderOperation): string[] {
  const op = orderOperationSchema.parse(operation);
  switch (op.type) {
    case "set_daily_quantity": return [op.serviceDate];
    case "pause_interval": case "resume_interval": return dateRange(op.fromDate, op.toDate);
    case "replace_recurring_plan": return dateRange(op.startDate, op.endDate === null || op.endDate > addDays(op.startDate, 30) ? addDays(op.startDate, 30) : op.endDate);
  }
}
function operationPeriod(op: OrderOperation): { startDate: string; endDate: string | null } {
  if (op.type === "replace_recurring_plan") return op;
  if (op.type === "set_daily_quantity") return { startDate: op.serviceDate, endDate: op.serviceDate };
  return { startDate: op.fromDate, endDate: op.toDate };
}
export function validateOperations(operations: OrderOperation[], customers: Customer[], settings?: Settings): void {
  if (operations.length < 1 || operations.length > 20) throw new AppError("VALIDATION_FAILED", "Expected 1–20 complete operations", 422);
  for (const [index, raw] of operations.entries()) {
    const op = orderOperationSchema.parse(raw);
    if (!customers.some((customer) => customer._id === op.customerId && customer.status === "active")) throw new AppError("VALIDATION_FAILED", "Operation requires an active confirmed customer", 422);
    const quantities = op.type === "set_daily_quantity" ? [op.quantity] : op.type === "replace_recurring_plan" ? op.quantities : [];
    for (const quantity of quantities) {
      quantitySchema.parse(quantity);
      if (quantity > (settings?.quantityCap ?? 1000)) throw new AppError("VALIDATION_FAILED", "Quantity cap exceeded", 422);
    }
    if (settings && op.type === "replace_recurring_plan" && op.quantities.some((quantity, weekday) => quantity > 0 && !settings.weekdays.includes(weekday + 1))) throw new AppError("VALIDATION_FAILED", "Recurring quantity on a closed weekday", 422);
    if (settings && op.type === "set_daily_quantity" && op.quantity > 0 && !isServiceDate(op.serviceDate, settings.weekdays)) throw new AppError("VALIDATION_FAILED", "Quantity on a closed service date", 422);
    for (const previous of operations.slice(0, index)) {
      // One command must not depend on operation ordering to decide fulfillment.
      if (previous.customerId === op.customerId && overlaps(operationPeriod(previous), operationPeriod(op))) throw new AppError("OVERLAPPING_CHANGE", "Operations overlap within this proposal", 409);
    }
  }
}

export function replaceRecurringPlan(plans: Plan[], replacement: Plan, makeId: () => string): Plan[] {
  planSchema.parse(replacement);
  assertNonOverlappingPlans(plans);
  const output: Plan[] = [];
  const superseded: string[] = [];
  for (const plan of plans) {
    if (plan.customerId !== replacement.customerId || !overlaps(plan, replacement)) { output.push(plan); continue; }
    superseded.push(plan._id);
    if (plan.startDate < replacement.startDate) output.push({ ...plan, _id: makeId(), createdAt: replacement.createdAt, endDate: addDays(replacement.startDate, -1), revision: plan.revision + 1, supersedesPlanIds: [plan._id] });
    if (replacement.endDate !== null && (plan.endDate === null || plan.endDate > replacement.endDate)) output.push({ ...plan, _id: makeId(), createdAt: replacement.createdAt, startDate: addDays(replacement.endDate, 1), revision: plan.revision + 1, supersedesPlanIds: [plan._id] });
  }
  output.push({ ...replacement, supersedesPlanIds: superseded.sort() });
  assertNonOverlappingPlans(output);
  return output.sort((a, b) => a.customerId.localeCompare(b.customerId) || a.startDate.localeCompare(b.startDate));
}

export function applyOperations(state: OrderState, operations: OrderOperation[], options: { approvalId: string; createdAt: string; makeId: () => string; settings?: Settings }): OrderState {
  validateOperations(operations, state.customers, options.settings);
  let plans = [...state.plans];
  let overrides = [...state.overrides];
  assertNonOverlappingPlans(plans);
  for (const op of operations) {
    const customer = state.customers.find((customer) => customer._id === op.customerId)!;
    const common = { sellerId: customer.sellerId, schemaVersion: 1 as const, createdAt: options.createdAt, customerId: op.customerId, approvalId: options.approvalId };
    if (op.type === "replace_recurring_plan") {
      plans = replaceRecurringPlan(plans, { ...common, _id: options.makeId(), startDate: op.startDate, endDate: op.endDate, quantities: [...op.quantities], revision: 0, supersedesPlanIds: [] }, options.makeId);
      continue;
    }
    if (op.type === "resume_interval") {
      const pauses = overrides.filter((override) => override.customerId === op.customerId && override.kind === "pause" && override.serviceDate >= op.fromDate && override.serviceDate <= op.toDate);
      if (!pauses.length) throw new AppError("INVALID_STATE", "Resume requires an existing approved pause", 409);
      if (pauses.some((pause) => !plans.some((plan) => plan.customerId === op.customerId && plan.startDate <= pause.serviceDate && (plan.endDate === null || plan.endDate >= pause.serviceDate)))) {
        throw new AppError("VALIDATION_FAILED", "Confirm a recurring baseline before resuming this pause", 422);
      }
    }
    for (const serviceDate of operationDates(op)) {
      if (op.type === "resume_interval") {
        overrides = overrides.filter((override) => !(override.customerId === op.customerId && override.serviceDate === serviceDate && override.kind === "pause"));
      } else {
        overrides = overrides.filter((override) => !(override.customerId === op.customerId && override.serviceDate === serviceDate));
        overrides.push({ ...common, _id: options.makeId(), serviceDate, quantity: op.type === "pause_interval" ? 0 : op.quantity, kind: op.type === "pause_interval" ? "pause" : "quantity" });
      }
    }
  }
  return { customers: state.customers, plans, overrides };
}

export type PreviewChanges = Pick<Preview, "operations" | "affectedDates" | "effects" | "totals" | "conflicts" | "requiredAcknowledgements" | "continuesBeyondWindow">;
export function previewOperations(input: OrderState & { operations: OrderOperation[]; settings: Settings; now: string }): PreviewChanges {
  const { operations, settings, now } = input;
  validateOperations(operations, input.customers, settings);
  let id = 0;
  const next = applyOperations(input, operations, { approvalId: "preview", createdAt: now, makeId: () => `preview_${++id}`, settings });
  const affectedDates = [...new Set(operations.flatMap(operationDates))].sort();
  const effects: PreviewChanges["effects"] = [];
  const totals: PreviewChanges["totals"] = [];
  const conflicts: PreviewChanges["conflicts"] = [];
  for (const serviceDate of affectedDates) {
    const before = calculateDay({ ...input, serviceDate });
    const after = calculateDay({ ...next, settings, serviceDate });
    totals.push({ serviceDate, before: before.total, after: after.total });
    for (const row of after.rows) {
      if (operations.some((op) => op.customerId === row.customerId && operationDates(op).includes(serviceDate))) effects.push({ customerId: row.customerId, serviceDate, before: before.rows.find((old) => old.customerId === row.customerId)!.quantity, after: row.quantity });
    }
  }
  for (const op of operations) {
    const period = operationPeriod(op);
    if (op.type === "replace_recurring_plan") {
      for (const plan of input.plans.filter((plan) => plan.customerId === op.customerId && overlaps(plan, period))) conflicts.push({ customerId: op.customerId, serviceDate: plan.startDate > period.startDate ? plan.startDate : period.startDate, approvalId: plan.approvalId, kind: "plan" });
    } else {
      for (const override of input.overrides.filter((override) => override.customerId === op.customerId && operationDates(op).includes(override.serviceDate) && (op.type !== "resume_interval" || override.kind === "pause"))) conflicts.push({ customerId: op.customerId, serviceDate: override.serviceDate, approvalId: override.approvalId, kind: "override" });
    }
  }
  conflicts.sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || a.customerId.localeCompare(b.customerId) || a.approvalId.localeCompare(b.approvalId));
  const requiredAcknowledgements: PreviewChanges["requiredAcknowledgements"] = [];
  if (conflicts.length) requiredAcknowledgements.push("supersession");
  if (affectedDates.some((date) => isLateServiceDate(date, settings, now))) requiredAcknowledgements.push("late_change");
  return { operations, affectedDates, effects, totals, conflicts, requiredAcknowledgements, continuesBeyondWindow: operations.some((op) => op.type === "replace_recurring_plan" && (op.endDate === null || op.endDate > addDays(op.startDate, 30))) };
}

export function assertProposalReady(proposal: Proposal, source: Source | null): void {
  if (proposal.status !== "needs_review") throw new AppError("INVALID_STATE", "Only a reviewable draft can be approved", 409);
  if (proposal.missingFields.length || proposal.operations.length === 0) throw new AppError("VALIDATION_FAILED", "Resolve all missing fields before approval", 422);
  if (proposal.sourceId === null) {
    if (!proposal.manualReason?.trim() || proposal.sourceRevision !== null || proposal.evidenceSpans.length) throw new AppError("VALIDATION_FAILED", "Manual proposal requires a reason and no source evidence", 422);
    return;
  }
  if (!source || source._id !== proposal.sourceId || source.sellerId !== proposal.sellerId) throw new AppError("NOT_FOUND", "Supporting source not found", 404);
  if (source.revision !== proposal.sourceRevision) throw new AppError("STALE_REVISION", "Supporting source has changed", 409);
  if (source.status !== "needs_review") throw new AppError("INVALID_STATE", "Supporting source is not reviewable", 409);
  if (proposal.manualReason !== null || !source.customerId || proposal.operations.some((operation) => operation.customerId !== source.customerId)) throw new AppError("VALIDATION_FAILED", "Confirm the source customer before approval", 422);
  if (!proposal.evidenceSpans.length || proposal.evidenceSpans.some((span) => !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.start >= span.end || span.end > source.text.length)) throw new AppError("VALIDATION_FAILED", "Valid supporting source spans are required", 422);
}

export function transitionProposal(status: Proposal["status"], action: "reject" | "defer" | "reopen", serviceDate?: string): Proposal["status"] {
  if (status === "deferred" && action === "reopen") return "needs_review";
  if (status !== "needs_review" || action === "reopen") throw new AppError("INVALID_STATE", "Proposal transition is not allowed", 409);
  if (action === "defer") {
    if (!serviceDate) throw new AppError("VALIDATION_FAILED", "Deferral requires a service date", 422);
    parseDate(serviceDate);
    return "deferred";
  }
  return "rejected";
}

export function assertOperationalDates(operations: OrderOperation[], sheets: Sheet[], settings: Settings, now: string): void {
  const today = localDateAt(now, settings.timezone);
  if (sheets.some((sheet) => sheet.serviceDate < today && operations.some((op) => {
    const period = operationPeriod(op);
    return period.startDate <= sheet.serviceDate && (period.endDate === null || period.endDate >= sheet.serviceDate);
  }))) throw new AppError("INVALID_STATE", "Past finalized service days are read-only", 409);
}

export function proposalAffectsDate(proposal: Proposal, serviceDate: string): boolean {
  parseDate(serviceDate);
  if (proposal.status === "approved" || proposal.status === "rejected" || proposal.status === "obsolete") return false;
  if (proposal.status === "deferred" && proposal.deferredDate === serviceDate) return false;
  if (proposal.missingFields.length || proposal.operations.length === 0) return true;
  return proposal.operations.some((op) => { const period = operationPeriod(op); return period.startDate <= serviceDate && (period.endDate === null || period.endDate >= serviceDate); });
}
export function pendingReviewCount(sources: Source[], proposals: Proposal[], serviceDate: string): number {
  parseDate(serviceDate);
  const pendingProposals = proposals.filter((proposal) => proposalAffectsDate(proposal, serviceDate));
  const pendingSources = sources.filter((source) => {
    if (source.status === "dismissed" || source.status === "superseded") return false;
    if (source.status === "deferred" && source.deferredDate === serviceDate) return false;
    const linked = proposals.filter((proposal) => proposal.sourceId === source._id && proposal.sourceRevision === source.revision && proposal.status !== "obsolete");
    if (!linked.length) return source.status !== "resolved";
    return linked.some((proposal) => proposalAffectsDate(proposal, serviceDate));
  });
  // Count each source once; manual drafts remain independent blockers.
  return pendingSources.length + pendingProposals.filter((proposal) => proposal.sourceId === null || !pendingSources.some((source) => source._id === proposal.sourceId)).length;
}
