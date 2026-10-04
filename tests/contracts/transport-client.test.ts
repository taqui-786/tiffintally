import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@/app/actions/customers", () => ({ createCustomerAction: vi.fn(), updateCustomerAction: vi.fn(), updateSettingsAction: vi.fn() }));
vi.mock("@/app/actions/orders", () => ({ approveProposalAction: vi.fn(), correctSourceAction: vi.fn(), createProposalAction: vi.fn(), editProposalAction: vi.fn(), importSourcesAction: vi.fn(), previewProposalAction: vi.fn(), setProposalDispositionAction: vi.fn(), setSourceDispositionAction: vi.fn() }));
vi.mock("@/app/actions/sheets", () => ({ finalizeSheetAction: vi.fn() }));

import { operationSchemas, outputSchemas } from "@/lib/contracts/api";
import type { Result } from "@/lib/contracts/common";
import type { CommandOutput } from "@/lib/contracts/api";
import { ClientError, retryRead, unwrapResult } from "@/lib/client/api";
import { customersQueryOptions } from "@/lib/client/queries";
import { actionMutationOptions, newCommandMeta } from "@/lib/client/mutations";
import { routeRegistry } from "@/lib/client/endpoints";
import { backendInputSchemas } from "@/lib/contracts/backend";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const output = outputSchemas.createCustomer.parse({
  receipt: {
    _id: "receipt-a", sellerId: "seller-a", schemaVersion: 1, createdAt: "2026-10-03T00:00:00Z", committedAt: "2026-10-03T00:00:00Z",
    operation: "createCustomer", idempotencyKey: "logical-key-a", payloadHash: "a".repeat(64), actorUserId: "owner-a",
    priorStateRevision: 0, stateRevision: 1, resourceIds: ["customer-a"], affectedDates: [], warnings: [], before: {}, after: {},
  }, stateRevision: 1, resourceIds: ["customer-a"], affectedDates: [], warnings: [],
});

describe("headless query transport", () => {
  it("uses normalized GET options, private fetch settings and a cancellation signal", async () => {
    const client = new QueryClient();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { items: [], nextCursor: null }, meta: { requestId: "read-a" } }));
    vi.stubGlobal("fetch", fetchMock);
    const options = customersQueryOptions("seller-a", { status: "active" });
    expect(options.queryKey).toEqual(["tiffin", "seller-a", "listCustomers", { status: "active", limit: 25 }]);
    await expect(client.fetchQuery(options)).resolves.toEqual({ items: [], nextCursor: null });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/customers?limit=25&status=active", expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin", signal: expect.any(AbortSignal) }));
    client.clear();
  });

  it("propagates QueryClient cancellation to fetch", async () => {
    const client = new QueryClient();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const options = customersQueryOptions("seller-a");
    const pending = client.fetchQuery(options).catch((error: unknown) => error);
    await client.cancelQueries({ queryKey: options.queryKey });
    expect(signal?.aborted).toBe(true);
    await pending;
    client.clear();
  });

  it("rejects malformed output and avoids retrying auth/validation failures", () => {
    expect(() => unwrapResult("listCustomers", { ok: true, data: { secret: "bad-shape" }, meta: { requestId: "x" } })).toThrow(ClientError);
    for (const status of [401, 403, 404, 422]) expect(retryRead(0, new ClientError("DENIED", "Denied", true, status))).toBe(false);
    expect(retryRead(0, new ClientError("DEPENDENCY_UNAVAILABLE", "Unavailable", true, 503))).toBe(true);
    expect(retryRead(1, new TypeError("Network"))).toBe(false);
  });

  it("only assigns GET endpoints to read operations; preview stays explicit POST", () => {
    expect(routeRegistry.find((route) => route.operation === "previewProposal")).toMatchObject({ method: "POST", mutation: false });
    expect(routeRegistry.find((route) => route.operation === "previewInvoice")).toMatchObject({ method: "POST", mutation: false });
    expect(new Set(routeRegistry.map((route) => route.operation)).size).toBe(Object.keys(backendInputSchemas).length);
  });
});

describe("headless command transport", () => {
  it("unwraps failures without automatic retries and retains the logical key for explicit retry", async () => {
    const client = new QueryClient();
    const action = vi.fn<(input: ReturnType<typeof operationSchemas.createCustomer.parse>) => Promise<Result<CommandOutput>>>()
      .mockResolvedValueOnce({ ok: false, error: { code: "COMMIT_UNCERTAIN", message: "Look up the receipt.", retryable: false }, meta: { requestId: "command-a" } })
      .mockResolvedValueOnce({ ok: true, data: output, meta: { requestId: "command-b" } });
    const options = actionMutationOptions(client, "seller-a", "createCustomer", action);
    expect(options.retry).toBe(false);
    const variables = operationSchemas.createCustomer.parse({ alias: "A", expectedStateRevision: 0, meta: newCommandMeta() });
    const first = client.getMutationCache().build(client, options);
    await expect(first.execute(variables)).rejects.toMatchObject({ code: "COMMIT_UNCERTAIN" });
    expect(action).toHaveBeenCalledTimes(1);
    const second = client.getMutationCache().build(client, options);
    await expect(second.execute(variables)).resolves.toEqual(output);
    expect(action.mock.calls[0]).toHaveLength(1);
    expect(action.mock.calls[0][0]).toEqual(action.mock.calls[1][0]);
    expect(action.mock.calls[0][0].meta.idempotencyKey).toBe(variables.meta.idempotencyKey);
    client.clear();
  });

  it("awaits broad seller-scoped invalidation before mutation settles", async () => {
    const client = new QueryClient();
    client.setQueryData(["tiffin", "seller-a", "day"], { total: 6 });
    client.setQueryData(["tiffin", "seller-b", "day"], { total: 4 });
    const action = vi.fn(async (): Promise<Result<CommandOutput>> => ({ ok: true, data: output, meta: { requestId: "command" } }));
    const options = actionMutationOptions(client, "seller-a", "createCustomer", action);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await client.getMutationCache().build(client, options).execute(operationSchemas.createCustomer.parse({ alias: "A", expectedStateRevision: 0, meta: newCommandMeta() }));
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ["tiffin", "seller-a"] });
    expect(client.getQueryState(["tiffin", "seller-a", "day"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["tiffin", "seller-b", "day"])?.isInvalidated).toBe(false);
    client.clear();
  });

  it("rejects extra variables instead of forwarding framework objects to actions", async () => {
    const client = new QueryClient();
    const action = vi.fn();
    const options = actionMutationOptions(client, "seller-a", "createCustomer", action);
    const variables = { alias: "A", packingNote: "", expectedStateRevision: 0, meta: newCommandMeta(), context: () => "not serializable" };
    await expect(client.getMutationCache().build(client, options).execute(variables)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
    client.clear();
  });
});
