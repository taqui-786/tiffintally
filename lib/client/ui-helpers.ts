import { ClientError } from "./api";

export function uiError(error: unknown): string {
  return error instanceof ClientError ? error.message : error instanceof Error ? error.message : "This action could not be completed.";
}

export function isUncertain(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ClientError && (error.retryable || (error.status !== undefined && error.status >= 500)));
}

export function serviceToday(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return "";
  }
}

export function formatInstant(iso: string, timezone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso;
  }
}
