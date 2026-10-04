import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/server/auth";
import { errorResponse, privateHeaders } from "@/lib/server/http";

export const runtime = "nodejs";

async function handle(request: Request): Promise<Response> {
  try {
    const handlers = toNextJsHandler(await getAuth());
    const response = await handlers[request.method === "GET" ? "GET" : "POST"](request);
    for (const [key, value] of Object.entries(privateHeaders)) response.headers.set(key, value);
    return response;
  } catch (error) {
    return errorResponse(error, crypto.randomUUID());
  }
}

export const GET = handle;
export const POST = handle;
