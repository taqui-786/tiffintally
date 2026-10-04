import "server-only";
import { z } from "zod";
import { AppError, type SellerContext } from "@/lib/contracts/common";
import { historyInputSchemas, historyOutputSchemas, type AcceptedHistory, type ForecastRun, type HistoryOperationName } from "@/lib/contracts/history";
import { capturePlanningSnapshot, commitHistory, historyCommand, historyRead, importDto, importFor, recordOutcome, stageHistory, type HistoryScope } from "./history";
import { effectiveForecast, readForecast, requestForecast } from "./forecast";
export { initializeForecastIndexes, checkForecastIndexes, parseHistoryCsv, currentPolicyHash } from "./history";
export { FEATURE_NAMES } from "./features";
export { evaluateHistory } from "./forecast";
export { evaluateHistoryRows } from "./evaluate";

export async function executeForecastingOperation<K extends HistoryOperationName>(name: K, raw: unknown, context: SellerContext): Promise<z.infer<(typeof historyOutputSchemas)[K]>> {
  const input = historyInputSchemas[name].parse(raw);
  let value: unknown;
  switch (name) {
    case "stageHistory": { const i = historyInputSchemas.stageHistory.parse(input); value = (await historyCommand(name, i, context, (scope) => stageHistory(i, scope))).value; break; }
    case "commitHistory": { const i = historyInputSchemas.commitHistory.parse(input); value = (await historyCommand(name, i, context, (scope, receiptId) => commitHistory(i, scope, receiptId))).value; break; }
    case "capturePlanningSnapshot": { const i = historyInputSchemas.capturePlanningSnapshot.parse(input); value = (await historyCommand(name, i, context, (scope) => capturePlanningSnapshot(i, scope))).value; break; }
    case "recordOutcome": { const i = historyInputSchemas.recordOutcome.parse(input); value = (await historyCommand(name, i, context, (scope) => recordOutcome(i, scope))).value; break; }
    case "requestForecast": value = await requestForecast(historyInputSchemas.requestForecast.parse(input), context); break;
    case "getHistoryImport": { const i = historyInputSchemas.getHistoryImport.parse(input); value = await historyRead(context, async (scope) => importDto(await importFor(scope, i.importId))); break; }
    case "getForecast": { const i = historyInputSchemas.getForecast.parse(input); value = await historyRead(context, (scope) => readForecast(scope, { _id: i.forecastId })); break; }
    case "getForecastByKey": { const i = historyInputSchemas.getForecastByKey.parse(input); value = await historyRead(context, (scope) => readForecast(scope, { requestKey: i.requestKey })); break; }
    case "listHistory": {
      const i = historyInputSchemas.listHistory.parse(input);
      if (i.fromDate && i.toDate && i.fromDate > i.toDate) throw new AppError("VALIDATION_FAILED", "History date interval is reversed.", 422);
      value = await historyRead(context, async (scope) => {
        const dates = { ...(i.fromDate ? { $gte: i.fromDate } : {}), ...(i.toDate ? { $lte: i.toDate } : {}) };
        const filter = { sellerId: scope.seller._id, active: true, ...(Object.keys(dates).length ? { "row.serviceDate": dates } : {}), ...(i.evidenceMode ? { "row.evidenceMode": i.evidenceMode } : {}), ...(i.cursor ? { _id: { $gt: cursorId(i.cursor) } } : {}) };
        const rows = await scope.db.collection<AcceptedHistory>("historyRows").find(filter, { session: scope.session }).sort({ _id: 1 }).limit(i.limit + 1).toArray();
        return page(rows, i.limit, scope);
      }); break;
    }
    case "listForecasts": {
      const i = historyInputSchemas.listForecasts.parse(input);
      value = await historyRead(context, async (scope) => { const rows = await scope.db.collection<ForecastRun>("forecastRuns").find({ sellerId: scope.seller._id, serviceDate: i.serviceDate, ...(i.snapshotId ? { snapshotId: i.snapshotId } : {}), ...(i.cursor ? { _id: { $gt: cursorId(i.cursor) } } : {}) }, { session: scope.session }).sort({ _id: 1 }).limit(i.limit + 1).toArray(); return page(rows.map((run) => effectiveForecast(run, scope)), i.limit, scope); }); break;
    }
    default: throw new AppError("NOT_FOUND", "Unknown forecasting operation.", 404);
  }
  return historyOutputSchemas[name].parse(value) as z.infer<(typeof historyOutputSchemas)[K]>;
}
function cursorId(cursor: string) {
  const value = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value) || Buffer.from(value).toString("base64url") !== cursor) throw new AppError("VALIDATION_FAILED", "Invalid history cursor.", 422);
  return value;
}
function page<T extends { _id: string }>(rows: T[], limit: number, scope: HistoryScope) { const items = rows.slice(0, limit); return { items, nextCursor: rows.length > limit ? Buffer.from(items[items.length - 1]._id).toString("base64url") : null, historyVersion: scope.history.version }; }
