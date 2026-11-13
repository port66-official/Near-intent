import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { encryptPII } from "../../common/pii/pii-crypto";
import {
  CheckoutStateService,
  INTENTS_RAIL,
} from "../payments/checkout-state.service";
import { PaymentsService } from "../payments/payments.service";
import { getSolanaPaymentConfig } from "../payments/verify-solana";
import { basePayoutWallet } from "../payments/payout-wallet";
import {
  OneClickClient,
  OneClickError,
  type OneClickStatusResponse,
  type OneClickToken,
} from "./one-click.client";
import {
  payableAssets,
  payableSpec,
  platformFee,
  settlementFor,
  type PayableAsset,
  type SettlementKey,
} from "./intent-assets";

/**
 * "Pay from any chain" checkout on NEAR Intents.
 *
 * The buyer pays in whatever they hold (BTC, SOL, NEAR, ETH...) to a one-time
 * deposit address. NEAR Intents solvers deliver the exact USDC price straight
 * to the seller's Solana wallet, and refund the buyer on their own chain if
 * the swap cannot complete. There is no bridge step and no second payment.
 *
 * Port66 never holds the money. Its job is the two things a swap API cannot
 * know: keeping the item reserved while a payment is in flight, and deciding
 * that an order is paid. The latter is never taken from the client or from
 * the provider's word alone: an order is recorded only when
 *   1. the provider reports SUCCESS for the deposit address saved on the
 *      buyer's own reserved checkout,
 *   2. that swap was quoted for this checkout's seller wallet and amount, and
 *   3. the delivery transaction on Solana really credited the seller's wallet
 *      with at least the reserved amount (checked against an RPC node).
 */

/** Hold the item a little past the quote, for a deposit sent at the wire. */
const HOLD_GRACE_MS = 20 * 60_000;
/** A saved quote this close to lapsing is replaced rather than resumed. */
const MIN_RESUME_MS = 3 * 60_000;
const TOKEN_CACHE_MS = 60_000;

type IntentRow = Awaited<ReturnType<CheckoutStateService["own"]>>;

/** What is saved on CheckoutIntent.bridge for this rail. */
interface SavedQuote {
  provider: "near-intents";
  originAsset: string;
  symbol: string;
  chain: string;
  depositAddress: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  deadline: string;
  timeEstimate: number;
  /** Solver signature over the quote, kept for disputes. */
  signature: string;
  correlationId: string;
}

export type IntentCheckoutState =
  | "awaiting_deposit"
  | "deposit_seen"
  | "incomplete_deposit"
  | "processing"
  | "paid"
  | "refunded"
  | "failed"
  | "expired"
  | "review";

export interface IntentCheckoutView {
  id: string;
  state: IntentCheckoutState;
  listingId: string;
  pay: {
    assetId: string;
    symbol: string;
    chain: string;
    amount: string;
    /** Exact amount to send, in the asset's base units (lamports, sats...). */
    amountBaseUnits: string;
    amountUsd: string;
    depositAddress: string;
    depositMemo?: string;
  };
  /** USDC the seller receives, human-readable. */
  sellerReceivesUsdc: string;
  /** Where the seller is paid: "Solana" or "Base". */
  settlementChain: string;
  deadline: string;
  /** Seconds from deposit confirmation to delivery, per the solver quote. */
  timeEstimate: number;
  originTx: { hash: string; explorerUrl: string }[];
  deliveryTx: { hash: string; explorerUrl: string }[];
  refundedAmount?: string;
  orderId?: string;
}

@Injectable()
export class NearIntentsService {
  private readonly logger = new Logger(NearIntentsService.name);
  private readonly client = new OneClickClient({
    apiKey: process.env.NEAR_INTENTS_API_KEY,
  });
  private tokenCache?: { tokens: OneClickToken[]; expires: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly checkout: CheckoutStateService,
    private readonly payments: PaymentsService,
  ) {}

