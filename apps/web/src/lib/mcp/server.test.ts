/**
 * MCP protocol and tool tests. Read tools run against live Port66 data.
 *   ../buyer-agent/node_modules/.bin/tsx --test src/lib/mcp/server.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, handleMessage } from "./server";

const ctx = { api: process.env.PORT66_API ?? "https://port66.xyz/api/v1" };
const rpc = (method: string, params?: Record<string, unknown>, id: number | null = 1) =>
  handleMessage({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }, ctx);
const callTool = async (name: string, args: Record<string, unknown>, c = ctx) => {
  const r = (await handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }, c)) as {
    result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
  };
  return r.result;
};

test("initialize negotiates a supported protocol version and advertises tools", async () => {
  const r = (await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } })) as { result: Record<string, unknown> };
  assert.equal(r.result.protocolVersion, "2025-03-26");
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  const unknown = (await rpc("initialize", { protocolVersion: "1999-01-01" })) as { result: { protocolVersion: string } };
  assert.equal(unknown.result.protocolVersion, "2025-06-18");
});

test("notifications get no answer; unknown methods and tools are errors", async () => {
  // null here means "send without an id", i.e. a notification.
  assert.equal(await rpc("notifications/initialized", {}, null), null);
  assert.deepEqual(((await rpc("nope")) as { error: { code: number } }).error.code, -32601);
  assert.equal(((await rpc("tools/call", { name: "nope" })) as { error: { code: number } }).error.code, -32602);
  assert.equal(((await handleMessage({ hello: 1 }, ctx)) as { error: { code: number } }).error.code, -32600);
});

test("tools/list exposes every tool with a schema and no implementation", async () => {
  const r = (await rpc("tools/list")) as { result: { tools: { name: string; inputSchema: unknown; run?: unknown }[] } };
  assert.deepEqual(r.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  for (const t of r.result.tools) {
    assert.equal(t.run, undefined);
    assert.equal((t.inputSchema as { type: string }).type, "object");
  }
});

test("buying tools refuse without a session, before touching anything", async () => {
  for (const name of ["start_purchase", "make_offer", "offer_status", "purchase_status"]) {
    const r = await callTool(name, { id: "x", checkout_id: "x", pay_with: "SOL", refund_to: "x", amount_usd: 1, shipping_address: {} });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /needs a Port66 session/);
  }
});

test("live: search finds a multi-word query the site search misses", async () => {
  const r = await callTool("search_listings", { query: "KAWS figure" });
  const results = (r.structuredContent?.results ?? []) as { id: string; title: string }[];
  assert.ok(results.some((x) => /kaws/i.test(x.title)), JSON.stringify(r.structuredContent));
});

test("live: listing details and a crypto price for it", async () => {
  const d = await callTool("get_listing", { id: "kaws-x-sesame-street-water-parade-elmo-figure" });
  assert.equal(d.isError, undefined, d.content[0].text);
  assert.match(String(d.structuredContent?.title), /KAWS/);
  const p = await callTool("price_in_crypto", { id: "kaws-x-sesame-street-water-parade-elmo-figure", pay_with: "SOL" });
  if (p.isError) {
    // NEAR Intents itself can be down; the tool must then say so plainly.
    assert.match(p.content[0].text, /NEAR Intents is not responding/);
    return;
  }
  assert.match(String(p.structuredContent?.seller_receives), /USDC on (Solana|Base)/);
});
