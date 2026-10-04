import { getDb } from "@/lib/server/db/client";
import { handleIncomingWhatsAppMessage, type WhatsAppConfig } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token) {
    const db = await getDb();
    const config = await db.collection<WhatsAppConfig>("whatsappConfigs").findOne({ verifyToken: token });
    const defaultToken = process.env.WHATSAPP_VERIFY_TOKEN || "tiffindelta";

    if (config || token === defaultToken) {
      return new Response(challenge, { status: 200 });
    }
  }

  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            metadata?: { phone_number_id?: string };
            contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
            messages?: Array<{
              from?: string;
              id?: string;
              timestamp?: string;
              text?: { body?: string };
              type?: string;
            }>;
          };
        }>;
      }>;
    };

    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const contact = value?.contacts?.[0];
    const phoneNumberId = value?.metadata?.phone_number_id || "";

    if (message && message.type === "text" && message.text?.body && message.from && message.id) {
      await handleIncomingWhatsAppMessage({
        phoneNumberId,
        from: message.from,
        profileName: contact?.profile?.name || message.from,
        messageId: message.id,
        text: message.text.body,
        timestamp: message.timestamp || String(Math.floor(Date.now() / 1000)),
      });
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("whatsapp_webhook_error", error);
    return Response.json({ ok: false, error: "Failed to process webhook" }, { status: 200 }); // Meta requires 200 to not retry spam
  }
}
