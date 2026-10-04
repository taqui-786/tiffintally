import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FEATURE_NAMES, featureRowSchema, historyInputSchemas, historyOutputSchemas, historyRowSchema } from "@/lib/contracts/history";
import { exactSupersession, parseHistoryCsv, validateHistoryRows } from "@/lib/server/forecasting/history";

const row = { schemaVersion: 1, serviceDate: "2026-01-01", timezone: "UTC", policyHash: "a".repeat(64), asOf: "2026-01-01T09:00:00Z", cutoffAt: "2026-01-01T10:00:00Z", outcomeAvailableAt: "2026-01-01T10:00:00Z", confirmedMeals: 10, cutoffTotal: 12, features: [4, 60, 10, 10, 2, null, null, null, null, null, 0, null, null, 0], evidenceMode: "synthetic_demo", provenance: { kind: "synthetic", reference: "fixture", complete: true, snapshotEvidenceAt: "2026-01-01T09:00:00Z", cutoffEvidenceAt: "2026-01-01T10:00:00Z", messageFeatures: "missing", messageEvidenceAt: null } };
const command = { meta: { idempotencyKey: "history_fixture" }, expectedStateRevision: 0, expectedHistoryVersion: 0 };
describe("strict historical import contracts", () => {
  it("exports the exact requested operation maps and serializable schemas", () => {
    expect(Object.keys(historyInputSchemas)).toEqual(["stageHistory", "getHistoryImport", "commitHistory", "listHistory", "capturePlanningSnapshot", "recordOutcome", "requestForecast", "listForecasts", "getForecast", "getForecastByKey"]);
    expect(Object.keys(historyOutputSchemas)).toEqual(Object.keys(historyInputSchemas));
    for (const schema of Object.values(historyInputSchemas)) expect(z.toJSONSchema(schema)).toBeTruthy();
  });
  it("accepts finite 14 cells with missing null, but not omitted cells, infinity or strings", () => {
    expect(featureRowSchema.safeParse(row.features).success).toBe(true);
    for (const cells of [row.features.slice(1), [...row.features, 0], [Infinity, ...row.features.slice(1)], ["4", ...row.features.slice(1)]]) expect(featureRowSchema.safeParse(cells).success).toBe(false);
    expect(row.features.length).toBe(FEATURE_NAMES.length);
  });
  it("rejects unknown row and provenance fields, fractional counts and non-JSON values", () => {
    for (const invalid of [{ ...row, total: 12 }, { ...row, confirmedMeals: 1.2 }, { ...row, provenance: { ...row.provenance, trusted: true } }, { ...row, cutoffTotal: -1 }, { ...row, timezone: "invalid/zone" }, { ...row, serviceDate: "2026-13-01" }]) expect(historyRowSchema.safeParse(invalid).success).toBe(false);
    expect(historyInputSchemas.stageHistory.safeParse({ ...command, schemaVersion: 1, evidenceMode: "synthetic_demo", rows: [new Date()] }).success).toBe(false);
  });
  it("rejects invented past evidence and leaked retrospective message features", () => {
    expect(historyRowSchema.safeParse({ ...row, outcomeAvailableAt: row.asOf }).success).toBe(false);
    expect(historyRowSchema.safeParse({ ...row, provenance: { ...row.provenance, cutoffEvidenceAt: "2026-01-01T11:00:00Z" } }).success).toBe(false);
    const features = [...row.features]; features[5] = 1; features[13] = 1;
    expect(historyRowSchema.safeParse({ ...row, features, provenance: { ...row.provenance, messageFeatures: "retrospective", messageEvidenceAt: "2026-01-02T00:00:00Z" } }).success).toBe(false);
  });
  it("rejects source-derived counts without as-of evidence and preserves complete zero counts", () => {
    const features = [...row.features]; for (let i = 5; i <= 9; i++) features[i] = 0; features[13] = 1;
    expect(historyRowSchema.safeParse({ ...row, features, provenance: { ...row.provenance, messageFeatures: "as_of", messageEvidenceAt: row.asOf } }).success).toBe(true);
    expect(historyRowSchema.safeParse({ ...row, features, provenance: { ...row.provenance, messageFeatures: "as_of", messageEvidenceAt: row.cutoffAt } }).success).toBe(false);
  });
  it("stages duplicate dates, policy and evidence-mode errors together", () => {
    const result = validateHistoryRows([row, { ...row, policyHash: "b".repeat(64) }], { policyHash: row.policyHash, timezone: row.timezone, evidenceMode: "real" });
    expect(result.errors.map((error) => error.row)).toContain(1);
    expect(result.errors.filter((error) => error.row === 2).length).toBeGreaterThan(1);
  });
  it("bounds rows and prohibits request-controlled runtime/model/validation", () => {
    expect(historyInputSchemas.stageHistory.safeParse({ ...command, schemaVersion: 1, evidenceMode: "synthetic_demo", rows: Array(2001).fill(row) }).success).toBe(false);
    for (const field of ["url", "model", "validated"]) expect(historyInputSchemas.requestForecast.safeParse({ ...command, snapshotId: "s", serviceDate: row.serviceDate, [field]: true }).success).toBe(false);
    expect(historyInputSchemas.getForecast.safeParse({ forecastId: "by-key" }).success).toBe(false);
  });
  it("requires exact supersession IDs", () => {
    expect(() => exactSupersession(["a", "b"], ["b", "a"])).not.toThrow();
    expect(() => exactSupersession(["a", "b"], ["a"])).toThrow();
    expect(() => exactSupersession(["a"], ["a", "c"])).toThrow();
  });
  it("uses csv-parse for quoted JSON cells and strict columns", () => {
    const quote = (value: unknown) => `"${(typeof value === "object" ? JSON.stringify(value) : String(value)).replaceAll('"', '""')}"`;
    const csv = `${Object.keys(row).join(",")}\n${Object.values(row).map(quote).join(",")}\n`;
    expect(parseHistoryCsv(csv)).toEqual([row]);
    expect(() => parseHistoryCsv(`serviceDate,serviceDate\n2026-01-01,2026-01-01`)).toThrow();
    expect(() => parseHistoryCsv(csv.replace("schemaVersion", "unknown"))).toThrow();
    expect(() => parseHistoryCsv("x".repeat(2 * 1024 * 1024 + 1))).toThrow();
  });
});