  /** NEAR Intents is mainnet-only; the rail is on when the flag is. */
  enabled(): boolean {
    return process.env.NEAR_INTENTS_ENABLED === "true";
  }

  /**
   * Where to pay this seller: their Solana wallet when Solana mainnet
   * payments are on (the default), otherwise their Base payout wallet.
   */
  private settlementOf(seller: {
    solanaWalletAddress?: string | null;
    walletAddress?: string | null;
    payoutWalletAddress?: string | null;
  } | null): { key: SettlementKey; wallet: string } | null {
    const solana = getSolanaPaymentConfig();
    if (
      seller?.solanaWalletAddress &&
      solana.enabled &&
      solana.cluster === "mainnet-beta"
    )
      return { key: "mainnet-beta", wallet: seller.solanaWalletAddress };
    const base = seller ? basePayoutWallet(seller as never) : undefined;
    return base ? { key: "base", wallet: base } : null;
  }

  private assertEnabled() {
    if (!this.enabled())
      throw new ServiceUnavailableException(
        "Paying from another chain is not available right now.",
      );
  }

  async options(): Promise<{ enabled: boolean; assets: PayableAsset[] }> {
    if (!this.enabled()) return { enabled: false, assets: [] };
    try {
      return { enabled: true, assets: payableAssets(await this.tokens()) };
    } catch {
      // The picker simply does not appear while the provider is unreachable.
      return { enabled: false, assets: [] };
    }
  }

