import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), context: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/server/operations", () => ({ executeOperation: mocks.execute }));
vi.mock("@/lib/server/context", () => ({ requireSellerContext: mocks.context }));
vi.mock("@/lib/server/rate-limit", async () => {
  const { AppError } = await import("@/lib/contracts/common");
  return { enforceRateLimit: mocks.limit, RateLimitError: class extends AppError {} };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://example.test" }) }));

import { AppError } from "@/lib/contracts/common";
import { operationSchemas, outputSchemas } from "@/lib/contracts/api";
import { DEFAULT_SETTINGS } from "@/lib/contracts/records";
import { endpointFor } from "@/lib/client/endpoints";
import { routeHandler } from "@/lib/server/http";
import { createCustomerAction, updateCustomerAction, updateSettingsAction } from "@/app/actions/customers";
import { approveProposalAction, correctSourceAction, createProposalAction, editProposalAction, importSourcesAction, previewProposalAction, setProposalDispositionAction, setSourceDispositionAction } from "@/app/actions/orders";
import { finalizeSheetAction } from "@/app/actions/sheets";

const command = { meta: { idempotencyKey: "logical-key-0001" }, expectedStateRevision: 0 };
const inputs = {
  createCustomer: operationSchemas.createCustomer.parse({ ...command, alias: "A" }),
  updateCustomer: operationSchemas.updateCustomer.parse({ ...command, customerId: "customer-a", expectedCustomerRevision: 0, alias: "A2" }),
  updateSettings: operationSchemas.updateSettings.parse({ ...command, settings: DEFAULT_SETTINGS }),
  importSources: operationSchemas.importSources.parse({ ...command, sources: [{ text: "One lunch", sentAt: "2026-10-03T00:00:00Z", customerId: "customer-a" }] }),
  correctSource: operationSchemas.correctSource.parse({ ...command, sourceId: "source-a", expectedSourceRevision: 0, customerId: "customer-a", reason: "Confirmed sender" }),
  sourceDisposition: operationSchemas.sourceDisposition.parse({ ...command, sourceId: "source-a", expectedSourceRevision: 0, action: "dismiss", reason: "Information only" }),
  createProposal: operationSchemas.createProposal.parse({ ...command, sourceId: null, expectedSourceRevision: null, manualReason: "Owner request", operations: [], missingFields: [], evidenceSpans: [] }),
  editProposal: operationSchemas.editProposal.parse({ ...command, proposalId: "proposal-a", expectedSourceRevision: null, expectedDraftRevision: 0, operations: [], missingFields: [], evidenceSpans: [] }),
  previewProposal: operationSchemas.previewProposal.parse({ proposalId: "proposal-a", expectedDraftRevision: 0 }),
  approveProposal: operationSchemas.approveProposal.parse({ ...command, proposalId: "proposal-a", expectedSourceRevision: null, expectedDraftRevision: 0, previewHash: "a".repeat(64) }),
  proposalDisposition: operationSchemas.proposalDisposition.parse({ ...command, proposalId: "proposal-a", expectedSourceRevision: null, expectedDraftRevision: 0, action: "reject", reason: "Duplicate" }),
  finalizeSheet: operationSchemas.finalizeSheet.parse({ ...command, serviceDate: "2026-10-03", expectedPriorSheetId: null }),
};
type ActionOperation = keyof typeof inputs;
const actions: Record<ActionOperation, () => Promise<unknown>> = {
  createCustomer: () => createCustomerAction(inputs.createCustomer), updateCustomer: () => updateCustomerAction(inputs.updateCustomer), updateSettings: () => updateSettingsAction(inputs.updateSettings),
  importSources: () => importSourcesAction(inputs.importSources), correctSource: () => correctSourceAction(inputs.correctSource), sourceDisposition: () => setSourceDispositionAction(inputs.sourceDisposition),
  createProposal: () => createProposalAction(inputs.createProposal), editProposal: () => editProposalAction(inputs.editProposal), previewProposal: () => previewProposalAction(inputs.previewProposal),
  approveProposal: () => approveProposalAction(inputs.approveProposal), proposalDisposition: () => setProposalDispositionAction(inputs.proposalDisposition), finalizeSheet: () => finalizeSheetAction(inputs.finalizeSheet),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", "https://example.test");
  mocks.context.mockResolvedValue({ sellerId: "seller-a", userId: "owner-a", requestId: "request-a" });
  mocks.limit.mockResolvedValue(undefined);
});

function httpRequest(operation: ActionOperation) {
  const endpoint = endpointFor(operation);
  const body: Record<string, unknown> = { ...inputs[operation] };
  const params: Record<string, string> = {};
  const path = endpoint.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = String(body[key]);
    params[key] = value;
    delete body[key];
    return value;
  });
  delete body.meta;
  return {
    request: new Request(`https://example.test${path}`, { method: endpoint.method, headers: { origin: "https://example.test", "content-type": "application/json", ...(endpoint.mutation ? { "Idempotency-Key": command.meta.idempotencyKey } : {}) }, body: JSON.stringify(body) }),
    context: { params: Promise.resolve(params) },
  };
}

describe("all public action mappings", () => {
  for (const operation of Object.keys(actions) as ActionOperation[]) {
    it(`${operation} authenticates and reaches the same validated operation through HTTP and action`, async () => {
      mocks.execute.mockRejectedValue(new AppError("STALE_REVISION", "Refresh the state.", 409));
      const actionResult = await actions[operation]();
      const { request, context } = httpRequest(operation);
      const response = await routeHandler(operation)(request, context);
      const httpResult = await response.json();
      expect(actionResult).toMatchObject({ ok: false, error: httpResult.error });
      expect(response.status).toBe(409);
      expect(mocks.context).toHaveBeenCalledTimes(2);
      expect(mocks.limit).toHaveBeenCalledTimes(2);
      expect(mocks.execute).toHaveBeenNthCalledWith(1, operation, inputs[operation], expect.objectContaining({ sellerId: "seller-a" }));
      expect(mocks.execute).toHaveBeenNthCalledWith(2, operation, inputs[operation], expect.objectContaining({ sellerId: "seller-a" }));
    });
  }

  it("returns JSON-safe validated DTOs with equivalent HTTP/action envelopes", async () => {
    const output = outputSchemas.previewProposal.parse({ proposalId: "proposal-a", operations: [], affectedDates: [], effects: [], totals: [], sourceId: null, sourceRevision: null, missingFields: [], conflicts: [], requiredAcknowledgements: [], expectedDraftRevision: 0, expectedStateRevision: 0, continuesBeyondWindow: false, previewHash: "a".repeat(64) });
    mocks.execute.mockResolvedValue(output);
    const action = await previewProposalAction(inputs.previewProposal);
    const { request, context } = httpRequest("previewProposal");
    const http = await (await routeHandler("previewProposal")(request, context)).json();
    expect(action).toMatchObject({ ok: true, data: http.data });
    expect(JSON.parse(JSON.stringify(action))).toEqual(action);
  });

  it("rejects unauthenticated and cross-seller action attempts without leaking records", async () => {
    mocks.context.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Authentication required.", 401));
    expect(await updateCustomerAction(inputs.updateCustomer)).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(mocks.execute).not.toHaveBeenCalled();
    mocks.execute.mockRejectedValueOnce(new AppError("NOT_FOUND", "Not found.", 404));
    expect(await updateCustomerAction({ ...inputs.updateCustomer, customerId: "other-seller-customer" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(mocks.execute).toHaveBeenCalledWith("updateCustomer", expect.objectContaining({ customerId: "other-seller-customer" }), expect.objectContaining({ sellerId: "seller-a" }));
  });
});
