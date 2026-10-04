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

  // 1. Check if sender is a selected / linked customer
  const existingContact = await db.collection<WhatsAppContact>("whatsappContacts").findOne({ sellerId: seller._id, waId: payload.from });
  let customerId = existingContact?.customerId ?? null;

  // If not explicitly linked on contact, check if an active customer has this exact phone number
  if (!customerId) {
    const matchedCustomer = await db.collection<Customer>("customers").findOne({
      sellerId: seller._id,
      status: "active",
      packingNote: { $regex: payload.from, $options: "i" },
    });
    if (matchedCustomer) {
      customerId = matchedCustomer._id;
    }
  }

  // Update WhatsApp Contact so the merchant can see recent chat/activity in their customer selection dialog
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

  // 2. CRITICAL FILTER: If the sender is NOT a selected/linked customer, DO NOT create a source or review item!
  if (!customerId) {
    console.log(
      `[WhatsApp] 🛑 Message from unselected contact +${payload.from} ("${payload.profileName}"): "${payload.text}". Skipped because contact is not selected as a customer in TiffinTally.`
    );
    return { ok: true, skipped: true, reason: "contact_not_a_customer" };
  }

  // Find customer details
  const customer = await db.collection<Customer>("customers").findOne({
    _id: customerId,
    sellerId: seller._id,
    status: "active",
  });
  if (!customer) {
    console.log(`[WhatsApp] 🛑 Contact +${payload.from} is linked to missing or archived customer (${customerId}). Skipping.`);
    return { ok: true, skipped: true, reason: "inactive_customer" };
  }

  console.log(`\n======================================================================`);
  console.log(`[WhatsApp] 📩 Processing incoming message from selected customer:`);
  console.log(`  Customer: "${customer.alias}" (ID: ${customer._id})`);
  console.log(`  Sender Phone: +${payload.from}`);
  console.log(`  Profile Name: "${payload.profileName}"`);
  console.log(`  Message ID: ${payload.messageId}`);
  console.log(`  Message Text: "${payload.text}"`);
  console.log(`  Sent At: ${sentAt}`);
  console.log(`======================================================================\n`);

  // 3. Prevent duplicate message imports by upstreamId
  const existingSource = await db.collection<Source>("sources").findOne({
    sellerId: seller._id,
    upstreamId: payload.messageId,
  });
  if (existingSource) {
    console.log(`[WhatsApp] ⚠️ Duplicate message skipped for upstreamId: ${payload.messageId}`);
    return { ok: true, sourceId: existingSource._id, duplicate: true };
  }

  // 4. Create Source record
  const fingerprint = payloadHash({
    text: payload.text.trim().replace(/\s+/g, " ").toLocaleLowerCase("en"),
    sentAt,
    customerId,
  });

  // 4. Check for pure greetings (e.g. "Hey", "Hi", "Good morning", "Thanks", "Ok")
  const isPureGreeting = /^(hey|hi|hello|good\s*(morning|afternoon|evening|night)|thanks|thank\s*you|ok|okay|k|bye)[\s!.]*$/i.test(payload.text.trim());
  if (isPureGreeting) {
    console.log(`[WhatsApp Classification] ℹ️ Casual greeting detected from ${customer.alias}: "${payload.text}". Auto-dismissed from review queue.`);
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
      status: "dismissed",
      deferredDate: null,
      fingerprint,
      channel: "whatsapp",
      upstreamId: payload.messageId,
      replacesSourceId: null,
      dispositionReason: "Conversational greeting / non-order text",
    });
    await db.collection<Source>("sources").insertOne(source);
    return { ok: true, sourceId: source._id, isOrderRelated: false };
  }

  // 5. Create Source record for review/analysis
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

  // 6. Run Gemma + JEV extraction & classification automatically
  try {
    const requestId = randomUUID();
    const safeMsgId = payload.messageId.replace(/[^A-Za-z0-9_-]/g, "_");
    const runKey = `wa_run_${safeMsgId}`.slice(0, 64);
    console.log(`[WhatsApp AI] 🤖 Dispatching Gemma + JEV intelligence analysis for ${customer.alias}...`);
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

    console.log(`[WhatsApp AI] ✅ Analysis run completed (${analysis.runId}). State: ${analysis.state}`);
    console.log(`  Proposals generated count: ${analysis.proposalIds.length}`);

    if (analysis.proposalIds.length > 0) {
      const proposals = await db.collection<Proposal>("proposals")
        .find({ _id: { $in: analysis.proposalIds }, sellerId: seller._id })
        .toArray();

      const operations = proposals.flatMap((p) => p.operations);
      console.log(`  Actionable operations count: ${operations.length}`);

      if (operations.length > 0) {
        isOrderRelated = true;
        console.log(`[WhatsApp Classification] 🎯 Confirmed ORDER-RELATED message from ${customer.alias}!`);
        console.log(`  Operations:`, JSON.stringify(operations, null, 2));

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

        // Send reply if Cloud API is configured
        const config = await getWhatsAppConfig(seller._id);
        if (config?.connected && config.accessToken && config.phoneNumberId !== "qr_web" && replyText) {
          await sendWhatsAppMessage(
            config.phoneNumberId,
            config.accessToken,
            payload.from,
            replyText
          );
        }
      } else {
        // Zero actionable operations (e.g. "Hey", greetings, non-order chat)
        console.log(`[WhatsApp Classification] ℹ️ NON-ORDER MESSAGE from ${customer.alias}: "${payload.text}".`);
        console.log(`  JEV and Gemma found 0 meal order operations. Auto-dismissing from review queue.`);

        // Auto-dismiss the source so it does not clutter the kitchen review queue!
        await db.collection<Source>("sources").updateOne(
          { _id: source._id, sellerId: seller._id },
          {
            $set: {
              status: "dismissed",
              dispositionReason: "Non-order conversation / greeting (classified by JEV/Gemma: no meal operations)",
            },
            $inc: { revision: 1 },
          }
        );

        // Reject empty proposals (with 0 operations)
        await db.collection<Proposal>("proposals").updateMany(
          { _id: { $in: analysis.proposalIds }, sellerId: seller._id, "operations.0": { $exists: false } },
          {
            $set: {
              status: "rejected",
              dispositionReason: "Auto-dismissed: message contains no actionable order change",
            },
          }
        );
      }
    } else {
      // 0 proposals generated
      console.log(`[WhatsApp Classification] ℹ️ NON-ORDER MESSAGE from ${customer.alias}: "${payload.text}". 0 proposals generated.`);
      await db.collection<Source>("sources").updateOne(
        { _id: source._id, sellerId: seller._id },
        {
          $set: {
            status: "dismissed",
            dispositionReason: "Non-order conversation / greeting (no proposals generated)",
          },
          $inc: { revision: 1 },
        }
      );
    }
  } catch (analysisErr) {
    console.error("[WhatsApp AI] ❌ Analysis error:", analysisErr);
  }

  return { ok: true, sourceId: source._id, isOrderRelated, replyText };
}
