import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), findOne: vi.fn(), collection: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/server/auth", () => ({ getAuth: async () => ({ api: { getSession: mocks.session } }) }));
vi.mock("@/lib/server/db/client", () => ({ getDb: async () => ({ collection: mocks.collection }) }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));

import { requireSellerContext } from "@/lib/server/context";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.collection.mockReturnValue({ findOne: mocks.findOne });
  mocks.headers.mockResolvedValue(new Headers({ cookie: "synthetic-session" }));
});

it("rejects a missing or expired session before reading owner bindings", async () => {
  mocks.session.mockResolvedValue(null);
  await expect(requireSellerContext(new Headers())).rejects.toMatchObject({ status: 401 });
  expect(mocks.collection).not.toHaveBeenCalled();
});

it("rejects authenticated users without an active provisioned seller", async () => {
  mocks.session.mockResolvedValue({ user: { id: "user-a" } });
  mocks.findOne.mockResolvedValue(null);
  await expect(requireSellerContext()).rejects.toMatchObject({ status: 403 });
  expect(mocks.findOne).toHaveBeenCalledWith({ ownerUserId: "user-a", status: "active" }, { projection: { _id: 1, privacyDeleting: 1 } });
});

it("rechecks session and binding on each call and trusts only that binding", async () => {
  mocks.session.mockResolvedValue({ user: { id: "user-a" } });
  mocks.findOne.mockResolvedValueOnce({ _id: "seller-a" }).mockResolvedValueOnce(null);
  const suppliedHeaders = new Headers({ cookie: "synthetic-session", "x-seller-id": "seller-b" });
  expect(await requireSellerContext(suppliedHeaders, "request-a")).toEqual({ sellerId: "seller-a", userId: "user-a", requestId: "request-a" });
  await expect(requireSellerContext(suppliedHeaders, "request-b")).rejects.toMatchObject({ status: 403 });
  expect(mocks.session).toHaveBeenCalledTimes(2);
  expect(mocks.session).toHaveBeenCalledWith({ headers: suppliedHeaders });
});

it("blocks deleting sellers except owner progress and derives freshness from the session", async () => {
  const createdAt = new Date();
  mocks.session.mockResolvedValue({ user: { id: "user-a" }, session: { createdAt } });
  mocks.findOne.mockResolvedValue({ _id: "seller-a", privacyDeleting: true });
  await expect(requireSellerContext(new Headers(), "r")).rejects.toMatchObject({ code: "PRIVACY_DELETING" });
  expect(await requireSellerContext(new Headers(), "r", true)).toMatchObject({ sellerId: "seller-a", sessionCreatedAt: createdAt.toISOString() });
});
