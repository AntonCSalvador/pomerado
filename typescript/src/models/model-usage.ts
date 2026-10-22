import type { Usage } from "@openai/agents";

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** The SDK types token details as numbers, but it copies the provider's nested objects as given. */
const total = (details: readonly object[], read: (entry: object) => unknown) =>
  details.reduce((sum, entry) => sum + count(read(entry)), 0);

const field = (key: string) => (entry: object) => Reflect.get(entry, key);

/** A cache write's tokens at one lifetime, from the provider's `cache_write_tokens_details`. */
const writtenFor = (key: "ttl_30m_tokens" | "ttl_12h_tokens") => (entry: object) => {
  const details: unknown = Reflect.get(entry, "cache_write_tokens_details");
  return typeof details === "object" && details !== null ? Reflect.get(details, key) : undefined;
};

/** One model call's token counts, as finite diagnostics: the cache hit rate is
 * `cachedTokens / inputTokens`, and `cacheWriteTokens` is what the call newly cached, split by
 * lifetime into `cacheWrite30mTokens` and `cacheWrite12hTokens` (a 12-hour write costs twice a
 * 30-minute one). Input the call neither read from nor wrote to the cache is
 * `inputTokens - cachedTokens - cacheWriteTokens`. */
export const modelUsageCounts = (usage: Usage) => ({
  inputTokens: usage.inputTokens,
  cachedTokens: total(usage.inputTokensDetails, field("cached_tokens")),
  cacheWriteTokens: total(usage.inputTokensDetails, field("cache_write_tokens")),
  cacheWrite30mTokens: total(usage.inputTokensDetails, writtenFor("ttl_30m_tokens")),
  cacheWrite12hTokens: total(usage.inputTokensDetails, writtenFor("ttl_12h_tokens")),
  outputTokens: usage.outputTokens,
  reasoningTokens: total(usage.outputTokensDetails, field("reasoning_tokens")),
});
