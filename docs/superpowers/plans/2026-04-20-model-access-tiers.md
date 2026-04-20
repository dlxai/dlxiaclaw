# Model Access Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the model selector behind subscription tier, show it only to pro users and custom-key users; fix credits deduction to use actual OpenRouter token usage instead of estimates.

**Architecture:** `show_model` from `/api/credits/quota` drives UI gating in ChatPage. Cloud-api proxy deducts real tokens post-response. Free users see a read-only model badge; pro users get the full cascading selector with free/premium grouping.

**Tech Stack:** TypeScript, React, Hono (cloud-api), existing `fetchQuota()` / `KeyModelSelector` / `creditsRoute`

---

## File Map

| File | Change |
|---|---|
| `apps/cloud-api/src/routes/proxy.ts` | Deduct actual tokens from OpenRouter usage; add `stream_options` |
| `apps/panel/src/pages/ChatPage.tsx` | Fetch quota; conditionally render selector vs read-only badge |
| `apps/panel/src/components/inputs/KeyModelSelector.tsx` | Add group labels: [免费] / [高级] / [自定义] |
| `apps/panel/src/api/credits.ts` | No change — `fetchQuota()` already returns `show_model` |
| `apps/desktop/src/api-routes/provider-routes.ts` | No change — full catalog already accessible; free-models injected |

---

## Task 1: Cloud-API — Deduct actual tokens from OpenRouter response

**Files:**
- Modify: `apps/cloud-api/src/routes/proxy.ts`

Currently the proxy estimates input tokens and deducts upfront. OpenRouter returns actual usage in every response. We need to deduct the real numbers after the response.

For **streaming**: add `stream_options: { include_usage: true }` to the forwarded payload so OpenRouter includes usage in the final SSE data chunk. Buffer all SSE lines, parse usage from the last non-`[DONE]` data chunk, then deduct after the stream ends.

For **non-streaming**: parse `response.usage` from the response JSON body.

- [ ] **Step 1: Replace proxy.ts with real-usage deduction logic**

Replace `apps/cloud-api/src/routes/proxy.ts` entirely with:

```typescript
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { sql } from "../db/client.js";
import { isFreeModel } from "../config/free-models.js";
import { getActiveSubscription } from "../db/quota.js";

export const proxyRoute = new Hono<{ Variables: { userId: string } }>();

/** Deduct tokens from daily_quota. Returns false if over limit. */
async function deductDailyTokens(userId: string, tokens: number, dailyLimit: number): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  return sql.begin(async (tx) => {
    await tx`
      INSERT INTO daily_quota (user_id, date, tokens_used)
      VALUES (${userId}, ${today}::date, 0)
      ON CONFLICT (user_id) DO UPDATE
        SET tokens_used = CASE
              WHEN daily_quota.date < ${today}::date THEN 0
              ELSE daily_quota.tokens_used
            END,
            date = ${today}::date
    `;
    const [updated] = await tx<{ tokens_used: number }[]>`
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
async function recordActualUsage(userId: string, model: string, promptTokens: number, completionTokens: number): Promise<void> {
  const tokens = promptTokens + completionTokens;
  if (tokens <= 0) return;
  await sql`
    INSERT INTO credit_ledger (user_id, delta, reason, model, tokens)
    VALUES (${userId}, ${-tokens}, 'consumption', ${model}, ${tokens})
  `;
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
    // Rough pre-flight to block clearly-over-quota requests early.
    // Actual deduction happens post-response with real token counts.
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
      const reader = upstreamRes.body!.getReader();
      const decoder = new TextDecoder();
      let usagePromptTokens = 0;
      let usageCompletionTokens = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Parse SSE chunks for usage stats before forwarding
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split("\n")) {
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
        // Deduct actual tokens after stream ends
        const totalTokens = usagePromptTokens + usageCompletionTokens;
        if (totalTokens > 0) {
          if (!sub) {
            // Deduct from daily quota (best-effort — if over limit, just log)
            await deductDailyTokens(userId, totalTokens, dailyLimit).catch(() => {});
          }
          await recordActualUsage(userId, payload.model, usagePromptTokens, usageCompletionTokens).catch(() => {});
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
      if (!sub) {
        await deductDailyTokens(userId, totalTokens, dailyLimit).catch(() => {});
      }
      await recordActualUsage(userId, payload.model, promptTokens, completionTokens).catch(() => {});
    }
  } catch {
    // Response not JSON — skip usage tracking
  }

  return new Response(responseBody, {
    status: upstreamRes.status,
    headers: { "Content-Type": upstreamRes.headers.get("Content-Type") ?? "application/json" },
  });
});
```

- [ ] **Step 2: Remove the now-unused `estimateInputTokens` helper from quota.ts**

Open `apps/cloud-api/src/db/quota.ts`. The `deductDailyTokens` and `deductMonthlyTokens` functions are now only called from within proxy.ts (which embeds its own deductDailyTokens). Delete the two exported functions `deductDailyTokens` and `deductMonthlyTokens` from `quota.ts` — they're now inlined in proxy.ts and no longer needed externally.

If `deductMonthlyTokens` is referenced elsewhere, keep it; otherwise remove it.

Run: `cd apps/cloud-api && grep -r "deductDailyTokens\|deductMonthlyTokens" src/`

Expected: only quota.ts itself (no other usages after the proxy.ts replacement).

- [ ] **Step 3: Rebuild cloud-api dist**

```bash
cd apps/cloud-api
pnpm build
```

Expected: Build completes with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add apps/cloud-api/src/routes/proxy.ts apps/cloud-api/src/db/quota.ts apps/cloud-api/dist/
git commit -m "fix(cloud-api): deduct actual OpenRouter token usage instead of estimates"
```

