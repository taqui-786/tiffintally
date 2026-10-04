import { Temporal } from "@js-temporal/polyfill";
import { FEATURE_NAMES, featureRowSchema, type AcceptedHistory } from "@/lib/contracts/history";
import type { Proposal, Source } from "@/lib/contracts/records";
export { FEATURE_NAMES };

export interface ClassificationFeatureInput {
  _id?: string; runId?: string; model?: string; promptVersion?: string;
  sourceId: string; sourceRevision: number; computedAt: string; labels?: string[]; intent?: string;
  reviewedAt?: string | null; reviewedLabels?: string[] | null;
}
export function availableHistory(history: AcceptedHistory[], origin: { asOf: string; serviceDate: string; policyHash: string; evidenceMode: string }): AcceptedHistory[] {
  return history.filter((entry) => entry.active && entry.row.policyHash === origin.policyHash && entry.row.evidenceMode === origin.evidenceMode && entry.row.serviceDate < origin.serviceDate && Date.parse(entry.row.outcomeAvailableAt) <= Date.parse(origin.asOf) && (!entry.supersedesIds.length || Date.parse(entry.createdAt) <= Date.parse(origin.asOf)))
    .sort((a, b) => a.row.serviceDate.localeCompare(b.row.serviceDate));
}
export function recentDeltas(history: AcceptedHistory[], origin: { asOf: string; serviceDate: string; policyHash: string; evidenceMode: string }): [number | null, number | null] {
  const prior = availableHistory(history, origin).slice(-28);
  const weekday = Temporal.PlainDate.from(origin.serviceDate).dayOfWeek;
  const same = prior.filter((entry) => Temporal.PlainDate.from(entry.row.serviceDate).dayOfWeek === weekday);
  const mean = (entries: AcceptedHistory[]) => entries.length ? entries.reduce((sum, entry) => sum + entry.row.cutoffTotal - entry.row.confirmedMeals, 0) / entries.length : null;
  return [mean(prior), mean(same)];
}
export function historicalFeatures(entry: AcceptedHistory, history: AcceptedHistory[]): (number | null)[] {
  const row = [...entry.row.features];
  [row[11], row[12]] = recentDeltas(history, entry.row);
  return featureRowSchema.parse(row);
}
function operationRelevant(proposal: Proposal, date: string) {
  return proposal.operations.some((op) => op.type === "set_daily_quantity" ? op.serviceDate === date : op.type === "replace_recurring_plan" ? op.startDate <= date && (op.endDate === null || op.endDate >= date) : op.fromDate <= date && op.toDate >= date);
}
/** v1 relevance: date-linked sources plus unresolved/unclear sources, counted separately by unclear label. */
export function messageFeatures(input: { asOf: string; serviceDate: string; sources: (Source & { erasurePending?: boolean })[]; proposals: Proposal[]; classifications: ClassificationFeatureInput[] }): { values: (number | null)[]; complete: boolean } {
  const at = Date.parse(input.asOf);
  const proposals = input.proposals.filter((p) => Date.parse(p.createdAt) <= at);
  const sources = input.sources.filter((source) => !source.erasurePending && Date.parse(source.receivedAt) <= at && Date.parse(source.createdAt) <= at && !["dismissed", "superseded"].includes(source.status) && (proposals.some((p) => p.sourceId === source._id && p.sourceRevision === source.revision && operationRelevant(p, input.serviceDate)) || (source.status === "needs_review" && !proposals.some((p) => p.sourceId === source._id && p.operations.length)) || (source.status === "deferred" && source.deferredDate === input.serviceDate)));
  const unique = [...new Map(sources.map((source) => [`${source._id}:${source.revision}`, source])).values()];
  const counts = [unique.length, 0, 0, 0, 0];
  let complete = true;
  for (const source of unique) {
    const classification = input.classifications.filter((c) => c.sourceId === source._id && c.sourceRevision === source.revision && Date.parse(c.computedAt) <= at).sort((a, b) => Date.parse(b.computedAt) - Date.parse(a.computedAt) || (b._id ?? b.runId ?? "").localeCompare(a._id ?? a.runId ?? ""))[0];
    if (!classification) { complete = false; continue; }
    const labels = new Set(classification.reviewedAt && Date.parse(classification.reviewedAt) <= at && classification.reviewedLabels ? classification.reviewedLabels : classification.labels ?? (classification.intent ? [classification.intent] : []));
    for (const [index, label] of ["pause", "resume", "quantity_change", "unclear"].entries()) if (labels.has(label)) counts[index + 1]++;
  }
  // No classified evidence means unknown message features, not a fabricated all-zero row.
  return { values: complete ? counts : [null, null, null, null, null], complete };
}
export function buildFeatureRow(input: { serviceDate: string; asOf: string; cutoffAt: string; baselineMeals: number; confirmedMeals: number; activeCustomers: number; pendingChangeCount: number; policyHash: string; evidenceMode: string; history: AcceptedHistory[]; messages: ReturnType<typeof messageFeatures> }) {
  const prior = recentDeltas(input.history, input);
  return featureRowSchema.parse([Temporal.PlainDate.from(input.serviceDate).dayOfWeek, (Date.parse(input.cutoffAt) - Date.parse(input.asOf)) / 60000, input.baselineMeals, input.confirmedMeals, input.activeCustomers, ...input.messages.values, input.pendingChangeCount, ...prior, input.messages.complete ? 1 : 0]);
}
