/**
 * Domains that identify traffic referred by an AI assistant/chat product rather
 * than a classic search engine or generic referral. Piwik Pro reports these as
 * ordinary `referral` (sometimes `organic`, e.g. Google's AI Overviews still tag
 * as organic search) traffic with `source` set to the assistant's domain -- there
 * is no dedicated "AI" channel in Piwik Pro, so this list is how the app tells
 * "a person clicked a link ChatGPT/Perplexity/Gemini gave them" apart from
 * regular referral/search traffic.
 *
 * Deliberately excludes plain "bing.com"/"google.com": Bing Copilot and Google's
 * AI Overviews aren't distinguishable from classic search in the `source`
 * dimension, so including them would silently inflate this number with regular
 * search traffic.
 */
const AI_REFERRER_DOMAINS = new Set([
  "chat.openai.com",
  "chatgpt.com",
  "perplexity.ai",
  "www.perplexity.ai",
  "gemini.google.com",
  "bard.google.com",
  "copilot.microsoft.com",
  "you.com",
  "claude.ai",
  "poe.com",
  "character.ai",
  "mistral.ai",
  "chat.mistral.ai",
]);

export function isAiReferrerSource(source: string): boolean {
  const normalized = source.trim().toLowerCase();
  return AI_REFERRER_DOMAINS.has(normalized);
}
