import { unstable_rethrow } from "next/navigation";
import { validateCoreConfig } from "@/lib/server/env";
import { getDb } from "@/lib/server/db/client";
import { checkIndexes } from "@/lib/server/db/indexes";
import { checkRateLimitIndexes } from "@/lib/server/rate-limit";
import { checkPhase2Indexes } from "@/lib/server/phase2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let probe: { until: number; result: Promise<boolean> } | undefined;

async function readiness(): Promise<boolean> {
  try {
    validateCoreConfig();
    const db = await getDb();
    await db.command({ ping: 1 }, { timeoutMS: 2_000 });
    return await checkIndexes(db) && await checkRateLimitIndexes(db) && await checkPhase2Indexes();
  } catch (error) {
    unstable_rethrow(error);
    return false;
  }
}

export async function GET() {
  if (!probe || probe.until <= Date.now()) probe = { until: Date.now() + 5_000, result: readiness() };
  const ok = await probe.result;
  return Response.json({ ok }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
