import { routeHandler } from "@/lib/server/http";
export const runtime = "nodejs";
export const GET = routeHandler("listInvoices");
export const POST = routeHandler("createInvoice");