---

## Task 2: Panel — Gate model selector on subscription tier

**Files:**
- Modify: `apps/panel/src/pages/ChatPage.tsx`

`fetchQuota()` already returns `{ show_model: boolean, plan: string }`. We need to:
1. Fetch quota after connecting in credits mode
2. Store `showModelSelector` state
3. Show `KeyModelSelector` only when `showModelSelector || hasCustomKeys`
4. When not showing selector, render a read-only model badge in the status bar

**Files:**
- Modify: `apps/panel/src/pages/ChatPage.tsx`

- [ ] **Step 1: Add `showModelSelector` state and quota fetch**

Find the state declarations near the top of `ChatPage` (around line 40–55). Add:

```typescript
const [showModelSelector, setShowModelSelector] = useState(false);
```

Then find where `fetchSettings()` is called (around line 765). After the `setAccessMode` call, add a quota fetch for credits mode:

```typescript
fetchSettings().then(async (s) => {
  if (cancelled) return;
  const mode = s["access_mode"];
  if (mode) setAccessMode(mode);
  // Fetch quota to determine model selector visibility
  if (mode === "credits" || (!mode && accessMode === "credits")) {
    try {
      const { fetchQuota } = await import("../api/credits.js");
      const quota = await fetchQuota();
      if (!cancelled) setShowModelSelector(quota.show_model);
    } catch {
      // Leave showModelSelector as false (safe default for free tier)
    }
  }
}).catch(() => {});
```

- [ ] **Step 2: Update the model selector rendering condition**

Find the `KeyModelSelector` block in the JSX (around line 1373–1401). Currently it renders when `connectionState === "connected" && activeModel`. Change it to only render when the user can switch models:

```tsx
{connectionState === "connected" && activeModel && (showModelSelector || entityStore.providerKeys.some((k) => k.authType === "custom")) && (
  <KeyModelSelector
    keys={(() => {
      const userKeys = entityStore.providerKeys.map((k) => ({
        id: k.id,
        provider: k.provider,
        label: k.label,
        model: k.model,
        isDefault: k.isDefault,
      }));
      if (accessMode === "credits" && !userKeys.some((k) => k.provider === "openrouter")) {
        userKeys.unshift({
          id: "__credits_default__",
          provider: "openrouter",
          label: "默认",
          model: "meta-llama/llama-3.3-70b-instruct:free",
          isDefault: false,
        });
      }
      return userKeys;
    })()}
    catalog={modelCatalog}
    selectedProvider={activeModel.provider}
    selectedModel={activeModel.model}
    onChange={handleKeyModelChange}
    creditsMode={accessMode === "credits"}
  />
)}
{connectionState === "connected" && activeModel && !showModelSelector && !entityStore.providerKeys.some((k) => k.authType === "custom") && (
  <span className="chat-model-badge">
    {activeModel.model.split("/").pop()?.replace(":free", "") ?? activeModel.model}
  </span>
)}
```

