import { describe, expect, it } from "vitest";
import { formatINR, rupeesToPaise, whatsappShareUrl } from "@/lib/client/whatsapp-share";

describe("explicit money input and WhatsApp composers", () => {
  it("parses integer paise without floating-point rounding or exponent inputs", () => {
    expect(rupeesToPaise("100.01")).toBe(10001);
    expect(rupeesToPaise(" 0.1 ")).toBe(10);
    expect(rupeesToPaise("0")).toBe(0);
    expect(rupeesToPaise("10000000")).toBe(1_000_000_000);
    for (const raw of ["", "-1", "0.001", "1e2", "1,000", "1.234", "10000000.01", "Infinity"]) expect(rupeesToPaise(raw)).toBeNull();
    expect(formatINR(10001)).toContain("100.01");
  });
  it("encodes statement content and never permits an arbitrary sharing origin", () => {
    const text = "Fictional meal statement\n₹100 & paid? #proof";
    const url = new URL(whatsappShareUrl("919876543210", text)!);
    expect(url.origin).toBe("https://wa.me");
    expect(url.pathname).toBe("/919876543210");
    expect(url.searchParams.get("text")).toBe(text);
    expect(new URL(whatsappShareUrl("", text)!).pathname).toBe("/");
    for (const phone of ["+919876543210", "javascript:alert(1)", "9198/../123", "123"]) expect(whatsappShareUrl(phone, text)).toBeNull();
  });
  it("refuses empty or oversized links so the UI can offer copy instead", () => {
    expect(whatsappShareUrl("", " ")).toBeNull();
    expect(whatsappShareUrl("", "₹".repeat(1000))).toBeNull();
  });
});
