import { privateKeyToAccount } from "viem/accounts";
import type { Candidate } from "./mandate.js";

/**
 * Port66's public HTTP API, as the agent uses it. Browsing needs no account;
 * buying signs in with the agent's own wallet (Sign-In with Ethereum), which
 * gives the agent its own Port66 account exactly as a person would get one.
 */

export interface IntentAsset {
  assetId: string;
  symbol: string;
  chain: string;
  decimals: number;
  priceUsd: number;
}

export interface IntentCheckout {
  id: string;
  state:
    | "awaiting_deposit"
    | "deposit_seen"
    | "incomplete_deposit"
    | "processing"
    | "paid"
    | "refunded"
    | "failed"
    | "expired"
    | "review";
  listingId: string;
  pay: {
    assetId: string;
    symbol: string;
    chain: string;
    amount: string;
    /** Exact amount to send, in base units (lamports for SOL). */
    amountBaseUnits: string;
    amountUsd: string;
    depositAddress: string;
    depositMemo?: string;
  };
  sellerReceivesUsdc: string;
  deadline: string;
  timeEstimate: number;
  originTx: { hash: string; explorerUrl: string }[];
  deliveryTx: { hash: string; explorerUrl: string }[];
  orderId?: string;
}

interface ListingRow {
  id: string;
  slug: string;
  title: string;
  price: string | null;
  shippingCost?: string | null;
  status: string;
  listingType?: string;
}

interface ListingDetail extends ListingRow {
  seller?: {
    username?: string;
    sellerRating?: number | string | null;
    solanaWalletAddress?: string | null;
    walletAddress?: string | null;
  } | null;
}

export class Port66Error extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Port66 {
  readonly site: string;
  private readonly api: string;
  private token?: string;

  constructor(site = "https://port66.xyz") {
    this.site = site.replace(/\/+$/, "");
    this.api = `${this.site}/api/v1`;
  }

  listingUrl(slug: string) {
    return `${this.site}/listing/${slug}`;
  }

