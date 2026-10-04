import { routeHandler } from "@/lib/server/http";
export const runtime = "nodejs";
export const GET = routeHandler("getCustomer");
export const PATCH = routeHandler("updateCustomer");
