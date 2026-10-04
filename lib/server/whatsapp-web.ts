import "server-only";

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState as initMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { getDb } from "@/lib/server/db/client";
import { handleIncomingWhatsAppMessage, type WhatsAppConfig, type WhatsAppContact } from "@/lib/server/whatsapp";
import { transcribeVoiceNote } from "@/lib/server/audio/elevenlabs";

export type WebSession = {
  sock: WASocket | null;
  status: "disconnected" | "connecting" | "scan_qr" | "connected";
  qrDataUrl: string | null;
  phoneNumber: string | null;
  lastError: string | null;
};

// Global session registry to survive dev module reloads in Node.js process
const globalSessions = (globalThis as unknown as { __whatsappWebSessions?: Map<string, WebSession> });
if (!globalSessions.__whatsappWebSessions) {
  globalSessions.__whatsappWebSessions = new Map<string, WebSession>();
}
const sessions = globalSessions.__whatsappWebSessions;

type SocketOptions = NonNullable<Parameters<typeof makeWASocket>[0]>;
const silentLogger = {
  level: "silent",
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
} as unknown as SocketOptions["logger"];

function getSessionDir(sellerId: string) {
  const safeId = sellerId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.resolve(".private", "whatsapp-sessions", safeId);
}

export function getSessionState(sellerId: string): WebSession {
  if (!sessions.has(sellerId)) {
    sessions.set(sellerId, {
      sock: null,
      status: "disconnected",
      qrDataUrl: null,
      phoneNumber: null,
      lastError: null,
    });
  }
  return sessions.get(sellerId)!;
}

export async function hasSavedSession(sellerId: string): Promise<boolean> {
  try {
    const credsPath = path.join(getSessionDir(sellerId), "creds.json");
    await fs.access(credsPath);
    return true;
  } catch {
    return false;
  }
}

