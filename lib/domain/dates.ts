import { Temporal } from "@js-temporal/polyfill";
import { AppError, dateSchema } from "../contracts/common";
import type { Settings } from "../contracts/records";

export function parseDate(value: string): Temporal.PlainDate {
  if (!dateSchema.safeParse(value).success) throw new AppError("VALIDATION_FAILED", "Expected a valid YYYY-MM-DD date", 422);
  return Temporal.PlainDate.from(value);
}
export function addDays(date: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new AppError("VALIDATION_FAILED", "Days must be an integer", 422);
  return parseDate(date).add({ days }).toString();
}
export function dateRange(fromDate: string, toDate: string): string[] {
  const start = parseDate(fromDate);
  const count = start.until(parseDate(toDate)).days + 1;
  if (count < 1 || count > 31) throw new AppError("VALIDATION_FAILED", "Interval must contain 1–31 days", 422);
  return Array.from({ length: count }, (_, index) => start.add({ days: index }).toString());
}
export function localDateAt(instant: string, timezone: string): string {
  try { return Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainDate().toString(); }
  catch { throw new AppError("VALIDATION_FAILED", "Invalid timestamp or timezone", 422); }
}
export function relativeServiceDate(relative: "today" | "tomorrow", sentAt: string, timezone: string): string {
  return addDays(localDateAt(sentAt, timezone), relative === "tomorrow" ? 1 : 0);
}
export function localTimeInstant(serviceDate: string, time: string, timezone: string, disambiguation: "reject" | "earlier" | "later" = "reject"): string {
  parseDate(serviceDate);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new AppError("VALIDATION_FAILED", "Expected HH:mm local time", 422);
  try { return Temporal.PlainDateTime.from(`${serviceDate}T${time}`).toZonedDateTime(timezone, { disambiguation }).toInstant().toString(); }
  catch { throw new AppError("VALIDATION_FAILED", "Invalid or ambiguous local time; explicit disambiguation is required", 422); }
}
export function isServiceDate(serviceDate: string, weekdays: number[]): boolean {
  return weekdays.includes(parseDate(serviceDate).dayOfWeek);
}
export function isLateServiceDate(serviceDate: string, settings: Settings, now: string): boolean {
  return Temporal.Instant.compare(Temporal.Instant.from(now), Temporal.Instant.from(localTimeInstant(serviceDate, settings.cutoffTime, settings.timezone))) >= 0;
}
