/**
 * The owner's rules, and every decision the agent makes against them.
 *
 * Everything here is a pure function of the mandate, the ledger and what the
 * agent observed. No network, no keys, no model. That is deliberate: the part
 * of an agent that decides whether money moves should be the part a human can
 * read in one sitting and test exhaustively (see test/mandate.test.ts). The
 * language model, when one is configured, only reads the task and writes the
 * reasoning on a counter-offer; it never decides whether to pay.
 */

export interface Mandate {
  /** The owner can stop all spending instantly by setting this to true. */
  killSwitch: boolean;
  /** Never pay more than this for one item, in USD, before routing costs. */
  maxItemUsd: number;
  /** Total the agent may spend per UTC day, including routing costs. */
  dailyBudgetUsd: number;
  /**
   * Routing cost the agent will accept on top of the price, as a percentage.
   * The swap is quoted to deliver the exact price to the seller, so anything
   * the agent sends beyond it is the cost of paying from another chain.
   */
  maxRoutingPct: number;
  /** What the agent may pay with (symbols as NEAR Intents lists them). */
  payWith: string[];
  negotiation: {
    enabled: boolean;
    /**
     * Above maxItemUsd by no more than this percentage, the agent counters
     * once at maxItemUsd instead of walking straight away.
     */
    stretchPct: number;
  };
  /** Only buy from sellers at or above this rating (0 to 5). 0 = any. */
  minSellerRating: number;
  /** Where purchases are shipped. */
  shipTo: Record<string, string>;
}

export interface Candidate {
  id: string;
  slug: string;
  title: string;
  priceUsd: number;
  shippingUsd: number;
  sellerRating: number | null;
  sellerCanReceive: boolean;
  /** Seller's wallet, where the USDC lands. */
  sellerWallet?: string;
  /** Chain the seller is paid on: Solana by default, Base if they have no Solana wallet. */
  sellerChain?: "Solana" | "Base";
}

export interface SpendRecord {
  /** ISO time of the purchase. */
  at: string;
  /** What actually left the agent's wallet, in USD. */
  spentUsd: number;
}

export type ListingDecision =
  | { action: "buy"; priceUsd: number; reason: string }
  | { action: "counter"; offerUsd: number; reason: string }
  | { action: "skip"; reason: string };

/** Validate an owner's config; throws with every problem at once. */
export function parseMandate(raw: unknown): Mandate {
  const m = raw as Partial<Mandate> & Record<string, unknown>;
  const problems: string[] = [];
  const num = (key: string, value: unknown, min = 0) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min)
      problems.push(`${key} must be a number >= ${min}`);
  };
  if (typeof m?.killSwitch !== "boolean") problems.push("killSwitch must be true or false");
  num("maxItemUsd", m?.maxItemUsd, 0.01);
  num("dailyBudgetUsd", m?.dailyBudgetUsd, 0);
  num("maxRoutingPct", m?.maxRoutingPct, 0);
  num("minSellerRating", m?.minSellerRating, 0);
  if (!Array.isArray(m?.payWith) || !m.payWith.length)
    problems.push("payWith must list at least one asset, e.g. [\"SOL\"]");
  if (typeof m?.negotiation?.enabled !== "boolean")
    problems.push("negotiation.enabled must be true or false");
  num("negotiation.stretchPct", m?.negotiation?.stretchPct, 0);
  if (!m?.shipTo || typeof m.shipTo !== "object") problems.push("shipTo is required");
  if (problems.length) throw new Error(`Invalid mandate:\n- ${problems.join("\n- ")}`);
  return m as Mandate;
}

/** USD already spent today (UTC), from the agent's own receipts. */
export function spentToday(records: SpendRecord[], now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  return records
    .filter((r) => r.at.slice(0, 10) === day)
    .reduce((sum, r) => sum + r.spentUsd, 0);
}

/** Whether the agent may spend at all right now, and how much is left. */
export function spendingRoom(
  mandate: Mandate,
  records: SpendRecord[],
  now = new Date(),
): { allowed: boolean; remainingUsd: number; reason: string } {
  if (mandate.killSwitch)
    return { allowed: false, remainingUsd: 0, reason: "the owner's kill switch is on" };
  const remainingUsd = Math.max(0, mandate.dailyBudgetUsd - spentToday(records, now));
  if (remainingUsd <= 0)
    return { allowed: false, remainingUsd, reason: "today's budget is used up" };
  return { allowed: true, remainingUsd, reason: `${usd(remainingUsd)} left today` };
}

