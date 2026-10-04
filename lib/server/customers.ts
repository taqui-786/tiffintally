import "server-only";
import { localDateAt } from "@/lib/domain/dates";
import { AppError } from "@/lib/contracts/common";
import type { OperationInput } from "@/lib/contracts/api";
import { customerSchema, type Customer, type DailyOverride, type Plan, type Seller } from "@/lib/contracts/records";
import { assertRevision, found, type Change, type MutationScope } from "./receipts";

export async function createCustomer(input: OperationInput<"createCustomer">, scope: MutationScope): Promise<Change> {
  const { db, session, seller, now, id } = scope;
  const count = await db.collection<Customer>("customers").countDocuments({ sellerId: seller._id, status: "active" }, { session });
  if (count >= seller.settings.customerCap) throw new AppError("VALIDATION_FAILED", "The active customer limit has been reached.", 422);
  const customer = customerSchema.parse({ _id: id("customer"), sellerId: seller._id, schemaVersion: 1, createdAt: now, alias: input.alias, packingNote: input.packingNote, status: "active", revision: 0 });
  await db.collection<Customer>("customers").insertOne(customer, { session });
  return { before: null, after: customer, resourceIds: [customer._id] };
}

export async function updateCustomer(input: OperationInput<"updateCustomer">, scope: MutationScope): Promise<Change> {
  const { db, session, seller, now } = scope;
  const before = found(await db.collection<Customer>("customers").findOne({ _id: input.customerId, sellerId: seller._id }, { session }));
  assertRevision(before.revision, input.expectedCustomerRevision);
  const today = localDateAt(now, seller.settings.timezone);
  if (input.status === "archived" && before.status === "active") {
    const plans = await db.collection<Plan>("plans").find({ sellerId: seller._id, customerId: before._id, $or: [{ endDate: null }, { endDate: { $gte: today } }] }, { session }).toArray();
    const override = await db.collection<DailyOverride>("dailyOverrides").findOne({ sellerId: seller._id, customerId: before._id, serviceDate: { $gte: today }, quantity: { $gt: 0 } }, { session });
    if (plans.some((plan) => plan.quantities.some((quantity) => quantity > 0)) || override) throw new AppError("INVALID_STATE", "End active and future fulfillment explicitly before archiving this customer.", 409);
  }
  if (input.status === "active" && before.status === "archived") {
    const count = await db.collection<Customer>("customers").countDocuments({ sellerId: seller._id, status: "active" }, { session });
    if (count >= seller.settings.customerCap) throw new AppError("VALIDATION_FAILED", "The active customer limit has been reached.", 422);
  }
  const after = customerSchema.parse({ ...before, alias: input.alias ?? before.alias, packingNote: input.packingNote ?? before.packingNote, status: input.status ?? before.status, revision: before.revision + 1 });
  await db.collection<Customer>("customers").replaceOne({ _id: before._id, sellerId: seller._id }, after, { session });
  return { before, after, resourceIds: [after._id] };
}

export async function updateSettings(input: OperationInput<"updateSettings">, scope: MutationScope): Promise<Change> {
  const { db, session, seller } = scope;
  const activeCount = await db.collection<Customer>("customers").countDocuments({ sellerId: seller._id, status: "active" }, { session });
  if (activeCount > input.settings.customerCap) throw new AppError("VALIDATION_FAILED", "Customer cap is below the active customer count.", 422);
  const plans = await db.collection<Plan>("plans").find({ sellerId: seller._id }, { session }).toArray();
  const overrides = await db.collection<DailyOverride>("dailyOverrides").find({ sellerId: seller._id }, { session }).toArray();
  if (seller.stateRevision > 0 && input.settings.timezone !== seller.settings.timezone) throw new AppError("INVALID_STATE", "Changing the timezone after operation begins requires a migration.", 409);
  if (plans.some((plan) => plan.quantities.some((quantity) => quantity > input.settings.quantityCap)) || overrides.some((override) => override.quantity > input.settings.quantityCap)) throw new AppError("INVALID_STATE", "Quantity cap is below an approved quantity.", 409);
  if ((plans.length || overrides.length) && [...input.settings.weekdays].sort().join() !== [...seller.settings.weekdays].sort().join()) throw new AppError("INVALID_STATE", "Changing service weekdays with approved schedules requires a migration.", 409);
  await db.collection<Seller>("sellers").updateOne({ _id: seller._id, ownerUserId: scope.context.userId }, { $set: { settings: input.settings } }, { session });
  return { before: seller.settings, after: input.settings, resourceIds: [seller._id] };
}
