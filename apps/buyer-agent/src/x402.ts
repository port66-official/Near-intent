import { randomBytes } from "node:crypto";
import { ValironSDK } from "@valiron/sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { PROOF_HEADERS, proofMessage } from "../../web/src/lib/x402/agent-proof";

/**
 * A real agent calling Port66's paid x402 API, end to end:
 *
 *   1. Enrols its key with Valiron (EIP-191 challenge-response), once.
 *   2. Signs every request (valiron-wallet-request-v2) so Port66 can prove
 *      the agent controls the address it claims; Port66 then asks Valiron
 *      for the agent's trust score.
 *   3. On HTTP 402, pays the exact USDC price on Base through x402 (gasless:
 *      an EIP-3009 authorisation the facilitator settles), and retries with
 *      a fresh signature.
 *
 * Without --pay it stops at the 402 challenge and spends nothing.
 */

export interface X402Run {
  url: string;
  key: `0x${string}`;
  pay: boolean;
  /** Highest price, in USDC, the agent will pay for one call. */
  maxUsd: number;
  say: (line: string) => void;
}

export interface X402Result {
  status: number;
  stage: "identity" | "trust" | "payment" | "served" | "error";
  detail: string;
  paidTx?: string;
  body?: unknown;
}

const USDC_DECIMALS = 6;

/** Headers proving this agent sent this exact request, fresh each call. */
async function proof(account: PrivateKeyAccount, method: string, url: string) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString("base64url");
  const signature = await account.signMessage({
    message: proofMessage({ agent: account.address, chain: "base", method, url, body: "", timestamp, nonce }),
  });
  return {
    "x-agent-address": account.address,
    "x-chain": "base",
    [PROOF_HEADERS.timestamp]: timestamp,
    [PROOF_HEADERS.nonce]: nonce,
    [PROOF_HEADERS.signature]: signature,
  };
}

