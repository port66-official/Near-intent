import { OneClickClient, OneClickError } from "./one-click.client";
import { PAYABLE_ASSETS, SETTLEMENT_ASSET_ID, payableAssets, platformFee } from "./intent-assets";
import { NearIntentsService } from "./near-intents.service";
import { verifySolanaUsdcPayment } from "../payments/verify-solana";

const BTC = "nep141:btc.omft.near";
const SELLER = "DmT8iUarUdx5p1HbMxc642zAuPNm8C2chL62rcAena5w";
const REFUND = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const DELIVERY = "5".repeat(88);

const TOKENS = [
  { assetId: BTC, symbol: "BTC", blockchain: "btc", decimals: 8, price: 73000 },
  {
    assetId: "nep141:wrap.near",
    symbol: "wNEAR",
    blockchain: "near",
    decimals: 24,
    price: 3.4,
  },
  { assetId: "nep141:pepe.omft.near", symbol: "PEPE", blockchain: "eth", decimals: 18, price: 0 },
];

function jsonFetch(routes: Record<string, (init?: RequestInit) => [number, unknown]>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const [status, body] = key ? routes[key](init) : [404, { message: "no route" }];
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("1Click client", () => {
  it("sends the partner key and posts the quote as JSON", async () => {
    const { impl, calls } = jsonFetch({ "/v0/quote": () => [200, { quote: {} }] });
    const client = new OneClickClient({ apiKey: " key ", fetch: impl });
    await client.quote({ dry: true } as never);
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("key");
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ dry: true });
  });

  it("works without a key and surfaces the provider's own error message", async () => {
    const { impl, calls } = jsonFetch({
      "/v0/quote": () => [400, { message: "refundTo is not valid" }],
    });
    const client = new OneClickClient({ fetch: impl });
    await expect(client.quote({} as never)).rejects.toMatchObject({
      status: 400,
      message: "refundTo is not valid",
    });
    expect(
      (calls[0].init!.headers as Record<string, string>)["x-api-key"],
    ).toBeUndefined();
  });

  it("echoes the deposit memo when polling status", async () => {
    const { impl, calls } = jsonFetch({ "/v0/status": () => [200, {}] });
    await new OneClickClient({ fetch: impl }).status("addr", "memo 1");
    expect(calls[0].url).toContain("depositAddress=addr&depositMemo=memo+1");
  });
});

describe("platform fee", () => {
  it("is off unless a NEAR account and a fee are both set", () => {
    expect(platformFee({})).toBeUndefined();
    expect(platformFee({ NEAR_INTENTS_FEE_BPS: "50" })).toBeUndefined();
    expect(platformFee({ NEAR_INTENTS_FEE_RECIPIENT: "port66.near" })).toBeUndefined();
    expect(
      platformFee({ NEAR_INTENTS_FEE_RECIPIENT: "port66.near", NEAR_INTENTS_FEE_BPS: "50" }),
    ).toEqual({ recipient: "port66.near", fee: 50 });
  });
  it("caps the fee at 1% and rejects a recipient that is not a NEAR account", () => {
    expect(
      platformFee({ NEAR_INTENTS_FEE_RECIPIENT: "port66.near", NEAR_INTENTS_FEE_BPS: "900" })?.fee,
    ).toBe(100);
    expect(
      platformFee({ NEAR_INTENTS_FEE_RECIPIENT: "Port66.NEAR", NEAR_INTENTS_FEE_BPS: "50" }),
    ).toBeUndefined();
    expect(
      platformFee({ NEAR_INTENTS_FEE_RECIPIENT: "port66.near", NEAR_INTENTS_FEE_BPS: "0.5" }),
    ).toBeUndefined();
  });
});

describe("payable assets", () => {
  it("offers only allowlisted assets the provider lists, and shows wNEAR as NEAR", () => {
    const assets = payableAssets(TOKENS as never);
    expect(assets.map((a) => a.symbol)).toEqual(["BTC", "NEAR"]);
    expect(assets[0].windowMinutes).toBeGreaterThan(assets[1].windowMinutes);
  });
  it("never offers the settlement asset as a way to pay", () => {
    expect(PAYABLE_ASSETS.some((a) => a.assetId === SETTLEMENT_ASSET_ID)).toBe(false);
  });
});

