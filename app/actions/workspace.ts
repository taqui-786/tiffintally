"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { getAuth } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db/client";
import { DEFAULT_SETTINGS, sellerSchema, settingsSchema, type Seller } from "@/lib/contracts/records";

// ponytail: single-workspace per user, extend to multi-tenant organization switching if needed
export async function provisionWorkspaceAction(input?: {
  timezone?: string;
  planningTime?: string;
  cutoffTime?: string;
}) {
  try {
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user?.id) {
      return { ok: false, error: "Authentication required. Please sign in first." };
    }

    const db = await getDb();
    const existing = await db.collection<Seller>("sellers").findOne({ ownerUserId: session.user.id, status: "active" });
    if (existing) {
      return { ok: true, sellerId: existing._id };
    }

    const settings = settingsSchema.parse({
      ...DEFAULT_SETTINGS,
      ...(input?.timezone ? { timezone: input.timezone } : {}),
      ...(input?.planningTime ? { planningTime: input.planningTime } : {}),
      ...(input?.cutoffTime ? { cutoffTime: input.cutoffTime } : {}),
    });

    const seller = sellerSchema.parse({
      _id: randomUUID(),
      ownerUserId: session.user.id,
      settings,
      stateRevision: 0,
      status: "active",
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    });

    await db.collection<Seller>("sellers").insertOne(seller);
    return { ok: true, sellerId: seller._id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to set up workspace." };
  }
}