  /**
   * Reserve the item and issue a deposit address for it. Calling again with
   * the same asset resumes the saved quote; a different asset replaces it,
   * but only while nothing has been deposited.
   */
  async quote(
    buyerId: string,
    input: {
      listingId: string;
      originAsset: string;
      refundTo: string;
      shippingAddress?: Record<string, string>;
    },
  ): Promise<IntentCheckoutView> {
    this.assertEnabled();
    const spec = payableSpec(input.originAsset);
    if (!spec) throw new BadRequestException("That asset is not supported.");
    const refundTo = (input.refundTo ?? "").trim();
    if (!refundTo || refundTo.length > 128)
      throw new BadRequestException(
        "Enter the address to refund if the payment cannot complete.",
      );
    const asset = payableAssets(await this.tokens()).find(
      (a) => a.assetId === spec.assetId,
    );
    if (!asset)
      throw new BadRequestException(
        "That asset is temporarily unavailable. Choose another.",
      );

    const listing = await this.prisma.listing.findUnique({
      where: { id: input.listingId },
      select: {
        id: true,
        status: true,
        sellerId: true,
        seller: {
          select: {
            solanaWalletAddress: true,
            walletAddress: true,
            payoutWalletAddress: true,
          },
        },
      },
    });
    if (!listing) throw new NotFoundException("Listing not found");
    if (listing.status !== "ACTIVE" || listing.sellerId === buyerId)
      throw new BadRequestException("This item is no longer available.");
    const target = this.settlementOf(listing.seller);
    if (!target)
      throw new BadRequestException(
        "This seller cannot receive payments from other chains yet.",
      );
    const sellerWallet = target.wallet;
    const settlement = settlementFor(target.key);

    // An open checkout of the buyer's own on this item: resume or replace.
    const open = await this.checkout.intentsFor(buyerId, listing.id);
    if (open) {
      const view = await this.refresh(open);
      const saved = open.bridge as unknown as SavedQuote | null;
      const resumable =
        view.state === "awaiting_deposit" &&
        saved?.originAsset === spec.assetId &&
        open.payer === refundTo &&
        Date.parse(saved.deadline) - Date.now() > MIN_RESUME_MS;
      // Money is moving (or has moved): never issue a second deposit address
      // for the same item.
      const inFlight = (
        [
          "deposit_seen",
          "incomplete_deposit",
          "processing",
          "paid",
          "review",
        ] as IntentCheckoutState[]
      ).includes(view.state);
      if (inFlight || resumable) return view;
      // Awaiting a deposit that never came, or already ended unpaid: free
      // the item (a no-op if refresh just did) and quote afresh.
      await this.checkout.intentsRelease(open.id);
    }

    // A price the seller agreed to: their acceptance of this buyer's offer,
    // while that offer is still live. Otherwise the listed price applies.
    const accepted = await this.prisma.offer.findFirst({
      where: {
        listingId: listing.id,
        buyerId,
        status: "ACCEPTED",
        expiresAt: { gt: new Date() },
      },
      orderBy: { updatedAt: "desc" },
      select: { amount: true },
    });
    const agreedPrice = accepted ? Number(accepted.amount) : undefined;

    const intent = await this.checkout.reserve(
      buyerId,
      [listing.id],
      INTENTS_RAIL,
      refundTo,
      sellerWallet,
      target.key,
      agreedPrice && agreedPrice > 0 ? agreedPrice : undefined,
    );

    const deadline = new Date(Date.now() + spec.windowMinutes * 60_000);
    const fee = platformFee();
    let saved: SavedQuote;
    try {
      const res = await this.client.quote({
        dry: false,
        // The seller is owed an exact price, so the output is fixed and the
        // solver quotes the input. Any excess the buyer sends is refunded.
        swapType: "EXACT_OUTPUT",
        slippageTolerance: 100,
        originAsset: spec.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: settlement.assetId,
        // Reserved snapshot (item + postage) in USDC base units: decided by
        // the server when the item was held, never by the client.
        amount: intent.amount,
        recipient: sellerWallet,
        recipientType: "DESTINATION_CHAIN",
        refundTo,
        refundType: "ORIGIN_CHAIN",
        deadline: deadline.toISOString(),
        referral: "port66",
        ...(fee ? { appFees: [fee] } : {}),
      });
      const q = res.quote;
      if (!q.depositAddress)
        throw new OneClickError(502, "No deposit address was issued.");
      if (BigInt(q.amountOut) < BigInt(intent.amount))
        throw new OneClickError(502, "The quote does not cover the price.");
      saved = {
        provider: "near-intents",
        originAsset: spec.assetId,
        symbol: asset.symbol,
        chain: asset.chain,
        depositAddress: q.depositAddress,
        ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}),
        amountIn: q.amountIn,
        amountInFormatted: q.amountInFormatted,
        amountInUsd: q.amountInUsd,
        deadline: q.deadline ?? deadline.toISOString(),
        timeEstimate: q.timeEstimate,
        signature: res.signature,
        correlationId: res.correlationId,
      };
    } catch (error) {
      await this.checkout.intentsRelease(intent.id);
      if (error instanceof OneClickError && error.status < 500)
        // 1Click's 4xx messages are written for the payer ("refundTo is not
        // a valid address", "amount is too low for bridge...").
        throw new BadRequestException(error.message);
      this.logger.warn(`1Click quote failed: ${(error as Error)?.message}`);
      throw new ServiceUnavailableException(
        "Could not get a quote right now. Nothing was charged; try again.",
      );
    }

    const row = await this.checkout.attachIntentsQuote(intent.id, {
      bridge: saved as never,
      providerId: `near-intents:${saved.depositAddress}${
        saved.depositMemo ? `:${saved.depositMemo}` : ""
      }`,
      expiresAt: new Date(Date.parse(saved.deadline) + HOLD_GRACE_MS),
      shippingAddress: input.shippingAddress
        ? encryptPII(input.shippingAddress)
        : undefined,
    });
    return this.view(row, "awaiting_deposit");
  }

  /**
   * The buyer's latest offer on a listing and whether it can be paid at the
   * agreed price now. Lets a buyer (or their agent) learn that a seller
   * accepted before paying, instead of reserving the item to find out.
   */
  async offerFor(buyerId: string, listingId: string) {
    const offer = await this.prisma.offer.findFirst({
      where: { listingId, buyerId },
      orderBy: { createdAt: "desc" },
      select: { id: true, amount: true, status: true, expiresAt: true },
    });
    if (!offer) return { offer: null, payableAt: null };
    const live = offer.expiresAt > new Date();
    return {
      offer: {
        id: offer.id,
        amountUsd: Number(offer.amount),
        status: offer.status,
        expiresAt: offer.expiresAt.toISOString(),
      },
      payableAt:
        offer.status === "ACCEPTED" && live ? Number(offer.amount) : null,
    };
  }

  /**
   * A seller's sales paid through NEAR Intents, as a CSV a bookkeeper can
   * open without questions: one row per order, in USDC, with the on-chain
   * receipt for each.
   */
  async salesCsv(sellerId: string): Promise<string> {
    const orders = await this.prisma.order.findMany({
      where: { sellerId, tokenSymbol: { contains: "_VIA_" } },
      orderBy: { paidAt: "desc" },
      take: 5000,
      select: {
        id: true,
        paidAt: true,
        createdAt: true,
        finalPrice: true,
        shippingCost: true,
        sellerPayout: true,
        status: true,
        tokenSymbol: true,
        transactionHash: true,
        listing: { select: { title: true } },
      },
    });
    const cell = (v: unknown) => {
      const text = v === null || v === undefined ? "" : String(v);
      // Neutralise spreadsheet formulas as well as quoting separators.
      const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const head = [
      "date_utc",
      "order_id",
      "item",
      "item_price_usdc",
      "shipping_usdc",
      "received_usdc",
      "received_on",
      "buyer_paid_with",
      "status",
      "receipt_url",
    ];
    const rows = orders.map((o) =>
      [
        (o.paidAt ?? o.createdAt).toISOString().replace("T", " ").slice(0, 19),
        o.id,
        o.listing?.title,
        Number(o.finalPrice).toFixed(2),
        Number(o.shippingCost ?? 0).toFixed(2),
        Number(o.sellerPayout).toFixed(2),
        o.tokenSymbol?.startsWith("USDC_BASE") ? "Base" : "Solana",
        o.tokenSymbol?.split("_VIA_")[1] ?? "",
        o.status,
        o.transactionHash
          ? (o.tokenSymbol?.startsWith("USDC_BASE")
              ? settlementFor("base")
              : settlementFor("mainnet-beta")
            ).explorer(o.transactionHash)
          : "",
      ]
        .map(cell)
        .join(","),
    );
    return [head.join(","), ...rows].join("\n") + "\n";
  }

  /** Optional hint that a deposit was broadcast; speeds up detection. */
  async submitDeposit(buyerId: string, id: string, txHash: string) {
    const intent = await this.own(buyerId, id);
    const saved = intent.bridge as unknown as SavedQuote;
    const hash = (txHash ?? "").trim();
    if (!hash || hash.length > 128)
      throw new BadRequestException("Invalid transaction reference");
    // Best effort, and deliberately NOT a state change: a claimed hash is
    // unverified, so it must not extend the hold. Only the provider seeing
    // the deposit does that (see refresh).
    await this.client
      .submitDeposit({
        depositAddress: saved.depositAddress,
        txHash: hash,
        memo: saved.depositMemo,
      })
      .catch(() => undefined);
    return this.refresh(intent);
  }

  async status(buyerId: string, id: string): Promise<IntentCheckoutView> {
    return this.refresh(await this.own(buyerId, id));
  }

  /**
   * Advance every open Intents checkout. The buyer's browser normally drives
   * this by polling, but a buyer who pays and closes the tab must still get
   * their order, so a scheduler calls it too.
   */
  async reconcile(): Promise<{ checked: number; paid: number }> {
    if (!this.enabled()) return { checked: 0, paid: 0 };
    const open = await this.prisma.checkoutIntent.findMany({
      where: {
        rail: INTENTS_RAIL,
        status: { in: ["RESERVED", "PROVIDER"] },
        providerId: { not: null },
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    let paid = 0;
    for (const intent of open) {
      try {
        if ((await this.refresh(intent)).state === "paid") paid += 1;
      } catch (error) {
        this.logger.warn(
          `Reconcile failed for ${intent.id}: ${(error as Error)?.message}`,
        );
      }
    }
    return { checked: open.length, paid };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async own(buyerId: string, id: string): Promise<IntentRow> {
    const intent = await this.checkout.own(buyerId, id);
    if (intent.rail !== INTENTS_RAIL || !intent.bridge)
      throw new NotFoundException("Checkout not found");
    return intent;
  }

  /**
   * Read the provider's state for a checkout and move ours to match:
   * extend the hold once a deposit is seen, free the item when nothing will
   * arrive, and record the order once the seller has verifiably been paid.
   */
  private async refresh(intent: IntentRow): Promise<IntentCheckoutView> {
    const saved = intent.bridge as unknown as SavedQuote | null;
    if (!saved?.depositAddress)
      // Reserved but never quoted (the quote call died): nothing can arrive.
      return this.view(intent, "expired");
    if (intent.status === "PAID") return this.paidView(intent);
    if (intent.status === "REVIEW") return this.view(intent, "review");

    let remote: OneClickStatusResponse;
    try {
      remote = await this.client.status(
        saved.depositAddress,
        saved.depositMemo,
      );
    } catch (error) {
      // 1Click answers 404 until it has seen the address in use; treat any
      // failure to read as "nothing new" and never as a failed payment.
      const lapsed = Date.parse(saved.deadline) + HOLD_GRACE_MS < Date.now();
      if (
        lapsed &&
        error instanceof OneClickError &&
        error.status === 404 &&
        intent.status === "RESERVED"
      ) {
        await this.checkout.intentsRelease(intent.id);
        return this.view(intent, "expired");
      }
      return this.view(
        intent,
        intent.status === "PROVIDER"
          ? "processing"
          : intent.status === "EXPIRED"
            ? "expired"
            : "awaiting_deposit",
      );
    }

    switch (remote.status) {
      case "PENDING_DEPOSIT":
        if (Date.parse(saved.deadline) < Date.now()) {
          await this.checkout.intentsRelease(intent.id);
          return this.view(intent, "expired", remote);
        }
        return this.view(intent, "awaiting_deposit", remote);
      case "KNOWN_DEPOSIT_TX":
        await this.checkout.intentsInFlight(intent.id);
        return this.view(intent, "deposit_seen", remote);
      case "INCOMPLETE_DEPOSIT":
        await this.checkout.intentsInFlight(intent.id);
        return this.view(intent, "incomplete_deposit", remote);
      case "PROCESSING":
        await this.checkout.intentsInFlight(intent.id);
        return this.view(intent, "processing", remote);
      case "REFUNDED":
        await this.checkout.intentsRelease(intent.id);
        return this.view(intent, "refunded", remote);
      case "FAILED":
        await this.checkout.intentsRelease(intent.id);
        return this.view(intent, "failed", remote);
      case "SUCCESS":
        return this.settle(intent, saved, remote);
      default:
        return this.view(intent, "processing", remote);
    }
  }

  private async settle(
    intent: IntentRow,
    saved: SavedQuote,
    remote: OneClickStatusResponse,
  ): Promise<IntentCheckoutView> {
    // The provider's record must be the swap this checkout asked for.
    const asked = remote.quoteResponse?.quoteRequest;
    const settlement = settlementFor(intent.cluster);
    // EVM addresses compare case-insensitively; Solana's are case-sensitive.
    const sameRecipient =
      intent.cluster === "base"
        ? asked?.recipient?.toLowerCase() === intent.recipient.toLowerCase()
        : asked?.recipient === intent.recipient;
    const matches =
      !!settlement &&
      sameRecipient &&
      asked?.destinationAsset === settlement.assetId &&
      asked?.swapType === "EXACT_OUTPUT" &&
      /^\d+$/.test(asked?.amount ?? "") &&
      BigInt(asked.amount) >= BigInt(intent.amount);
    if (!matches) {
      this.logger.error(`Intents checkout ${intent.id}: provider mismatch`);
      await this.checkout.intentsReview(intent.id);
      return this.view(intent, "review", remote);
    }

    const signatures = (remote.swapDetails?.destinationChainTxHashes ?? [])
      .map((tx) => tx.hash)
      .filter((hash) => settlement!.txPattern.test(hash));
    // SUCCESS can be reported a moment before the delivery hash is listed.
    if (!signatures.length) return this.view(intent, "processing", remote);

    let lastReason = "";
    for (const signature of signatures) {
      try {
        const order = await this.payments.settleIntentsCheckout(
          intent,
          signature,
          saved.symbol,
        );
        return { ...this.view(intent, "paid", remote), orderId: order.id };
      } catch (error) {
        lastReason = (error as Error)?.message ?? "";
      }
    }
    // The delivery may not be visible to our RPC node yet: try again on the
    // next poll rather than flagging a good payment.
    if (/not found|RPC/i.test(lastReason))
      return this.view(intent, "processing", remote);

    // The seller was paid but the order could not be recorded (most likely
    // the item sold elsewhere after the hold lapsed). Keep it for a human:
    // the buyer is owed either the item or a refund.
    this.logger.error(
      `Intents checkout ${intent.id} paid but not recorded: ${lastReason}`,
    );
    await this.checkout.intentsReview(intent.id);
    return this.view(intent, "review", remote);
  }

  private async paidView(intent: IntentRow): Promise<IntentCheckoutView> {
    const order = intent.transactionHash
      ? await this.prisma.order.findFirst({
          where: { transactionHash: intent.transactionHash },
          select: { id: true },
        })
      : null;
    const view = this.view(intent, "paid");
    if (intent.transactionHash)
      view.deliveryTx = [
        {
          hash: intent.transactionHash,
          explorerUrl: (
            settlementFor(intent.cluster) ?? settlementFor("mainnet-beta")
          ).explorer(intent.transactionHash),
        },
      ];
    return { ...view, orderId: order?.id };
  }

  private view(
    intent: IntentRow,
    state: IntentCheckoutState,
    remote?: OneClickStatusResponse,
  ): IntentCheckoutView {
    const saved = (intent.bridge ?? {}) as unknown as Partial<SavedQuote>;
    const items = intent.items as { id: string }[];
    const details = remote?.swapDetails;
    return {
      id: intent.id,
      state,
      listingId: items?.[0]?.id ?? "",
      pay: {
        assetId: saved.originAsset ?? "",
        symbol: saved.symbol ?? "",
        chain: saved.chain ?? "",
        amount: saved.amountInFormatted ?? "",
        amountBaseUnits: saved.amountIn ?? "",
        amountUsd: saved.amountInUsd ?? "",
        depositAddress: saved.depositAddress ?? "",
        ...(saved.depositMemo ? { depositMemo: saved.depositMemo } : {}),
      },
      sellerReceivesUsdc: (Number(intent.amount) / 1e6).toFixed(2),
      settlementChain: settlementFor(intent.cluster)?.chain ?? "Solana",
      deadline: saved.deadline ?? intent.expiresAt.toISOString(),
      timeEstimate: saved.timeEstimate ?? 0,
      originTx: details?.originChainTxHashes ?? [],
      deliveryTx: details?.destinationChainTxHashes ?? [],
      ...(details?.refundedAmountFormatted &&
      Number(details.refundedAmountFormatted) > 0
        ? { refundedAmount: details.refundedAmountFormatted }
        : {}),
    };
  }

  private async tokens(): Promise<OneClickToken[]> {
    if (this.tokenCache && this.tokenCache.expires > Date.now())
      return this.tokenCache.tokens;
    const tokens = await this.client.tokens();
    this.tokenCache = { tokens, expires: Date.now() + TOKEN_CACHE_MS };
    return tokens;
  }
}