describe("NEAR Intents checkout", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.NEAR_INTENTS_ENABLED = "true";
    process.env.SOLANA_PAYMENTS_ENABLED = "true";
    process.env.SOLANA_CLUSTER = "mainnet-beta";
    process.env.PII_ENCRYPTION_KEY = "0".repeat(64);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  function build(opts: { intentStatus?: string; open?: boolean } = {}) {
    const intent = {
      id: "intent",
      buyerId: "buyer",
      rail: "intents",
      cluster: "mainnet-beta",
      payer: REFUND,
      recipient: SELLER,
      amount: "282500000",
      status: opts.intentStatus ?? "RESERVED",
      items: [{ id: "listing", price: "280", shipping: "2.5", sellerId: "seller" }],
      bridge: null as unknown,
      transactionHash: null as string | null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const saved = {
      provider: "near-intents",
      originAsset: BTC,
      symbol: "BTC",
      chain: "Bitcoin",
      depositAddress: "bc1deposit",
      amountIn: "388593",
      amountInFormatted: "0.00388593",
      amountInUsd: "283.7",
      deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
      timeEstimate: 800,
      signature: "sig",
      correlationId: "corr",
    };
    if (opts.open) intent.bridge = saved;
    let reserved: typeof intent = intent;
    const prisma = {
      listing: {
        findUnique: jest.fn().mockResolvedValue({
          id: "listing",
          status: "ACTIVE",
          sellerId: "seller",
          seller: { solanaWalletAddress: SELLER },
        }),
      },
      offer: { findFirst: jest.fn().mockResolvedValue(null) },
      order: {
        findFirst: jest.fn().mockResolvedValue({ id: "order" }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: "o1",
            paidAt: new Date("2026-11-13T10:00:00Z"),
            createdAt: new Date("2026-11-13T09:59:00Z"),
            finalPrice: "280",
            shippingCost: "2.5",
            sellerPayout: "282.5",
            status: "PAYMENT_RECEIVED",
            tokenSymbol: "USDC_SOLANA_MAINNET-BETA_VIA_BTC",
            transactionHash: "sig",
            listing: { title: '=HYPERLINK("x"), "Tee"' },
          },
        ]),
      },
      checkoutIntent: { findMany: jest.fn().mockResolvedValue([intent]) },
    };
    const checkout = {
      intentsFor: jest.fn().mockResolvedValue(opts.open ? intent : null),
      // Like the real service: the reserved row carries the recipient and
      // settlement chain it was asked for, and the quote is attached to it.
      reserve: jest.fn(async (_b, _ids, _rail, _payer, recipient, cluster) => {
        reserved = { ...intent, recipient, cluster };
        return reserved;
      }),
      attachIntentsQuote: jest.fn(async (_id, data) => ({
        ...reserved,
        bridge: data.bridge,
      })),
      intentsInFlight: jest.fn(),
      intentsRelease: jest.fn(),
      intentsReview: jest.fn(),
      own: jest.fn(async (buyerId: string) => {
        if (buyerId !== "buyer") throw new Error("Checkout not found");
        return { ...intent, bridge: saved };
      }),
    };
    const payments = {
      settleIntentsCheckout: jest.fn().mockResolvedValue({ id: "order" }),
    };
    const client = {
      tokens: jest.fn().mockResolvedValue(TOKENS),
      quote: jest.fn().mockResolvedValue({
        signature: "sig",
        correlationId: "corr",
        quote: {
          depositAddress: "bc1deposit",
          amountIn: "388593",
          amountInFormatted: "0.00388593",
          amountInUsd: "283.7",
          amountOut: "282500000",
          timeEstimate: 800,
          deadline: saved.deadline,
        },
      }),
      status: jest.fn(),
      submitDeposit: jest.fn().mockResolvedValue({}),
    };
    const service = new NearIntentsService(
      prisma as never,
      checkout as never,
      payments as never,
    );
    (service as unknown as { client: unknown }).client = client;
    const remote = (status: string, over: Record<string, unknown> = {}) => ({
      status,
      quoteResponse: {
        quoteRequest: {
          recipient: SELLER,
          destinationAsset: SETTLEMENT_ASSET_ID,
          swapType: "EXACT_OUTPUT",
          amount: "282500000",
          ...over,
        },
      },
      swapDetails: {
        originChainTxHashes: [],
        destinationChainTxHashes: [{ hash: DELIVERY, explorerUrl: "x" }],
      },
    });
    return { service, prisma, checkout, payments, client, intent, remote };
  }

  it("is off unless the flag is set", async () => {
    const { service } = build();
    delete process.env.NEAR_INTENTS_ENABLED;
    expect(service.enabled()).toBe(false);
    await expect(
      service.quote("buyer", { listingId: "listing", originAsset: BTC, refundTo: REFUND }),
    ).rejects.toThrow("not available");
  });

  it("pays a seller without Solana on Base, in Base USDC", async () => {
    const { service, prisma, client, checkout } = build();
    prisma.listing.findUnique.mockResolvedValueOnce({
      id: "listing",
      status: "ACTIVE",
      sellerId: "seller",
      seller: { solanaWalletAddress: null, walletAddress: "0x1111111111111111111111111111111111111111" },
    });
    const view = await service.quote("buyer", { listingId: "listing", originAsset: BTC, refundTo: REFUND });
    expect(client.quote.mock.calls[0][0]).toMatchObject({
      destinationAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      recipient: "0x1111111111111111111111111111111111111111",
    });
    expect(checkout.reserve.mock.calls[0][5]).toBe("base");
    expect(view.settlementChain).toBe("Base");
  });

  it("falls back to Base when Solana payments are off, and refuses a seller with neither", async () => {
    const { service, prisma, client } = build();
    process.env.SOLANA_PAYMENTS_ENABLED = "false";
    prisma.listing.findUnique.mockResolvedValueOnce({
      id: "listing", status: "ACTIVE", sellerId: "seller",
      seller: { solanaWalletAddress: SELLER, walletAddress: null },
    });
    await expect(
      service.quote("buyer", { listingId: "listing", originAsset: BTC, refundTo: REFUND }),
    ).rejects.toThrow("cannot receive");
    expect(client.quote).not.toHaveBeenCalled();
  });

  it("settles a Base checkout from an EVM delivery hash, matching the seller case-insensitively", async () => {
    const { service, client, payments, checkout, intent } = build();
    const evmSeller = "0xAbCdEf0000000000000000000000000000000001";
    const hash = "0x" + "a".repeat(64);
    checkout.own.mockResolvedValueOnce({
      ...intent, cluster: "base", recipient: evmSeller,
      bridge: {
        provider: "near-intents", originAsset: BTC, symbol: "BTC", chain: "Bitcoin",
        depositAddress: "bc1deposit", amountIn: "388593", amountInFormatted: "0.00388593",
        amountInUsd: "283.7", deadline: new Date(Date.now() + 60_000).toISOString(),
        timeEstimate: 800, signature: "sig", correlationId: "corr",
      },
    });
    client.status.mockResolvedValueOnce({
      status: "SUCCESS",
      quoteResponse: { quoteRequest: {
        recipient: evmSeller.toLowerCase(),
        destinationAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        swapType: "EXACT_OUTPUT", amount: "282500000",
      } },
      swapDetails: { originChainTxHashes: [], destinationChainTxHashes: [{ hash, explorerUrl: "x" }] },
    });
    expect((await service.status("buyer", "intent")).state).toBe("paid");
    expect(payments.settleIntentsCheckout).toHaveBeenCalledWith(expect.objectContaining({ cluster: "base" }), hash, "BTC");
  });

  it("quotes an exact USDC amount to the seller's own Solana wallet, from server-side data", async () => {
    const { service, client, checkout } = build();
    const view = await service.quote("buyer", {
      listingId: "listing",
      originAsset: BTC,
      refundTo: REFUND,
      // A client cannot steer the money: these are ignored by design.
      ...({ recipient: "attacker", amount: "1" } as object),
    });
    const sent = client.quote.mock.calls[0][0];
    expect(sent).toMatchObject({
      dry: false,
      swapType: "EXACT_OUTPUT",
      destinationAsset: SETTLEMENT_ASSET_ID,
      amount: "282500000",
      recipient: SELLER,
      recipientType: "DESTINATION_CHAIN",
      refundTo: REFUND,
      refundType: "ORIGIN_CHAIN",
    });
    expect(checkout.reserve).toHaveBeenCalledWith(
      "buyer", ["listing"], "intents", REFUND, SELLER, "mainnet-beta", undefined,
    );
    expect(view).toMatchObject({
      state: "awaiting_deposit",
      sellerReceivesUsdc: "282.50",
      pay: { symbol: "BTC", amount: "0.00388593", depositAddress: "bc1deposit" },
    });
  });

  it("prices the checkout at an offer the seller accepted, for that buyer only", async () => {
    const { service, prisma, checkout } = build();
    prisma.offer.findFirst.mockResolvedValueOnce({ amount: "250" });
    await service.quote("buyer", { listingId: "listing", originAsset: BTC, refundTo: REFUND });
    expect(prisma.offer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ listingId: "listing", buyerId: "buyer", status: "ACCEPTED" }),
      }),
    );
    expect(checkout.reserve).toHaveBeenLastCalledWith(
      "buyer", ["listing"], "intents", REFUND, SELLER, "mainnet-beta", 250,
    );
  });

  it("exports a seller's Intents sales as a bookkeeper-safe CSV", async () => {
    const { service, prisma } = build();
    const csv = await service.salesCsv("seller");
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sellerId: "seller", tokenSymbol: { contains: "_VIA_" } } }),
    );
    const [head, row] = csv.trim().split("\n");
    expect(head.split(",")[5]).toBe("received_usdc");
    expect(row).toContain("282.50,Solana,BTC,PAYMENT_RECEIVED,https://solscan.io/tx/sig");
    // A formula in a title is defused, not executed by the spreadsheet.
    expect(row).toContain(`"'=HYPERLINK(""x""), ""Tee"""`);
  });

  it("tells a buyer their offer was accepted, and only while it is live", async () => {
    const { service, prisma } = build();
    const future = new Date(Date.now() + 60_000);
    prisma.offer.findFirst.mockResolvedValueOnce({ id: "o", amount: "250", status: "ACCEPTED", expiresAt: future });
    expect((await service.offerFor("buyer", "listing")).payableAt).toBe(250);
    prisma.offer.findFirst.mockResolvedValueOnce({ id: "o", amount: "250", status: "ACCEPTED", expiresAt: new Date(0) });
    expect((await service.offerFor("buyer", "listing")).payableAt).toBeNull();
    prisma.offer.findFirst.mockResolvedValueOnce({ id: "o", amount: "250", status: "PENDING", expiresAt: future });
    expect(await service.offerFor("buyer", "listing")).toMatchObject({ payableAt: null, offer: { status: "PENDING" } });
  });

  it("adds Port66's fee to the quote only when configured", async () => {
    const { service, client } = build();
    await service.quote("buyer", { listingId: "listing", originAsset: BTC, refundTo: REFUND });
    expect(client.quote.mock.calls[0][0].appFees).toBeUndefined();
    process.env.NEAR_INTENTS_FEE_RECIPIENT = "port66.near";
    process.env.NEAR_INTENTS_FEE_BPS = "50";
    await service.quote("buyer", { listingId: "listing", originAsset: BTC, refundTo: REFUND });
    expect(client.quote.mock.calls[1][0].appFees).toEqual([{ recipient: "port66.near", fee: 50 }]);
  });

  it("rejects assets outside the allowlist and frees the item when the quote fails", async () => {
    const { service, client, checkout } = build();
    await expect(
      service.quote("buyer", { listingId: "listing", originAsset: "nep141:pepe.omft.near", refundTo: REFUND }),
    ).rejects.toThrow("not supported");
    client.quote.mockRejectedValueOnce(new OneClickError(400, "refundTo is not valid"));
    await expect(
      service.quote("buyer", { listingId: "listing", originAsset: BTC, refundTo: "nope" }),
    ).rejects.toThrow("refundTo is not valid");
    expect(checkout.intentsRelease).toHaveBeenCalledWith("intent");
  });

  it("refuses a quote that would not cover the price", async () => {
    const { service, client, checkout } = build();
    const short = await client.quote();
    short.quote.amountOut = "282499999";
    client.quote.mockResolvedValueOnce(short);
    await expect(
      service.quote("buyer", { listingId: "listing", originAsset: BTC, refundTo: REFUND }),
    ).rejects.toThrow("Could not get a quote");
    expect(checkout.attachIntentsQuote).not.toHaveBeenCalled();
    expect(checkout.intentsRelease).toHaveBeenCalled();
  });

  it("never issues a second deposit address while a payment is in flight", async () => {
    const { service, client, checkout, remote } = build({ open: true });
    client.status.mockResolvedValue(remote("PROCESSING"));
    const view = await service.quote("buyer", {
      listingId: "listing",
      originAsset: "nep141:wrap.near",
      refundTo: "alice.near",
    });
    expect(view.state).toBe("processing");
    expect(client.quote).not.toHaveBeenCalled();
    expect(checkout.reserve).not.toHaveBeenCalled();
  });

  it("holds the item once a deposit is seen and frees it when nothing will arrive", async () => {
    const { service, client, checkout, remote } = build();
    client.status.mockResolvedValueOnce(remote("KNOWN_DEPOSIT_TX"));
    expect((await service.status("buyer", "intent")).state).toBe("deposit_seen");
    expect(checkout.intentsInFlight).toHaveBeenCalledWith("intent");
    client.status.mockResolvedValueOnce(remote("REFUNDED"));
    expect((await service.status("buyer", "intent")).state).toBe("refunded");
    expect(checkout.intentsRelease).toHaveBeenCalledWith("intent");
  });

  it("does not extend the hold on a buyer's unverified claim of a deposit", async () => {
    const { service, client, checkout, remote } = build();
    client.status.mockResolvedValue(remote("PENDING_DEPOSIT"));
    const view = await service.submitDeposit("buyer", "intent", "abc123");
    expect(view.state).toBe("awaiting_deposit");
    expect(client.submitDeposit).toHaveBeenCalled();
    expect(checkout.intentsInFlight).not.toHaveBeenCalled();
  });

  it("records the order from the provider's delivery hash, not anything a client sent", async () => {
    const { service, client, payments, remote } = build();
    client.status.mockResolvedValue(remote("SUCCESS"));
    const view = await service.status("buyer", "intent");
    expect(view).toMatchObject({ state: "paid", orderId: "order" });
    expect(payments.settleIntentsCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ id: "intent" }), DELIVERY, "BTC",
    );
  });

  it.each([
    ["a different recipient", { recipient: "AttackerWa11et111111111111111111111111111111" }],
    ["a smaller amount", { amount: "1000000" }],
    ["a different asset", { destinationAsset: "nep141:wrap.near" }],
  ])("flags for review when the provider's swap was for %s", async (_name, over) => {
    const { service, client, payments, checkout, remote } = build();
    client.status.mockResolvedValue(remote("SUCCESS", over));
    expect((await service.status("buyer", "intent")).state).toBe("review");
    expect(payments.settleIntentsCheckout).not.toHaveBeenCalled();
    expect(checkout.intentsReview).toHaveBeenCalledWith("intent");
  });

  it("retries while the delivery is not yet visible, and flags a paid-but-unrecordable order", async () => {
    const { service, client, payments, checkout, remote } = build();
    client.status.mockResolvedValue(remote("SUCCESS"));
    payments.settleIntentsCheckout.mockRejectedValueOnce(
      new Error("Payment could not be verified: Transaction not found on Solana"),
    );
    expect((await service.status("buyer", "intent")).state).toBe("processing");
    expect(checkout.intentsReview).not.toHaveBeenCalled();
    payments.settleIntentsCheckout.mockRejectedValueOnce(new Error("Listing already sold"));
    expect((await service.status("buyer", "intent")).state).toBe("review");
    expect(checkout.intentsReview).toHaveBeenCalledWith("intent");
  });

  it("only lets the buyer who owns a checkout read or advance it", async () => {
    const { service, client } = build();
    await expect(service.status("someone-else", "intent")).rejects.toThrow("not found");
    expect(client.status).not.toHaveBeenCalled();
  });

  it("reconciles open checkouts so a closed tab still gets its order", async () => {
    const { service, client, intent, remote } = build({ open: true });
    client.status.mockResolvedValue(remote("SUCCESS"));
    expect(await service.reconcile()).toEqual({ checked: 1, paid: 1 });
    expect(intent.id).toBe("intent");
  });
});

