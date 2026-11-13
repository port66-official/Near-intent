/**
 * Port66's MCP server: the marketplace as tools any AI agent can call.
 *
 * Served at https://port66.xyz/api/mcp over MCP's streamable HTTP transport,
 * statelessly: every POST carries one JSON-RPC message and gets one JSON
 * answer. No sessions, no server-sent events, nothing to keep warm.
 *
 * Browsing needs nothing: search, inspect, and price a piece in any crypto.
 * Buying needs a Port66 session (Authorization: Bearer <token>), the same one
 * a person gets from wallet sign-in, and is paid through NEAR Intents: the
 * agent sends crypto from any chain, the seller receives exact USDC.
 *
 * The server never holds or moves money. Its buying tools return a deposit
 * address and an exact amount; the agent's own wallet decides whether to pay.
 */
import { SITE, toDetail, toSummary, type MarketListing } from "../muse/catalog";

export const MCP_SERVER_INFO = { name: "port66", title: "Port66", version: "1.0.0" };
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Port66 is a marketplace for authenticated luxury, streetwear and collectibles.
Use search_listings to find pieces (one or two words in the query match best), get_listing for details,
and price_in_crypto to see what a piece costs in BTC, SOL, NEAR, ETH and others.
To buy: start_purchase reserves the piece and returns a deposit address and an exact amount; send exactly that
from the buyer's wallet, optionally report_deposit, then poll purchase_status until it is "paid".
NEAR Intents delivers the exact USDC price to the seller and refunds the buyer on their own chain if it cannot.
make_offer and offer_status negotiate; an accepted offer prices the next purchase at the agreed amount.
Buying tools need a Port66 session token; never send funds anywhere except a deposit address from start_purchase.`;

// ── JSON-RPC plumbing ────────────────────────────────────────────────────────

type Id = string | number | null;
interface RpcRequest {
  jsonrpc: "2.0";
  id?: Id;
  method: string;
  params?: Record<string, unknown>;
}
type RpcResponse =
  | { jsonrpc: "2.0"; id: Id; result: unknown }
  | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string } };

const ok = (id: Id, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

export interface McpContext {
  /** Port66 API base, e.g. https://port66-api.vercel.app/api/v1 */
  api: string;
  /** The caller's Authorization header, forwarded to Port66 for buying tools. */
  authorization?: string | null;
  fetch?: typeof fetch;
}

/**
 * Handle one JSON-RPC message. Returns null for notifications, which the
 * transport answers with 202 Accepted and no body.
 */
export async function handleMessage(
  message: unknown,
  ctx: McpContext,
): Promise<RpcResponse | null> {
  const req = message as RpcRequest;
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string")
    return fail(null, -32600, "Invalid Request");
  const isNotification = req.id === undefined;
  const id: Id = req.id ?? null;

  try {
    switch (req.method) {
      case "initialize": {
        const asked = String(req.params?.protocolVersion ?? "");
        return ok(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return isNotification ? null : ok(id, {});
      case "tools/list":
        return ok(id, { tools: TOOLS.map(({ run: _run, ...tool }) => tool) });
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${name}`);
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const result = await tool.run(args, ctx);
          return ok(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          });
        } catch (error) {
          // Tool failures are results the model can read and act on, not
          // protocol errors.
          return ok(id, {
            content: [{ type: "text", text: (error as Error).message }],
            isError: true,
          });
        }
      }
      default:
        if (isNotification) return null;
        return fail(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (error) {
    return isNotification ? null : fail(id, -32603, (error as Error).message);
  }
}

// ── Port66 calls ─────────────────────────────────────────────────────────────

class ToolError extends Error {}

const NEEDS_SESSION =
  "This tool needs a Port66 session. Sign in with a wallet (see https://port66.xyz/llms.txt, " +
  '"Buying a marketplace listing") and connect with the header Authorization: Bearer <token>.';

