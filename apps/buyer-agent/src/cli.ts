/**
 * Port66 buyer agent.
 *
 *   pnpm agent custody                         what the agent holds and cannot do
 *   pnpm agent buy "a KAWS figure under $300"  dry run: decides and quotes, spends nothing
 *   pnpm agent buy "..." --live                does it for real, inside the mandate
 *   pnpm agent ledger [--csv]                  every receipt so far
 *   pnpm agent x402 [path] [--pay] [--times N] call Port66's paid API as a
 *                                              Valiron-verified agent (x402)
 *   pnpm agent setup                           create a dedicated test buyer: keys in .env,
 *                                              tight limits in agent.config.json
 *   pnpm agent wallets                         the buyer's addresses and balances
 *   pnpm agent fleet status                    Port66's agent fleet: addresses, USDC
 *   pnpm agent fleet fund --each 0.05          top each agent up from AGENT_EVM_PAY_KEY
 *   pnpm agent fleet run [indexer|scout|watcher] [--budget 0.05]
 *                                              do the fleet's jobs through the paid API
 *
 * Options: --config <file> (default agent.config.json, else the example),
 *          --pay <SYMBOL>, --chain <name> (e.g. Arbitrum for ETH),
 *          --listing <slug> (skip search), --receipts <file>.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { createPublicClient, erc20Abi, formatUnits, http as viemHttp } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrum as arbChain, base as baseChain, mainnet as ethChain } from "viem/chains";
import { resolve } from "node:path";
import { OneClickClient } from "../../api/src/modules/near-intents/one-click.client";
import { SETTLEMENTS } from "../../api/src/modules/near-intents/intent-assets";
import {
  acceptQuote,
  decide,
  parseMandate,
  rank,
  spendingRoom,
  usd,
  type Candidate,
  type ListingDecision,
  type Mandate,
} from "./mandate.js";
import { brainName, counterMessage, readTask } from "./brain.js";
import { Port66, type IntentCheckout } from "./port66.js";
import { ReceiptBook, type Receipt } from "./receipts.js";
import { payerFor, type Payer } from "./payers.js";
import { callPaidEndpoint } from "./x402.js";
import { Fleet, ROLES, type Role } from "./fleet.js";

// ── arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv
  .slice(1)
  .filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));

const here = resolve(new URL(".", import.meta.url).pathname, "..");
// The test buyer's keys live in a git-ignored .env next to the agent.
if (existsSync(resolve(here, ".env"))) process.loadEnvFile(resolve(here, ".env"));
const configPath = option("config")
  ? resolve(option("config")!)
  : existsSync(resolve(here, "agent.config.json"))
    ? resolve(here, "agent.config.json")
    : resolve(here, "agent.config.example.json");
const receipts = new ReceiptBook(resolve(option("receipts") ?? resolve(here, "receipts.jsonl")));
const port66 = new Port66(process.env.PORT66_URL ?? "https://port66.xyz");
const LIVE = flag("live");

// ── output ───────────────────────────────────────────────────────────────────

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const say = (s = "") => console.log(s);
const step = (s: string) => say(`${bold("•")} ${s}`);

function loadMandate(): Mandate {
  return parseMandate(JSON.parse(readFileSync(configPath, "utf8")));
}

function record(receipt: Omit<Receipt, "at" | "mode">): Receipt {
  const full = receipts.add({
    at: new Date().toISOString(),
    mode: LIVE ? "live" : "dry-run",
    ...receipt,
  });
  say();
  say(bold(`Receipt (${full.mode}): ${full.outcome}`));
  if (full.listing) say(`  item      ${full.listing.title}  ${dim(full.listing.url)}`);
  if (full.seller) say(`  seller    ${full.seller}`);
  if (full.listedUsd !== undefined) say(`  listed    ${usd(full.listedUsd)}`);
  if (full.agreedUsd !== undefined) say(`  agreed    ${usd(full.agreedUsd)}`);
  if (full.paid)
    say(`  ${full.mode === "live" ? "paid" : "would pay"}  ${full.paid.amount} ${full.paid.symbol} (${usd(full.paid.usd)})`);
  if (full.sellerReceived) say(`  seller gets ${full.sellerReceived}`);
  if (full.routingPct !== undefined) say(`  routing   ${full.routingPct.toFixed(2)}%`);
  if (full.check) say(`  check     ${full.check.passed ? "passed" : "FAILED"}: ${full.check.detail}`);
  for (const tx of full.transactions ?? []) say(`  ${tx.label.padEnd(9)} ${dim(tx.url)}`);
  say(`  why       ${full.reason}`);
  return full;
}

// ── custody ──────────────────────────────────────────────────────────────────

function custody(mandate: Mandate) {
  say(bold("How this agent holds its keys"));
  say(`  AGENT_EVM_KEY     signs it in to Port66 as its own account. Holds no funds.`);
  say(`  Spending wallets, each a small float the owner funds (set only the ones you use):`);
  say(`    AGENT_SOLANA_KEY                         SOL on Solana`);
  say(`    AGENT_EVM_PAY_KEY                        ETH, USDC, USDT on Ethereum, Arbitrum, Base`);
  say(`    AGENT_NEAR_ACCOUNT_ID + AGENT_NEAR_KEY   NEAR (wrapped on the way) and USDC on NEAR`);
  say(`  All stay in this process's environment. Only signatures leave the machine.`);
  say();
  say(bold("What it can do on its own"));
  say(`  Search Port66, counter once on price, and pay a Port66 quote's one-time`);
  say(`  NEAR Intents deposit address, which turns what it pays with into the seller's USDC.`);
  say();
  say(bold("What it cannot do"));
  say(`  - pay any address that did not come from a Port66 quote`);
  say(`  - pay more than ${usd(mandate.maxItemUsd)} for an item, or more than ${usd(mandate.dailyBudgetUsd)} in a UTC day`);
  say(`  - accept a route costing more than ${mandate.maxRoutingPct}% on top of the price`);
  say(`  - pay with anything but ${mandate.payWith.join(", ")}`);
  say(`  - counter more than once on the same item`);
  say(`  - act at all while the kill switch is on (now: ${mandate.killSwitch ? "ON" : "off"})`);
  say();
  say(bold("What needs the owner"));
  say(`  Funding the wallet, changing ${configPath.split("/").pop()}, anything above the limits,`);
  say(`  and any purchase Port66 flags for review.`);
  say();
  say(dim(`  The limits are enforced by this program before every payment, and the`));
  say(dim(`  config is re-read right before money moves. The hard cap on loss is the`));
  say(dim(`  float itself: the agent cannot top up its own wallet.`));
  say(dim(`  Language layer: ${brainName()}. It never decides whether to pay.`));
}

// ── buy ──────────────────────────────────────────────────────────────────────

async function buy(taskText: string) {
  let mandate = loadMandate();
  const room = spendingRoom(mandate, receipts.spend());
  say(`${bold(LIVE ? "LIVE" : "DRY RUN")} ${dim(`(mandate: ${configPath.split("/").pop()}, ${room.reason})`)}`);
  if (!room.allowed)
    return record({ task: taskText, outcome: "refused", reason: `Not spending: ${room.reason}.` });

  const payWith = (option("pay") ?? mandate.payWith[0]).toUpperCase();
  if (!mandate.payWith.map((s) => s.toUpperCase()).includes(payWith))
    return record({ task: taskText, outcome: "refused", reason: `${payWith} is not in the owner's payWith list.` });

  const task = await readTask(taskText);
  const ceiling = Math.min(task.maxUsd ?? mandate.maxItemUsd, mandate.maxItemUsd);
  step(`Task read as "${task.query}", ceiling ${usd(ceiling)}${task.maxUsd && task.maxUsd > mandate.maxItemUsd ? dim(` (owner caps items at ${usd(mandate.maxItemUsd)})`) : ""}`);

  const assets = await port66.intentAssets();
  // --chain picks among same-symbol assets (ETH on Arbitrum vs Ethereum);
  // otherwise SOL means Solana and anything else the first listed.
  const chain = option("chain")?.toLowerCase();
  const asset = assets.find(
    (a) =>
      a.symbol === payWith &&
      (chain ? a.chain.toLowerCase() === chain : payWith !== "SOL" || a.chain === "Solana"),
  ) ?? (chain ? undefined : assets.find((a) => a.symbol === payWith));
  if (!asset)
    return record({ task: taskText, outcome: "refused", reason: `Port66 is not accepting ${payWith}${chain ? ` on ${chain}` : ""} right now.` });
  // Fail before searching or signing in if this chain cannot be paid from.
  const payer = LIVE ? payerFor(asset) : undefined;

  const searchCeiling = mandate.negotiation.enabled
    ? ceiling * (1 + mandate.negotiation.stretchPct / 100)
    : ceiling;
  const slug = option("listing");
  const found = slug
    ? [await port66.listing(slug)]
    : rank(await port66.search(task.query, searchCeiling));
  step(`${found.length} listing${found.length === 1 ? "" : "s"} considered`);
  if (!found.length)
    return record({ task: taskText, outcome: "skipped", reason: `Nothing on Port66 matched "${task.query}" within reach of ${usd(ceiling)}.` });

  let chosen: { c: Candidate; d: ListingDecision } | undefined;
  for (const c of found) {
    const d = decide(mandate, c, ceiling, room.remainingUsd);
    say(`  ${d.action === "skip" ? dim("skip   ") : bold(d.action.padEnd(7))} ${c.title} ${dim(usd(c.priceUsd))}  ${dim(d.reason)}`);
    if (!chosen && d.action !== "skip") chosen = { c, d };
  }
  if (!chosen)
    return record({ task: taskText, outcome: "skipped", reason: "No listing fits the owner's rules." });

  const { c } = chosen;
  let decision = chosen.d;
  const listing = { id: c.id, slug: c.slug, title: c.title, url: port66.listingUrl(c.slug) };
  const seller = await port66.sellerName(c.slug).catch(() => undefined);

  let agreedUsd: number | undefined;
  if (LIVE) {
    const address = await port66.signIn(requireKey("AGENT_EVM_KEY") as `0x${string}`);
    step(`Signed in to Port66 as ${dim(address)}`);
    // Counter once: an earlier offer on this item decides what happens now.
    const prior = await port66.offerStatus(c.id);
    if (prior.payableAt !== null && prior.payableAt <= ceiling) {
      agreedUsd = prior.payableAt;
      decision = { action: "buy", priceUsd: agreedUsd, reason: `the seller accepted the counter at ${usd(agreedUsd)}` };
      step(`The seller accepted ${usd(agreedUsd)}`);
    } else if (decision.action === "counter" && prior.offer) {
      const waiting = prior.offer.status === "PENDING" && Date.parse(prior.offer.expiresAt) > Date.now();
      return record({
        task: taskText, outcome: "skipped", listing, seller, listedUsd: c.priceUsd,
        reason: waiting
          ? `Already countered at ${usd(prior.offer.amountUsd)}; waiting for the seller. It only counters once.`
          : `The one counter at ${usd(prior.offer.amountUsd)} was ${prior.offer.status.toLowerCase()}; walking away.`,
      });
    }
  }

  if (decision.action === "counter") {
    const message = await counterMessage({ title: c.title, listedUsd: c.priceUsd, offerUsd: decision.offerUsd, ceilingUsd: ceiling });
    if (LIVE) await port66.offer(c.id, decision.offerUsd, message);
    say();
    say(`${bold(LIVE ? "Counter-offer sent:" : "Counter-offer it would send:")} ${message}`);
    return record({
      task: taskText, outcome: "countered", listing, seller, listedUsd: c.priceUsd, agreedUsd: undefined,
      reason: `${decision.reason}. Offered ${usd(decision.offerUsd)} once${LIVE ? "; run again after the seller answers" : ""}.`,
    });
  }
  if (decision.action !== "buy") throw new Error("unreachable");

  const dueUsd = (agreedUsd ?? c.priceUsd) + c.shippingUsd;
  return LIVE
    ? buyLive({ taskText, c, listing, seller, dueUsd, agreedUsd, assetId: asset.assetId, symbol: asset.symbol, chain: asset.chain, payer: payer! })
    : quoteDry({ taskText, c, listing, seller, dueUsd, assetId: asset.assetId, symbol: asset.symbol, chain: asset.chain, remainingUsd: room.remainingUsd, mandate });
}

interface BuyContext {
  taskText: string;
  c: Candidate;
  listing: Receipt["listing"];
  seller?: string;
  dueUsd: number;
  assetId: string;
  symbol: string;
  chain?: string;
}

/** Dry run: ask NEAR Intents' solvers for a real price; spend nothing. */
async function quoteDry(ctx: BuyContext & { remainingUsd: number; mandate: Mandate }) {
  const client = new OneClickClient({ apiKey: process.env.NEAR_INTENTS_API_KEY });
  // A dry quote only needs a well-formed refund address on the paying chain.
  const sample: Record<string, string> = {
    Solana: "DmT8iUarUdx5p1HbMxc642zAuPNm8C2chL62rcAena5w",
    Ethereum: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    Arbitrum: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    Base: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    NEAR: "alice.near",
    Bitcoin: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    Dogecoin: "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L",
    Litecoin: "ltc1qhzjptwpym9afcdjhs7jcz6fd0jma0l0rc0e5yr",
  };
  const refundTo = sample[ctx.chain ?? "Solana"] ?? sample.Solana;
  const { quote } = await client.quote({
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: ctx.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: SETTLEMENTS[ctx.c.sellerChain === "Base" ? "base" : "mainnet-beta"].assetId,
    amount: BigInt(Math.round(ctx.dueUsd * 1e6)).toString(),
    recipient: ctx.c.sellerWallet ?? (ctx.c.sellerChain === "Base" ? sample.Base : sample.Solana),
    recipientType: "DESTINATION_CHAIN",
    refundTo,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    referral: "port66",
  });
  const sendUsd = Number(quote.amountInUsd);
  const verdict = acceptQuote(ctx.mandate, ctx.dueUsd, sendUsd, ctx.remainingUsd);
  step(`NEAR Intents quote: send ${quote.amountInFormatted} ${ctx.symbol} so the seller gets exactly ${quote.amountOutFormatted} USDC`);
  return record({
    task: ctx.taskText,
    outcome: verdict.ok ? "quoted" : "refused",
    listing: ctx.listing,
    seller: ctx.seller,
    listedUsd: ctx.c.priceUsd,
    paid: { amount: quote.amountInFormatted, symbol: ctx.symbol, usd: sendUsd },
    sellerReceived: `${quote.amountOutFormatted} USDC on ${ctx.c.sellerChain ?? "Solana"}`,
    routingPct: verdict.routingPct,
    reason: verdict.ok
      ? `Would buy: ${verdict.reason}. Dry run, so nothing was reserved or sent. Add --live to buy.`
      : `Would refuse: ${verdict.reason}.`,
  });
}

