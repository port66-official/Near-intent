import type { OneClickToken } from "./one-click.client";

/**
 * What a buyer may pay with, and where the seller is paid.
 *
 * 1Click lists a couple of hundred assets. A checkout should offer a short,
 * legible set of majors, so this is an explicit allowlist of asset ids rather
 * than a symbol match: "USDC" and "ETH" are many different tokens across
 * chains and a symbol alone does not say which one is meant.
 */

/** USDC on Solana: what sellers receive by default. */
export const SETTLEMENT_ASSET_ID =
  "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
export const SETTLEMENT_DECIMALS = 6;

/**
 * Where a seller can be paid. Solana is the default; Base covers sellers who
 * only have an EVM wallet. The key is stored as the checkout's `cluster`.
 */
export const SETTLEMENTS = {
  "mainnet-beta": {
    chain: "Solana",
    assetId: SETTLEMENT_ASSET_ID,
    txPattern: /^[1-9A-HJ-NP-Za-km-z]{64,88}$/,
    explorer: (hash: string) => `https://solscan.io/tx/${hash}`,
  },
  base: {
    chain: "Base",
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    txPattern: /^0x[0-9a-fA-F]{64}$/,
    explorer: (hash: string) => `https://basescan.org/tx/${hash}`,
  },
} as const;
export type SettlementKey = keyof typeof SETTLEMENTS;

export function settlementFor(cluster: string) {
  return SETTLEMENTS[cluster as SettlementKey];
}

interface PayableSpec {
  assetId: string;
  /** Human name of the chain the buyer sends from. */
  chain: string;
  /**
   * How long the buyer has to send, in minutes. Slow chains need room for
   * the deposit itself to confirm before the quote lapses.
   */
  windowMinutes: number;
}

const FAST = 30;
const SLOW = 120;

export const PAYABLE_ASSETS: PayableSpec[] = [
  { assetId: "nep141:btc.omft.near", chain: "Bitcoin", windowMinutes: SLOW },
  { assetId: "nep141:sol.omft.near", chain: "Solana", windowMinutes: FAST },
  { assetId: "nep141:wrap.near", chain: "NEAR", windowMinutes: FAST },
  { assetId: "nep141:eth.omft.near", chain: "Ethereum", windowMinutes: FAST },
  { assetId: "nep141:arb.omft.near", chain: "Arbitrum", windowMinutes: FAST },
  { assetId: "nep141:base.omft.near", chain: "Base", windowMinutes: FAST },
  {
    assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    chain: "Ethereum",
    windowMinutes: FAST,
  },
  {
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    chain: "Arbitrum",
    windowMinutes: FAST,
  },
  {
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    chain: "Base",
    windowMinutes: FAST,
  },
  {
    assetId:
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    chain: "NEAR",
    windowMinutes: FAST,
  },
  {
    assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    chain: "Ethereum",
    windowMinutes: FAST,
  },
  { assetId: "nep141:doge.omft.near", chain: "Dogecoin", windowMinutes: SLOW },
  { assetId: "nep141:ltc.omft.near", chain: "Litecoin", windowMinutes: SLOW },
];

export interface PayableAsset {
  assetId: string;
  symbol: string;
  chain: string;
  decimals: number;
  /** USD price per whole unit, for an indicative total before quoting. */
  priceUsd: number;
  windowMinutes: number;
}

/** wNEAR is what 1Click lists; buyers know it as NEAR. */
function displaySymbol(token: OneClickToken): string {
  return token.assetId === "nep141:wrap.near" ? "NEAR" : token.symbol;
}

/**
 * Allowlisted assets that 1Click is listing right now, in allowlist order.
 * An asset 1Click has dropped simply disappears from the picker.
 */
export function payableAssets(tokens: OneClickToken[]): PayableAsset[] {
  const byId = new Map(tokens.map((t) => [t.assetId, t]));
  return PAYABLE_ASSETS.flatMap((spec) => {
    const token = byId.get(spec.assetId);
    if (!token) return [];
    return [
      {
        assetId: spec.assetId,
        symbol: displaySymbol(token),
        chain: spec.chain,
        decimals: token.decimals,
        priceUsd: token.price,
        windowMinutes: spec.windowMinutes,
      },
    ];
  });
}

export function payableSpec(assetId: string): PayableSpec | undefined {
  return PAYABLE_ASSETS.find((a) => a.assetId === assetId);
}

/**
 * Port66's share of a cross-chain payment, paid by NEAR Intents inside the
 * same swap. Off unless both variables are set.
 *
 * With an EXACT_OUTPUT quote the seller still receives the exact price: the
 * fee is added to what the buyer sends, in basis points of that amount.
 * Capped at 1% so a typo cannot overcharge buyers.
 */
export function platformFee(
  env: Record<string, string | undefined> = process.env,
): { recipient: string; fee: number } | undefined {
  const recipient = env.NEAR_INTENTS_FEE_RECIPIENT?.trim();
  const bps = Number(env.NEAR_INTENTS_FEE_BPS);
  if (!recipient || !Number.isInteger(bps) || bps <= 0) return undefined;
  // A NEAR account: named (port66.near) or implicit (64 hex characters).
  if (!/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(recipient) || recipient.length > 64)
    return undefined;
  return { recipient, fee: Math.min(bps, 100) };
}
