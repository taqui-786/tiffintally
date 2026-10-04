/** Opens a composer, not a sending API. No message leaves the app until the person shares it. */
export function whatsappShareUrl(phone: string, text: string): string | null {
  if (phone && !/^[1-9]\d{7,14}$/.test(phone)) return null;
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
  return text.trim() && url.length <= 8000 ? url : null;
}

export function formatINR(paise: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100);
}

export function rupeesToPaise(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(paise) && paise <= 1_000_000_000 ? paise : null;
}
