import { Hono } from "hono";
import { stream } from "hono/streaming";
import { sql } from "../db/client.js";
import { isFreeModel } from "../config/free-models.js";
import { getActiveSubscription, deductMonthlyTokens, deductDailyTokens } from "../db/quota.js";
import { getVerifiedFreeModels, invalidateModelCache } from "../lib/model-verifier.js";

export const proxyRoute = new Hono<{ Variables: { userId: string } }>();

/** Record actual consumption in the ledger and balance. */
async function recordActualUsage(userId: string, model: string, promptTokens: number, completionTokens: number): Promise<void> {
  const tokens = promptTokens + completionTokens;
  if (tokens <= 0) return;
  await sql`
    INSERT INTO credit_ledger (user_id, delta, reason, model, tokens)
    VALUES (${userId}, ${-tokens}, 'consumption', ${model}, ${tokens})
  `;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Forward a request to OpenRouter, with automatic failover to the next verified
 * free model if the request is rate-limited (429) or the model is unavailable (503).
 *
 * Returns { res, model } — the successful response and the model that was used.
 * On exhaustion, returns the last failed response.
 */
async function forwardWithFailover(
  payload: Record<string, unknown>,
  masterKey: string,
  isFree: boolean,
): Promise<{ res: Response; model: string }> {
  const originalModel = payload.model as string;

  async function doFetch(model: string): Promise<Response> {
    return fetch(OPENROUTER_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${masterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://dlxai.app",
        "X-Title": "DlxAI",
      },
      body: JSON.stringify({ ...payload, model }),
    });
  }

  const firstRes = await doFetch(originalModel);

  // For subscribers or non-retriable statuses, return immediately
  const isRetriable = firstRes.status === 429 || firstRes.status === 503;
  if (firstRes.ok || !isRetriable || !isFree) {
    return { res: firstRes, model: originalModel };
  }

  // Rate-limited on a free model — try the other verified free models
  console.warn(`[proxy] Model ${originalModel} returned ${firstRes.status}, attempting failover`);
  // Invalidate cache so next getVerifiedFreeModels re-checks availability
  if (firstRes.status === 503) invalidateModelCache();

  const freeModels = await getVerifiedFreeModels();
  const tried = new Set([originalModel]);

  for (const candidate of freeModels) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);

    const res = await doFetch(candidate);
    if (res.ok) {
      console.info(`[proxy] Failover succeeded with model ${candidate}`);
      return { res, model: candidate };
    }
    if (res.status !== 429 && res.status !== 503) {
      // Hard error on this model — stop trying
      return { res, model: candidate };
    }
  }

  // All models exhausted — return the last response
  return { res: await doFetch(freeModels[0] ?? originalModel), model: freeModels[0] ?? originalModel };
}

proxyRoute.post("/openrouter/chat/completions", async (c) => {
  const userId = c.get("userId");
  const masterKey = process.env.OPENROUTER_MASTER_KEY;
  if (!masterKey) return c.json({ error: "Proxy not configured" }, 503);

  let payload: {
    model: string;
    messages: Array<{ role: string; content: unknown }>;
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
    [key: string]: unknown;
  };
  try {
    payload = await c.req.json();
  } catch {
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
    const [quotaRow] = await sql<{ date: string; tokens_used: number }[]>`
      SELECT date::text, tokens_used FROM daily_quota WHERE user_id = ${userId}
    `;
    const dailyUsed = quotaRow?.date === today ? (quotaRow?.tokens_used ?? 0) : 0;
    if (dailyUsed >= dailyLimit) {
      return c.json({ error: "Daily quota exceeded. Resets at midnight.", used: dailyUsed, limit: dailyLimit }, 402);
    }
  }

  // 3. Ensure OpenRouter returns usage stats in streaming responses
  const forwardPayload: typeof payload = { ...payload };
  if (forwardPayload.stream === true) {
    forwardPayload.stream_options = { ...forwardPayload.stream_options, include_usage: true };
  }

  // 4. Forward to OpenRouter (with free-model failover on rate limit)
  const isFree = !sub && isFreeModel(payload.model);
  const { res: upstreamRes, model: usedModel } = await forwardWithFailover(forwardPayload, masterKey, isFree);

  // Non-OK response after all failovers exhausted: return JSON error
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
      const reader = upstreamRes.body!.getReader();
      const decoder = new TextDecoder();
      let usagePromptTokens = 0;
      let usageCompletionTokens = 0;
      let sseBuffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          sseBuffer += chunk;

          // Only process complete lines (ending with \n)
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? "";  // Keep incomplete last line for next chunk

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.usage) {
                usagePromptTokens = parsed.usage.prompt_tokens ?? 0;
                usageCompletionTokens = parsed.usage.completion_tokens ?? 0;
              }
            } catch {
              // Not valid JSON — skip
            }
          }

          try {
            await s.write(value);
          } catch {
            break; // Client disconnected
          }
        }
      } finally {
        reader.releaseLock();
        const totalTokens = usagePromptTokens + usageCompletionTokens;
        if (totalTokens > 0) {
          if (sub) {
            await deductMonthlyTokens(sub.id, totalTokens).catch(() => {});
          } else {
            await deductDailyTokens(userId, totalTokens, dailyLimit).catch(() => {});
          }
          await recordActualUsage(userId, usedModel, usagePromptTokens, usageCompletionTokens).catch(() => {});
        }
      }
    });
  }

  // Non-streaming: parse usage from response body
  const responseBody = await upstreamRes.text();
  try {
    const parsed = JSON.parse(responseBody);
    const promptTokens: number = parsed.usage?.prompt_tokens ?? 0;
    const completionTokens: number = parsed.usage?.completion_tokens ?? 0;
    const totalTokens = promptTokens + completionTokens;
    if (totalTokens > 0) {
      if (sub) {
        await deductMonthlyTokens(sub.id, totalTokens).catch(() => {});
      } else {
        await deductDailyTokens(userId, totalTokens, dailyLimit).catch(() => {});
      }
      await recordActualUsage(userId, usedModel, promptTokens, completionTokens).catch(() => {});
    }
  } catch {
    // Response not JSON — skip usage tracking
  }

  return new Response(responseBody, {
    status: upstreamRes.status,
    headers: { "Content-Type": upstreamRes.headers.get("Content-Type") ?? "application/json" },
  });
});
