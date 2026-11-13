/**
 * Minimal client for NEAR Intents' 1Click Swap API.
 *
 * Deliberately dependency-free (global fetch only, no Nest, no SDK) so this
 * file can be lifted out of Port66 unchanged: the same client backs the API
 * module, the dry-run script and the buyer agent.
 *
 * Docs: https://docs.near-intents.org (1Click API). Flow:
 *
 *   tokens()        GET  /v0/tokens          assets a buyer can pay with
 *   quote()         POST /v0/quote           price + a one-time deposit address
 *   submitDeposit() POST /v0/deposit/submit  optional, speeds up detection
 *   status()        GET  /v0/status          poll until SUCCESS | REFUNDED | FAILED
 *
 * NEAR Intents has no testnet. Use `dry: true` quotes (no deposit address is
 * issued, nothing can be funded) or tiny mainnet amounts when testing.
 */

export const ONE_CLICK_BASE_URL = "https://1click.chaindefuser.com";

export type OneClickSwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT";

export type OneClickStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt?: string;
  contractAddress?: string;
}

export interface OneClickQuoteRequest {
  /** true = price only: no deposit address is issued and nothing can be paid. */
  dry: boolean;
  swapType: OneClickSwapType;
  /** Basis points; 100 = 1%. With EXACT_OUTPUT it applies to the input side. */
  slippageTolerance: number;
  originAsset: string;
  destinationAsset: string;
  /** Base units, integer string. For EXACT_OUTPUT: what the recipient gets. */
  amount: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS";
  /** ISO time. An unfilled or late deposit is refunded to `refundTo`. */
  deadline: string;
  referral?: string;
  /** Fee in basis points of amountIn, paid to an Intents account. */
  appFees?: { recipient: string; fee: number }[];
}

export interface OneClickQuote {
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  /** Seconds, counted from the deposit confirming on its own chain. */
  timeEstimate: number;
  /** Absent on a dry quote. */
  depositAddress?: string;
  /** Present for chains that route deposits by memo; must be echoed back. */
  depositMemo?: string;
  deadline?: string;
  timeWhenInactive?: string;
}

export interface OneClickQuoteResponse {
  correlationId: string;
  timestamp: string;
  /** Solver-side signature over the quote. Keep it: it settles disputes. */
  signature: string;
  quoteRequest: OneClickQuoteRequest;
  quote: OneClickQuote;
}

export interface OneClickTx {
  hash: string;
  explorerUrl: string;
}

export interface OneClickStatusResponse {
  correlationId: string;
  status: OneClickStatus;
  updatedAt: string;
  quoteResponse: OneClickQuoteResponse;
  swapDetails: {
    amountIn?: string;
    amountInFormatted?: string;
    amountOut?: string;
    amountOutFormatted?: string;
    refundedAmount?: string;
    refundedAmountFormatted?: string;
    originChainTxHashes: OneClickTx[];
    destinationChainTxHashes: OneClickTx[];
  };
}

/** A non-2xx answer from 1Click, carrying its own message. */
export class OneClickError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OneClickError";
  }
}

export interface OneClickClientOptions {
  /**
   * Partner key from partners.near-intents.org. Optional: without it every
   * quote carries an extra 0.25% platform fee, but the API still works.
   */
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export class OneClickClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OneClickClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ONE_CLICK_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.fetchImpl = options.fetch ?? fetch;
  }

  tokens(): Promise<OneClickToken[]> {
    return this.request<OneClickToken[]>("GET", "/v0/tokens");
  }

  quote(request: OneClickQuoteRequest): Promise<OneClickQuoteResponse> {
    return this.request<OneClickQuoteResponse>("POST", "/v0/quote", request);
  }

  /** Tell 1Click about a broadcast deposit so it need not wait to spot it. */
  submitDeposit(input: {
    depositAddress: string;
    txHash: string;
    memo?: string;
  }): Promise<unknown> {
    return this.request("POST", "/v0/deposit/submit", {
      depositAddress: input.depositAddress,
      txHash: input.txHash,
      ...(input.memo ? { memo: input.memo } : {}),
    });
  }

  status(
    depositAddress: string,
    depositMemo?: string,
  ): Promise<OneClickStatusResponse> {
    const query = new URLSearchParams({ depositAddress });
    if (depositMemo) query.set("depositMemo", depositMemo);
    return this.request<OneClickStatusResponse>(
      "GET",
      `/v0/status?${query.toString()}`,
    );
  }

  /**
   * One retry on a transport failure (connection reset, timeout). Safe for
   * every call here: reads are idempotent, a repeated deposit hint is a
   * no-op, and a repeated quote only issues an address nobody is shown.
   * An HTTP answer, even an error, is final and is never retried.
   */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      return await this.send<T>(method, path, body);
    } catch (error) {
      if (!(error instanceof OneClickError) || error.status !== 504)
        throw error;
      return this.send<T>(method, path, body);
    }
  }

  private async send<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        let message = text.slice(0, 300);
        try {
          const parsed = JSON.parse(text) as { message?: unknown };
          if (typeof parsed.message === "string") message = parsed.message;
        } catch {
          // Not JSON: keep the raw text.
        }
        throw new OneClickError(
          res.status,
          message || `1Click returned HTTP ${res.status}`,
        );
      }
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (error) {
      if (error instanceof OneClickError) throw error;
      const aborted = (error as { name?: string })?.name === "AbortError";
      throw new OneClickError(
        504,
        aborted ? "1Click timed out" : "1Click is unreachable",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** True once a swap can no longer change state. */
export function isTerminal(status: OneClickStatus): boolean {
  return status === "SUCCESS" || status === "REFUNDED" || status === "FAILED";
}
