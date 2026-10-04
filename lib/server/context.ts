import "server-only";

import { headers } from "next/headers";
import { AppError, type SellerContext } from "@/lib/contracts/common";
import { getAuth } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db/client";

export async function requireSellerContext(
  requestHeaders?: Headers,
  requestId: string = crypto.randomUUID(),
  allowPrivacyProgress = false,
): Promise<SellerContext> {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders ?? await headers() });
  if (!session?.user?.id) {
    throw new AppError("UNAUTHENTICATED", "Authentication required.", 401);
  }
  const db = await getDb();
  const seller = await db.collection<{ _id: string; ownerUserId: string; status: string; privacyDeleting?: boolean }>("sellers")
    .findOne({ ownerUserId: session.user.id, status: "active" }, { projection: { _id: 1, privacyDeleting: 1 } });
  if (!seller) {
    throw new AppError("FORBIDDEN", "An active owner binding is required.", 403);
  }
  if (seller.privacyDeleting && !allowPrivacyProgress) throw new AppError("PRIVACY_DELETING", "Only deletion progress is available during seller erasure.", 409);
  const created = session.session?.createdAt;
  const sessionCreatedAt = created instanceof Date ? created.toISOString() : typeof created === "string" ? created : undefined;
  return { sellerId: seller._id, userId: session.user.id, requestId, ...(sessionCreatedAt ? { sessionCreatedAt } : {}) };
}