/** Live: reserve, re-check the mandate, pay, and confirm the order exists. */
async function buyLive(ctx: BuyContext & { agreedUsd?: number; payer: Payer }) {
  const { payer } = ctx;
  const asset = { assetId: ctx.assetId, symbol: ctx.symbol, chain: ctx.chain ?? payer.chain };
  let checkout = await port66.quote({
    listingId: ctx.c.id,
    originAsset: ctx.assetId,
    // Refunds go back to the agent's own address on the chain it pays from.
    refundTo: payer.address,
    shippingAddress: loadMandate().shipTo,
  });
  step(`Item reserved. Quote: send ${checkout.pay.amount} ${checkout.pay.symbol} (${usd(Number(checkout.pay.amountUsd))})`);
  if (checkout.state !== "awaiting_deposit") return settle(ctx, checkout, "This item already has a payment from the agent in progress.");

  // The owner can change the rules at any moment: read them again now.
  const mandate = loadMandate();
  const room = spendingRoom(mandate, receipts.spend());
  const due = Number(checkout.sellerReceivesUsdc);
  const verdict = acceptQuote(mandate, due, Number(checkout.pay.amountUsd), room.remainingUsd);
  const reasons = [
    !room.allowed && room.reason,
    due > ctx.dueUsd + 0.01 && `Port66 priced it at ${usd(due)}, above the ${usd(ctx.dueUsd)} the agent agreed to`,
    !verdict.ok && verdict.reason,
  ].filter(Boolean);
  if (reasons.length)
    return record({
      task: ctx.taskText, outcome: "refused", listing: ctx.listing, seller: ctx.seller, listedUsd: ctx.c.priceUsd,
      agreedUsd: ctx.agreedUsd, routingPct: verdict.routingPct, checkoutId: checkout.id,
      reason: `Did not pay: ${reasons.join("; ")}. The reservation lapses on its own.`,
    });

  const amount = BigInt(checkout.pay.amountBaseUnits);
  const balance = await payer.balance(asset);
  if (balance < amount)
    return record({
      task: ctx.taskText, outcome: "refused", listing: ctx.listing, seller: ctx.seller, checkoutId: checkout.id,
      reason: `The agent's ${asset.chain} wallet cannot cover ${checkout.pay.amount} ${asset.symbol} plus fees. The owner must fund ${payer.address}.`,
    });

  step(`Paying ${checkout.pay.amount} ${asset.symbol} on ${asset.chain} to the NEAR Intents deposit address ${dim(checkout.pay.depositAddress)}`);
  const signature = await payer.pay(asset, checkout.pay.depositAddress, amount);
  step(`Sent ${dim(payer.explorer(signature))}`);
  checkout = await port66.reportDeposit(checkout.id, signature).catch(() => checkout);

  const until = Date.now() + 15 * 60_000;
  let last = checkout.state;
  while (["awaiting_deposit", "deposit_seen", "incomplete_deposit", "processing"].includes(checkout.state) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5_000));
    checkout = await port66.checkout(checkout.id).catch(() => checkout);
    if (checkout.state !== last) step(`Status: ${checkout.state.replace(/_/g, " ")}`);
    last = checkout.state;
  }
  return settle(ctx, checkout, undefined, {
    amount: checkout.pay.amount,
    usd: Number(checkout.pay.amountUsd),
    signature,
    url: payer.explorer(signature),
  });
}

