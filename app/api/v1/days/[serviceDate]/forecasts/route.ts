import { routeHandler } from "@/lib/server/http";
export const runtime = "nodejs";
export const GET = routeHandler("listForecasts");
export const POST = routeHandler("requestForecast");
