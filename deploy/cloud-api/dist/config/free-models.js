/**
 * Models available to free-tier users via OpenRouter.
 * Lead entries support tool use (function calling) — these are best for chat.
 * Add/remove entries here to control free-tier access — no code changes elsewhere needed.
 */
export const FREE_MODELS = [
    // Tool-use capable free models (preferred defaults)
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen-2.5-72b-instruct:free",
    "google/gemini-2.0-flash-exp:free",
    // Other free models (may not support tool use)
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3-nano-30b-a3b:free",
    "minimax/minimax-m2.5:free",
    "stepfun/step-3.5-flash:free",
    "arcee-ai/trinity-large-preview:free",
    "liquid/lfm-2.5-1.2b-instruct:free",
];
/** Returns true if the given model ID is available on the free tier. */
export function isFreeModel(model) {
    return FREE_MODELS.includes(model);
}
//# sourceMappingURL=free-models.js.map