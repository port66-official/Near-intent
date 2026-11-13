import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { SpendRecord } from "./mandate.js";

/**
 * One line per decision the agent made, appended to receipts.jsonl.
 *
 * A receipt is written for every task, including the ones where nothing was
 * bought, so the owner can see why the agent walked away as well as what it
 * paid. The spend ledger (and so the daily budget) is derived from these
 * same lines: there is no second record that could drift from it.
 */
export interface Receipt {
  at: string;
  task: string;
  mode: "dry-run" | "live";
  outcome: "bought" | "countered" | "skipped" | "refused" | "failed" | "quoted";
  listing?: { id: string; slug: string; title: string; url: string };
  seller?: string;
  listedUsd?: number;
  agreedUsd?: number;
  /** What left the agent's wallet. */
  paid?: { amount: string; symbol: string; usd: number };
  /** What the seller received. */
  sellerReceived?: string;
  routingPct?: number;
  /** The agent's own check that the purchase really completed. */
  check?: { passed: boolean; detail: string };
  checkoutId?: string;
  orderId?: string;
  transactions?: { label: string; url: string }[];
  reason: string;
}

export class ReceiptBook {
  constructor(private readonly path: string) {}

  all(): Receipt[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Receipt);
  }

  add(receipt: Receipt): Receipt {
    appendFileSync(this.path, `${JSON.stringify(receipt)}\n`);
    return receipt;
  }

  /** Live money that actually left the wallet: the basis of the budget. */
  spend(): SpendRecord[] {
    return this.all()
      .filter((r) => r.mode === "live" && r.paid && r.outcome !== "refused")
      .map((r) => ({ at: r.at, spentUsd: r.paid!.usd }));
  }

  /** A CSV a bookkeeper can open without questions. */
  csv(): string {
    const head = [
      "date",
      "mode",
      "outcome",
      "item",
      "listing_url",
      "listed_usd",
      "agreed_usd",
      "paid_amount",
      "paid_asset",
      "paid_usd",
      "seller_received",
      "routing_pct",
      "check_passed",
      "order_id",
      "reason",
    ];
    const cell = (v: unknown) => {
      const s = v === undefined || v === null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = this.all().map((r) =>
      [
        r.at,
        r.mode,
        r.outcome,
        r.listing?.title,
        r.listing?.url,
        r.listedUsd?.toFixed(2),
        r.agreedUsd?.toFixed(2),
        r.paid?.amount,
        r.paid?.symbol,
        r.paid?.usd.toFixed(2),
        r.sellerReceived,
        r.routingPct?.toFixed(2),
        r.check ? (r.check.passed ? "yes" : "no") : "",
        r.orderId,
        r.reason,
      ]
        .map(cell)
        .join(","),
    );
    return [head.join(","), ...rows].join("\n") + "\n";
  }
}
