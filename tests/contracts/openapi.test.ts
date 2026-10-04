import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backendInputSchemas as operationSchemas } from "@/lib/contracts/backend";
import { routeRegistry } from "@/lib/client/endpoints";

describe("generated API contract", () => {
  it("covers every operation with an actual route file and the declared method", () => {
    expect([...routeRegistry.map((route) => route.operation)].sort()).toEqual(Object.keys(operationSchemas).sort());
    for (const route of routeRegistry) {
      const file = `app${route.path.replace(/\{([^}]+)\}/g, "[$1]")}/route.ts`;
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain(`export const ${route.method}`);
    }
  });
  it("matches runtime schemas and resolves every local reference", () => {
    execFileSync(process.execPath, ["--import", "tsx", "scripts/api-spec.ts", "--check"], { stdio: "pipe" });
    const spec = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
    expect(spec.openapi).toBe("3.1.0");
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) {
          const resolved = child.slice(2).split("/").reduce((node, segment) => node?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")], spec);
          expect(resolved, child).toBeDefined();
        } else visit(child);
      }
    }
    visit(spec);
  });
});
