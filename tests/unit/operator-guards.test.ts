import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("refuses unconfirmed live/operator commands before any provider or database dispatch", () => {
  const env = { ...process.env, BACKBOARD_API_KEY: "", GEMMA_PROVIDER: "", GEMMA_MODEL: "", JEV_MODEL: "", SENTRY_DSN: "", MONGODB_URI: "mongodb://127.0.0.1:9/", MONGODB_DB: "test_guard_only", APP_ENV: "test" };
  const cases = [
    { script: "ai-live", args: [], code: "USAGE" },
    { script: "ai-live", args: ["--allow-provider-spend"], code: "AI_NOT_CONFIGURED" },
    { script: "phase2-ops", args: [], code: "USAGE" },
    { script: "phase2-ops", args: ["retention", "--database", "wrong_database", "--seller-id", "seller-a", "--user-id", "user-a", "--before", "2026-01-01T00:00:00Z", "--dry-run"], code: "DATABASE_CONFIRMATION_REQUIRED" },
  ];
  for (const item of cases) {
    const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", `scripts/${item.script}.ts`, ...item.args], { env, encoding: "utf8", timeout: 10000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(item.code);
    expect(result.stdout).not.toContain("verified");
  }
}, 30000);
