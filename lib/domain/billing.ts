import { Temporal } from "@js-temporal/polyfill";
import { AppError } from "../contracts/common";
import { billingAdjustmentsSchema, moneySchema, monthSchema, type CommerceInput, type InvoicePreview } from "../contracts/commerce";

export function billingMonthDates(month: string): string[] {
  try {
    monthSchema.parse(month);
    const calendar = Temporal.PlainYearMonth.from(month);
    if (calendar.year < 1 || calendar.year > 9999) throw new Error("Unsupported year");
    const first = calendar.toPlainDate({ day: 1 });
    return Array.from({ length: calendar.daysInMonth }, (_, index) => first.add({ days: index }).toString());
  } catch {
    throw new AppError("VALIDATION_FAILED", "Expected a valid month in years 0001–9999.", 422);
  }
}

function money(value: number): number {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000_000) throw new AppError("VALIDATION_FAILED", "Billing amount exceeds the supported integer-paise limit.", 422);
  return value;
}

type ProofLine = Pick<InvoicePreview["lines"][number], "serviceDate" | "baseline" | "quantity" | "sheetId" | "sheetRevision" | "finalizedAt" | "approvalReceiptId" | "approvalReceiptKey" | "approvedAt">;

/** Frozen sheet quantities are the charge basis; an adjustment replaces a day's amount. */
export function calculateBilling(rows: ProofLine[], unitPricePaise: number | null, rawAdjustments: CommerceInput<"previewInvoice">["adjustments"] = []) {
  const adjustments = billingAdjustmentsSchema.parse(rawAdjustments);
  if (unitPricePaise !== null) moneySchema.parse(unitPricePaise);
  if (rows.length > 31 || new Set(rows.map((row) => row.serviceDate)).size !== rows.length) throw new AppError("VALIDATION_FAILED", "Billing requires at most one finalized row per date.", 422);
  for (const adjustment of adjustments) {
    if (!rows.some((row) => row.serviceDate === adjustment.serviceDate && row.quantity > 0)) throw new AppError("VALIDATION_FAILED", "A seller billing adjustment requires an existing positive finalized row.", 422);
    if (unitPricePaise === null) throw new AppError("VALIDATION_FAILED", "Configure a price before applying a billing adjustment.", 422);
  }
  let baselineSubtotalPaise = 0, skipCreditPaise = 0, reductionCreditPaise = 0, extraChargesPaise = 0, adjustmentsPaise = 0, totalPaise = 0;
  const rate = unitPricePaise ?? 0;
  const lines = [...rows].sort((a, b) => a.serviceDate.localeCompare(b.serviceDate)).map((row) => {
    if (![row.baseline, row.quantity].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 1000)) throw new AppError("VALIDATION_FAILED", "Invalid finalized billing quantity.", 422);
    const baseAmountPaise = money(row.baseline * rate);
    const ordinary = money(row.quantity * rate);
    const adjustment = adjustments.find((item) => item.serviceDate === row.serviceDate);
    const amountPaise = adjustment?.amountPaise ?? ordinary;
    const adjustmentPaise = money(amountPaise - ordinary);
    baselineSubtotalPaise = money(baselineSubtotalPaise + baseAmountPaise);
    skipCreditPaise = money(skipCreditPaise + (row.quantity === 0 ? baseAmountPaise : 0));
    reductionCreditPaise = money(reductionCreditPaise + (row.quantity > 0 && row.quantity < row.baseline ? (row.baseline - row.quantity) * rate : 0));
    extraChargesPaise = money(extraChargesPaise + Math.max(0, row.quantity - row.baseline) * rate);
    adjustmentsPaise = money(adjustmentsPaise + adjustmentPaise);
    totalPaise = money(totalPaise + amountPaise);
    return { ...row, baseAmountPaise, amountPaise, adjustmentPaise, adjustmentReason: adjustment?.reason ?? null };
  });
  if (money(baselineSubtotalPaise - skipCreditPaise - reductionCreditPaise + extraChargesPaise + adjustmentsPaise) !== totalPaise) throw new AppError("INVALID_STATE", "Billing reconciliation failed.", 409);
  return { lines, baselineSubtotalPaise, skipCreditPaise, reductionCreditPaise, extraChargesPaise, adjustmentsPaise, totalPaise };
}

export function invoiceMessage(invoice: Pick<InvoicePreview, "alias" | "month" | "lines" | "unitPricePaise" | "baselineSubtotalPaise" | "skipCreditPaise" | "reductionCreditPaise" | "extraChargesPaise" | "adjustmentsPaise" | "totalPaise" | "upiId" | "canIssue" | "warnings">): string {
  const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
  const detail = invoice.lines.map((line) => `${line.serviceDate}: ${line.quantity} meal(s), ${rupees(line.amountPaise)} [sheet ${line.sheetId.slice(0, 8)} r${line.sheetRevision}${line.approvalReceiptId ? `; approval ${line.approvalReceiptId.slice(0, 8)}` : ""}]${line.adjustmentReason ? ` — seller billing adjustment: ${line.adjustmentReason}` : ""}`);
  return [
    `Hi ${invoice.alias}, here is your ${invoice.month} meal statement${invoice.canIssue ? "" : " (draft — review needed)"}.`,
    `Rate: ${invoice.unitPricePaise === null ? "not configured" : `${rupees(invoice.unitPricePaise)} per meal`}`,
    `Baseline: ${rupees(invoice.baselineSubtotalPaise)}`,
    `Skipped-day credit: -${rupees(invoice.skipCreditPaise)}`,
    `Reduced-quantity credit: -${rupees(invoice.reductionCreditPaise)}`,
    `Extra meals: +${rupees(invoice.extraChargesPaise)}`,
    `Seller billing adjustments: ${rupees(invoice.adjustmentsPaise)}`,
    ...detail, `Total due: ${rupees(invoice.totalPaise)}`,
    ...(invoice.upiId ? [`UPI: ${invoice.upiId}`] : []),
    ...(!invoice.canIssue ? invoice.warnings.map((warning) => `Review: ${warning}`) : []),
    "This statement records finalized packing quantities; it is not confirmation of delivery or payment. Thank you!",
  ].join("\n");
}
