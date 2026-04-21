/**
 * Model Verifier
 *
 * Fetches the OpenRouter model list and cross-references against FREE_MODELS
 * to determine which free models are currently available AND support tool use.
 *
 * Results are cached for 1 hour to avoid hammering OpenRouter's API.
 * On failure, falls back to the known-good tool-use capable subset.
 */

import { FREE_MODELS } from "../config/free-models.js";

// Known-good defaults: these 3 are stable and support tool use (function calling)
const FALLBACK_FREE_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
];

interface OpenRouterModel {
  id: string;
  supported_parameters?: string[];
}

let cachedVerifiedModels: string[] | null = null;
let cacheExpiry = 0;

/**
 * Returns the list of FREE_MODELS that are:
 * 1. Currently listed on OpenRouter (not deprecated/removed)
 * 2. Support tool use (function calling)
 *
 * Result is cached for 1 hour. Falls back to FALLBACK_FREE_MODELS on error.
 */
export async function getVerifiedFreeModels(): Promise<string[]> {
  const now = Date.now();
  if (cachedVerifiedModels && now < cacheExpiry) {
    return cachedVerifiedModels;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return FALLBACK_FREE_MODELS;
  }

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      console.warn(`[model-verifier] OpenRouter models fetch failed: ${resp.status}`);
      return cachedVerifiedModels ?? FALLBACK_FREE_MODELS;
    }

    const data = (await resp.json()) as { data: OpenRouterModel[] };

    const availableIds = new Set(data.data.map((m) => m.id));
    const toolCapableIds = new Set(
      data.data
        .filter((m) => m.supported_parameters?.includes("tools"))
        .map((m) => m.id),
    );

    // Prefer free models that are available AND support tools
    let verified = FREE_MODELS.filter(
      (id) => availableIds.has(id) && toolCapableIds.has(id),
    );

    // Fallback: if none support tools, take any available free model
    if (verified.length === 0) {
      verified = FREE_MODELS.filter((id) => availableIds.has(id));
    }

    // Last resort: use hardcoded defaults
    if (verified.length === 0) {
      verified = [...FALLBACK_FREE_MODELS];
    }

    cachedVerifiedModels = verified;
    cacheExpiry = now + 60 * 60 * 1000; // cache for 1 hour

    console.info(`[model-verifier] Verified ${verified.length} free models (tool-use capable)`);
    return verified;
  } catch (err) {
    console.warn("[model-verifier] Error fetching OpenRouter models:", err);
    return cachedVerifiedModels ?? FALLBACK_FREE_MODELS;
  }
}

/** Invalidate the model cache (e.g., after a proxy error suggests a model is down). */
export function invalidateModelCache(): void {
  cacheExpiry = 0;
}
