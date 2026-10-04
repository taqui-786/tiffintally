import { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/dev/auth-check/route";

const request = (url = "http://localhost:3000/api/dev/auth-check", host = "localhost:3000") => new Request(url, { headers: { Host: host } });
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
});
afterEach(() => vi.unstubAllEnvs());

describe("local development OAuth helper", () => {
  it("serves nonce-protected HTML without configuration/session values", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-do-not-render");
    const response = GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    const match = html.match(/<script nonce="([^"]+)">([\s\S]+?)<\/script>/);
    expect(match).not.toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(`script-src 'nonce-${match![1]}'`);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).not.toContain("synthetic-do-not-render");
    expect(html).not.toContain("document.cookie");
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("owner:provision");
    expect(html).toContain("disableRedirect: true");
    expect(html).toContain("owner access is not granted automatically");
    expect(() => new Script(match![2])).not.toThrow();
    expect((await GET(request()).text()).match(/nonce="([^"]+)"/)?.[1]).not.toBe(match![1]);
  });
  it.each(["production", "test"])("returns 404 outside the development runtime: %s", (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    expect(GET(request()).status).toBe(404);
  });
  it.each(["production", "test", ""])("returns 404 outside APP_ENV development: %s", (mode) => {
    vi.stubEnv("APP_ENV", mode);
    expect(GET(request()).status).toBe(404);
  });
  it.each(["", "malformed", "http://example.invalid", "https://localhost:3000", "http://user:secret@localhost:3000", "http://localhost:3000/path"])("rejects unsafe configured origins (%#)", (origin) => {
    vi.stubEnv("APP_ORIGIN", origin);
    expect(GET(request()).status).toBe(404);
  });
  it("rejects mismatched request origin and Host", () => {
    expect(GET(request("http://localhost:3001/api/dev/auth-check", "localhost:3001")).status).toBe(404);
    expect(GET(request(undefined, "evil.invalid")).status).toBe(404);
    expect(GET(new Request("http://localhost:3000/api/dev/auth-check")).status).toBe(404);
  });
  it.each(["127.0.0.1", "[::1]"])("supports explicit loopback origins: %s", (host) => {
    vi.stubEnv("APP_ORIGIN", `http://${host}:3000`);
    expect(GET(request(`http://${host}:3000/api/dev/auth-check`, `${host}:3000`)).status).toBe(200);
  });
});