function settle(
  ctx: BuyContext & { agreedUsd?: number },
  checkout: IntentCheckout,
  note?: string,
  sent?: { amount: string; usd: number; signature: string; url: string },
) {
  const delivered = checkout.deliveryTx.length > 0;
  const passed = checkout.state === "paid" && !!checkout.orderId && delivered;
  const transactions = [
    ...(sent ? [{ label: "paid", url: sent.url }] : []),
    ...checkout.deliveryTx.map((t) => ({ label: "delivered", url: t.explorerUrl })),
  ];
  return record({
    task: ctx.taskText,
    outcome: passed ? "bought" : "failed",
    listing: ctx.listing,
    seller: ctx.seller,
    listedUsd: ctx.c.priceUsd,
    agreedUsd: ctx.agreedUsd,
    ...(sent ? { paid: { amount: sent.amount, symbol: ctx.symbol, usd: sent.usd } } : {}),
    sellerReceived: delivered
      ? `${checkout.sellerReceivesUsdc} USDC on ${(checkout as { settlementChain?: string }).settlementChain ?? "Solana"}`
      : undefined,
    check: {
      passed,
      detail: passed
        ? `Port66 recorded order ${checkout.orderId} and the seller's USDC delivery is on chain`
        : `checkout ended as "${checkout.state}"${checkout.state === "review" ? "; the owner must contact Port66 support" : ""}`,
    },
    checkoutId: checkout.id,
    orderId: checkout.orderId,
    transactions,
    reason: note ?? (passed ? "Bought within the mandate." : "The payment did not complete; any funds are refunded to the agent's wallet by NEAR Intents."),
  });
}