  /**
   * Active buy-now listings for a query, with what the agent needs.
   *
   * Port66's search matches the whole query as one phrase, so "KAWS figure"
   * finds nothing while "KAWS" finds the KAWS Elmo figure. The agent searches
   * word by word and keeps the listings whose titles match the most words.
   */
  async search(query: string, maxPriceUsd?: number): Promise<Candidate[]> {
    const words = [...new Set(query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3))].slice(0, 5);
    const terms = words.length ? words : [query];
    const rows = new Map<string, ListingRow>();
    await Promise.all(
      terms.map(async (term) => {
        const params = new URLSearchParams({ q: term, limit: "10", status: "ACTIVE" });
        if (maxPriceUsd) params.set("maxPrice", String(Math.ceil(maxPriceUsd)));
        const found = await this.get<ListingRow[]>(`/listings?${params}`).catch(() => []);
        for (const r of found ?? []) rows.set(r.id, r);
      }),
    );
    const score = (title: string) => terms.filter((t) => title.toLowerCase().includes(t)).length;
    const buyable = [...rows.values()].filter((r) => r.status === "ACTIVE" && Number(r.price) > 0);
    const best = Math.max(0, ...buyable.map((r) => score(r.title)));
    const relevant = buyable.filter((r) => best > 0 && score(r.title) === best).slice(0, 8);
    const details = await Promise.all(
      relevant.map((r) =>
        this.get<ListingDetail>(`/listings/${encodeURIComponent(r.slug)}`).catch(() => null),
      ),
    );
    return details
      .filter((d): d is ListingDetail => !!d && d.status === "ACTIVE")
      .map((d) => this.candidate(d));
  }

  async listing(slug: string): Promise<Candidate & { seller?: string }> {
    const d = await this.get<ListingDetail>(`/listings/${encodeURIComponent(slug)}`);
    return { ...this.candidate(d), seller: d.seller?.username };
  }

  async sellerName(slug: string): Promise<string | undefined> {
    const d = await this.get<ListingDetail>(`/listings/${encodeURIComponent(slug)}`);
    return d.seller?.username;
  }

  async intentAssets(): Promise<IntentAsset[]> {
    const res = await this.get<{ enabled: boolean; assets: IntentAsset[] }>(
      "/near-intents/options",
    );
    if (!res?.enabled)
      throw new Port66Error(503, "Port66 is not accepting payments from other chains right now.");
    return res.assets;
  }

  /**
   * Sign in with the agent's EVM key (EIP-4361). Only a signature leaves the
   * machine; the key itself never does.
   */
  async signIn(evmPrivateKey: `0x${string}`): Promise<string> {
    const account = privateKeyToAccount(evmPrivateKey);
    const { nonce, nonceJwt } = await this.raw<{ nonce: string; nonceJwt: string }>(
      `${this.site}/api/auth/nonce`,
    );
    const host = new URL(this.site).host;
    const message = [
      `${host} wants you to sign in with your Ethereum account:`,
      account.address,
      "",
      "Sign in to Port66.",
      "",
      `URI: ${this.site}`,
      "Version: 1",
      "Chain ID: 8453",
      `Nonce: ${nonce}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
    const signature = await account.signMessage({ message });
    const { token } = await this.raw<{ token: string }>(`${this.site}/api/auth/verify`, {
      method: "POST",
      body: JSON.stringify({ message, signature, nonceJwt }),
    });
    if (!token) throw new Port66Error(401, "Sign-in returned no session.");
    this.token = token;
    return account.address;
  }

  quote(input: {
    listingId: string;
    originAsset: string;
    refundTo: string;
    shippingAddress: Record<string, string>;
  }): Promise<IntentCheckout> {
    return this.post<IntentCheckout>("/near-intents/quote", input);
  }

  checkout(id: string): Promise<IntentCheckout> {
    return this.get<IntentCheckout>(`/near-intents/checkouts/${id}`);
  }

  reportDeposit(id: string, txHash: string): Promise<IntentCheckout> {
    return this.post<IntentCheckout>(`/near-intents/checkouts/${id}/deposit`, { txHash });
  }

  /** The agent's latest offer on a listing; `payableAt` is set once accepted. */
  offerStatus(listingId: string): Promise<{
    offer: { id: string; amountUsd: number; status: string; expiresAt: string } | null;
    payableAt: number | null;
  }> {
    return this.get(`/near-intents/offers/${listingId}`);
  }

  offer(listingId: string, amount: number, message: string): Promise<{ id: string }> {
    return this.post<{ id: string }>(`/listings/${listingId}/offer`, { amount, message });
  }

  private get<T>(path: string): Promise<T> {
    return this.call<T>(path, { method: "GET" });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    const json = await this.raw<{ data?: T }>(`${this.api}${path}`, init);
    return (json && typeof json === "object" && "data" in json ? json.data : json) as T;
  }

  private async raw<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const msg =
        (body as { message?: unknown; error?: unknown })?.message ??
        (body as { error?: unknown })?.error ??
        text.slice(0, 200);
      throw new Port66Error(
        res.status,
        Array.isArray(msg) ? msg.join("; ") : String(msg || `HTTP ${res.status}`),
      );
    }
    return body as T;
  }

  private candidate(d: ListingDetail): Candidate {
    const rating = d.seller?.sellerRating;
    return {
      id: d.id,
      slug: d.slug,
      title: d.title,
      priceUsd: Number(d.price ?? 0),
      shippingUsd: Number(d.shippingCost ?? 0),
      sellerRating:
        rating === null || rating === undefined || Number(rating) === 0
          ? null
          : Number(rating),
      // Port66 pays sellers in USDC on Solana, or on Base when they have only
      // an EVM wallet.
      sellerCanReceive: !!(d.seller?.solanaWalletAddress || d.seller?.walletAddress),
      sellerWallet: d.seller?.solanaWalletAddress ?? d.seller?.walletAddress ?? undefined,
      sellerChain: d.seller?.solanaWalletAddress ? "Solana" : "Base",
    };
  }
}
