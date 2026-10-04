import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppOrigin, getAuthConfig, getDatabaseConfig, validateCoreConfig } from "@/lib/server/env";

afterEach(() => vi.unstubAllEnvs());
const valid = () => {
  vi.stubEnv("MONGODB_URI", "mongodb://localhost:27017");
  vi.stubEnv("MONGODB_DB", "test_tiffin");
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-test-secret-with-at-least-32-characters");
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("APP_ENV", "test");
};
describe("lazy environment configuration", () => {
  it("accepts a complete isolated configuration without connecting", () => {
    valid(); expect(() => validateCoreConfig()).not.toThrow();
    expect(getDatabaseConfig().dbName).toBe("test_tiffin");
    expect(getAuthConfig().production).toBe(false);
  });
  it.each(["", "not-a-url", "https://example.invalid/path", "https://user:password@example.invalid"])("fails closed for an invalid origin without leaking it (%#)", (value) => {
    valid(); vi.stubEnv("APP_ORIGIN", value); vi.stubEnv("BETTER_AUTH_URL", value);
    for (const parse of [getAppOrigin, getAuthConfig]) {
      try { parse(); throw new Error("Expected rejection"); }
      catch (error) { expect(error).toMatchObject({ code: "CONFIGURATION_UNAVAILABLE", status: 503, message: "Service is not configured." }); }
    }
  });
  it("requires matching origins and HTTPS in production", () => {
    valid(); vi.stubEnv("BETTER_AUTH_URL", "http://different.invalid");
    expect(getAuthConfig).toThrow("Service is not configured");
    valid(); vi.stubEnv("APP_ENV", "production");
    expect(getAuthConfig).toThrow("Service is not configured");
  });
});
