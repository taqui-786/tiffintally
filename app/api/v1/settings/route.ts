import { routeHandler } from "@/lib/server/http";
export const runtime = "nodejs";
export const GET = routeHandler("getSettings");
export const PATCH = routeHandler("updateSettings");
