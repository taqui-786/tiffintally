import "server-only";
import type { Db, IndexDescription } from "mongodb";

export const INDEX_VERSION = 2;
export const businessIndexes: Record<string, IndexDescription[]> = {
  commerceSettings: [{ key: { sellerId: 1 }, name: "commerce_seller_unique", unique: true }],
  customerCommerce: [{ key: { sellerId: 1, customerId: 1 }, name: "commerce_customer_unique", unique: true }],
  invoices: [{ key: { sellerId: 1, customerId: 1, month: 1, version: 1 }, name: "invoice_version_unique", unique: true }, { key: { sellerId: 1, month: 1, issuedAt: -1 }, name: "invoice_month_issued" }],
  sellers: [{ key: { ownerUserId: 1 }, name: "owner_unique", unique: true }],
  customers: [{ key: { sellerId: 1, status: 1, _id: 1 }, name: "seller_status_id" }],
  plans: [{ key: { sellerId: 1, customerId: 1, startDate: 1 }, name: "seller_customer_start" }],
  sources: [
    { key: { sellerId: 1, receivedAt: 1, _id: 1 }, name: "seller_received_id" },
    { key: { sellerId: 1, channel: 1, upstreamId: 1 }, name: "upstream_unique", unique: true, partialFilterExpression: { upstreamId: { $type: "string" } } },
  ],
  proposals: [
    { key: { sellerId: 1, status: 1, createdAt: 1, _id: 1 }, name: "seller_status_created_id" },
    { key: { sellerId: 1, sourceId: 1 }, name: "seller_source" },
  ],
  dailyOverrides: [{ key: { sellerId: 1, customerId: 1, serviceDate: 1 }, name: "customer_date_unique", unique: true }],
  receipts: [
    { key: { sellerId: 1, idempotencyKey: 1 }, name: "seller_key_unique", unique: true },
    { key: { sellerId: 1, committedAt: 1, _id: 1 }, name: "seller_committed_id" },
  ],
  sheets: [{ key: { sellerId: 1, serviceDate: 1, revision: 1 }, name: "sheet_revision_unique", unique: true }],
};

export async function initializeIndexes(db: Db): Promise<void> {
  for (const [name, indexes] of Object.entries(businessIndexes)) {
    await db.collection(name).createIndexes(indexes);
  }
}

export async function checkIndexes(db: Db): Promise<boolean> {
  for (const [name, expected] of Object.entries(businessIndexes)) {
    const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
    if (!exists) return false;
    const actual = await db.collection(name).listIndexes().toArray();
    for (const index of expected) {
      const found = actual.find((item) => item.name === index.name);
      if (!found || JSON.stringify(found.key) !== JSON.stringify(index.key) || Boolean(found.unique) !== Boolean(index.unique)) return false;
      if (JSON.stringify(found.partialFilterExpression) !== JSON.stringify(index.partialFilterExpression)) return false;
    }
  }
  return true;
}

export const indexesReady = checkIndexes;
