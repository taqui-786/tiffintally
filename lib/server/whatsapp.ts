import "server-only";

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/server/db/client";
import { sourceSchema, type Customer, type Proposal, type Seller, type Source } from "@/lib/contracts/records";
import { payloadHash } from "@/lib/server/receipts";
import { executeIntelligenceOperation } from "@/lib/server/ai/analyze";

export type WhatsAppConfig = {
  sellerId: string;
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  connected: boolean;
  updatedAt: string;
};

export type WhatsAppContact = {
  _id: string;
  sellerId: string;
  waId: string; // phone number e.g. "919876543210"
  profileName: string;
  lastMessage: string;
  lastMessageAt: string;
  customerId: string | null;
};

// ponytail: single active seller default; multi-tenant lookup by phoneNumberId if scaled
export async function getActiveSeller(): Promise<Seller | null> {
  const db = await getDb();
  return db.collection<Seller>("sellers").findOne({ status: "active" });
}

export async function getWhatsAppConfig(sellerId: string): Promise<WhatsAppConfig | null> {
  const db = await getDb();
  return db.collection<WhatsAppConfig>("whatsappConfigs").findOne({ sellerId });
}

export async function saveWhatsAppConfig(sellerId: string, input: { phoneNumberId: string; accessToken: string; verifyToken: string }) {
  const db = await getDb();
  const config: WhatsAppConfig = {
    sellerId,
    phoneNumberId: input.phoneNumberId.trim(),
    accessToken: input.accessToken.trim(),
    verifyToken: input.verifyToken.trim(),
    connected: Boolean(input.phoneNumberId && input.accessToken),
    updatedAt: new Date().toISOString(),
  };
  await db.collection<WhatsAppConfig>("whatsappConfigs").updateOne(
    { sellerId },
    { $set: config },
    { upsert: true }
  );
  return config;
}

export async function sendWhatsAppMessage(phoneNumberId: string, accessToken: string, to: string, text: string) {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("whatsapp_send_failed", err);
    return false;
  }
}

