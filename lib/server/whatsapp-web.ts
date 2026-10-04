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

// Global session and in-flight registry to survive dev module reloads in Node.js process
const globalSessions = (globalThis as unknown as {
  __whatsappWebSessions?: Map<string, WebSession>;
  __whatsappInFlight?: Map<string, Promise<WebSession>>;
});
if (!globalSessions.__whatsappWebSessions) {
  globalSessions.__whatsappWebSessions = new Map<string, WebSession>();
}
if (!globalSessions.__whatsappInFlight) {
  globalSessions.__whatsappInFlight = new Map<string, Promise<WebSession>>();
}
const sessions = globalSessions.__whatsappWebSessions;
const inFlight = globalSessions.__whatsappInFlight;

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
  return path.join(process.cwd(), ".private", "whatsapp-sessions", safeId);
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

export async function getSavedPhoneNumber(sellerId: string): Promise<string | null> {
  try {
    const credsPath = path.join(getSessionDir(sellerId), "creds.json");
    const raw = await fs.readFile(credsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.me?.id) {
      return parsed.me.id.split(":")[0].replace(/\D/g, "");
    }
    return null;
  } catch {
    return null;
  }
}

// Single background socket per seller; reconnect on unexpected close; mutex locked
export async function startWhatsAppWeb(sellerId: string): Promise<WebSession> {
  const session = getSessionState(sellerId);
  if (session.status === "connected" && session.sock) {
    return session;
  }

  // Mutex lock: Prevent duplicate concurrent sockets from conflicting and invalidating the session
  if (inFlight.has(sellerId)) {
    return inFlight.get(sellerId)!;
  }

  const runConnect = async (): Promise<WebSession> => {
    // Gracefully clean up any dangling previous socket before creating a new one
    if (session.sock) {
      try {
        session.sock.ev.removeAllListeners("connection.update");
        session.sock.ev.removeAllListeners("creds.update");
        session.sock.ev.removeAllListeners("messages.upsert");
        session.sock.ev.removeAllListeners("contacts.upsert");
        session.sock.ev.removeAllListeners("chats.upsert");
        session.sock.end(undefined);
      } catch {
        // ignore close errors
      }
      session.sock = null;
    }

    const sessionDir = getSessionDir(sellerId);
    await fs.mkdir(sessionDir, { recursive: true });

    session.status = "connecting";
    session.lastError = null;

    const { state, saveCreds } = await initMultiFileAuthState(sessionDir);

    if (state.creds.me?.id) {
      session.phoneNumber = state.creds.me.id.split(":")[0].replace(/\D/g, "");
    }

    const sock = makeWASocket({
      auth: state,
      logger: silentLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      browser: ["TiffinTally", "Chrome", "1.0.0"],
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
        const waUser = (sock.user?.id || state.creds.me?.id)?.split(":")[0]?.replace(/\D/g, "") || session.phoneNumber;
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

        // NOTE: NEVER delete sessionDir on disk here! Deleting credentials on transient 401/timeout
        // causes permanent session loss. Only user-initiated disconnect (stopWhatsAppWeb) deletes credentials.
        if (statusCode === DisconnectReason.loggedOut) {
          session.status = "disconnected";
          session.sock = null;
          session.qrDataUrl = null;
          session.lastError = "Session disconnected by WhatsApp. Please scan QR to reconnect.";
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
  };

  const promise = runConnect().finally(() => {
    inFlight.delete(sellerId);
  });
  inFlight.set(sellerId, promise);
  return promise;
}

export async function stopWhatsAppWeb(sellerId: string): Promise<void> {
  inFlight.delete(sellerId);
  const session = getSessionState(sellerId);
  if (session.sock) {
    try {
      session.sock.ev.removeAllListeners("connection.update");
      session.sock.ev.removeAllListeners("creds.update");
      session.sock.ev.removeAllListeners("messages.upsert");
      session.sock.ev.removeAllListeners("contacts.upsert");
      session.sock.ev.removeAllListeners("chats.upsert");
      session.sock.end(undefined);
    } catch {
      // ignore close errors
    }
    session.sock = null;
  }
  session.status = "disconnected";
  session.qrDataUrl = null;
  session.phoneNumber = null;
  session.lastError = null;

  try {
    const sessionDir = getSessionDir(sellerId);
    await fs.rm(sessionDir, { recursive: true, force: true });
    const db = await getDb();
    await db.collection("whatsappConfigs").deleteOne({ sellerId });
  } catch {
    // ignore
  }
}

export async function restoreActiveWhatsAppSessions(): Promise<void> {
  try {
    const db = await getDb();
    const configs = await db.collection<WhatsAppConfig>("whatsappConfigs").find({ connected: true }).toArray();
    for (const config of configs) {
      if (await hasSavedSession(config.sellerId)) {
        void startWhatsAppWeb(config.sellerId);
      }
    }
  } catch (err) {
    console.error("[WHATSAPP_WEB] Error restoring sessions on startup:", err);
  }
}
