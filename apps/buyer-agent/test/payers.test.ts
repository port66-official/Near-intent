import { test } from "node:test";
import assert from "node:assert/strict";
import { evmToken, nearToken, payerFor } from "../src/payers.js";

test("reads the token contract out of a NEAR Intents asset id", () => {
  assert.equal(
    evmToken("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"),
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  );
  // Native ETH has no contract.
  assert.equal(evmToken("nep141:arb.omft.near"), null);
  assert.equal(nearToken("nep141:wrap.near"), "wrap.near");
  assert.throws(() => nearToken("nep245:v2_1.omni.hot.tg:10_x"));
});

test("names the key a chain needs, and refuses chains it cannot pay from", () => {
  const saved = { ...process.env };
  for (const k of ["AGENT_SOLANA_KEY", "AGENT_EVM_PAY_KEY", "AGENT_NEAR_ACCOUNT_ID", "AGENT_NEAR_KEY"])
    delete process.env[k];
  try {
    assert.throws(() => payerFor({ assetId: "nep141:sol.omft.near", symbol: "SOL", chain: "Solana" }), /AGENT_SOLANA_KEY/);
    assert.throws(() => payerFor({ assetId: "nep141:arb.omft.near", symbol: "ETH", chain: "Arbitrum" }), /AGENT_EVM_PAY_KEY/);
    assert.throws(() => payerFor({ assetId: "nep141:wrap.near", symbol: "NEAR", chain: "NEAR" }), /AGENT_NEAR_ACCOUNT_ID/);
    assert.throws(() => payerFor({ assetId: "nep141:btc.omft.near", symbol: "BTC", chain: "Bitcoin" }), /cannot pay from Bitcoin live/);
  } finally {
    process.env = saved;
  }
});

test("an EVM payer pays from the address of its own key", () => {
  const saved = { ...process.env };
  // A throwaway, well-known test key: never funded.
  process.env.AGENT_EVM_PAY_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  try {
    const payer = payerFor({ assetId: "nep141:base.omft.near", symbol: "ETH", chain: "Base" });
    assert.equal(payer.address, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    assert.match(payer.explorer("0xabc"), /basescan\.org\/tx\/0xabc$/);
  } finally {
    process.env = saved;
  }
});