// ponytail: single background socket per seller; reconnect on unexpected close
export async function startWhatsAppWeb(sellerId: string): Promise<WebSession> {
  const session = getSessionState(sellerId);
  if (session.status === "connected" && session.sock) {
    return session;
  }

  const sessionDir = getSessionDir(sellerId);
  await fs.mkdir(sessionDir, { recursive: true });

  session.status = "connecting";
  session.lastError = null;

  const { state, saveCreds } = await initMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    logger: silentLogger,
    printQRInTerminal: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  session.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        session.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
        session.status = "scan_qr";
      } catch (err) {
        console.error("qrcode_generation_error", err);
      }
    }

    if (connection === "open") {
      const waUser = sock.user?.id ? sock.user.id.split(":")[0].replace(/\D/g, "") : null;
      session.status = "connected";
      session.qrDataUrl = null;
      session.phoneNumber = waUser;
      session.lastError = null;

      // Update DB config flag
      try {
        const db = await getDb();
        await db.collection<WhatsAppConfig>("whatsappConfigs").updateOne(
          { sellerId },
          {
            $set: {
              sellerId,
              phoneNumberId: "qr_web",
              accessToken: "qr_web_active",
              verifyToken: "qr_web",
              connected: true,
              updatedAt: new Date().toISOString(),
            },
          },
          { upsert: true }
        );
      } catch (dbErr) {
        console.error("whatsapp_config_db_error", dbErr);
      }
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (statusCode === DisconnectReason.loggedOut) {
        session.status = "disconnected";
        session.sock = null;
        session.phoneNumber = null;
        session.qrDataUrl = null;
        try {
          await fs.rm(sessionDir, { recursive: true, force: true });
          const db = await getDb();
          await db.collection("whatsappConfigs").deleteOne({ sellerId });
        } catch {
          // ignore cleanup errors
        }
      } else if (shouldReconnect) {
        // Reconnect after brief pause
        setTimeout(() => {
          void startWhatsAppWeb(sellerId);
        }, 3000);
      } else {
        session.status = "disconnected";
      }
    }
  });

  sock.ev.on("contacts.upsert", async (contacts) => {
    try {
      const db = await getDb();
      for (const c of contacts) {
        if (!c.id || c.id.endsWith("@g.us") || c.id.includes("broadcast")) continue;
        const waId = c.id.replace("@s.whatsapp.net", "").replace(/\D/g, "");
        if (!waId) continue;
        const name = c.name || c.notify || c.verifiedName || `+${waId}`;
        await db.collection<WhatsAppContact>("whatsappContacts").updateOne(
          { sellerId, waId },
          {
            $setOnInsert: {
              _id: randomUUID(),
              customerId: null,
              lastMessage: "",
              lastMessageAt: new Date().toISOString(),
            },
            $set: {
              sellerId,
              waId,
              profileName: name,
            },
          },
          { upsert: true }
        );
      }
    } catch (err) {
      console.error("contacts_upsert_error", err);
    }
  });

  sock.ev.on("chats.upsert", async (chats) => {
    try {
      const db = await getDb();
      for (const chat of chats) {
        if (!chat.id || chat.id.endsWith("@g.us") || chat.id.includes("broadcast")) continue;
        const waId = chat.id.replace("@s.whatsapp.net", "").replace(/\D/g, "");
        if (!waId) continue;
        const updateDoc: Partial<WhatsAppContact> = { sellerId, waId };
        if (chat.name) updateDoc.profileName = chat.name;

        await db.collection<WhatsAppContact>("whatsappContacts").updateOne(
          { sellerId, waId },
          {
            $setOnInsert: {
              _id: randomUUID(),
              customerId: null,
              lastMessage: "",
              lastMessageAt: new Date().toISOString(),
              profileName: chat.name || `+${waId}`,
            },
            $set: updateDoc,
          },
          { upsert: true }
        );
      }
    } catch (err) {
      console.error("chats_upsert_error", err);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.endsWith("@g.us")) continue; // direct messages only

      const from = remoteJid.replace("@s.whatsapp.net", "").replace(/\D/g, "");
      let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
      let isVoiceNote = false;

      // Handle voice notes and audio messages
      const audioMessage = msg.message?.audioMessage;
      if (!text.trim() && audioMessage) {
        try {
          const buffer = (await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { logger: silentLogger!, reuploadRequest: sock.updateMediaMessage }
          )) as Buffer;

          if (buffer && buffer.length > 0) {
            const transcription = await transcribeVoiceNote(buffer, audioMessage.mimetype || "audio/ogg");
            if (transcription.ok) {
              text = transcription.text;
              isVoiceNote = Boolean(text.trim());
            } else {
              console.warn("whatsapp_voice_transcription_skipped", transcription.error);
            }
          }
        } catch (mediaErr) {
          console.error("whatsapp_voice_download_error", mediaErr);
        }
      }

      if (!text.trim()) continue;

      const profileName = msg.pushName || from;
      const messageId = msg.key.id || `msg_${Date.now()}`;
      const timestamp = String(msg.messageTimestamp || Math.floor(Date.now() / 1000));

      const result = await handleIncomingWhatsAppMessage({
        phoneNumberId: "qr_web",
        from,
        profileName,
        messageId,
        text,
        timestamp,
        isVoiceNote,
      });

      // Only send a reply if classified and confirmed as an order update, cancellation, or change
      if (result.ok && !result.duplicate && result.isOrderRelated && result.replyText) {
        try {
          await sock.sendMessage(remoteJid, {
            text: result.replyText,
          });
        } catch (sendErr) {
          console.error("whatsapp_web_reply_error", sendErr);
        }
      }
    }
  });

  // Wait briefly for initial QR code or connection event
  await new Promise((resolve) => setTimeout(resolve, 800));

  return session;
}

export async function stopWhatsAppWeb(sellerId: string): Promise<void> {
  const session = getSessionState(sellerId);
  if (session.sock) {
    try {
      session.sock.end(undefined);
    } catch {
      // ignore close errors
    }
    session.sock = null;
  }
  session.status = "disconnected";
  session.qrDataUrl = null;
  session.phoneNumber = null;

  try {
    const sessionDir = getSessionDir(sellerId);
    await fs.rm(sessionDir, { recursive: true, force: true });
    const db = await getDb();
    await db.collection("whatsappConfigs").deleteOne({ sellerId });
  } catch {
    // ignore
  }
}
