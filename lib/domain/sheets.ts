import type { SheetDelta, SheetRow } from "../contracts/records";

export function sheetDelta(previous: SheetRow[], current: SheetRow[]): SheetDelta[] {
  const before = new Map(previous.map((row) => [row.customerId, row.quantity]));
  const after = new Map(current.map((row) => [row.customerId, row.quantity]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((customerId) => {
    const oldQuantity = before.get(customerId) ?? 0;
    const newQuantity = after.get(customerId) ?? 0;
    return oldQuantity === newQuantity ? [] : [{ customerId, before: oldQuantity, after: newQuantity, difference: newQuantity - oldQuantity }];
  });
}

export function safeCsvCell(value: string): string {
  // Neutralize formulas even behind Unicode whitespace or invisible control bytes.
  return /^[\s\p{Cc}\p{Cf}]*[=+@-]/u.test(value) ? `'${value}` : value;
}
