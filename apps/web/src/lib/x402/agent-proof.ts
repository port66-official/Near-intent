import { createHash } from "node:crypto";
import { verifyMessage } from "viem";

/**
 * Proof that the caller really controls the agent identity it claims.
 *
 * An `x-agent-address` header on its own proves nothing: anyone can copy a
 * well-scored agent's address and borrow its Valiron reputation. So every
 * gated request must also carry a fresh signature from that address over
 * this exact request, in Valiron's `valiron-wallet-request-v2` format:
 *
 *   valiron-wallet-request-v2
 *   agent:<the x-agent-address, exactly as sent>
 *   chain:<x-chain, default base>
 *   method:<UPPERCASE method>
 *   url:<absolute request URL>
 *   body-sha256:<lowercase hex SHA-256 of the body; "" for GET>
 *   timestamp:<ms>
 *   nonce:<24-128 URL-safe chars>
 *
 * signed with EIP-191 (`personal_sign`) and sent as `x-agent-timestamp`,
 * `x-agent-nonce` and `x-agent-request-signature`. The timestamp must be
 * within a minute and each nonce works once (see consumeNonce).
 *
 * This module is pure apart from the injected nonce store, so it is tested
 * without a database.
 */

export const PROOF_WINDOW_MS = 60_000;
export const PROOF_HEADERS = {
  timestamp: "x-agent-timestamp",
  nonce: "x-agent-nonce",
  signature: "x-agent-request-signature",
} as const;

export type ProofResult =
  | { ok: true; agent: string }
  | { ok: false; code: string; message: string };

export interface ProofRequest {
  method: string;
  url: string;
  headers: { get(name: string): string | null };
  /** Body as the client serialised it; "" when there is none. */
  body: string;
}

/** Stores a nonce once; resolves false if it was already used. */
export type NonceStore = (nonce: string, agent: string, expiresAt: Date) => Promise<boolean>;

export function proofMessage(p: {
  agent: string;
  chain: string;
  method: string;
  url: string;
  body: string;
  timestamp: string;
  nonce: string;
}): string {
  const digest = createHash("sha256").update(p.body).digest("hex");
  return [
    "valiron-wallet-request-v2",
    `agent:${p.agent}`,
    `chain:${p.chain}`,
    `method:${p.method.toUpperCase()}`,
    `url:${p.url}`,
    `body-sha256:${digest}`,
    `timestamp:${p.timestamp}`,
    `nonce:${p.nonce}`,
  ].join("\n");
}

const fail = (code: string, message: string): ProofResult => ({ ok: false, code, message });

export async function verifyAgentProof(
  req: ProofRequest,
  storeNonce: NonceStore,
  now: number = Date.now(),
): Promise<ProofResult> {
  const agentId = req.headers.get("x-agent-id")?.trim();
  const agent = req.headers.get("x-agent-address")?.trim();

  if (agentId && !agent)
    return fail(
      "AGENT_ID_NOT_SUPPORTED",
      "On-chain agent IDs (x-agent-id) cannot be verified here yet. Send x-agent-address with a signed request instead.",
    );
  if (!agent) return fail("MISSING_AGENT_IDENTITY", "Send an x-agent-address header.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(agent))
    return fail("INVALID_AGENT_ADDRESS", "x-agent-address must be a 0x-prefixed 20-byte address.");

  const timestamp = req.headers.get(PROOF_HEADERS.timestamp)?.trim() ?? "";
  const nonce = req.headers.get(PROOF_HEADERS.nonce)?.trim() ?? "";
  const signature = req.headers.get(PROOF_HEADERS.signature)?.trim() ?? "";
  if (!timestamp || !nonce || !signature)
    return fail(
      "AGENT_OWNERSHIP_REQUIRED",
      `Sign this request: send ${PROOF_HEADERS.timestamp}, ${PROOF_HEADERS.nonce} and ${PROOF_HEADERS.signature}. See https://port66.xyz/llms.txt.`,
    );
  if (!/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > PROOF_WINDOW_MS)
    return fail("STALE_PROOF", "x-agent-timestamp must be the current time in milliseconds, within 60 seconds.");
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(nonce))
    return fail("INVALID_NONCE", "x-agent-nonce must be 24 to 128 URL-safe characters.");
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
    return fail("INVALID_SIGNATURE", "x-agent-request-signature must be a 65-byte hex signature.");

  const message = proofMessage({
    agent,
    chain: req.headers.get("x-chain")?.trim() || "base",
    method: req.method,
    url: req.url,
    body: req.body,
    timestamp,
    nonce,
  });

  let valid: boolean;
  try {
    valid = await verifyMessage({
      address: agent as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid)
    return fail(
      "INVALID_SIGNATURE",
      "The signature does not match x-agent-address for this method, URL, body, timestamp and nonce.",
    );

  // Only a valid proof spends its nonce, so junk cannot fill the store.
  const fresh = await storeNonce(nonce, agent.toLowerCase(), new Date(now + PROOF_WINDOW_MS * 2));
  if (!fresh) return fail("REPLAYED_PROOF", "This nonce was already used. Sign each request afresh.");

  return { ok: true, agent };
}
