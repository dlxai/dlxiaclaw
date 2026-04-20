import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { proxyRoute } from "../routes/proxy.js";

vi.mock("../db/client.js", () => ({
  sql: Object.assign(vi.fn(), { begin: vi.fn() }),
}));
vi.mock("../db/quota.js", () => ({
  getActiveSubscription: vi.fn(),
}));

import { sql } from "../db/client.js";
import { getActiveSubscription } from "../db/quota.js";

const mockGetSub = getActiveSubscription as ReturnType<typeof vi.fn>;
const sqlMock = sql as unknown as ReturnType<typeof vi.fn> & { begin: ReturnType<typeof vi.fn> };

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const app = new Hono();
app.use("/api/proxy/*", authMiddleware);
app.route("/api/proxy", proxyRoute);

async function makeToken(userId = "user-uuid-123") {
  const { SignJWT } = await import("jose");
  const secret = new TextEncoder().encode("test-user-secret-32-chars-padded!!");
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
}

describe("POST /api/proxy/openrouter/chat/completions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENROUTER_MASTER_KEY = "sk-or-test-key";
  });

  it("returns 503 when OPENROUTER_MASTER_KEY is not set", async () => {
    delete process.env.OPENROUTER_MASTER_KEY;
    sqlMock.mockResolvedValueOnce([{ jwt_secret: "test-user-secret-32-chars-padded!!" }]);
    const token = await makeToken();
    const res = await app.request("/api/proxy/openrouter/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });
    expect(res.status).toBe(503);
  });

  it("returns 403 when free user requests non-free model", async () => {
    sqlMock.mockResolvedValueOnce([{ jwt_secret: "test-user-secret-32-chars-padded!!" }]);
    mockGetSub.mockResolvedValueOnce(null); // no subscription = free user
    const token = await makeToken();
    const res = await app.request("/api/proxy/openrouter/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(/free plan/i);
  });

  it("returns 402 when free user has already hit daily quota", async () => {
    sqlMock
      .mockResolvedValueOnce([{ jwt_secret: "test-user-secret-32-chars-padded!!" }]) // auth
      .mockResolvedValueOnce([{ date: new Date().toISOString().slice(0, 10), tokens_used: 100_001 }]); // daily_quota row
    mockGetSub.mockResolvedValueOnce(null);
    const token = await makeToken();
    const res = await app.request("/api/proxy/openrouter/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-flash-1.5", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error).toMatch(/quota/i);
  });

  it("proxies request for free user within quota and records usage after response", async () => {
    const today = new Date().toISOString().slice(0, 10);
    sqlMock
      .mockResolvedValueOnce([{ jwt_secret: "test-user-secret-32-chars-padded!!" }]) // auth
      .mockResolvedValueOnce([{ date: today, tokens_used: 500 }]); // daily_quota pre-flight check
    // begin() for deductDailyTokens post-response
    sqlMock.begin.mockResolvedValueOnce(true);
    // recordActualUsage INSERT
    sqlMock.mockResolvedValueOnce(undefined);
    mockGetSub.mockResolvedValueOnce(null);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "Hi" } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const token = await makeToken();
    const res = await app.request("/api/proxy/openrouter/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-flash-1.5", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("proxies request for subscribed user without daily quota check", async () => {
    sqlMock
      .mockResolvedValueOnce([{ jwt_secret: "test-user-secret-32-chars-padded!!" }]) // auth
      .mockResolvedValueOnce(undefined); // recordActualUsage INSERT
    const sub = { id: "sub-1", tier: "basic", tokens_monthly: 5_000_000, tokens_used: 0, period_end: "2026-05-01" };
    mockGetSub.mockResolvedValueOnce(sub);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 100 } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const token = await makeToken();
    const res = await app.request("/api/proxy/openrouter/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(res.status).toBe(200);
    // Subscribed users skip daily quota pre-flight — sql.begin should not be called for deduction
    expect(sqlMock.begin).not.toHaveBeenCalled();
  });
});
