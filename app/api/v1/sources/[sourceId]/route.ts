import { routeHandler } from "@/lib/server/http";
export const runtime = "nodejs";
export const GET = routeHandler("getSource");
export const PATCH = routeHandler("correctSource");
