# Port66 × NEAR Intents: buy luxury from any chain

[Port66](https://port66.xyz) is a live marketplace for authenticated luxury and collectibles. For the NEAR Hackathon we added a checkout that lets anyone, person or AI agent, buy a listing **paying from whatever chain they hold** (BTC, SOL, NEAR, ETH, USDC, USDT, DOGE, LTC). **NEAR Intents** turns that into the exact USDC price in the seller's wallet in one step. If the swap cannot complete, the buyer is refunded on their own chain. Port66 never holds the money.

The feature is live on port66.xyz: open a listing, choose **Buy with USDC**, then **Pay from any chain**.

On top of it we built **shopping agents that buy on their own**: you tell an agent what you want and the most you will pay, approve a daily USDC cap once in a Coinbase wallet, and the agent finds the piece, pays through NEAR Intents and places the order with no checkout and no clicks. The cap is enforced on chain, not by Port66.

**Tracks:** Agent Economy (primary), Real-World Money.

## Watch an agent buy on port66.xyz

Needs a Coinbase Smart Wallet (created in the popup with a passkey) holding a few USDC on Base.

| Do | See |
|---|---|
| 1. Sign in at port66.xyz, open **Agents**, click **New agent**, type `Monaco Racing Club Tee`, set the price limit to 7 and click **Start agent**. | The agent page, with matching pieces listed and a **Created to look for…** entry in Activity. |
| 2. In **Let it buy for you**, click **Set up**, enter a daily amount and a delivery address, then **Connect wallet and allow**. | Coinbase's **Allow Spend Permission** popup: "Transfer up to 7.00 USDC a day". After approving, the box reads **Buys for you automatically** with your wallet address. |
| 3. Send a little more than the price in USDC on Base to that wallet, then click **Search now**. | Activity shows **Bought "…": paid 6.06 USDC from your wallet** with a **View payment** link to Basescan, and the piece moves to **Found and bought**. |
| 4. Click **Search now** again a minute later. | The order completes once NEAR Intents has paid the seller, and appears under **Orders**. |

The agent never buys your own listings, never pays above your limits, and can be switched off with **Turn off** (or by revoking the permission in the wallet).



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

### 2. Shopping agents that pay on their own
`apps/api/src/modules/shopping-agents`, `apps/web/src/app/(account)/agents`, `apps/web/src/components/agents/auto-buy-card.tsx`

```
user: "Monaco Racing Club Tee, up to $7"  +  signs a Base spend permission once
   │                                         ("Port66's agent may spend 7 USDC a day")
   ▼
agent (every 30 min, or "Search now") ── searches live listings, applies the rules:
   │       per-item limit, daily budget, never the user's own listings, one offer
   │       at the limit when the asking price is up to 15% above it
   ▼
NEAR Intents 1Click ── reserves the piece and quotes EXACT_OUTPUT:
   │                   the seller's price in USDC, paid from USDC on Base
   ▼
one user operation from a Coinbase CDP smart account, atomically:
   │   SpendPermissionManager.spend (user's wallet → spender)
   │   + USDC.transfer (spender → the one-time NEAR Intents deposit address)
   ▼
NEAR Intents delivers the exact price to the seller ──> Port66 verifies on chain,
                                                        records the order
```

- **The user's money stays in the user's wallet** until a purchase. The daily cap is enforced on chain by Coinbase's SpendPermissionManager (`0xf85210B2…9b67Ad`), whatever Port66's server does, and the user can revoke it at any time.
- **Atomic, so Port66 never holds funds:** pulling from the user's wallet and paying the NEAR Intents deposit address happen in one user operation. If either step fails, both revert.
- **Checks before money moves:** the wallet's USDC balance (a short balance becomes an "add USDC" notice, not a failed purchase), the live route cost (at most 5% over the price), and the permission's remaining allowance for today.
- **One purchase per piece:** a unique (agent, listing) row is the lock, so two overlapping runs cannot buy twice.
- **Every step is in the agent's Activity**, with a Basescan link for each payment. The rules are pure functions (`shopping-agent.rules.ts`) with tests in `shopping-agents.spec.ts`.

### 3. Buyer agent (`apps/buyer-agent`)
An AI buying agent that shops Port66 inside an owner's mandate and pays through the same checkout. See its [README](apps/buyer-agent/README.md).

- **Owner's rules** in one file: per-item ceiling, daily budget, routing-cost limit, allowed assets, minimum seller rating, and a **kill switch**. The rules are pure functions (`src/mandate.ts`) with no network, keys or model, and are fully tested.
- **Checks twice.** Once when choosing a listing, and again against the live quote just before money moves; the config is re-read at that moment.
- **Negotiates once** through Port66's real offers. An accepted offer prices the checkout at the agreed amount; declined or expired means it walks away.
- **Pays live** from Solana (SOL), Ethereum, Arbitrum or Base (ETH, USDC, USDT) or NEAR (NEAR, USDC), only ever to a deposit address issued by a Port66 quote.
- **A receipt for every task**, including the ones where it bought nothing: what, from whom, at what price, and whether its own post-purchase check passed.
- **Optional NEAR AI Cloud** reads the task and writes the counter-offer. It never decides whether to pay; without a key, built-in rules do both.

### 4. MCP server: the marketplace as tools
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

### 5. Agent discovery
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

**A shopping agent buying on its own** (14 Nov 2026), after the user approved a 7 USDC/day spend permission from a Coinbase Smart Wallet:

| Step | Transaction |
|---|---|
| The agent finds the Monaco Racing Club Tee ($6, free postage), quotes it through NEAR Intents, and in one user operation pulls **6.063031 USDC** from the shopper's wallet `0xE380…4Ce0` and pays the one-time deposit address `0xcf7C…C870` (19:41:49 UTC) | [Basescan](https://basescan.org/tx/0x4143c1248f5cb6e2e57df46b2122293806b57601f4045d91cd479ff3c6663222) |
| NEAR Intents delivers **exactly 6.00 USDC** to the seller's wallet on Base, and Port66 records the order | [Basescan](https://basescan.org/tx/0xae212c8a2b38231b253caab01b4fd1e20ab7f835193f3df3ff9cfc4bc6c8e94b) |

```bash
curl "https://1click.chaindefuser.com/v0/status?depositAddress=0xcf7CA26660adDE62d3c4ea6C2f918b375b0AC870"
```

The command-line buyer agent's live payers (`--live`) use the same checkout but have not yet been run with real funds.

## Disclosure (hackathon rules)

- **Port66 existed before the hackathon** and lives in a private repository. Only the NEAR Intents integration is submitted.
- **Everything in this repository was written during the hackathon window,** starting 12 November 2026. `integration.diff` shows every change made to pre-existing Port66 files, such as payment verification, the checkout window and the discovery docs. The NestJS module runs inside Port66 and is included for review. The 1Click client, the dry-run script and the buyer agent run standalone, as shown above.
- **Libraries:** NEAR Intents 1Click API (through our own dependency-free client), `@solana/web3.js`, `viem`, `near-api-js`, `bs58`, `tsx`; inside Port66, NestJS, Prisma and Next.js. AI coding assistance was used.

## Links

- Live: https://port66.xyz
- Demo video: _to be added_
- X post: _to be added_
