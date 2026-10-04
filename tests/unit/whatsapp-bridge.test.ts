import { describe, expect, it } from "vitest";
import { getSessionState, hasSavedSession } from "@/lib/server/whatsapp-web";

describe("WhatsApp Web Bridge (Option A)", () => {
  it("initializes an isolated session state for a seller", () => {
    const session = getSessionState("seller-unit-test-1");
    expect(session).toBeDefined();
    expect(session.status).toBe("disconnected");
    expect(session.qrDataUrl).toBeNull();
    expect(session.phoneNumber).toBeNull();
  });

  it("checks saved session returns false when no credentials directory exists", async () => {
    const hasCreds = await hasSavedSession("seller-non-existent-999");
    expect(hasCreds).toBe(false);
  });
});
