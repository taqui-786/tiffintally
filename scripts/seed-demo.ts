import { AppError, type SellerContext } from "../lib/contracts/common";
import { DEFAULT_SETTINGS, type Seller } from "../lib/contracts/records";
import { addDays, isServiceDate, localDateAt } from "../lib/domain/dates";
import { getDb } from "../lib/server/db/client";
import { checkIndexes } from "../lib/server/db/indexes";
import { executeOperation } from "../lib/server/operations";
import { run } from "./run";

void run(async () => {
  if (process.argv.slice(2).join(" ") !== "--confirm" || !process.env.MONGODB_DB?.startsWith("demo_") || process.env.APP_ENV !== "development") {
    throw new AppError("DEMO_ONLY", "Seeding requires APP_ENV=development, a demo_-prefixed DB and --confirm. It never deletes records.", 422);
  }
  const db = await getDb();
  if (!await checkIndexes(db)) throw new AppError("INDEXES_REQUIRED", "Run pnpm db:init first.", 503);
  const existing = await db.collection<Seller>("sellers").findOne({});
  if (!existing) throw new AppError("OWNER_REQUIRED", "Provision a verified owner in the isolated demo DB first.", 422);
  if (await db.collection("customers").countDocuments({ sellerId: existing._id })) throw new AppError("DEMO_NOT_EMPTY", "Seed only an empty seller. Existing records are preserved.", 409);
  const context: SellerContext = { sellerId: existing._id, userId: existing.ownerUserId, requestId: crypto.randomUUID() };
  let date = addDays(localDateAt(new Date().toISOString(), existing.settings.timezone), 1);
  while (!isServiceDate(date, existing.settings.weekdays)) date = addDays(date, 1);
  const meta = async () => ({ expectedStateRevision: (await executeOperation("me", {}, context)).stateRevision, meta: { idempotencyKey: crypto.randomUUID() } });
  for (const [alias, quantity] of [["Fictional A", 2], ["Fictional B", 1], ["Fictional C", 3]] as const) {
    const created = await executeOperation("createCustomer", { ...await meta(), alias }, context);
    const quantities = Array.from({ length: 7 }, (_, index) => existing.settings.weekdays.includes(index + 1) ? quantity : 0);
    const draft = await executeOperation("createProposal", {
      ...await meta(), sourceId: null, expectedSourceRevision: null, manualReason: "Synthetic demo baseline",
      operations: [{ type: "replace_recurring_plan", customerId: created.resourceIds[0], startDate: date, endDate: null, quantities }],
      missingFields: [], evidenceSpans: [],
    }, context);
    const proposalId = draft.resourceIds[0];
    const preview = await executeOperation("previewProposal", { proposalId, expectedDraftRevision: 0 }, context);
    await executeOperation("approveProposal", {
      ...await meta(), proposalId, expectedDraftRevision: 0, expectedSourceRevision: null, previewHash: preview.previewHash,
      supersedesApprovalIds: [], acknowledgeLateChange: false,
    }, context);
  }
  const day = await executeOperation("getDay", { serviceDate: date }, context);
  if (day.total !== 6) throw new Error("Unexpected demo total");
  console.log(`Synthetic demo created: service date ${date}, confirmed meals ${day.total}. No AI was called.`);
  console.log(`Default timezone reference: ${DEFAULT_SETTINGS.timezone}; actual seller settings were used.`);
});
