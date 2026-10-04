import "server-only";

import { z } from "zod";
import { AppError } from "@/lib/contracts/common";

const databaseSchema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
  MONGODB_DB: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
});
const originSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  } catch { return false; }
});
const authSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: originSchema,
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  APP_ORIGIN: originSchema,
  APP_ENV: z.enum(["development", "test", "production"]),
}).refine((value) => value.BETTER_AUTH_URL === value.APP_ORIGIN)
  .refine((value) => value.APP_ENV !== "production" || value.APP_ORIGIN.startsWith("https://"));

function unavailable(): never {
  // Never attach Zod's environment issues: they may contain secret values.
  throw new AppError("CONFIGURATION_UNAVAILABLE", "Service is not configured.", 503, false);
}

export function getDatabaseConfig() {
  const parsed = databaseSchema.safeParse(process.env);
  if (!parsed.success) unavailable();
  return { uri: parsed.data.MONGODB_URI, dbName: parsed.data.MONGODB_DB };
}

export function getAuthConfig() {
  const parsed = authSchema.safeParse(process.env);
  if (!parsed.success) unavailable();
  return {
    secret: parsed.data.BETTER_AUTH_SECRET,
    baseURL: parsed.data.BETTER_AUTH_URL,
    clientId: parsed.data.GOOGLE_CLIENT_ID,
    clientSecret: parsed.data.GOOGLE_CLIENT_SECRET,
    origin: parsed.data.APP_ORIGIN,
    production: parsed.data.APP_ENV === "production",
  };
}

export function getAppOrigin(): string {
  const parsed = originSchema.safeParse(process.env.APP_ORIGIN);
  if (!parsed.success) unavailable();
  return parsed.data;
}

export function validateCoreConfig(): void {
  getDatabaseConfig();
  getAuthConfig();
}