/** Valiron key-agent enrolment; harmless to repeat. */
export async function enrolWithValiron(account: PrivateKeyAccount) {
  const valiron = new ValironSDK({ chain: "base", telemetry: { enabled: false } });
  const { challenge } = await valiron.getKeyAgentChallenge(account.address);
  const signature = await account.signMessage({ message: challenge });
  return valiron.verifyKeyAgent({ challenge, signature, agentAddress: account.address });
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function callPaidEndpoint(run: X402Run): Promise<X402Result> {
  const account = privateKeyToAccount(run.key);
  const { say } = run;
  say(`Agent ${account.address}`);

  const enrolled = await enrolWithValiron(account);
  say(`Valiron: key verified=${enrolled.verified}, score=${enrolled.score ?? "not yet scored"}, tier=${enrolled.tier ?? "-"}`);

  // 1. Signed, unpaid call: expect 402 (or a trust answer).
  let res = await fetch(run.url, { headers: await proof(account, "GET", run.url) });
  let body = await readBody(res);
  say(`GET ${run.url} -> ${res.status}`);

  if (res.status === 401)
    return { status: 401, stage: "identity", detail: JSON.stringify(body), body };
  if (res.status === 403)
    return { status: 403, stage: "trust", detail: JSON.stringify(body), body };
  if (res.status !== 402)
    return {
      status: res.status,
      stage: res.ok ? "served" : "error",
      detail: res.ok ? "Served without payment." : JSON.stringify(body),
      body,
    };

  // 2. The x402 challenge.
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const http = new x402HTTPClient(client);
  const required = http.getPaymentRequiredResponse((h) => res.headers.get(h), body);
  const option = required.accepts.find((a) => a.network === "eip155:8453");
  if (!option) return { status: 402, stage: "payment", detail: "No Base USDC option offered.", body: required };
  const priceUsd = Number(option.amount) / 10 ** USDC_DECIMALS;
  say(`Trust check passed. x402 asks ${priceUsd} USDC on Base, paid to ${option.payTo}.`);

  if (!run.pay)
    return { status: 402, stage: "payment", detail: `Would pay ${priceUsd} USDC. Add --pay to pay it.`, body: required };
  if (priceUsd > run.maxUsd)
    return { status: 402, stage: "payment", detail: `Price ${priceUsd} USDC is above --max ${run.maxUsd}. Not paid.` };

  // 3. Pay and retry, with a fresh identity proof (the old nonce is spent).
  const payload = await http.createPaymentPayload({ ...required, accepts: [option] });
  res = await fetch(run.url, {
    headers: { ...(await proof(account, "GET", run.url)), ...http.encodePaymentSignatureHeader(payload) },
  });
  body = await readBody(res);
  say(`Paid retry -> ${res.status}`);

  let paidTx: string | undefined;
  try {
    paidTx = http.getPaymentSettleResponse((h) => res.headers.get(h))?.transaction;
  } catch {
    // No settlement header: the payment did not settle.
  }
  return {
    status: res.status,
    stage: res.ok ? "served" : "payment",
    detail: res.ok ? "Paid and served." : JSON.stringify(body),
    paidTx,
    body,
  };
}

// ── A long-lived paying client, for agents that make many calls ───────────────

export interface PaidResponse<T = unknown> {
  status: number;
  body: T;
  /** USDC actually paid for this call (0 if not charged). */
  paidUsd: number;
  paidTx?: string;
}

/**
 * One agent identity calling Port66's paid API many times: enrols with
 * Valiron once, signs every request afresh, pays each 402 within a per-run
 * budget, and waits out Valiron's first evaluation of a new agent.
 */
export class X402Agent {
  readonly account: PrivateKeyAccount;
  private readonly http: x402HTTPClient;
  private enrolled = false;
  spentUsd = 0;
  calls = 0;

  constructor(
    key: `0x${string}`,
    private readonly opts: { budgetUsd: number; maxPerCallUsd?: number; say?: (line: string) => void },
  ) {
    this.account = privateKeyToAccount(key);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: this.account });
    this.http = new x402HTTPClient(client);
  }

  get address() {
    return this.account.address;
  }

  async enrol() {
    if (this.enrolled) return;
    const profile = await enrolWithValiron(this.account);
    this.enrolled = true;
    this.opts.say?.(`  Valiron: ${this.address} verified=${profile.verified} score=${profile.score ?? "pending"} tier=${profile.tier ?? "-"}`);
  }

  async get<T = unknown>(url: string): Promise<PaidResponse<T>> {
    await this.enrol();
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: await proof(this.account, "GET", url) });
      const body = await readBody(res);
      this.calls++;
      // A new agent is denied until Valiron finishes its first evaluation.
      if (res.status === 403 && attempt < 4 && JSON.stringify(body).includes("pending")) {
        this.opts.say?.("  Valiron is still evaluating this agent; waiting 30s.");
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
      if (res.status !== 402) return { status: res.status, body: body as T, paidUsd: 0 };

      const required = this.http.getPaymentRequiredResponse((h) => res.headers.get(h), body);
      const option = required.accepts.find((a) => a.network === "eip155:8453");
      if (!option) throw new Error("No Base USDC payment option offered.");
      const price = Number(option.amount) / 10 ** USDC_DECIMALS;
      if (price > (this.opts.maxPerCallUsd ?? 0.05)) throw new Error(`Price ${price} USDC is above the per-call cap.`);
      if (this.spentUsd + price > this.opts.budgetUsd + 1e-9)
        throw new BudgetExhausted(`Budget ${this.opts.budgetUsd} USDC reached after ${this.spentUsd.toFixed(3)} USDC.`);

      const payload = await this.http.createPaymentPayload({ ...required, accepts: [option] });
      const paid = await fetch(url, {
        headers: { ...(await proof(this.account, "GET", url)), ...this.http.encodePaymentSignatureHeader(payload) },
      });
      const paidBody = await readBody(paid);
      this.calls++;
      let paidTx: string | undefined;
      try {
        paidTx = this.http.getPaymentSettleResponse((h) => paid.headers.get(h))?.transaction;
      } catch {
        // Not settled: nothing was charged.
      }
      const charged = paid.ok && paidTx ? price : 0;
      this.spentUsd += charged;
      return { status: paid.status, body: paidBody as T, paidUsd: charged, paidTx };
    }
  }
}

export class BudgetExhausted extends Error {}
