import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { BudgetExhausted, X402Agent } from "./x402.js";

/**
 * Port66's own agent fleet: three agents that do real, useful work through
 * the paid x402 API, each with its own Valiron identity and spending cap.
 *
 *   indexer  pages through the whole live catalogue and writes a structured
 *            index with brand, category and price-band counts
 *   scout    runs buyer-intent searches (brands, deadstock, size) and keeps
 *            a shortlist of the best-value pieces per search
 *   watcher  re-reads the most valuable listings and reports any price or
 *            availability change since its last run
 *
 * They are labelled as Port66's agents (in their reports and as their Valiron
 * identities); they are not presented as outside adoption. Every call is
 * signed, scored by Valiron, paid in USDC on Base and reported to Valiron.
 */

export const ROLES = ["indexer", "scout", "watcher"] as const;
export type Role = (typeof ROLES)[number];

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

interface Listing {
  slug: string;
  title: string;
  brand?: string | null;
  category?: string | null;
  price?: number | null;
  condition?: string | null;
  size?: string | null;
  status?: string;
  url?: string;
}

export class Fleet {
  constructor(
    private readonly dir: string,
    private readonly base: string,
    private readonly say: (line: string) => void,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /** Each role's key, created on first use and kept only on this machine. */
  key(role: Role): `0x${string}` {
    const file = join(this.dir, `${role}.key`);
    if (!existsSync(file)) {
      writeFileSync(file, generatePrivateKey() + "\n");
      chmodSync(file, 0o600);
    }
    return readFileSync(file, "utf8").trim() as `0x${string}`;
  }

  address(role: Role) {
    return privateKeyToAccount(this.key(role)).address;
  }

  private read<T>(name: string, fallback: T): T {
    const file = join(this.dir, name);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  }

  private write(name: string, value: unknown) {
    writeFileSync(join(this.dir, name), JSON.stringify(value, null, 2));
  }

  private url(path: string, params: Record<string, string | number> = {}) {
    const u = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u.toString();
  }

  // ── balances and funding ────────────────────────────────────────────────

  private reader() {
    return createPublicClient({ chain: base, transport: http(process.env.AGENT_BASE_RPC) });
  }

  async balances() {
    const reader = this.reader();
    const rows = [];
    for (const role of ROLES) {
      const address = this.address(role);
      const usdc = await reader.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [address] });
      rows.push({ role, address, usdc: Number(formatUnits(usdc, 6)) });
    }
    return rows;
  }

  /** Tops each agent up to `each` USDC from a treasury key (pays Base gas). */
  async fund(treasuryKey: `0x${string}`, each: number) {
    const treasury = privateKeyToAccount(treasuryKey);
    const reader = this.reader();
    const wallet = createWalletClient({ account: treasury, chain: base, transport: http(process.env.AGENT_BASE_RPC) });
    for (const row of await this.balances()) {
      const missing = each - row.usdc;
      if (missing < 0.001) {
        this.say(`  ${row.role}: already holds ${row.usdc} USDC`);
        continue;
      }
      const hash = await wallet.writeContract({
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: "transfer",
        args: [row.address, parseUnits(missing.toFixed(6), 6)],
        chain: base,
        account: treasury,
      });
      await reader.waitForTransactionReceipt({ hash });
      this.say(`  ${row.role}: +${missing.toFixed(3)} USDC  https://basescan.org/tx/${hash}`);
    }
  }

  // ── the jobs ────────────────────────────────────────────────────────────

  private agent(role: Role, budgetUsd: number) {
    return new X402Agent(this.key(role), { budgetUsd, say: this.say });
  }

  private paidLine(r: { status: number; paidUsd: number; paidTx?: string }, what: string) {
    this.say(`  ${r.status} ${what}${r.paidTx ? `  paid ${r.paidUsd} USDC  https://basescan.org/tx/${r.paidTx}` : ""}`);
  }

  /** Pages through every active listing and writes a catalogue index. */
  async indexer(budgetUsd: number) {
    const agent = this.agent("indexer", budgetUsd);
    const all: Listing[] = [];
    for (let page = 1; page <= 20; page++) {
      const r = await agent.get<{ meta?: { totalPages?: number }; listings?: Listing[] }>(
        this.url("/api/agent/v1/listings", { limit: 50, page }),
      );
      this.paidLine(r, `listings page ${page}`);
      if (r.status !== 200 || !r.body.listings) break;
      all.push(...r.body.listings);
      if (page >= (r.body.meta?.totalPages ?? 1)) break;
    }
    const count = (key: (l: Listing) => string | null | undefined) =>
      Object.entries(
        all.reduce<Record<string, number>>((acc, l) => {
          const k = (key(l) ?? "unknown").toString().trim() || "unknown";
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
      ).sort((a, b) => b[1] - a[1]);
    const band = (p?: number | null) =>
      p == null ? "make an offer" : p < 100 ? "under $100" : p < 500 ? "$100–499" : p < 2000 ? "$500–1,999" : "$2,000+";
    const report = {
      agent: "port66-indexer",
      at: new Date().toISOString(),
      listings: all.length,
      byBrand: count((l) => l.brand).slice(0, 25),
      byCategory: count((l) => l.category),
      byPriceBand: count((l) => band(l.price)),
    };
    this.write("catalogue.json", all);
    this.write("indexer-report.json", report);
    this.say(`  Indexed ${all.length} listings; ${report.byBrand.length} brands. Spent ${agent.spentUsd.toFixed(3)} USDC.`);
    return agent;
  }

  /** Buyer-intent searches; keeps the best-priced matches for each. */
  async scout(budgetUsd: number) {
    const agent = this.agent("scout", budgetUsd);
    const catalogue = this.read<Listing[]>("catalogue.json", []);
    const topBrands = [...new Set(catalogue.map((l) => l.brand?.trim()).filter(Boolean))].slice(0, 6) as string[];
    const searches: Record<string, string | number>[] = [
      ...topBrands.map((brandName) => ({ brandName, limit: 20 })),
      { condition: "DEADSTOCK", limit: 20 },
      { q: "bag", limit: 20 },
      { q: "sneakers", limit: 20 },
    ];
    const shortlist: Record<string, Listing[]> = {};
    try {
      for (const params of searches) {
        const label = Object.entries(params).filter(([k]) => k !== "limit").map(([k, v]) => `${k}=${v}`).join(" ");
        const r = await agent.get<{ listings?: Listing[] }>(this.url("/api/agent/v1/listings", params));
        this.paidLine(r, `search ${label}`);
        const priced = (r.body.listings ?? []).filter((l) => l.price != null).sort((a, b) => a.price! - b.price!);
        shortlist[label] = priced.slice(0, 3);
      }
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      this.say(`  ${error.message}`);
    }
    this.write("scout-shortlist.json", { agent: "port66-scout", at: new Date().toISOString(), shortlist });
    this.say(`  ${Object.keys(shortlist).length} searches shortlisted. Spent ${agent.spentUsd.toFixed(3)} USDC.`);
    return agent;
  }

  /** Re-reads the most valuable listings and reports changes since last run. */
  async watcher(budgetUsd: number, watch = 8) {
    const agent = this.agent("watcher", budgetUsd);
    const catalogue = this.read<Listing[]>("catalogue.json", []);
    const watched = catalogue
      .filter((l) => l.price != null && !/test/i.test(l.title))
      .sort((a, b) => b.price! - a.price!)
      .slice(0, watch);
    if (!watched.length) {
      this.say("  Nothing to watch yet: run the indexer first.");
      return agent;
    }
    const last = this.read<Record<string, { price: number | null; status?: string }>>("watcher-state.json", {});
    const now: typeof last = {};
    const changes: string[] = [];
    try {
      for (const l of watched) {
        const r = await agent.get<{ listing?: Listing } & Listing>(this.url(`/api/agent/v1/listings/${l.slug}`));
        this.paidLine(r, `listing ${l.slug}`);
        if (r.status === 404) {
          if (last[l.slug]) changes.push(`${l.title}: no longer listed`);
          continue;
        }
        const item = (r.body.listing ?? r.body) as Listing;
        now[l.slug] = { price: item.price ?? null, status: item.status };
        const before = last[l.slug];
        if (before && before.price !== now[l.slug].price)
          changes.push(`${item.title}: price ${before.price} -> ${now[l.slug].price}`);
        if (before && before.status !== now[l.slug].status)
          changes.push(`${item.title}: ${before.status} -> ${now[l.slug].status}`);
      }
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      this.say(`  ${error.message}`);
    }
    this.write("watcher-state.json", { ...last, ...now });
    this.write("watcher-report.json", { agent: "port66-watcher", at: new Date().toISOString(), changes });
    this.say(`  Watched ${Object.keys(now).length}; ${changes.length} change(s). Spent ${agent.spentUsd.toFixed(3)} USDC.`);
    for (const c of changes) this.say(`    ${c}`);
    return agent;
  }
}
