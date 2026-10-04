import { routeHandler } from "@/lib/server/http";
export const runtime = "nodejs";
export const GET = routeHandler("listProposals");
export const POST = routeHandler("createProposal");
