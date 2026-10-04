import { Temporal } from "@js-temporal/polyfill";
import { orderOperationSchema, type OrderOperation, type Settings } from "@/lib/contracts/records";
import type { Extraction } from "./schemas";

export function normalizeDatePhrase(phrase: string | null, sentAt: string, timezone: string): string | null {
  if (phrase === null) return null;
  const originalDate = Temporal.Instant.from(sentAt).toZonedDateTimeISO(timezone).toPlainDate();
  const clean = phrase.trim().toLowerCase();
  if (clean === "today") return originalDate.toString();
  if (clean === "tomorrow") return originalDate.add({ days: 1 }).toString();
  // ponytail: only unambiguous ISO dates + today/tomorrow; locale-specific dates require review.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return null;
  try { return Temporal.PlainDate.from(clean).toString(); } catch { return null; }
}
export interface NormalizedDraft { operations: OrderOperation[]; evidenceSpans: { start: number; end: number }[]; missingFields: string[] }
export function normalizeExtraction(extraction: Extraction, source: { text: string; customerId: string | null; sentAt: string }, settings: Settings, warnings: string[] = []): NormalizedDraft[] {
  const drafts: NormalizedDraft[] = [];
  const seen = new Set<string>();
  for (const candidate of extraction.candidates) {
    const missingFields = [...candidate.missingFields, ...warnings];
    const from = normalizeDatePhrase(candidate.datePhrase, source.sentAt, settings.timezone);
    const to = candidate.endDatePhrase === null ? from : normalizeDatePhrase(candidate.endDatePhrase, source.sentAt, settings.timezone);
    if (!from || !to) missingFields.push("exact_service_dates");
    if (!source.customerId) missingFields.push("confirmed_customer");
    const operations: OrderOperation[] = [];
    if (source.customerId && from && to) {
      const days = Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days;
      if (days < 0 || days > 30) missingFields.push("bounded_date_interval");
      else if (candidate.kind === "quantity_change") {
        if (candidate.quantity === null) missingFields.push("explicit_quantity");
        else if (candidate.quantity > settings.quantityCap) missingFields.push("quantity_cap");
        else if (from !== to) missingFields.push("quantity_interval_requires_review");
        else if (candidate.quantity > 0 && !settings.weekdays.includes(Temporal.PlainDate.from(from).dayOfWeek)) missingFields.push("closed_service_date");
        else operations.push(orderOperationSchema.parse({ type: "set_daily_quantity", customerId: source.customerId, serviceDate: from, quantity: candidate.quantity }));
      } else if (candidate.kind === "pause" || candidate.kind === "resume") {
        operations.push(orderOperationSchema.parse({ type: candidate.kind === "pause" ? "pause_interval" : "resume_interval", customerId: source.customerId, fromDate: from, toDate: to }));
      }
    }
    if (candidate.kind === "recurring_change") missingFields.push("recurring_schedule_requires_confirmation");
    if (candidate.kind === "unsupported" || candidate.kind === "unclear") missingFields.push("unsupported_or_unclear_intent");
    const draft = { operations, evidenceSpans: candidate.evidence.map(({ start, end }) => ({ start, end })), missingFields: [...new Set(missingFields)].slice(0, 40) };
    const key = JSON.stringify({ kind: candidate.kind, datePhrase: candidate.datePhrase, endDatePhrase: candidate.endDatePhrase, quantity: candidate.quantity, operations });
    if (seen.has(key)) continue;
    seen.add(key);
    drafts.push(draft);
  }
  if (!drafts.length) drafts.push({ operations: [], evidenceSpans: [], missingFields: ["no_actionable_candidates", ...warnings].slice(0, 40) });
  return drafts;
}
