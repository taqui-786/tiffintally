import { readFile } from "node:fs/promises";
import { outputSchemas, type OperationName } from "../lib/contracts/api";
import { resultSchema } from "../lib/contracts/common";
import { addDays, isServiceDate, localDateAt } from "../lib/domain/dates";
import { endpointFor } from "../lib/client/endpoints";

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const origin = new URL(option("--base-url") ?? (process.env.APP_ORIGIN || "http://localhost:3000")).origin;
  const live = await fetch(`${origin}/api/health/live`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (live.status !== 200 || !(await live.json()).ok) throw new Error("Liveness failed");
  const ready = await fetch(`${origin}/api/health/ready`, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  console.log(`Liveness passed; readiness HTTP ${ready.status}.`);
  const cookieFile = option("--cookie-file");
  if (!cookieFile) {
    const me = await fetch(`${origin}/api/v1/me`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (![401, 503].includes(me.status)) throw new Error("Anonymous access did not fail closed");
    console.log(`Anonymous access correctly rejected (${me.status}). Authenticated flow not run: supply --cookie-file privately after sign-in.`);
    return;
  }
  const cookie = (await readFile(cookieFile, "utf8")).trim();
  if (!cookie || cookie.includes("\n") || cookie.length > 16_384) throw new Error("Cookie file must contain a single bounded Cookie header value");
  async function request<K extends OperationName>(operation: K, data: Record<string, unknown> = {}) {
    const endpoint = endpointFor(operation);
    const payload = { ...data };
    const path = endpoint.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
      const value = payload[key]; delete payload[key];
      if (typeof value !== "string") throw new Error(`Missing path parameter: ${key}`);
      return encodeURIComponent(value);
    });
    const headers = new Headers({ Cookie: cookie, Origin: origin });
    if (endpoint.mutation) {
      const meta = payload.meta;
      if (!meta || typeof meta !== "object" || !("idempotencyKey" in meta) || typeof meta.idempotencyKey !== "string") throw new Error("Missing command key");
      headers.set("Idempotency-Key", meta.idempotencyKey); delete payload.meta;
    }
    const url = new URL(path, origin);
    if (endpoint.method === "GET") for (const [key, value] of Object.entries(payload)) url.searchParams.set(key, String(value));
    else headers.set("Content-Type", "application/json");
    const response = await fetch(url, { method: endpoint.method, headers, redirect: "error", signal: AbortSignal.timeout(30_000), ...(endpoint.method === "GET" ? {} : { body: JSON.stringify(payload) }) });
    const result = resultSchema(outputSchemas[operation]).parse(await response.json());
    if (!result.ok) throw new Error(`${operation}: ${result.error.code}`);
    return result.data;
  }
  // Parse at the call site to retain concrete schema types across the script's generic helper.
  const me = outputSchemas.me.parse(await request("me"));
  console.log("Authenticated owner read passed.");
  if (!args.includes("--write-demo")) return;
  if (process.env.APP_ENV !== "development" || !process.env.MONGODB_DB?.startsWith("demo_") || origin !== process.env.APP_ORIGIN) throw new Error("Writes require matching APP_ORIGIN, development mode and a demo_ database");
  const meta = async () => ({ expectedStateRevision: outputSchemas.me.parse(await request("me")).stateRevision, meta: { idempotencyKey: crypto.randomUUID() } });
  const created = outputSchemas.createCustomer.parse(await request("createCustomer", { ...await meta(), alias: `Synthetic smoke ${Date.now()}` }));
  let serviceDate = addDays(localDateAt(new Date().toISOString(), me.seller.settings.timezone), 1);
  while (!isServiceDate(serviceDate, me.seller.settings.weekdays)) serviceDate = addDays(serviceDate, 1);
  const source = outputSchemas.importSources.parse(await request("importSources", { ...await meta(), sources: [{ text: "One lunch on the confirmed service date", customerId: created.resourceIds[0], sentAt: new Date().toISOString() }] }));
  const draft = outputSchemas.createProposal.parse(await request("createProposal", {
    ...await meta(), sourceId: source.resourceIds[0], expectedSourceRevision: 0, manualReason: null,
    operations: [{ type: "set_daily_quantity", customerId: created.resourceIds[0], serviceDate, quantity: 1 }], missingFields: [], evidenceSpans: [{ start: 0, end: 9 }],
  }));
  const proposalId = draft.resourceIds[0];
  const preview = outputSchemas.previewProposal.parse(await request("previewProposal", { proposalId, expectedDraftRevision: 0 }));
  const command = { ...await meta(), proposalId, expectedDraftRevision: 0, expectedSourceRevision: 0, previewHash: preview.previewHash, supersedesApprovalIds: [], acknowledgeLateChange: true };
  const approved = outputSchemas.approveProposal.parse(await request("approveProposal", command));
  const replay = outputSchemas.approveProposal.parse(await request("approveProposal", command));
  if (approved.receipt._id !== replay.receipt._id) throw new Error("Idempotency check failed");
  const day = outputSchemas.getDay.parse(await request("getDay", { serviceDate }));
  if (!day.rows.some((row) => row.customerId === created.resourceIds[0] && row.quantity === 1)) throw new Error("Approved meal not visible");
  const finalized = outputSchemas.finalizeSheet.parse(await request("finalizeSheet", { ...await meta(), serviceDate, expectedPriorSheetId: day.latestSheetId, acknowledgeLateChange: true }));
  const sheet = outputSchemas.getSheet.parse(await request("getSheet", { sheetId: finalized.resourceIds[0] }));
  if (sheet.total !== day.total) throw new Error("Sheet total mismatch");
  console.log("API write-demo passed: source → review → approval → same-key retry → exact day → immutable sheet. Fictional records were retained.");
}
void main().catch(() => { console.error("Backend smoke failed. Check server/session/configuration; private cookie and response diagnostics are omitted."); process.exitCode = 1; });
