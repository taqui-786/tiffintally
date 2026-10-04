import "server-only";

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { getClient, getDb } from "@/lib/server/db/client";
import { getAuthConfig } from "@/lib/server/env";

async function createAuth() {
  const config = getAuthConfig();
  const client = await getClient();
  const db = await getDb();
  return betterAuth({
    logger: { disabled: true },
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [config.origin],
    database: mongodbAdapter(db, { client }),
    socialProviders: {
      google: { clientId: config.clientId, clientSecret: config.clientSecret },
    },
    advanced: {
      useSecureCookies: config.production,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: config.production },
    },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "memory", window: 60, max: 30 },
  });
}

let auth: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
  // Lazy construction permits builds and health/live without credentials or DB access.
  auth ??= createAuth().catch((error: unknown) => {
    auth = undefined;
    throw error;
  });
  return auth;
}
