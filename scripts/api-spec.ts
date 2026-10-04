import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { backendInputSchemas as operationSchemas, backendOutputSchemas as outputSchemas } from "../lib/contracts/backend";
import { errorSchema, resultMetaSchema, resultSchema } from "../lib/contracts/common";
import { routeRegistry } from "../lib/client/endpoints";

type JsonObject = Record<string, unknown>;
function relocate(value: unknown, name: string): unknown {
  if (Array.isArray(value)) return value.map((item) => relocate(item, name));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    key === "$ref" && typeof child === "string" && child.startsWith("#/")
      ? `#/components/schemas/${name}/${child.slice(2)}` : relocate(child, name),
  ]));
}
async function main() {
  const components: Record<string, JsonObject> = {};
  const paths: Record<string, JsonObject> = {};
  function schema(name: string, value: z.ZodType): JsonObject {
    const generated = z.toJSONSchema(value, { target: "draft-2020-12", io: "input" });
    delete generated.$schema;
    const rewritten = relocate(generated, name);
    if (!rewritten || typeof rewritten !== "object" || Array.isArray(rewritten)) throw new Error("Invalid schema");
    components[name] = rewritten as JsonObject;
    return components[name];
  }
  schema("Failure", z.strictObject({ ok: z.literal(false), error: errorSchema, meta: resultMetaSchema.pick({ requestId: true }) }));
  const security = [{ sessionCookie: [] }, { secureSessionCookie: [] }];
  for (const route of routeRegistry) {
    const inputName = `${route.operation}Input`;
    const input = schema(inputName, operationSchemas[route.operation]);
    const outputName = `${route.operation}Result`;
    schema(outputName, resultSchema(outputSchemas[route.operation]));
    const properties = input.properties as Record<string, JsonObject>;
    const required = (input.required ?? []) as string[];
    const pathKeys = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const parameters: JsonObject[] = pathKeys.map((name) => ({ name, in: "path", required: true, schema: properties[name] }));
    if (route.mutation) parameters.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" } });
    if (route.method !== "GET") parameters.push({ name: "Origin", in: "header", required: true, schema: { type: "string", format: "uri" }, description: "Must exactly match APP_ORIGIN." });
    const payloadProperties = Object.fromEntries(Object.entries(properties).filter(([name]) => !pathKeys.includes(name) && name !== "meta"));
    const body = { ...input, properties: payloadProperties, required: required.filter((name) => name !== "meta" && !pathKeys.includes(name)) };
    const responses: JsonObject = {
      "200": route.operation === "exportSheet"
        ? { description: "Immutable packing sheet CSV", content: { "text/csv": { schema: { type: "string" } } } }
        : route.operation === "privacyExport" ? { description: "Private business export attachment", content: { "application/json": { schema: { type: "object" } } } }
        : { description: "Operation completed or idempotently replayed", content: { "application/json": { schema: { $ref: `#/components/schemas/${outputName}` } } } },
    };
    for (const status of [400, 401, 403, 404, 405, 409, 413, 415, 422, 429, 500, 502, 503, 504]) responses[String(status)] = {
      description: `Safe error response (${status})`, content: { "application/json": { schema: { $ref: "#/components/schemas/Failure" } } },
      ...(status === 429 ? { headers: { "Retry-After": { schema: { type: "integer", minimum: 1 } } } } : {}),
    };
    if (route.method === "GET") for (const [name, property] of Object.entries(payloadProperties)) parameters.push({ name, in: "query", required: required.includes(name), schema: property });
    if (route.operation === "stageHistory") for (const name of ["X-Evidence-Mode", "X-Expected-State-Revision", "X-Expected-History-Version"]) parameters.push({ name, in: "header", required: false, schema: name === "X-Evidence-Mode" ? { type: "string", enum: ["real", "synthetic_demo"] } : { type: "integer", minimum: 0 }, description: "Required only for text/csv imports." });
    paths[route.path] ??= {};
    paths[route.path][route.method.toLowerCase()] = {
      operationId: route.operation, security, parameters,
      ...(route.method === "GET" ? {} : { requestBody: { required: true, content: { "application/json": { schema: body }, ...(route.operation === "stageHistory" ? { "text/csv": { schema: { type: "string" } } } : {}) } } }),
      responses,
      description: "Private/no-store. Runtime validation enforces dates, revisions, ownership, review and provenance. Run reservation is not provider completion. See backend setup and Phase 2 notes.",
    };
  }
  for (const kind of ["live", "ready"]) paths[`/api/health/${kind}`] = { get: {
    operationId: `health_${kind}`, security: [], responses: Object.fromEntries((kind === "ready" ? [200, 503] : [200]).map((status) => [String(status), { description: "Generic health state", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } } }])),
  } };
  const document = {
    openapi: "3.1.0", info: { title: "TiffinTally Backend API", version: "2.0.0", description: "Generated from runtime Zod contracts. Reviewed orders, Backboard analysis drafts, separate forecasts and bounded privacy operations. Better Auth owns /api/auth/* with its own protocol. No product UI." },
    servers: [{ url: "/" }], paths,
    components: { schemas: components, securitySchemes: {
      sessionCookie: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
      secureSessionCookie: { type: "apiKey", in: "cookie", name: "__Secure-better-auth.session_token" },
    } },
  };
  const target = "docs/openapi.json";
  if (process.argv.includes("--check")) {
    if (!isDeepStrictEqual(document, JSON.parse(await readFile(target, "utf8")))) throw new Error("API spec drift: run pnpm api:spec");
    console.log("OpenAPI matches runtime contracts.");
  } else {
    await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
    console.log(`Generated ${target}: ${routeRegistry.length} business operations.`);
  }
}
void main().catch((error) => { console.error(error instanceof Error ? error.message : "API spec generation failed"); process.exitCode = 1; });
