/**
 * Classifies Piwik Pro goal names into the two business-relevant buckets the
 * dashboard highlights. Goal names are configured per-site (each of the 20
 * sites has its own goal list, often with different wording for the same
 * intent -- "Demande de devis" on FR, "ESS Quote Form" on US, "Quotation
 * requests" on DE/APAC) so classification is keyword-based rather than by
 * goal id, which isn't stable across sites. Validated against all 51 unique
 * goal names seen across the real 20 in-scope sites: these two patterns
 * match every quote/support goal and nothing else (no false positives).
 */

const RFQ_PATTERN = /devis|quote|quotation/i;
const SUPPORT_PATTERN = /support/i;

export type GoalCategory = "rfq" | "support" | "other";

export function categorizeGoal(goalName: string): GoalCategory {
  if (RFQ_PATTERN.test(goalName)) return "rfq";
  if (SUPPORT_PATTERN.test(goalName)) return "support";
  return "other";
}