function requireKey(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Live mode needs the agent's keys; see the README.`);
  return value;
}

// ── ledger ───────────────────────────────────────────────────────────────────

function ledger() {
  if (flag("csv")) return void process.stdout.write(receipts.csv());
  const all = receipts.all();
  if (!all.length) return say("No receipts yet.");
  for (const r of all)
    say(`${r.at.slice(0, 16).replace("T", " ")}  ${r.mode.padEnd(7)}  ${r.outcome.padEnd(9)}  ${(r.listing?.title ?? r.task).slice(0, 40).padEnd(40)}  ${r.paid ? `${r.paid.amount} ${r.paid.symbol}` : ""}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

// ── x402: the paid agent API, behind Valiron ─────────────────────────────────

async function x402(path: string) {
  const key = process.env.AGENT_EVM_PAY_KEY?.trim();
  if (!key) throw new Error("Set AGENT_EVM_PAY_KEY: the agent's EVM key (it pays USDC on Base, no ETH needed).");
  const base = option("base") ?? "https://port66.xyz";
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base).toString();
  const times = Math.max(1, Math.min(50, Number(option("times") ?? 1)));
  const maxUsd = Number(option("max") ?? 0.05);

  for (let i = 1; i <= times; i++) {
    if (times > 1) say(`\n${bold(`Call ${i} of ${times}`)}`);
    const result = await callPaidEndpoint({ url, key: key as `0x${string}`, pay: flag("pay"), maxUsd, say });
    say(`${bold(result.stage.toUpperCase())} (${result.status}): ${result.detail}`);
    if (result.paidTx) say(`USDC payment: https://basescan.org/tx/${result.paidTx}`);
    if (result.stage === "served" && result.body) say(JSON.stringify(result.body, null, 2).slice(0, 800));
    if (result.stage === "trust") say("Valiron has not cleared this agent yet. A new agent is evaluated first; retry in a minute.");
  }
}