/**
 * Decide what to do about one listing: buy at the price, counter once, or
 * walk away. `maxUsd` is the task's own ceiling, never above the mandate's.
 */
export function decide(
  mandate: Mandate,
  candidate: Candidate,
  maxUsd: number,
  remainingUsd: number,
): ListingDecision {
  const ceiling = Math.min(maxUsd, mandate.maxItemUsd);
  if (!candidate.sellerCanReceive)
    return { action: "skip", reason: "the seller cannot receive payments from other chains" };
  if (
    mandate.minSellerRating > 0 &&
    candidate.sellerRating !== null &&
    candidate.sellerRating < mandate.minSellerRating
  )
    return {
      action: "skip",
      reason: `seller rating ${candidate.sellerRating} is below the owner's minimum of ${mandate.minSellerRating}`,
    };

  // The worst case the agent could be asked to send for this item.
  const worstCase = (price: number) =>
    (price + candidate.shippingUsd) * (1 + mandate.maxRoutingPct / 100);

  // The ceiling is on the item; postage is paid on top but still counted
  // against the day's budget below.
  if (candidate.priceUsd <= ceiling) {
    if (worstCase(candidate.priceUsd) > remainingUsd)
      return {
        action: "skip",
        reason: `${usd(worstCase(candidate.priceUsd))} with routing could exceed the ${usd(remainingUsd)} left today`,
      };
    return {
      action: "buy",
      priceUsd: candidate.priceUsd,
      reason: `${usd(candidate.priceUsd)} is within the ${usd(ceiling)} ceiling`,
    };
  }

  const stretch = ceiling * (1 + mandate.negotiation.stretchPct / 100);
  if (mandate.negotiation.enabled && candidate.priceUsd <= stretch) {
    const offerUsd = Math.floor(ceiling * 100) / 100;
    if (worstCase(offerUsd) > remainingUsd)
      return {
        action: "skip",
        reason: `even a counter at ${usd(offerUsd)} could exceed the ${usd(remainingUsd)} left today`,
      };
    return {
      action: "counter",
      offerUsd,
      reason: `${usd(candidate.priceUsd)} is above the ${usd(ceiling)} ceiling but within ${mandate.negotiation.stretchPct}% of it`,
    };
  }
  return {
    action: "skip",
    reason: `${usd(candidate.priceUsd)} is too far above the ${usd(ceiling)} ceiling to negotiate`,
  };
}

/**
 * Last check before money moves: the live quote from NEAR Intents. The seller
 * is owed `dueUsd`; the agent will send `sendUsd`. Accept only if the routing
 * cost is inside the mandate and the total fits today's remaining budget.
 */
export function acceptQuote(
  mandate: Mandate,
  dueUsd: number,
  sendUsd: number,
  remainingUsd: number,
): { ok: boolean; routingPct: number; reason: string } {
  const routingPct = dueUsd > 0 ? ((sendUsd - dueUsd) / dueUsd) * 100 : Infinity;
  if (!Number.isFinite(sendUsd) || sendUsd <= 0)
    return { ok: false, routingPct, reason: "the quote has no usable amount" };
  if (routingPct > mandate.maxRoutingPct)
    return {
      ok: false,
      routingPct,
      reason: `routing costs ${routingPct.toFixed(2)}%, above the owner's ${mandate.maxRoutingPct}% limit`,
    };
  if (sendUsd > remainingUsd)
    return {
      ok: false,
      routingPct,
      reason: `${usd(sendUsd)} exceeds the ${usd(remainingUsd)} left today`,
    };
  return {
    ok: true,
    routingPct,
    reason: `routing ${routingPct.toFixed(2)}% is within the ${mandate.maxRoutingPct}% limit`,
  };
}

/** Rank listings a task matched: cheapest acceptable first. */
export function rank(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) => a.priceUsd + a.shippingUsd - (b.priceUsd + b.shippingUsd),
  );
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}
