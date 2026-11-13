# Port66 × NEAR Intents: buy luxury from any chain

[Port66](https://port66.xyz) is a live marketplace for authenticated luxury and collectibles. For the NEAR Hackathon we added a checkout that lets anyone, person or AI agent, buy a listing **paying from whatever chain they hold** (BTC, SOL, NEAR, ETH, USDC, USDT, DOGE, LTC). **NEAR Intents** turns that into the exact USDC price in the seller's wallet in one step. If the swap cannot complete, the buyer is refunded on their own chain. Port66 never holds the money.

The feature is live on port66.xyz: open a listing, choose **Buy with USDC**, then **Pay from any chain**.

**Tracks:** Real-World Money (primary), Agent Economy.

## Try it in two minutes: no keys, no wallet, no funds

Needs Node 20+ and pnpm.

```bash
pnpm install
pnpm dry-run 280              # 1. live NEAR Intents quotes for a $280 item
cd apps/buyer-agent && pnpm install --ignore-workspace
pnpm agent custody            # 2. what the buyer agent holds and can never do
pnpm agent buy 'a KAWS figure under 300'   # 3. it decides to buy, and quotes
pnpm agent buy 'a KAWS figure under 250'   # 4. it counters once instead
pnpm agent ledger --csv       # 5. every decision as a CSV
pnpm test                     # 17 tests of the agent's spending rules
```

Use single quotes: in double quotes your shell turns `$300` into `00`.

| Step | What you should see |
|---|---|
| 1 | One row per payable asset. For each, what a buyer sends so the seller receives **exactly 280.0 USDC**, its USD value (about $283 to $285, so roughly 1 to 2% routing cost), and the time to settle (about 20 seconds for SOL or NEAR, about 13 minutes for BTC). Quotes come live from NEAR Intents solvers. `dry: true` means no deposit address is issued, so nothing can be paid. |
| 2 | The agent's custody statement: which keys it holds, what it may do alone, and the limits it cannot cross. |
| 3 | It finds the live KAWS × Sesame Street Elmo figure listed at $280 on port66.xyz, decides to buy under the $300 ceiling, gets a NEAR Intents quote (about 3.5 SOL), and checks the routing cost against its 3% limit. Dry run: nothing is reserved or sent. |
| 4 | $280 is above the $250 ceiling but within its 25% negotiating room, so it writes **one** counter-offer at $250 with its reasoning. |
| 5 | The receipts from steps 3 and 4, in a format an accountant can open. |

Prices and listings are live, so the exact numbers move.

## What we built

### 1. "Pay from any chain" checkout
`apps/api/src/modules/near-intents`, `apps/web/src/components/marketplace/near-intents-pay-step.tsx`

```
buyer picks BTC / SOL / NEAR / ETH ...
   │
   ▼
Port66 API ── reserves the item, then asks 1Click for an EXACT_OUTPUT quote:
   │          recipient = seller's wallet, amount = price + postage (from the DB)
   ▼
one-time deposit address + QR code ──> buyer sends from any wallet
   │
   ▼
NEAR Intents solvers ──> exact USDC to the seller (Solana, or Base for
   │                     sellers without a Solana wallet); refund to the
   │                     buyer on failure
   ▼
Port66 verifies the delivery on chain ──> order recorded, item marked sold
```

- **One step, seller paid directly.** Our previous cross-chain route (SODAX) bridged funds into the buyer's own wallet, then needed a second payment to the seller. With `EXACT_OUTPUT` and `recipientType: DESTINATION_CHAIN`, one deposit pays the seller the exact price.
- **The money is never trusted to the client or to the provider's word alone.** An order is recorded only when (1) 1Click reports `SUCCESS` for the deposit address saved on the buyer's own reserved checkout, (2) that swap was quoted for this seller's wallet, asset and amount, and (3) the delivery transaction on Solana or Base really credited the seller with at least the reserved amount, checked against an RPC node.
- **The item is held** while a payment is in flight, and released when a quote expires or is refunded. A payment that succeeds but cannot be matched goes to manual review, never silently dropped.
- **A buyer who closes the tab still gets their order:** a job reconciles open payments every 5 minutes.
- **Optional platform fee** inside the same intent (`appFees`): the seller still receives the exact price.
- **Sellers export their cross-chain sales as CSV** from the Sales tab, one row per order with the on-chain receipt.

### 2. Buyer agent (`apps/buyer-agent`)
An AI buying agent that shops Port66 inside an owner's mandate and pays through the same checkout. See its [README](apps/buyer-agent/README.md).

- **Owner's rules** in one file: per-item ceiling, daily budget, routing-cost limit, allowed assets, minimum seller rating, and a **kill switch**. The rules are pure functions (`src/mandate.ts`) with no network, keys or model, and are fully tested.
- **Checks twice.** Once when choosing a listing, and again against the live quote just before money moves; the config is re-read at that moment.
- **Negotiates once** through Port66's real offers. An accepted offer prices the checkout at the agreed amount; declined or expired means it walks away.
- **Pays live** from Solana (SOL), Ethereum, Arbitrum or Base (ETH, USDC, USDT) or NEAR (NEAR, USDC), only ever to a deposit address issued by a Port66 quote.
- **A receipt for every task**, including the ones where it bought nothing: what, from whom, at what price, and whether its own post-purchase check passed.
- **Optional NEAR AI Cloud** reads the task and writes the counter-offer. It never decides whether to pay; without a key, built-in rules do both.

### 3. MCP server: the marketplace as tools
`apps/web/src/lib/mcp/server.ts`, served at **https://port66.xyz/api/mcp** (streamable HTTP, stateless).

Any MCP client can connect by URL, with nothing to install:

```bash
claude mcp add --transport http port66 https://port66.xyz/api/mcp
```

| Tool | Needs a session | What it does |
|---|---|---|
| `search_listings` | no | Search live listings. Multi-word queries work, unlike the site's own search. |
| `get_listing` | no | Full details, provenance and how to buy. |
| `payment_options` | no | Assets and chains a buyer can pay from. |
| `price_in_crypto` | no | Live NEAR Intents price of a piece in BTC, SOL, NEAR, ETH and others. Reserves nothing. |
| `start_purchase` | yes | Reserves the piece and returns a deposit address and exact amount. |
| `purchase_status`, `report_deposit` | yes | Follow the payment until the order is recorded. |
| `make_offer`, `offer_status` | yes | Negotiate; an accepted offer prices the purchase. |

The server never holds or moves money. Buying tools return where to pay, and the agent's own wallet decides whether to.

### 4. Agent discovery
`port66.xyz/llms.txt` and the `/api/agent/v1` manifest now lead with the free catalogue and the MCP server, and explain how any agent can buy a listing this way: sign in with an EVM key, quote, pay, poll.

## Mainnet proof

NEAR Intents has no testnet, so the checkout was built against mainnet with dry-run quotes, then proven with a real purchase on port66.xyz: a $5 listing (free postage), paid in ETH on Ethereum from MetaMask.

| Step | Transaction |
|---|---|
| Buyer sends 0.0026063 ETH on Ethereum to the one-time deposit address `0x394C…636d` (13 Nov 2026, 20:40 UTC) | [Etherscan](https://etherscan.io/tx/0x2fcfe9119fe9a0244dc1bc50a3bdc0f7b266a0e482fcd9c4f66c39ecb458b0d9) |
| NEAR Intents delivers **exactly 5.0 USDC** to the seller's Solana wallet `DmT8…na5w` (20:43:29 UTC, 3 minutes later) | [Solscan](https://solscan.io/tx/5v4By3fQdxCYLdx27TPkvY3TE5Tbguny6JDAgdHEJTwxP2BL4Enn91cCTYkPviHEHKpo9q6j2LcJb2rA1Vit3hi) |

1Click reports the swap as `SUCCESS` with `amountOut: 5.0` and nothing refunded. Anyone can check it:

```bash
curl "https://1click.chaindefuser.com/v0/status?depositAddress=0x394Cce0Fb51EdeA385Df45ceA8fcA2005Fa5636d"
```

The buyer agent's live payers (`--live`) use the same checkout but have not yet been run with real funds.

## Disclosure (hackathon rules)

- **Port66 existed before the hackathon** and lives in a private repository. Only the NEAR Intents integration is submitted.
- **Everything in this repository was written during the hackathon window,** starting 12 November 2026. `integration.diff` shows every change made to pre-existing Port66 files, such as payment verification, the checkout window and the discovery docs. The NestJS module runs inside Port66 and is included for review. The 1Click client, the dry-run script and the buyer agent run standalone, as shown above.
- **Libraries:** NEAR Intents 1Click API (through our own dependency-free client), `@solana/web3.js`, `viem`, `near-api-js`, `bs58`, `tsx`; inside Port66, NestJS, Prisma and Next.js. AI coding assistance was used.

## Links

- Live: https://port66.xyz
- Demo video: _to be added_
- X post: _to be added_
