import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptQuote,
  decide,
  parseMandate,
  rank,
  spendingRoom,
  spentToday,
  type Candidate,
  type Mandate,
} from "../src/mandate.js";
import { parseTaskRules } from "../src/brain.js";
import { toBaseUnits } from "../src/wallet.js";
import { ReceiptBook } from "../src/receipts.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mandate: Mandate = parseMandate({
  killSwitch: false,
  maxItemUsd: 300,
  dailyBudgetUsd: 350,
  maxRoutingPct: 3,
  payWith: ["SOL"],
  negotiation: { enabled: true, stretchPct: 25 },
  minSellerRating: 0,
  shipTo: { name: "x" },
});

const item = (over: Partial<Candidate> = {}): Candidate => ({
  id: "l1",
  slug: "elmo",
  title: "KAWS Elmo",
  priceUsd: 280,
  shippingUsd: 0,
  sellerRating: null,
  sellerCanReceive: true,
  ...over,
});

test("rejects an incomplete mandate, listing every problem", () => {
  assert.throws(() => parseMandate({ maxItemUsd: -1 }), (e: Error) =>
    e.message.includes("killSwitch") && e.message.includes("maxItemUsd") && e.message.includes("shipTo"),
  );
});

test("buys at or under the ceiling", () => {
  const d = decide(mandate, item(), 300, 350);
  assert.equal(d.action, "buy");
});

test("the task's ceiling can lower the owner's, never raise it", () => {
  assert.equal(decide(mandate, item({ priceUsd: 280 }), 250, 350).action, "counter");
  assert.equal(decide(mandate, item({ priceUsd: 320 }), 1000, 350).action, "counter");
  assert.equal(decide(mandate, item({ priceUsd: 380 }), 1000, 350).action, "skip");
});

test("counters once at the ceiling when the price is within the stretch", () => {
  const d = decide(mandate, item({ priceUsd: 310 }), 300, 350);
  assert.deepEqual([d.action, d.action === "counter" && d.offerUsd], ["counter", 300]);
});

test("walks away when too far above the ceiling, or negotiation is off", () => {
  assert.equal(decide(mandate, item({ priceUsd: 400 }), 300, 350).action, "skip");
  const strict = { ...mandate, negotiation: { enabled: false, stretchPct: 25 } };
  assert.equal(decide(strict, item({ priceUsd: 310 }), 300, 350).action, "skip");
});

test("never buys what could exceed the day's remaining budget, routing included", () => {
  // 280 * 1.03 = 288.40 worst case
  assert.equal(decide(mandate, item(), 300, 288).action, "skip");
  assert.equal(decide(mandate, item(), 300, 289).action, "buy");
});

test("skips sellers who cannot be paid, or rated below the minimum", () => {
  assert.equal(decide(mandate, item({ sellerCanReceive: false }), 300, 350).action, "skip");
  const picky = { ...mandate, minSellerRating: 4 };
  assert.equal(decide(picky, item({ sellerRating: 3.2 }), 300, 350).action, "skip");
  assert.equal(decide(picky, item({ sellerRating: null }), 300, 350).action, "buy");
});

test("the kill switch stops everything", () => {
  const room = spendingRoom({ ...mandate, killSwitch: true }, []);
  assert.equal(room.allowed, false);
  assert.match(room.reason, /kill switch/);
});

test("the daily budget counts only today's spend", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const records = [
    { at: "2026-11-13T09:00:00Z", spentUsd: 200 },
    { at: "2026-11-12T23:59:00Z", spentUsd: 500 },
  ];
  assert.equal(spentToday(records, now), 200);
  assert.equal(spendingRoom(mandate, records, now).remainingUsd, 150);
  assert.equal(spendingRoom(mandate, [...records, { at: "2026-11-13T10:00:00Z", spentUsd: 150 }], now).allowed, false);
});

test("refuses a live quote whose routing cost or total breaks the mandate", () => {
  assert.equal(acceptQuote(mandate, 280, 284, 350).ok, true);
  assert.match(acceptQuote(mandate, 280, 290, 350).reason, /routing costs 3\.57%/);
  assert.match(acceptQuote(mandate, 280, 284, 283).reason, /exceeds/);
  assert.equal(acceptQuote(mandate, 280, 0, 350).ok, false);
});

test("ranks cheapest first, postage included", () => {
  const ranked = rank([item({ id: "a", priceUsd: 100, shippingUsd: 30 }), item({ id: "b", priceUsd: 110 })]);
  assert.deepEqual(ranked.map((c) => c.id), ["b", "a"]);
});

test("reads a task without any model", () => {
  assert.deepEqual(parseTaskRules("Find me a KAWS figure under $300, pay with SOL"), { query: "KAWS figure", maxUsd: 300 });
  assert.deepEqual(parseTaskRules("chrome hearts tee"), { query: "chrome hearts tee", maxUsd: undefined });
  // What a shell leaves of "under $300" in double quotes: no ceiling, not $0.
  assert.equal(parseTaskRules("KAWS under 00").maxUsd, undefined);
});

test("converts decimal amounts to base units exactly", () => {
  assert.equal(toBaseUnits("3.438636499", 9), 3438636499n);
  assert.equal(toBaseUnits("0.1", 9), 100000000n);
  assert.equal(toBaseUnits("2", 6), 2000000n);
  assert.throws(() => toBaseUnits("1e9", 9));
});

test("only live payments count toward the budget, and the CSV escapes cells", () => {
  const book = new ReceiptBook(join(mkdtempSync(join(tmpdir(), "agent-")), "r.jsonl"));
  book.add({ at: "2026-11-13T09:00:00Z", task: "t", mode: "dry-run", outcome: "quoted", paid: { amount: "1", symbol: "SOL", usd: 80 }, reason: "dry" });
  book.add({ at: "2026-11-13T10:00:00Z", task: "t", mode: "live", outcome: "bought", paid: { amount: "1", symbol: "SOL", usd: 81 }, listing: { id: "l", slug: "s", title: 'Tee, "M"', url: "u" }, reason: "ok" });
  assert.deepEqual(book.spend(), [{ at: "2026-11-13T10:00:00Z", spentUsd: 81 }]);
  assert.match(book.csv(), /"Tee, ""M"""/);
});
