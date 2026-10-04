import { routeHandler } from "@/lib/server/http";
export const runtime = "nodejs";
export const GET = routeHandler("getProposal");
export const PATCH = routeHandler("editProposal");