/** Fail fast, before any lookup, when a buying tool has no session. */
function requireSession(ctx: McpContext) {
  if (!ctx.authorization) throw new ToolError(NEEDS_SESSION);
}

async function call<T>(
  ctx: McpContext,
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  if (init.auth) requireSession(ctx);
  const res = await (ctx.fetch ?? fetch)(`${ctx.api}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.auth && ctx.authorization ? { authorization: ctx.authorization } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = (body as { message?: unknown })?.message;
    throw new ToolError(
      res.status === 401
        ? "The Port66 session is missing or expired. Sign in again."
        : Array.isArray(message)
          ? message.join("; ")
          : String(message ?? `Port66 returned HTTP ${res.status}`),
    );
  }
  return (body && typeof body === "object" && "data" in body
    ? (body as { data: T }).data
    : body) as T;
}

interface RawListing extends MarketListing {
  id: string;
  seller?: {
    username?: string;
    displayName?: string;
    solanaWalletAddress?: string | null;
    walletAddress?: string | null;
  } | null;
}

const listingOf = (ctx: McpContext, id: string) =>
  call<RawListing>(ctx, `/listings/${encodeURIComponent(id)}`);

/**
 * Port66's search matches the whole query as one phrase, so "KAWS figure"
 * finds nothing while "KAWS" finds the KAWS figure. Try the phrase first,
 * then each word, and keep the titles that match the most words.
 */
async function searchListings(
  ctx: McpContext,
  args: { query?: string; brand?: string; category?: string; min_price?: number; max_price?: number; limit?: number },
) {
  const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 20);
  const base = new URLSearchParams({ status: "ACTIVE", group: "true", limit: String(limit) });
  if (args.brand) base.set("brandName", String(args.brand).slice(0, 100));
  if (args.category) base.set("categoryName", String(args.category).slice(0, 100));
  if (args.min_price != null) base.set("minPrice", String(Number(args.min_price)));
  if (args.max_price != null) base.set("maxPrice", String(Number(args.max_price)));
  const browse = (q?: string) => {
    const p = new URLSearchParams(base);
    if (q) p.set("q", q.slice(0, 100));
    return call<MarketListing[]>(ctx, `/listings?${p}`).catch(() => [] as MarketListing[]);
  };

  const query = String(args.query ?? "").trim();
  let rows = await browse(query || undefined);
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3))];
  if (!rows.length && words.length > 1) {
    const found = new Map<string, MarketListing>();
    for (const batch of await Promise.all(words.slice(0, 5).map((w) => browse(w))))
      for (const r of batch) found.set(r.slug, r);
    const score = (t: string) => words.filter((w) => t.toLowerCase().includes(w)).length;
    const best = Math.max(0, ...[...found.values()].map((r) => score(r.title)));
    rows = [...found.values()].filter((r) => best > 0 && score(r.title) === best);
  }
  return { results: rows.slice(0, limit).map(toSummary), total: Math.min(rows.length, limit) };
}

interface IntentAsset {
  assetId: string;
  symbol: string;
  chain: string;
}

async function pickAsset(ctx: McpContext, payWith: unknown, chain: unknown): Promise<IntentAsset> {
  const symbol = String(payWith ?? "").trim().toUpperCase();
  const wantChain = chain ? String(chain).trim().toLowerCase() : undefined;
  const options = await call<{ enabled: boolean; assets: IntentAsset[] }>(ctx, "/near-intents/options");
  if (!options?.enabled) throw new ToolError("Paying from other chains is not available right now.");
  const asset =
    options.assets.find(
      (a) =>
        a.symbol === symbol &&
        (wantChain ? a.chain.toLowerCase() === wantChain : symbol !== "SOL" || a.chain === "Solana"),
    ) ?? (wantChain ? undefined : options.assets.find((a) => a.symbol === symbol));
  if (!asset)
    throw new ToolError(
      `Cannot pay with ${symbol}${wantChain ? ` on ${chain}` : ""}. Options: ${options.assets
        .map((a) => `${a.symbol} (${a.chain})`)
        .join(", ")}.`,
    );
  return asset;
}

const SETTLEMENT = {
  Solana: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  Base: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
};
// A dry quote only needs a well-formed refund address on the paying chain.
const SAMPLE_REFUND: Record<string, string> = {
  Solana: "DmT8iUarUdx5p1HbMxc642zAuPNm8C2chL62rcAena5w",
  Ethereum: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  Arbitrum: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  Base: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  NEAR: "alice.near",
  Bitcoin: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  Dogecoin: "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L",
  Litecoin: "ltc1qhzjptwpym9afcdjhs7jcz6fd0jma0l0rc0e5yr",
};

/** Live, non-binding price from NEAR Intents solvers; issues no deposit address. */
async function priceInCrypto(ctx: McpContext, args: Record<string, unknown>) {
  const listing = await listingOf(ctx, String(args.id ?? ""));
  const asset = await pickAsset(ctx, args.pay_with, args.chain);
  const due = Number(listing.price ?? 0) + Number(listing.shippingCost ?? 0);
  if (!(due > 0)) throw new ToolError("This piece has no buy-now price.");
  const settlementChain = listing.seller?.solanaWalletAddress ? "Solana" : "Base";
  const recipient = listing.seller?.solanaWalletAddress ?? listing.seller?.walletAddress;
  if (!recipient) throw new ToolError("This seller cannot be paid from other chains yet.");
  const res = await (ctx.fetch ?? fetch)("https://1click.chaindefuser.com/v0/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dry: true,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: asset.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: SETTLEMENT[settlementChain],
      amount: String(Math.round(due * 1e6)),
      recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo: SAMPLE_REFUND[asset.chain] ?? SAMPLE_REFUND.Solana,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      referral: "port66",
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res)
    throw new ToolError(
      "NEAR Intents is not responding right now, so no price is available. Try again in a few minutes.",
    );
  const body = (await res.json().catch(() => null)) as {
    quote?: { amountInFormatted: string; amountInUsd: string; amountOutFormatted: string; timeEstimate: number };
    message?: string;
  } | null;
  if (!res.ok || !body?.quote)
    throw new ToolError(
      res.status >= 500
        ? "NEAR Intents is not responding right now, so no price is available. Try again in a few minutes."
        : (body?.message ?? "No price available right now."),
    );
  return {
    piece: listing.title,
    price_usd: due,
    pay: { amount: body.quote.amountInFormatted, asset: asset.symbol, chain: asset.chain, usd: Number(body.quote.amountInUsd) },
    seller_receives: `${body.quote.amountOutFormatted} USDC on ${settlementChain}`,
    settles_in_seconds: body.quote.timeEstimate,
    note: "Indicative and non-binding. start_purchase reserves the piece and returns the exact amount to send.",
  };
}

// ── tools ────────────────────────────────────────────────────────────────────

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean | string>;
  run: (args: Record<string, unknown>, ctx: McpContext) => Promise<Record<string, unknown>>;
}

const READ = { readOnlyHint: true, openWorldHint: true };
const str = (description: string) => ({ type: "string", description });
const PAY_WITH = str("What the buyer pays with: BTC, SOL, NEAR, ETH, USDC, USDT, DOGE or LTC");
const CHAIN = str("Optional chain when the asset exists on several, e.g. Arbitrum for ETH");
const ID = str("Listing id (the slug from search_listings)");

export const TOOLS: Tool[] = [
  {
    name: "search_listings",
    title: "Search Port66",
    description:
      "Search active Port66 listings: luxury, streetwear and collectibles. Returns price, condition, authenticity level, image and link for each.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Words to look for in the title, e.g. 'KAWS figure' or 'Chrome Hearts'"),
        brand: str("Brand name"),
        category: str("Category name"),
        min_price: { type: "number", description: "Minimum price in USD" },
        max_price: { type: "number", description: "Maximum price in USD" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Results, default 10" },
      },
    },
    annotations: { title: "Search Port66", ...READ },
    run: (args, ctx) => searchListings(ctx, args),
  },
  {
    name: "get_listing",
    title: "Listing details",
    description: "Everything about one listing: description, condition, provenance record and how to buy it.",
    inputSchema: { type: "object", properties: { id: ID }, required: ["id"] },
    annotations: { title: "Listing details", ...READ },
    run: async (args, ctx) => toDetail(await listingOf(ctx, String(args.id ?? ""))),
  },
  {
    name: "payment_options",
    title: "Payment options",
    description: "Assets and chains a buyer can pay from. The seller always receives USDC.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Payment options", ...READ },
    run: async (_args, ctx) => {
      const o = await call<{ enabled: boolean; assets: (IntentAsset & { priceUsd?: number })[] }>(ctx, "/near-intents/options");
      return {
        available: !!o?.enabled,
        assets: (o?.assets ?? []).map((a) => ({ symbol: a.symbol, chain: a.chain })),
      };
    },
  },
  {
    name: "price_in_crypto",
    title: "Price in crypto",
    description:
      "Live, non-binding price of a listing in a crypto asset, from NEAR Intents solvers: what the buyer would send so the seller receives the exact USD price in USDC. Reserves nothing.",
    inputSchema: {
      type: "object",
      properties: { id: ID, pay_with: PAY_WITH, chain: CHAIN },
      required: ["id", "pay_with"],
    },
    annotations: { title: "Price in crypto", ...READ },
    run: (args, ctx) => priceInCrypto(ctx, args),
  },
  {
    name: "start_purchase",
    title: "Start a purchase",
    description:
      "Reserve a listing for the signed-in buyer and get a one-time NEAR Intents deposit address and the exact amount to send. Nothing is charged by this call; the purchase completes when the buyer's wallet sends that amount. Needs a Port66 session.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        pay_with: PAY_WITH,
        chain: CHAIN,
        refund_to: str("The buyer's own address on the paying chain; refunds go here"),
        shipping_address: {
          type: "object",
          description: "Where the piece is shipped",
          properties: {
            name: { type: "string" },
            line1: { type: "string" },
            line2: { type: "string" },
            city: { type: "string" },
            region: { type: "string" },
            postal: { type: "string" },
            country: { type: "string" },
            phone: { type: "string" },
          },
          required: ["name", "line1", "city", "postal", "country"],
        },
      },
      required: ["id", "pay_with", "refund_to", "shipping_address"],
    },
    annotations: { title: "Start a purchase", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (args, ctx) => {
      requireSession(ctx);
      const listing = await listingOf(ctx, String(args.id ?? ""));
      const asset = await pickAsset(ctx, args.pay_with, args.chain);
      const checkout = await call<Record<string, unknown> & {
        id: string;
        state: string;
        pay: { amount: string; amountBaseUnits: string; symbol: string; chain: string; depositAddress: string; depositMemo?: string; amountUsd: string };
        sellerReceivesUsdc: string;
        settlementChain?: string;
        deadline: string;
      }>(ctx, "/near-intents/quote", {
        method: "POST",
        auth: true,
        body: {
          listingId: listing.id,
          originAsset: asset.assetId,
          refundTo: String(args.refund_to ?? ""),
          shippingAddress: args.shipping_address ?? {},
        },
      });
      return {
        checkout_id: checkout.id,
        state: checkout.state,
        send: {
          amount: checkout.pay.amount,
          amount_base_units: checkout.pay.amountBaseUnits,
          asset: checkout.pay.symbol,
          chain: checkout.pay.chain,
          to: checkout.pay.depositAddress,
          ...(checkout.pay.depositMemo ? { memo: checkout.pay.depositMemo } : {}),
          usd: Number(checkout.pay.amountUsd),
        },
        seller_receives: `${checkout.sellerReceivesUsdc} USDC on ${checkout.settlementChain ?? "Solana"}`,
        pay_before: checkout.deadline,
        next: "Send exactly send.amount to send.to, then call purchase_status until state is 'paid'.",
      };
    },
  },
  {
    name: "purchase_status",
    title: "Purchase status",
    description:
      "Progress of a purchase: awaiting_deposit, deposit_seen, processing, paid (order recorded), refunded, failed, expired or review. Needs a Port66 session.",
    inputSchema: {
      type: "object",
      properties: { checkout_id: str("The checkout_id from start_purchase") },
      required: ["checkout_id"],
    },
    annotations: { title: "Purchase status", ...READ },
    run: async (args, ctx) => {
      const c = await call<Record<string, unknown> & {
        state: string;
        orderId?: string;
        originTx: { explorerUrl: string }[];
        deliveryTx: { explorerUrl: string }[];
      }>(ctx, `/near-intents/checkouts/${encodeURIComponent(String(args.checkout_id ?? ""))}`, { auth: true });
      return {
        state: c.state,
        order_id: c.orderId ?? null,
        buyer_payment: c.originTx.map((t) => t.explorerUrl),
        seller_paid: c.deliveryTx.map((t) => t.explorerUrl),
      };
    },
  },
  {
    name: "report_deposit",
    title: "Report a deposit",
    description: "Tell Port66 the hash of the buyer's deposit transaction. Optional; it only speeds up detection.",
    inputSchema: {
      type: "object",
      properties: {
        checkout_id: str("The checkout_id from start_purchase"),
        tx_hash: str("Hash of the deposit transaction"),
      },
      required: ["checkout_id", "tx_hash"],
    },
    annotations: { title: "Report a deposit", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (args, ctx) => {
      const c = await call<{ state: string }>(
        ctx,
        `/near-intents/checkouts/${encodeURIComponent(String(args.checkout_id ?? ""))}/deposit`,
        { method: "POST", auth: true, body: { txHash: String(args.tx_hash ?? "") } },
      );
      return { state: c.state };
    },
  },
  {
    name: "make_offer",
    title: "Make an offer",
    description:
      "Offer the seller a price below the listed one, with a message. The seller has 24 hours to answer. If accepted, start_purchase charges the agreed amount. Needs a Port66 session.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        amount_usd: { type: "number", minimum: 1, description: "Offered price in USD" },
        message: str("A short, polite note to the seller"),
      },
      required: ["id", "amount_usd"],
    },
    annotations: { title: "Make an offer", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (args, ctx) => {
      requireSession(ctx);
      const listing = await listingOf(ctx, String(args.id ?? ""));
      const offer = await call<{ id: string; status: string; expiresAt: string }>(
        ctx,
        `/listings/${encodeURIComponent(listing.id)}/offer`,
        {
          method: "POST",
          auth: true,
          body: { amount: Number(args.amount_usd), ...(args.message ? { message: String(args.message) } : {}) },
        },
      );
      return { offer_id: offer.id, status: offer.status, expires_at: offer.expiresAt };
    },
  },
  {
    name: "offer_status",
    title: "Offer status",
    description: "The buyer's latest offer on a listing, and the agreed price if the seller accepted. Needs a Port66 session.",
    inputSchema: { type: "object", properties: { id: ID }, required: ["id"] },
    annotations: { title: "Offer status", ...READ },
    run: async (args, ctx) => {
      requireSession(ctx);
      const listing = await listingOf(ctx, String(args.id ?? ""));
      const s = await call<{ offer: { amountUsd: number; status: string; expiresAt: string } | null; payableAt: number | null }>(
        ctx,
        `/near-intents/offers/${encodeURIComponent(listing.id)}`,
        { auth: true },
      );
      return {
        offer: s.offer ? { amount_usd: s.offer.amountUsd, status: s.offer.status, expires_at: s.offer.expiresAt } : null,
        agreed_price_usd: s.payableAt,
      };
    },
  },
];

export const MCP_URL = `${SITE}/api/mcp`;
