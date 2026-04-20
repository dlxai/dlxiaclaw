import { Hono } from "hono";
import { stream } from "hono/streaming";
import { sql } from "../db/client.js";
import { isFreeModel } from "../config/free-models.js";
import { getActiveSubscription } from "../db/quota.js";
export const proxyRoute = new Hono();
/** Deduct tokens from daily_quota. Returns false if over limit. */
async function deductDailyTokens(userId, tokens, dailyLimit) {
    const today = new Date().toISOString().slice(0, 10);
    return sql.begin(async (tx) => {
        await tx `
      INSERT INTO daily_quota (user_id, date, tokens_used)
      VALUES (${userId}, ${today}::date, 0)
      ON CONFLICT (user_id) DO UPDATE
        SET tokens_used = CASE
              WHEN daily_quota.date < ${today}::date THEN 0
              ELSE daily_quota.tokens_used
            END,
            date = ${today}::date
    `;
        const [updated] = await tx `
      UPDATE daily_quota
      SET tokens_used = tokens_used + ${tokens}
      WHERE user_id = ${userId}
        AND tokens_used + ${tokens} <= ${dailyLimit}
      RETURNING tokens_used
    `;
        return !!updated;
    });
}
/** Record actual consumption in the ledger and balance. */
async function recordActualUsage(userId, model, promptTokens, completionTokens) {
    const tokens = promptTokens + completionTokens;
    if (tokens <= 0)
        return;
    await sql `
    INSERT INTO credit_ledger (user_id, delta, reason, model, tokens)
    VALUES (${userId}, ${-tokens}, 'consumption', ${model}, ${tokens})
  `;
}
proxyRoute.post("/openrouter/chat/completions", async (c) => {
    const userId = c.get("userId");
    const masterKey = process.env.OPENROUTER_MASTER_KEY;
    if (!masterKey)
        return c.json({ error: "Proxy not configured" }, 503);
    let payload;
    try {
        payload = await c.req.json();
    }
    catch {
        return c.json({ error: "Invalid JSON body" }, 400);
    }
    // 1. Check model access
    const sub = await getActiveSubscription(userId);
    if (!sub && !isFreeModel(payload.model)) {
        return c.json({ error: "Model not available on free plan. Upgrade to access premium models." }, 403);
    }
    // 2. Pre-flight quota check (daily limit for free users)
    const dailyLimit = parseInt(process.env.DAILY_FREE_TOKENS ?? "100000", 10);
    if (!sub) {
        const today = new Date().toISOString().slice(0, 10);
        const [quotaRow] = await sql `
      SELECT date::text, tokens_used FROM daily_quota WHERE user_id = ${userId}
    `;
        const dailyUsed = quotaRow?.date === today ? (quotaRow?.tokens_used ?? 0) : 0;
        if (dailyUsed >= dailyLimit) {
            return c.json({ error: "Daily quota exceeded. Resets at midnight.", used: dailyUsed, limit: dailyLimit }, 402);
        }
    }
    // 3. Ensure OpenRouter returns usage stats in streaming responses
    const forwardPayload = { ...payload };
    if (forwardPayload.stream === true) {
        forwardPayload.stream_options = { ...forwardPayload.stream_options, include_usage: true };
    }
    // 4. Forward to OpenRouter
    const upstreamRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${masterKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://dlxai.app",
            "X-Title": "DlxAI",
        },
        body: JSON.stringify(forwardPayload),
    });
    // Non-OK response: return JSON error immediately
    if (!upstreamRes.ok) {
        const errorBody = await upstreamRes.text();
        return new Response(errorBody, {
            status: upstreamRes.status,
            headers: { "Content-Type": upstreamRes.headers.get("Content-Type") ?? "application/json" },
        });
    }
    const isStreaming = payload.stream === true;
    if (isStreaming && upstreamRes.body) {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        return stream(c, async (s) => {
            const reader = upstreamRes.body.getReader();
            const decoder = new TextDecoder();
            let usagePromptTokens = 0;
            let usageCompletionTokens = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    const chunk = decoder.decode(value, { stream: true });
                    for (const line of chunk.split("\n")) {
                        if (!line.startsWith("data: "))
                            continue;
                        const data = line.slice(6).trim();
                        if (data === "[DONE]")
                            continue;
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.usage) {
                                usagePromptTokens = parsed.usage.prompt_tokens ?? 0;
                                usageCompletionTokens = parsed.usage.completion_tokens ?? 0;
                            }
                        }
                        catch {
                            // Not valid JSON — skip
                        }
                    }
                    try {
                        await s.write(value);
                    }
                    catch {
                        break; // Client disconnected
                    }
                }
            }
            finally {
                reader.releaseLock();
                const totalTokens = usagePromptTokens + usageCompletionTokens;
                if (totalTokens > 0) {
                    if (!sub) {
                        await deductDailyTokens(userId, totalTokens, dailyLimit).catch(() => { });
                    }
                    await recordActualUsage(userId, payload.model, usagePromptTokens, usageCompletionTokens).catch(() => { });
                }
            }
        });
    }
    // Non-streaming: parse usage from response body
    const responseBody = await upstreamRes.text();
    try {
        const parsed = JSON.parse(responseBody);
        const promptTokens = parsed.usage?.prompt_tokens ?? 0;
        const completionTokens = parsed.usage?.completion_tokens ?? 0;
        const totalTokens = promptTokens + completionTokens;
        if (totalTokens > 0) {
            if (!sub) {
                await deductDailyTokens(userId, totalTokens, dailyLimit).catch(() => { });
            }
            await recordActualUsage(userId, payload.model, promptTokens, completionTokens).catch(() => { });
        }
    }
    catch {
        // Response not JSON — skip usage tracking
    }
    return new Response(responseBody, {
        status: upstreamRes.status,
        headers: { "Content-Type": upstreamRes.headers.get("Content-Type") ?? "application/json" },
    });
});
//# sourceMappingURL=proxy.js.map