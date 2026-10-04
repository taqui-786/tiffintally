import { describe, expect, it } from "vitest";
import { billingMonthDates, calculateBilling, invoiceMessage } from "@/lib/domain/billing";

function line(day: number, baseline: number, quantity: number) {
  return { serviceDate: `2024-02-${String(day).padStart(2, "0")}`, baseline, quantity, sheetId: `sheet_${day}`, sheetRevision: 1, finalizedAt: "2024-02-29T12:00:00Z", approvalReceiptId: null, approvalReceiptKey: null, approvedAt: null };
}

describe("integer-paise billing from frozen rows", () => {
  it("charges approved baseline rows with no daily override receipt ID", () => {
    expect(calculateBilling([line(1, 2, 2)], 8000)).toMatchObject({ baselineSubtotalPaise: 16000, totalPaise: 16000 });
  });
  it("reconciles skips, reductions and extras without double-subtracting skipped days", () => {
    const result = calculateBilling([line(1, 2, 2), line(2, 2, 0), line(3, 2, 1), line(4, 2, 3)], 8000);
    expect(result).toMatchObject({ baselineSubtotalPaise: 64000, skipCreditPaise: 16000, reductionCreditPaise: 8000, extraChargesPaise: 8000, adjustmentsPaise: 0, totalPaise: 48000 });
    expect(result.lines.reduce((sum, row) => sum + row.amountPaise, 0)).toBe(48000);
  });
  it("replaces a positive day's charge with an explicit reasoned absolute adjustment", () => {
    const result = calculateBilling([line(1, 2, 2)], 8000, [{ serviceDate: "2024-02-01", amountPaise: 12000, reason: "Seller half-portion billing adjustment" }]);
    expect(result).toMatchObject({ adjustmentsPaise: -4000, totalPaise: 12000 });
    expect(result.lines[0]).toMatchObject({ quantity: 2, amountPaise: 12000, adjustmentPaise: -4000, adjustmentReason: "Seller half-portion billing adjustment" });
  });
  it("refuses adjustments to absent or skipped rows and duplicate/invalid adjustments", () => {
    const adjustment = { serviceDate: "2024-02-01", amountPaise: 100, reason: "Explicit seller adjustment" };
    expect(() => calculateBilling([], 8000, [adjustment])).toThrow();
    expect(() => calculateBilling([line(1, 2, 0)], 8000, [adjustment])).toThrow();
    expect(() => calculateBilling([line(1, 2, 2)], 8000, [adjustment, adjustment])).toThrow();
    for (const amountPaise of [-1, 0.5, Number.MAX_SAFE_INTEGER]) expect(() => calculateBilling([line(1, 2, 2)], 8000, [{ ...adjustment, amountPaise }])).toThrow();
    expect(() => calculateBilling([line(1, 2, 2)], 8000, [{ ...adjustment, reason: " " }])).toThrow();
    expect(() => calculateBilling([line(1, 2, 2)], null, [adjustment])).toThrow();
  });
  it("enforces money bounds on each multiplication and aggregate, including extras", () => {
    expect(calculateBilling([line(1, 1, 1)], 1_000_000_000).totalPaise).toBe(1_000_000_000);
    expect(() => calculateBilling([line(1, 2, 2)], 1_000_000_000)).toThrow();
    expect(() => calculateBilling([line(1, 1, 1), line(2, 1, 1)], 600_000_000)).toThrow();
    expect(() => calculateBilling([line(1, 0, 1000)], 1_000_001)).toThrow();
    expect(() => calculateBilling([line(1, 1.5, 2)], 8000)).toThrow();
  });
  it("validates real month boundaries including leap years and invalid years", () => {
    expect(billingMonthDates("2024-02")).toHaveLength(29);
    expect(billingMonthDates("2023-02")).toHaveLength(28);
    expect(billingMonthDates("2024-01").at(-1)).toBe("2024-01-31");
    for (const value of ["2024-13", "2024-00", "0000-01", "2024-2", "10000-01"]) expect(() => billingMonthDates(value)).toThrow();
  });
  it("refuses duplicate date charges and keeps missing prices unconfigured", () => {
    expect(() => calculateBilling([line(1, 2, 2), line(1, 2, 2)], 8000)).toThrow();
    expect(calculateBilling([line(1, 2, 2)], null).totalPaise).toBe(0);
  });
  it("formats a friendly statement with reconciliation, proof refs and adjustment reasons", () => {
    const facts = calculateBilling([line(1, 2, 2)], 8000, [{ serviceDate: "2024-02-01", amountPaise: 12000, reason: "Seller half-portion billing adjustment" }]);
    const message = invoiceMessage({ ...facts, alias: "Fictional A", month: "2024-02", unitPricePaise: 8000, upiId: "fictional@upi", canIssue: true, warnings: [] });
    expect(message).toContain("Hi Fictional A");
    expect(message).toContain("2 meal(s), ₹120.00");
    expect(message).toContain("seller billing adjustment");
    expect(message).toContain("sheet sheet_1 r1");
    expect(message).toContain("Total due: ₹120.00");
    expect(message).toContain("UPI: fictional@upi");
    expect(message).toContain("not confirmation of delivery or payment");
  });
});