export async function handleIncomingWhatsAppMessage(payload: {
  phoneNumberId: string;
  from: string;
  profileName: string;
  messageId: string;
  text: string;
  timestamp: string;
  isVoiceNote?: boolean;
}) {
  const db = await getDb();
  const seller = await getActiveSeller();
  if (!seller) return { ok: false, error: "No active seller" };

  const now = new Date().toISOString();
  const sentAt = new Date(Number(payload.timestamp) * 1000).toISOString();

  // 1. Upsert WhatsApp Contact for instant customer discovery
  const existingContact = await db.collection<WhatsAppContact>("whatsappContacts").findOne({ sellerId: seller._id, waId: payload.from });
  let customerId = existingContact?.customerId ?? null;

  // If unlinked, try matching by phone number or alias
  if (!customerId) {
    const matchedCustomer = await db.collection<Customer>("customers").findOne({
      sellerId: seller._id,
      status: "active",
      $or: [
        { packingNote: { $regex: payload.from, $options: "i" } },
        { alias: { $regex: payload.profileName, $options: "i" } },
      ],
    });
    if (matchedCustomer) customerId = matchedCustomer._id;
  }

  await db.collection<WhatsAppContact>("whatsappContacts").updateOne(
    { sellerId: seller._id, waId: payload.from },
    {
      $set: {
        sellerId: seller._id,
        waId: payload.from,
        profileName: payload.profileName,
        lastMessage: payload.text,
        lastMessageAt: now,
        customerId,
      },
      $setOnInsert: { _id: randomUUID() },
    },
    { upsert: true }
  );

  // 2. Prevent duplicate message imports by upstreamId
  const existingSource = await db.collection<Source>("sources").findOne({
    sellerId: seller._id,
    upstreamId: payload.messageId,
  });
  if (existingSource) return { ok: true, sourceId: existingSource._id, duplicate: true };

  // 3. Create Source record
  const fingerprint = payloadHash({
    text: payload.text.trim().replace(/\s+/g, " ").toLocaleLowerCase("en"),
    sentAt,
    customerId,
  });

  const sourceId = randomUUID();
  const source = sourceSchema.parse({
    _id: sourceId,
    sellerId: seller._id,
    schemaVersion: 1,
    createdAt: now,
    receivedAt: now,
    sentAt,
    text: payload.text,
    customerId,
    revision: 0,
    status: "needs_review",
    deferredDate: null,
    fingerprint,
    channel: "whatsapp",
    upstreamId: payload.messageId,
    replacesSourceId: null,
    dispositionReason: null,
  });

  await db.collection<Source>("sources").insertOne(source);

  let isOrderRelated = false;
  let replyText: string | undefined;

  // 4. If linked to an active customer, run Gemma + JEV extraction automatically
  if (customerId) {
    try {
      const requestId = randomUUID();
      const runKey = `wa:${payload.messageId.slice(0, 48)}`;
      const analysis = await executeIntelligenceOperation(
        "analyzeSource",
        {
          sourceId: source._id,
          expectedSourceRevision: 0,
          expectedStateRevision: seller.stateRevision,
          expectedDraftRevisions: [],
          consentAcknowledged: true,
          meta: { idempotencyKey: runKey },
        },
        { sellerId: seller._id, userId: seller.ownerUserId, requestId }
      );

      // Only prepare a reply if the message is classified and confirmed to contain order-related operations
      if (analysis.proposalIds.length > 0) {
        const proposals = await db.collection<Proposal>("proposals")
          .find({ _id: { $in: analysis.proposalIds }, sellerId: seller._id })
          .toArray();

        const operations = proposals.flatMap((p) => p.operations);
        if (operations.length > 0) {
          isOrderRelated = true;

          const cancelOp = operations.find((op) => op.type === "set_daily_quantity" && op.quantity === 0);
          const mealOp = operations.find((op) => op.type === "set_daily_quantity" && op.quantity > 0);
          const pauseOp = operations.find((op) => op.type === "pause_interval");
          const resumeOp = operations.find((op) => op.type === "resume_interval");

          if (cancelOp && cancelOp.type === "set_daily_quantity") {
            replyText = `Hi ${payload.profileName}! We received your request to cancel/skip your meal on ${cancelOp.serviceDate}. We are updating today's packing sheet.`;
          } else if (mealOp && mealOp.type === "set_daily_quantity") {
            replyText = `Hi ${payload.profileName}! We received your order update for ${mealOp.quantity} meal(s) on ${mealOp.serviceDate}. We are updating today's packing sheet.`;
          } else if (pauseOp && pauseOp.type === "pause_interval") {
            replyText = `Hi ${payload.profileName}! We received your request to pause meals from ${pauseOp.fromDate} to ${pauseOp.toDate}. We are updating today's packing sheet.`;
          } else if (resumeOp && resumeOp.type === "resume_interval") {
            replyText = `Hi ${payload.profileName}! We received your request to resume meals from ${resumeOp.fromDate} to ${resumeOp.toDate}. We are updating today's packing sheet.`;
          } else {
            replyText = `Hi ${payload.profileName}! We received your meal plan update. We are updating today's packing sheet.`;
          }

          // If Cloud API (Meta API) is connected and not qr_web, send the classified confirmation reply
          const config = await getWhatsAppConfig(seller._id);
          if (config?.connected && config.accessToken && config.phoneNumberId !== "qr_web" && replyText) {
            await sendWhatsAppMessage(
              config.phoneNumberId,
              config.accessToken,
              payload.from,
              replyText
            );
          }
        }
      }
    } catch (analysisErr) {
      console.error("whatsapp_auto_analysis_error", analysisErr);
    }
  }

  return { ok: true, sourceId: source._id, isOrderRelated, replyText };
}
