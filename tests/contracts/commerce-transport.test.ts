import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), context: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/server/phase2", () => ({ executeBackendOperation: mocks.execute }));
vi.mock("@/lib/server/context", () => ({ requireSellerContext: mocks.context }));
vi.mock("@/lib/server/rate-limit", async () => {
  const { AppError } = await import("@/lib/contracts/common");
  return { enforceRateLimit: mocks.limit, RateLimitError: class extends AppError {} };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://example.test" }) }));
import { AppError } from "@/lib/contracts/common";
import { commerceInputSchemas } from "@/lib/contracts/commerce";
import { endpointFor } from "@/lib/client/endpoints";
import { routeHandler } from "@/lib/server/http";
import { createInvoiceAction, previewInvoiceAction, saveCommerceCustomerAction, saveCommerceSettingsAction } from "@/app/actions/commerce";

const command = { meta: { idempotencyKey: "fictional-command-0001" }, expectedStateRevision: 0 };
const inputs = {
  saveCommerceSettings: commerceInputSchemas.saveCommerceSettings.parse({ ...command, settings: { upiId: "fictional@upi", helperPhone: "" } }),
  saveCommerceCustomer: commerceInputSchemas.saveCommerceCustomer.parse({ ...command, customerId: "customer-a", expectedProfileRevision: null, profile: { unitPricePaise: 10000, phone: "", routeName: "Building A", routeOrder: 1, deliveryNote: "" } }),
  previewInvoice: commerceInputSchemas.previewInvoice.parse({ customerId: "customer-a", month: "2026-09" }),
  createInvoice: commerceInputSchemas.createInvoice.parse({ ...command, customerId: "customer-a", month: "2026-09", expectedBasisHash: "a".repeat(64), expectedPriorInvoiceId: null }),
};
const actions = {
  saveCommerceSettings: () => saveCommerceSettingsAction(inputs.saveCommerceSettings),
  saveCommerceCustomer: () => saveCommerceCustomerAction(inputs.saveCommerceCustomer),
  previewInvoice: () => previewInvoiceAction(inputs.previewInvoice),
  createInvoice: () => createInvoiceAction(inputs.createInvoice),
};
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("APP_ORIGIN", "https://example.test");
  mocks.context.mockResolvedValue({ sellerId: "seller-a", userId: "owner-a", requestId: "request-a" });
  mocks.execute.mockRejectedValue(new AppError("STALE_REVISION", "Refresh the state.", 409));
});
afterEach(() => vi.unstubAllEnvs());

describe("commerce action and HTTP boundaries", () => {
  for (const operation of Object.keys(actions) as (keyof typeof actions)[]) {
    it(`${operation} uses the same authenticated, rate-limited, validated arguments`, async () => {
      const action = await actions[operation]();
      const endpoint = endpointFor(operation);
      const body: Record<string, unknown> = { ...inputs[operation] };
      delete body.meta;
      const params: Record<string, string> = {};
      const path = endpoint.path.replace(/\{(\w+)\}/g, (_, key: string) => { params[key] = String(body[key]); delete body[key]; return params[key]; });
      const response = await routeHandler(operation)(new Request(`https://example.test${path}`, { method: endpoint.method, headers: { origin: "https://example.test", "content-type": "application/json", ...(endpoint.mutation ? { "Idempotency-Key": command.meta.idempotencyKey } : {}) }, body: JSON.stringify(body) }), { params: Promise.resolve(params) });
      const http = await response.json();
      expect(action).toMatchObject({ ok: false, error: http.error });
      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(mocks.context).toHaveBeenCalledTimes(2);
      expect(mocks.limit).toHaveBeenCalledTimes(2);
      expect(mocks.execute).toHaveBeenNthCalledWith(1, operation, inputs[operation], expect.objectContaining({ sellerId: "seller-a" }));
      expect(mocks.execute).toHaveBeenNthCalledWith(2, operation, inputs[operation], expect.objectContaining({ sellerId: "seller-a" }));
    });
  }
  it("requires authentication and trusted origins, without reaching business writes", async () => {
    mocks.context.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Sign in.", 401));
    expect(await createInvoiceAction(inputs.createInvoice)).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    const response = await routeHandler("saveCommerceSettings")(new Request("https://example.test/api/v1/commerce/settings", { method: "PATCH", headers: { origin: "https://foreign.test", "content-type": "application/json" }, body: JSON.stringify(inputs.saveCommerceSettings) }));
    expect(response.status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("does not trust a repeated path ID or a missing HTTP idempotency header", async () => {
    const duplicated = await routeHandler("saveCommerceCustomer")(new Request("https://example.test/api/v1/customers/customer-a/commerce", { method: "PATCH", headers: { origin: "https://example.test", "content-type": "application/json", "Idempotency-Key": command.meta.idempotencyKey }, body: JSON.stringify(inputs.saveCommerceCustomer) }), { params: Promise.resolve({ customerId: "customer-a" }) });
    expect(duplicated.status).toBe(422);
    const missing = await routeHandler("createInvoice")(new Request("https://example.test/api/v1/invoices", { method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: JSON.stringify(inputs.createInvoice) }));
    expect(missing.status).toBe(422);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
