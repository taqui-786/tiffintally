import { routeHandler } from "@/lib/server/http";
export const runtime = "nodejs";
export const GET = routeHandler("listSources");
export const POST = routeHandler("importSources");
