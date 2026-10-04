"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { getAuth } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db/client";
import { customerSchema, type Customer, type Seller } from "@/lib/contracts/records";
import { getWhatsAppConfig, saveWhatsAppConfig, type WhatsAppConfig, type WhatsAppContact } from "@/lib/server/whatsapp";
import {
  getSavedPhoneNumber,
  getSessionState,
  hasSavedSession,
  startWhatsAppWeb,
  stopWhatsAppWeb,
} from "@/lib/server/whatsapp-web";

async function getAuthSeller() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) throw new Error("Authentication required.");
  const db = await getDb();
  const seller = await db.collection<Seller>("sellers").findOne({ ownerUserId: session.user.id, status: "active" });
  if (!seller) throw new Error("No active seller workspace found.");
  return { seller, db, userId: session.user.id };
}

export type WhatsAppStatusResult =
  | { ok: true; connected: boolean; phoneNumberId: string; verifyToken: string }
  | { ok: false; error: string };

export async function getWhatsAppStatusAction(): Promise<WhatsAppStatusResult> {
  try {
    const { seller } = await getAuthSeller();
    const config = await getWhatsAppConfig(seller._id);
    return {
      ok: true,
      connected: Boolean(config?.connected),
      phoneNumberId: config?.phoneNumberId || "",
      verifyToken: config?.verifyToken || "tiffintally",
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to get WhatsApp status." };
  }
}

export async function saveWhatsAppConfigAction(input: { phoneNumberId: string; accessToken: string; verifyToken: string }) {
  try {
    const { seller } = await getAuthSeller();
    await saveWhatsAppConfig(seller._id, input);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to save WhatsApp config." };
  }
}

export async function disconnectWhatsAppAction() {
  try {
    const { seller, db } = await getAuthSeller();
    await db.collection<WhatsAppConfig>("whatsappConfigs").deleteOne({ sellerId: seller._id });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to disconnect WhatsApp." };
  }
}

export async function listWhatsAppContactsAction() {
  try {
    const { seller, db } = await getAuthSeller();
    const contacts = await db.collection<WhatsAppContact>("whatsappContacts")
      .find({ sellerId: seller._id })
      .sort({ lastMessageAt: -1 })
      .limit(200)
      .toArray();

    const customers = await db.collection<Customer>("customers")
      .find({ sellerId: seller._id, status: "active" })
      .project({ _id: 1, alias: 1 })
      .toArray();

    return { ok: true, contacts, customers };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to list contacts." };
  }
}

export async function linkWhatsAppContactAction(input: { waId: string; customerId: string }) {
  try {
    const { seller, db } = await getAuthSeller();
    await db.collection<WhatsAppContact>("whatsappContacts").updateOne(
      { sellerId: seller._id, waId: input.waId },
      { $set: { customerId: input.customerId } }
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to link contact." };
  }
}

export async function createCustomerFromWhatsAppContactAction(input: { waId: string; alias: string; packingNote?: string }) {
  try {
    const { seller, db } = await getAuthSeller();
    const now = new Date().toISOString();
    const customerId = randomUUID();

    const customer = customerSchema.parse({
      _id: customerId,
      sellerId: seller._id,
      schemaVersion: 1,
      createdAt: now,
      alias: input.alias.trim(),
      packingNote: input.packingNote?.trim() || `WhatsApp: +${input.waId}`,
      status: "active",
      revision: 0,
    });

    await db.collection<Customer>("customers").insertOne(customer);

    // Link contact
    await db.collection<WhatsAppContact>("whatsappContacts").updateOne(
      { sellerId: seller._id, waId: input.waId },
      { $set: { customerId: customer._id } }
    );

    return { ok: true, customerId: customer._id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to create customer." };
  }
}

export async function batchImportWhatsAppCustomersAction(
  items: Array<{ waId: string; alias: string }>
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  try {
    const { seller, db } = await getAuthSeller();
    const now = new Date().toISOString();
    let count = 0;

    for (const item of items) {
      const alias = item.alias.trim() || `Customer +${item.waId}`;
      const contact = await db.collection<WhatsAppContact>("whatsappContacts").findOne({
        sellerId: seller._id,
        waId: item.waId,
      });

      if (contact?.customerId) {
        // Already linked, update alias if changed
        await db.collection<Customer>("customers").updateOne(
          { _id: contact.customerId, sellerId: seller._id },
          { $set: { alias } }
        );
        count++;
        continue;
      }

      // Check if customer exists by packingNote
      const existing = await db.collection<Customer>("customers").findOne({
        sellerId: seller._id,
        status: "active",
        packingNote: { $regex: item.waId, $options: "i" },
      });

      if (existing) {
        await db.collection<WhatsAppContact>("whatsappContacts").updateOne(
          { sellerId: seller._id, waId: item.waId },
          { $set: { customerId: existing._id, profileName: alias } }
        );
        count++;
        continue;
      }

      // Create new customer
      const customerId = randomUUID();
      const customer = customerSchema.parse({
        _id: customerId,
        sellerId: seller._id,
        schemaVersion: 1,
        createdAt: now,
        alias,
        packingNote: `WhatsApp: +${item.waId}`,
        status: "active",
        revision: 0,
      });

      await db.collection<Customer>("customers").insertOne(customer);

      await db.collection<WhatsAppContact>("whatsappContacts").updateOne(
        { sellerId: seller._id, waId: item.waId },
        {
          $set: { customerId, profileName: alias },
          $setOnInsert: { _id: randomUUID(), lastMessage: "", lastMessageAt: now },
        },
        { upsert: true }
      );
      count++;
    }

    return { ok: true, count };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to import customers." };
  }
}

export async function updateWhatsAppContactNameAction(input: {
  waId: string;
  name: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { seller, db } = await getAuthSeller();
    const cleanName = input.name.trim();
    if (!cleanName) throw new Error("Name cannot be empty.");

    const contact = await db.collection<WhatsAppContact>("whatsappContacts").findOne({
      sellerId: seller._id,
      waId: input.waId,
    });

    await db.collection<WhatsAppContact>("whatsappContacts").updateOne(
      { sellerId: seller._id, waId: input.waId },
      { $set: { profileName: cleanName } }
    );

    if (contact?.customerId) {
      await db.collection<Customer>("customers").updateOne(
        { _id: contact.customerId, sellerId: seller._id },
        { $set: { alias: cleanName } }
      );
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to update name." };
  }
}

export async function addManualWhatsAppContactAction(input: {
  waId: string;
  name: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { seller, db } = await getAuthSeller();
    const cleanPhone = input.waId.replace(/\D/g, "");
    if (!cleanPhone || cleanPhone.length < 7) throw new Error("Please enter a valid phone number with country code.");
    const cleanName = input.name.trim() || `+${cleanPhone}`;

    await db.collection<WhatsAppContact>("whatsappContacts").updateOne(
      { sellerId: seller._id, waId: cleanPhone },
      {
        $setOnInsert: {
          _id: randomUUID(),
          customerId: null,
          lastMessage: "",
          lastMessageAt: new Date().toISOString(),
        },
        $set: {
          sellerId: seller._id,
          waId: cleanPhone,
          profileName: cleanName,
        },
      },
      { upsert: true }
    );

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to add contact." };
  }
}

export type WhatsAppWebStatusResult =
  | {
      ok: true;
      status: "disconnected" | "connecting" | "scan_qr" | "connected";
      qrDataUrl: string | null;
      phoneNumber: string | null;
      hasSavedSession: boolean;
      lastError: string | null;
    }
  | { ok: false; error: string };

export async function getWhatsAppWebStatusAction(): Promise<WhatsAppWebStatusResult> {
  try {
    const { seller, db } = await getAuthSeller();
    let session = getSessionState(seller._id);
    const saved = await hasSavedSession(seller._id);

    // If session in memory doesn't have phone number yet, load from saved creds.json
    if (!session.phoneNumber && saved) {
      const savedPhone = await getSavedPhoneNumber(seller._id);
      if (savedPhone) {
        session.phoneNumber = savedPhone;
      }
    }

    // If there is a saved session on disk or active config in DB, but the in-memory socket is disconnected:
    // Auto-resume connection so the user never has to re-connect manually!
    if (session.status === "disconnected") {
      const config = await db.collection<WhatsAppConfig>("whatsappConfigs").findOne({ sellerId: seller._id });
      if (saved || config?.connected) {
        // Start background socket with saved session
        void startWhatsAppWeb(seller._id);
        session = getSessionState(seller._id);
      }
    }

    return {
      ok: true,
      status: session.status,
      qrDataUrl: session.qrDataUrl,
      phoneNumber: session.phoneNumber,
      hasSavedSession: saved,
      lastError: session.lastError,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to get WhatsApp Web status." };
  }
}

export async function startWhatsAppWebConnectAction(): Promise<WhatsAppWebStatusResult> {
  try {
    const { seller } = await getAuthSeller();
    const session = await startWhatsAppWeb(seller._id);
    const saved = await hasSavedSession(seller._id);
    return {
      ok: true,
      status: session.status,
      qrDataUrl: session.qrDataUrl,
      phoneNumber: session.phoneNumber,
      hasSavedSession: saved,
      lastError: session.lastError,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to start WhatsApp Web session." };
  }
}

export async function stopWhatsAppWebAction(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { seller } = await getAuthSeller();
    await stopWhatsAppWeb(seller._id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Failed to stop WhatsApp Web session." };
  }
}
