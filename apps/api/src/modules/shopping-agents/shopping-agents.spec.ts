import { evaluate, searchWords, type AgentRules, type Candidate } from "./shopping-agent.rules";

const rules: AgentRules = { userId: "buyer", maxItemUsd: 300, dailyBudgetUsd: 500, negotiate: false };
const item = (over: Partial<Candidate> = {}): Candidate => ({
  id: "l1",
  sellerId: "seller",
  title: "KAWS x Sesame Street Elmo",
  priceUsd: 280,
  shippingUsd: 0,
  ...over,
});

describe("shopping agent rules", () => {
  it("matches an item within the limit, postage included", () => {
    const v = evaluate(item({ priceUsd: 280, shippingUsd: 15 }), rules, 0);
    expect(v).toEqual(expect.objectContaining({ kind: "match", totalUsd: 295 }));
  });

  it("skips when postage pushes the total over the limit", () => {
    expect(evaluate(item({ priceUsd: 290, shippingUsd: 15 }), rules, 0).kind).toBe("skip");
  });

  it("never proposes the user's own listing", () => {
    expect(evaluate(item({ sellerId: "buyer" }), rules, 0)).toEqual({ kind: "skip", reason: "Your own listing" });
  });

  it("skips offer-only listings with no price", () => {
    expect(evaluate(item({ priceUsd: null }), rules, 0).kind).toBe("skip");
  });

  it("respects what is already committed today", () => {
    const v = evaluate(item({ priceUsd: 280 }), rules, 300);
    expect(v.kind).toBe("skip");
    expect(v.reason).toMatch(/budget/);
  });

  it("offers at the limit only when negotiation is on and the price is within 15%", () => {
    const close = item({ priceUsd: 330 });
    expect(evaluate(close, rules, 0).kind).toBe("skip");
    expect(evaluate(close, { ...rules, negotiate: true }, 0)).toEqual(
      expect.objectContaining({ kind: "offer", offerUsd: 300 }),
    );
    expect(evaluate(item({ priceUsd: 400 }), { ...rules, negotiate: true }, 0).kind).toBe("skip");
  });

  it("offers on the item price, leaving room for postage", () => {
    const v = evaluate(item({ priceUsd: 320, shippingUsd: 20 }), { ...rules, negotiate: true }, 0);
    expect(v).toEqual(expect.objectContaining({ kind: "offer", offerUsd: 280 }));
  });

  it("splits a query into the words a listing must contain", () => {
    expect(searchWords("Find me a KAWS Elmo figure under $300")).toEqual(["kaws", "elmo", "figure"]);
    expect(searchWords("Chrome Hearts tee, size L")).toEqual(["chrome", "hearts", "tee"]);
  });
});

import { USDC_BASE, validatePermission, type SignedSpendPermission } from "./agent-spender";

describe("spend permission checks", () => {
  const spender = "0x1111111111111111111111111111111111111111";
  const good = (over: Partial<SignedSpendPermission["permission"]> = {}): SignedSpendPermission => ({
    signature: "0xsig",
    chainId: 8453,
    permission: {
      account: "0x2222222222222222222222222222222222222222",
      spender,
      token: USDC_BASE,
      allowance: String(300n * 10n ** 6n),
      period: 86_400,
      start: Math.floor(Date.now() / 1000),
      end: Math.floor(Date.now() / 1000) + 30 * 86_400,
      salt: "1",
      extraData: "0x",
      ...over,
    },
  });

  it("accepts USDC on Base, daily, within the agent's daily limit, for our spender", () => {
    expect(validatePermission(good(), spender, 500)).toBeNull();
  });
  it("rejects another spender, another token, or a non-daily period", () => {
    expect(validatePermission(good({ spender: "0x3333333333333333333333333333333333333333" }), spender, 500)).toMatch(/spender/);
    expect(validatePermission(good({ token: "0x4444444444444444444444444444444444444444" }), spender, 500)).toMatch(/USDC/);
    expect(validatePermission(good({ period: 7 * 86_400 }), spender, 500)).toMatch(/daily/);
  });
  it("rejects an allowance above the agent's daily limit, or an expired permission", () => {
    expect(validatePermission(good({ allowance: String(900n * 10n ** 6n) }), spender, 500)).toMatch(/daily limit/);
    expect(validatePermission(good({ end: 1 }), spender, 500)).toMatch(/expired/);
  });
});

import { isoOrNull } from "./shopping-agents.service";

describe("permission end dates", () => {
  it("formats a real end date and treats Coinbase's 'no end' as null", () => {
    expect(isoOrNull(1_800_000_000)).toBe("2027-01-15T08:00:00.000Z");
    expect(isoOrNull(281474976710655)).toBeNull();
  });
});