describe("receipt-only Solana verification", () => {
  const env = { ...process.env };
  const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  beforeEach(() => {
    process.env.SOLANA_PAYMENTS_ENABLED = "true";
    process.env.SOLANA_CLUSTER = "mainnet-beta";
    process.env.SOLANA_RPC_URL = "https://rpc.test";
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });
  function rpc(sellerGain: string) {
    const balance = (owner: string, amount: string) => ({
      mint: MINT, owner, uiTokenAmount: { amount },
    });
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          meta: {
            err: null,
            preTokenBalances: [balance(SELLER, "0"), balance("Solver", "999000000")],
            postTokenBalances: [balance(SELLER, sellerGain), balance("Solver", "0")],
          },
          // Signed by the solver, not the buyer.
          transaction: { message: { accountKeys: [{ pubkey: "Solver", signer: true }], instructions: [] } },
        },
      }),
    } as never);
  }
  const args = {
    signature: DELIVERY,
    buyerAddress: "",
    sellerAddress: SELLER,
    priceUsd: 282.5,
    amountBaseUnits: "282500000",
  };

  it("accepts a solver's delivery only in receipt mode", async () => {
    rpc("282500000");
    expect(await verifySolanaUsdcPayment({ ...args, receiptOnly: true })).toEqual({ ok: true });
    // The direct wallet rail is unchanged: the buyer must still be the sender.
    expect((await verifySolanaUsdcPayment(args)).ok).toBe(false);
  });

  it("still requires the seller to have received the full amount", async () => {
    rpc("282499999");
    expect(await verifySolanaUsdcPayment({ ...args, receiptOnly: true })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("No matching USDC transfer"),
    });
  });
});