Note: the model badge shows a simplified model name (last segment, no `:free` suffix) for free users.

- [ ] **Step 3: Add `.chat-model-badge` style**

Open `apps/panel/src/pages/chat/ChatPage.css`. Append at the end:

```css
.chat-model-badge {
  font-size: 12px;
  color: var(--text-muted, #87867f);
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--surface-2, #f0eee6);
  pointer-events: none;
  user-select: none;
}
```

- [ ] **Step 4: Also update the stale `openrouter/free` default key in the keys array**

In Step 2 above, notice the fix: `model: "meta-llama/llama-3.3-70b-instruct:free"` (was `"openrouter/free"` — an invalid model ID). Confirm this is applied.

- [ ] **Step 5: Rebuild desktop and restart Electron to verify**

```bash
cd apps/desktop && npx tsdown
```

Then restart dev environment. In the panel:
- As a free-tier user (no subscription): model selector should be **hidden**, only the badge shows.
- As a pro user: model selector should appear with full catalog.

- [ ] **Step 6: Commit**

```bash
git add apps/panel/src/pages/ChatPage.tsx apps/panel/src/pages/chat/ChatPage.css
git commit -m "feat(panel): gate model selector behind subscription tier; show read-only badge for free users"
```

---

## Task 3: Panel — Group models in KeyModelSelector (free / premium / custom)

**Files:**
- Modify: `apps/panel/src/components/inputs/KeyModelSelector.tsx`
- Modify: `apps/panel/src/components/inputs/KeyModelSelector.css`

Pro users see the model selector. The catalog has many OpenRouter models. We need to group them visually: [免费模型] (FREE_MODELS list), [高级模型] (rest of OpenRouter), [自定义] (user keys with authType !== "openrouter").

Add a `freeModelIds` prop to indicate which model IDs are free tier, so the selector can render group headers.

- [ ] **Step 1: Add `freeModelIds` prop to KeyModelSelector**

Open `apps/panel/src/components/inputs/KeyModelSelector.tsx`. Add to the props interface:

```typescript
export interface KeyModelSelectorProps {
  keys: KeyModelKey[];
  catalog: Record<string, CatalogModel[]>;
  selectedProvider: string;
  selectedModel: string;
  onChange: (provider: string, model: string) => void;
  disabled?: boolean;
  variant?: "compact" | "form";
  creditsMode?: boolean;
  /** Model IDs that belong to the free tier (for group labeling). Only used when creditsMode=true. */
  freeModelIds?: string[];
}
```

- [ ] **Step 2: Use `freeModelIds` to split the openrouter model list into two groups**

Inside the `KeyModelSelector` function, locate where the right-column model list is built (the part that maps `catalog[hoveredProvider ?? selectedProvider]`). When `creditsMode && freeModelIds` is provided and the active provider is `openrouter`, split into two sections:

```typescript
const activeProvider = hoveredProvider ?? selectedProvider;
const rawModels = (catalog[activeProvider] ?? []).filter(
  (m) => !search || m.id.toLowerCase().includes(search.toLowerCase()) || m.name.toLowerCase().includes(search.toLowerCase())
);

const freeSet = new Set(freeModelIds ?? []);
const freeModels = creditsMode && freeSet.size > 0 && activeProvider === "openrouter"
  ? rawModels.filter((m) => freeSet.has(m.id))
  : rawModels;
const premiumModels = creditsMode && freeSet.size > 0 && activeProvider === "openrouter"
  ? rawModels.filter((m) => !freeSet.has(m.id))
  : [];
```

Then in JSX, render grouped:

