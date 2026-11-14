/** Shapes returned by the API's /shopping-agents endpoints. */

export interface ShoppingAgent {
  id: string;
  name: string;
  query: string;
  brandName: string | null;
  size: string | null;
  condition: string | null;
  maxItemUsd: number;
  dailyBudgetUsd: number;
  payWith: string[];
  negotiate: boolean;
  status: "ACTIVE" | "PAUSED";
  autoBuy?: boolean;
  /** Terms of the spend permission when automatic buying is on. */
  permission?: { dailyUsd: number; account: string; end: string | null } | null;
  lastRunAt: string | null;
  createdAt: string;
  pendingMatches?: number;
}

export type MatchStatus = "PENDING" | "OFFERED" | "BUYING" | "DISMISSED" | "PURCHASED" | "FAILED" | "GONE";

export interface AgentMatch {
  id: string;
  status: MatchStatus;
  reason: string;
  priceUsd: number;
  offerId: string | null;
  createdAt: string;
  listing: {
    slug: string;
    title: string;
    image: string | null;
    priceUsd: number | null;
    shippingUsd: number;
    status: string;
    brand: string | null;
    seller: string | null;
  } | null;
}

export interface AgentEvent {
  id: string;
  kind: string;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentDetail {
  agent: ShoppingAgent;
  matches: AgentMatch[];
  events: AgentEvent[];
}

export const PAY_WITH_OPTIONS = ["USDC", "ETH", "SOL", "BTC", "NEAR", "USDT"] as const;

export function usd(n: number | null | undefined): string {
  if (n == null) return "Make an offer";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