// ── fleet: Port66's own agents doing real work through the paid API ──────────

async function fleet(action: string | undefined, role: string | undefined) {
  const f = new Fleet(resolve(here, ".fleet"), option("base") ?? "https://port66.xyz", say);
  if (action === "status") {
    for (const r of await f.balances()) say(`${r.role.padEnd(8)} ${r.address}  ${r.usdc} USDC on Base`);
    return;
  }
  if (action === "fund") {
    const key = process.env.AGENT_EVM_PAY_KEY?.trim();
    if (!key) throw new Error("Set AGENT_EVM_PAY_KEY to the treasury key (holds USDC and a little ETH on Base).");
    return f.fund(key as `0x${string}`, Number(option("each") ?? 0.05));
  }
  if (action === "run") {
    const budget = Number(option("budget") ?? 0.05);
    const roles = (role ? [role] : ROLES) as Role[];
    for (const r of roles) {
      if (!ROLES.includes(r)) throw new Error(`Unknown role ${r}. Roles: ${ROLES.join(", ")}`);
      say(`\n${bold(`port66-${r}`)} (${f.address(r)}), budget ${budget} USDC`);
      await f[r](budget);
    }
    say(`\nReports are in ${resolve(here, ".fleet")}.`);
    return;
  }
  throw new Error("Usage: pnpm agent fleet status | fund [--each 0.05] | run [indexer|scout|watcher] [--budget 0.05]");
}

