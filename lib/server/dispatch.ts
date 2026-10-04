import "server-only";
import { AppError } from "@/lib/contracts/common";
import { commerceProfileSchema, commerceSettingsSchema, type CommerceInput, type Dispatch } from "@/lib/contracts/commerce";
import { localDateAt } from "@/lib/domain/dates";
import { buildDispatch, type DispatchProfile } from "@/lib/domain/dispatch";
import type { ReadScope } from "./receipts";
import { dayFacts } from "./sheets";

export async function getDispatch(input: CommerceInput<"getDispatch">, scope: ReadScope): Promise<Dispatch> {
  const facts = await dayFacts(input.serviceDate, scope);
  const today = localDateAt(scope.now, scope.seller.settings.timezone);
  const rows = input.serviceDate < today && facts.latest ? facts.latest.rows : facts.rows;
  const documents = await scope.db.collection<DispatchProfile & { _id: string; sellerId: string; revision: number }>("customerCommerce")
    .find({ sellerId: scope.seller._id, customerId: { $in: rows.map((row) => row.customerId) } }, { session: scope.session })
    .sort({ customerId: 1 }).limit(101).toArray();
  if (documents.length > 100) throw new AppError("INVALID_STATE", "Routing profiles exceed the supported customer limit. Reconcile setup before dispatch.", 409);
  const preferences = await scope.db.collection<{ _id: string; sellerId: string; settings: { upiId: string; helperPhone: string } }>("commerceSettings")
    .findOne({ _id: scope.seller._id, sellerId: scope.seller._id }, { session: scope.session });
  const settings = commerceSettingsSchema.parse(preferences?.settings ?? { upiId: "", helperPhone: "" });
  return buildDispatch({
    serviceDate: input.serviceDate, today, stateRevision: scope.seller.stateRevision, pendingCount: facts.pendingCount,
    rows: facts.rows, latestSheet: facts.latest, helperPhone: settings.helperPhone,
    profiles: documents.map((document) => ({ customerId: document.customerId, profile: commerceProfileSchema.parse(document.profile) })),
  });
}
