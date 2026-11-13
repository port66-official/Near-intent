# Port66 buyer agent

An AI buying agent for [Port66](https://port66.xyz), a marketplace for authenticated luxury and collectibles. You give it a shopping task and a budget. It finds the item, counters once if the price is too high, and pays from its own wallet through **NEAR Intents**. The seller receives the exact price in USDC on Solana, and every decision is written down as a receipt.

The agent pays through the same "Pay from any chain" checkout people use on port66.xyz, so a buyer can pay in BTC, SOL, NEAR, ETH and other majors while the seller only ever sees USDC.

## Try it in two minutes (no keys, no funds)

Needs Node 20 or later and pnpm.

```bash
cd apps/buyer-agent
pnpm install --ignore-workspace
pnpm agent custody
pnpm agent buy 'a KAWS figure under 300'
pnpm agent buy 'a KAWS figure under 250'
pnpm agent ledger --csv
```

Use single quotes. In double quotes your shell turns `$300` into `00` before the agent sees it.

What you should see:

| Command | What happens |
|---|---|
| `custody` | How the agent holds its keys, what it can do alone, and what it can never do. |
| `buy '... under 300'` | It finds the KAWS x Sesame Street Elmo figure listed at $280, decides to buy, and gets a **live NEAR Intents quote**: about 3.5 SOL so the seller receives exactly 280 USDC. It checks the routing cost (about 1.3%) against the 3% limit. Nothing is reserved or sent. |
| `buy '... under 250'` | $280 is above the $250 ceiling but within the 25% negotiating room, so it writes **one counter-offer** at $250 with its reasoning, and stops. |
| `ledger --csv` | Every receipt so far, as a CSV a bookkeeper can open. |

Prices and the listing are live, so the exact figures move with the market.

Run the tests with `pnpm test`: 17 cases cover every spending rule and the payment helpers.

## How it works

```
task ──> read task ──> search Port66 ──> decide (mandate.ts) ──┬─> skip, with the reason
                                                              ├─> counter once (Port66 offer)
                                                              └─> buy
                                                                   │
        Port66 reserves the item and asks NEAR Intents for an      │
        EXACT_OUTPUT quote: seller's Solana wallet gets the price  │
                                                                   ▼
        re-read mandate ──> check routing cost and budget ──> send SOL to the
        one-time deposit address ──> solvers deliver USDC to the seller ──>
        Port66 verifies the delivery on Solana and records the order ──>
        agent checks the order exists ──> receipt
```

- **The rules** are in `agent.config.example.json` (copy it to `agent.config.json` to change them): the most it pays for one item, a daily budget, the routing cost it accepts on top of the price, which assets it pays with, how far above its ceiling it will negotiate, a minimum seller rating, a shipping address, and a **kill switch**.
- **The decisions** are pure functions in [`src/mandate.ts`](src/mandate.ts), with no network, keys or model involved, so they can be read in one sitting and are fully tested.
- **Every payment is checked twice.** Once when choosing the listing, and again against the live quote right before money moves. The config file is re-read at that moment, so flipping the kill switch stops a purchase already under way.
- **Negotiation** uses Port66's own offers. The agent counters once at its ceiling. On its next run it checks the offer: accepted means it pays the agreed price (Port66 prices the checkout at the accepted offer); declined or expired means it walks away; still pending means it waits. It never counters twice.
- **The language layer** is optional. With `NEAR_AI_API_KEY` and `NEAR_AI_MODEL` set, NEAR AI Cloud reads the task and writes the counter-offer message. Without them, built-in rules do both. The model never decides whether to pay.
- **Receipts** go to `receipts.jsonl`, one line per task, including the ones where nothing was bought. The daily budget is calculated from these same lines.

## Keys and custody

| Key | What it is for |
|---|---|
| `AGENT_EVM_KEY` | Signs the agent in to Port66 as its own account (Sign-In with Ethereum). Holds no funds. |
| `AGENT_SOLANA_KEY` | Spending wallet for SOL (base58 secret key). |
| `AGENT_EVM_PAY_KEY` | Spending wallet for ETH, USDC and USDT on Ethereum, Arbitrum and Base. Kept separate from the sign-in key. |
| `AGENT_NEAR_ACCOUNT_ID` + `AGENT_NEAR_KEY` | Spending wallet for NEAR (wrapped to wNEAR on the way) and USDC on NEAR. |

Set only the spending wallets you want the agent to use, each holding a small float you fund. All keys stay in the process environment; only signatures leave the machine. The agent can only pay deposit addresses issued by a Port66 quote. BTC, DOGE and LTC can be quoted in a dry run but not paid live.

The limits are enforced by this program, not by a smart contract, so **the hard cap on what the agent can lose is the float you put in its wallet**: it cannot top itself up. Fund it with what you are willing to let it spend.

## Buying for real

```bash
export AGENT_EVM_KEY=0x...      # any fresh EVM private key; it only signs in
export AGENT_SOLANA_KEY=...     # base58 secret key, wallet funded with a little SOL
pnpm agent buy 'port66 test item under 10' --live

# or pay with ETH on Arbitrum, or with NEAR
export AGENT_EVM_PAY_KEY=0x...
pnpm agent buy 'port66 test item under 10' --live --pay ETH --chain Arbitrum
export AGENT_NEAR_ACCOUNT_ID=youragent.near AGENT_NEAR_KEY=ed25519:...
pnpm agent buy 'port66 test item under 10' --live --pay NEAR
```

Live mode reserves the item, re-checks the mandate, pays from the matching wallet, waits for NEAR Intents to deliver the seller's USDC, and confirms that Port66 recorded the order. If the swap cannot complete, NEAR Intents refunds the agent on the chain it paid from.

NEAR Intents has no testnet, so live mode moves real money. Use a small listing and a small float.

## Built for the NEAR Hackathon

- **Tracks:** Agent Economy, Real-World Money.
- **What is new in the hackathon window:** this agent, and Port66's NEAR Intents checkout it pays through (`apps/api/src/modules/near-intents`, `apps/web/src/components/marketplace/near-intents-pay-step.tsx`). The rest of Port66 existed before the hackathon and is not part of the submission.
- **Libraries:** `@solana/web3.js`, `viem`, `near-api-js`, `bs58`, `tsx`. NEAR Intents is called through its 1Click API with a small dependency-free client (`apps/api/src/modules/near-intents/one-click.client.ts`).

## Calling Port66's paid API (x402, behind Valiron)

```bash
AGENT_EVM_PAY_KEY=0x... pnpm agent x402                       # stops at the 402, spends nothing
AGENT_EVM_PAY_KEY=0x... pnpm agent x402 --pay                 # pays 0.005 USDC on Base, gets the data
AGENT_EVM_PAY_KEY=0x... pnpm agent x402 /api/agent/v1/market/<slug> --pay --times 5
```

What happens on each call:

1. The agent enrols its key with Valiron (EIP-191 challenge-response).
2. It signs the request (`valiron-wallet-request-v2`), so Port66 can prove the
   agent controls the address it claims before asking Valiron for its score.
3. A new agent gets `403 pending evaluation` once; Valiron scores it within
   about a minute (a fresh key scored 75, tier BAA, in testing).
4. A trusted agent gets the x402 challenge (`402`, 0.005 USDC on Base). With
   `--pay` it signs an EIP-3009 authorisation (gasless: hold USDC on Base,
   no ETH needed), retries with a fresh signature, and prints the Basescan
   link for the payment.

`--max <usd>` caps the price per call (default 0.05); `--base <url>` targets
another deployment.
