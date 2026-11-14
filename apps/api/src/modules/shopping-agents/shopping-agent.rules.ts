/**
 * What a shopping agent decides about one listing. Pure: no database, no
 * network, so every rule is tested on its own (shopping-agents.spec.ts).
 *
 * The agent only ever proposes. It never pays: the user approves a match and
 * pays from their own wallet through the normal checkout.
 */

export interface AgentRules {
  userId: string;
  maxItemUsd: number;
  dailyBudgetUsd: number;
  negotiate: boolean;
}

export interface Candidate {
  id: string;
  sellerId: string;
  title: string;
  priceUsd: number | null;
  shippingUsd: number;
}

export type Verdict =
  | { kind: "match"; reason: string; totalUsd: number }
  | { kind: "offer"; reason: string; offerUsd: number }
  | { kind: "skip"; reason: string };

/** How far above the limit an asking price may be for one offer at the limit. */
export const NEGOTIATION_STRETCH = 0.15;

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Words the listing must contain, so "kaws elmo figure" finds "KAWS x Sesame Street Elmo". */
export function searchWords(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        // A price in the text ("under $300") is a limit, not a word to find.
        .replace(/\$\s?\d[\d,.]*k?/g, " ")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 2 && !STOP_WORDS.has(w)),
    ),
  ].slice(0, 6);
}

const STOP_WORDS = new Set(["a", "an", "the", "and", "or", "for", "with", "under", "below", "size", "in", "of", "me", "find", "buy", "want"]);

/**
 * @param spentTodayUsd what the user already bought through this agent today,
 *   plus what is already pending approval, so proposals stay inside the
 *   daily budget.
 */
export function evaluate(listing: Candidate, rules: AgentRules, spentTodayUsd: number): Verdict {
  if (listing.sellerId === rules.userId) return { kind: "skip", reason: "Your own listing" };
  if (listing.priceUsd === null) return { kind: "skip", reason: "No fixed price (offers only)" };

  const total = listing.priceUsd + listing.shippingUsd;
  const room = rules.dailyBudgetUsd - spentTodayUsd;

  if (total <= rules.maxItemUsd) {
    if (total > room)
      return { kind: "skip", reason: `${usd(total)} would pass today's ${usd(rules.dailyBudgetUsd)} budget` };
    return {
      kind: "match",
      reason: `${usd(total)} with postage, within your ${usd(rules.maxItemUsd)} limit`,
      totalUsd: total,
    };
  }

  const offerUsd = Math.floor(rules.maxItemUsd - listing.shippingUsd);
  if (rules.negotiate && listing.priceUsd <= rules.maxItemUsd * (1 + NEGOTIATION_STRETCH) && offerUsd >= 1) {
    if (rules.maxItemUsd > room)
      return { kind: "skip", reason: `An offer would pass today's ${usd(rules.dailyBudgetUsd)} budget` };
    return {
      kind: "offer",
      reason: `Asking ${usd(listing.priceUsd)} is just above your limit, so the agent offered ${usd(offerUsd)}`,
      offerUsd,
    };
  }

  return { kind: "skip", reason: `${usd(total)} is above your ${usd(rules.maxItemUsd)} limit` };
}