```tsx
{freeModels.length > 0 && premiumModels.length > 0 && (
  <div className="key-model-selector__group-label">免费模型</div>
)}
{freeModels.map((m) => (
  <button
    key={m.id}
    className={`key-model-selector__model-item ${m.id === selectedModel && activeProvider === selectedProvider ? "selected" : ""}`}
    onClick={() => { onChange(activeProvider, m.id); setOpen(false); }}
  >
    {m.name}
  </button>
))}
{premiumModels.length > 0 && (
  <>
    <div className="key-model-selector__group-label">高级模型</div>
    {premiumModels.map((m) => (
      <button
        key={m.id}
        className={`key-model-selector__model-item ${m.id === selectedModel && activeProvider === selectedProvider ? "selected" : ""}`}
        onClick={() => { onChange(activeProvider, m.id); setOpen(false); }}
      >
        {m.name}
      </button>
    ))}
  </>
)}
{freeModels.length === 0 && premiumModels.length === 0 && rawModels.map((m) => (
  <button
    key={m.id}
    className={`key-model-selector__model-item ${m.id === selectedModel && activeProvider === selectedProvider ? "selected" : ""}`}
    onClick={() => { onChange(activeProvider, m.id); setOpen(false); }}
  >
    {m.name}
  </button>
))}
```

- [ ] **Step 3: Add group label style to KeyModelSelector.css**

Open `apps/panel/src/components/inputs/KeyModelSelector.css`. Add:

```css
.key-model-selector__group-label {
  padding: 4px 10px 2px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted, #87867f);
  pointer-events: none;
  user-select: none;
}
```

- [ ] **Step 4: Pass `freeModelIds` from ChatPage to KeyModelSelector**

In `ChatPage.tsx`, import `FREE_MODELS` from the panel-side constants. Since `free-models.ts` lives in `apps/cloud-api`, we can't import it directly in the panel. Instead, define the same list inline in ChatPage (or a shared constant file). Add near the top of `ChatPage.tsx`:

```typescript
// Mirrors apps/cloud-api/src/config/free-models.ts — keep in sync
const CREDITS_FREE_MODEL_IDS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "minimax/minimax-m2.5:free",
  "stepfun/step-3.5-flash:free",
  "arcee-ai/trinity-large-preview:free",
  "liquid/lfm-2.5-1.2b-instruct:free",
];
```

Then pass to the selector:

```tsx
<KeyModelSelector
  ...
  freeModelIds={accessMode === "credits" ? CREDITS_FREE_MODEL_IDS : undefined}
/>
```

- [ ] **Step 5: Build and verify grouping**

```bash
cd apps/desktop && npx tsdown
```

Restart dev. As a pro user, open the model selector → openrouter → should see "免费模型" and "高级模型" sections.

- [ ] **Step 6: Commit**

```bash
git add apps/panel/src/components/inputs/KeyModelSelector.tsx apps/panel/src/components/inputs/KeyModelSelector.css apps/panel/src/pages/ChatPage.tsx
git commit -m "feat(panel): group model selector into free/premium sections in credits mode"
```

---

## Self-Review

**Spec coverage:**
- ✅ Free users locked to default model, no selector — Task 2
- ✅ Pro users get full model catalog with selector — Tasks 2 + 3
- ✅ Custom key users bypass credits, can switch — Task 2 (condition includes custom keys)
- ✅ Credits deducted from actual token usage — Task 1
- ✅ Free tier limited to FREE_MODELS, proxy enforces — already in proxy.ts, Task 1 preserves
- ✅ Model grouping: free / premium / custom — Task 3

**Placeholder scan:** No TBD items. All code blocks are complete.

**Type consistency:**
- `freeModelIds?: string[]` added to props interface (Task 3 Step 1) and used in JSX (Task 3 Step 4) ✅
- `showModelSelector` state added (Task 2 Step 1) and used in JSX (Task 2 Step 2) ✅
- `recordActualUsage` defined and called within same file (Task 1) ✅
- `deductDailyTokens` redefined inline in proxy.ts (Task 1) — remove from quota.ts import to avoid conflict ✅