// ── setup: a dedicated, funded test buyer ────────────────────────────────────

function setup() {
  const envFile = resolve(here, ".env");
  const configFile = resolve(here, "agent.config.json");
  if (existsSync(envFile) && /AGENT_EVM_KEY=/.test(readFileSync(envFile, "utf8"))) {
    say("A buyer already exists in .env; keeping its keys. Run: pnpm agent wallets");
  } else {
    const lines = [
      "# Port66 test buyer agent. Private keys: never commit or share this file.",
      `AGENT_EVM_KEY=${generatePrivateKey()}`,
      `AGENT_EVM_PAY_KEY=${generatePrivateKey()}`,
      `AGENT_SOLANA_KEY=${bs58.encode(Keypair.generate().secretKey)}`,
      "",
    ];
    writeFileSync(envFile, lines.join("\n"), { flag: "a" });
    chmodSync(envFile, 0o600);
    say("Created the buyer's keys in .env (readable only by you).");
  }
  if (!existsSync(configFile)) {
    const example = JSON.parse(readFileSync(resolve(here, "agent.config.example.json"), "utf8"));
    writeFileSync(
      configFile,
      JSON.stringify(
        { ...example, maxItemUsd: 10, dailyBudgetUsd: 25, maxRoutingPct: 5, payWith: ["USDC", "ETH", "SOL"], negotiation: { enabled: false, stretchPct: 0 } },
        null,
        2,
      ),
    );
    say("Wrote agent.config.json: one item up to $10, $25 a day, pays with USDC, ETH or SOL. Set shipTo to a real address.");
  }
  process.loadEnvFile(envFile);
}

