/**
 * Models available to free-tier users via OpenRouter.
 * Lead entries support tool use (function calling) — these are best for chat.
 * Add/remove entries here to control free-tier access — no code changes elsewhere needed.
 */
export declare const FREE_MODELS: readonly string[];
/** Returns true if the given model ID is available on the free tier. */
export declare function isFreeModel(model: string): boolean;
//# sourceMappingURL=free-models.d.ts.map