async function wallets() {
  const evm = process.env.AGENT_EVM_KEY?.trim();
  const pay = process.env.AGENT_EVM_PAY_KEY?.trim();
  const sol = process.env.AGENT_SOLANA_KEY?.trim();
  if (!evm || !pay) throw new Error("No buyer yet. Run: pnpm agent setup");
  say(`Port66 account (sign-in only, holds nothing): ${privateKeyToAccount(evm as `0x${string}`).address}`);
  const payAddr = privateKeyToAccount(pay as `0x${string}`).address;
  say(`\nEVM spending wallet: ${payAddr}  (fund with USDC or ETH on Base, Arbitrum or Ethereum)`);
  const USDC: Record<string, `0x${string}`> = {
    Base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    Arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    Ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  };
  for (const [name, chain] of [["Base", baseChain], ["Arbitrum", arbChain], ["Ethereum", ethChain]] as const) {
    const reader = createPublicClient({ chain, transport: viemHttp(process.env[`AGENT_${name.toUpperCase()}_RPC`]) });
    const [eth, usdc] = await Promise.all([
      reader.getBalance({ address: payAddr }),
      reader.readContract({ address: USDC[name], abi: erc20Abi, functionName: "balanceOf", args: [payAddr] }),
    ]).catch(() => [0n, 0n] as const);
    say(`  ${name.padEnd(9)} ${formatUnits(eth, 18).slice(0, 10)} ETH   ${formatUnits(usdc, 6)} USDC`);
  }
  if (sol) {
    const wallet = Keypair.fromSecretKey(bs58.decode(sol));
    say(`\nSolana spending wallet: ${wallet.publicKey.toBase58()}  (fund with SOL)`);
  }
}

async function main() {
  if (command === "custody") return custody(loadMandate());
  if (command === "ledger") return ledger();
  if (command === "buy" && positional.length) return void (await buy(positional.join(" ")));
  if (command === "x402") return x402(positional[0] ?? "/api/agent/v1/listings?limit=3");
  if (command === "fleet") return fleet(positional[0], positional[1]);
  if (command === "setup") return void (setup(), await wallets());
  if (command === "wallets") return wallets();
  say(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, "").replace(/^ \* ?/gm, "").trim());
  process.exitCode = command ? 1 : 0;
}

main().catch((error) => {
  console.error(`\n${bold("Error:")} ${(error as Error).message}`);
  process.exitCode = 1;
});
