"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Copy, RefreshCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useApiClient } from "@/lib/api/client";
import { NetworkMark } from "./network-mark";

/**
 * "Pay from any chain" on NEAR Intents.
 *
 * The buyer picks what they hold (BTC, SOL, NEAR, ETH...), gets one deposit
 * address, and sends from any wallet. NEAR Intents solvers deliver the exact
 * USDC price to the seller's wallet (Solana, or Base for sellers without a
 * Solana wallet); if the swap cannot complete, the
 * buyer is refunded on the chain they paid from. No wallet connection, no
 * bridge step and no second payment.
 *
 * Everything that matters is decided by the API: the amount, the seller's
 * wallet, and whether the order is paid. This component only shows the quote
 * and polls. The checkout id is kept in localStorage so a reload, or coming
 * back after a slow Bitcoin confirmation, resumes the same payment instead of
 * issuing a second deposit address.
 */

export interface IntentAsset {
  assetId: string;
  symbol: string;
  chain: string;
  decimals: number;
  priceUsd: number;
  windowMinutes: number;
}

type IntentState =
  | "awaiting_deposit"
  | "deposit_seen"
  | "incomplete_deposit"
  | "processing"
  | "paid"
  | "refunded"
  | "failed"
  | "expired"
  | "review";

interface IntentCheckout {
  id: string;
  state: IntentState;
  listingId: string;
  pay: {
    assetId: string;
    symbol: string;
    chain: string;
    amount: string;
    amountUsd: string;
    depositAddress: string;
    depositMemo?: string;
  };
  sellerReceivesUsdc: string;
  /** Where the seller is paid: "Solana" or "Base". */
  settlementChain?: string;
  deadline: string;
  timeEstimate: number;
  originTx: { hash: string; explorerUrl: string }[];
  deliveryTx: { hash: string; explorerUrl: string }[];
  refundedAmount?: string;
  orderId?: string;
}

interface Props {
  listingId: string;
  /** Total due in USDC (item + postage), for display before quoting. */
  usdcAmount: string;
  assets: IntentAsset[];
  shippingAddress: Record<string, string>;
  /** Connected EVM address, offered as the refund address on EVM chains. */
  evmAddress?: string;
  /** Where the seller will be paid, shown before a quote exists. */
  settlementChain?: string;
  onPaid: () => void;
  onBack: () => void;
}

const POLL_MS = 5_000;
const LIVE: IntentState[] = [
  "awaiting_deposit",
  "deposit_seen",
  "incomplete_deposit",
  "processing",
];
const EVM_CHAINS = new Set(["Ethereum", "Arbitrum", "Base"]);

/**
 * Catches a refund address that plainly belongs to another chain, such as a
 * MetaMask 0x address offered for a NEAR payment, before NEAR Intents rejects
 * it with a bare "refundTo is not valid". Returns why, or null if it looks fine.
 */
export function refundProblem(chain: string, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const evm = /^0x[0-9a-fA-F]{40}$/.test(v);
  const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
  const named = (what: string) =>
    evm
      ? `That is an Ethereum-style 0x address. Paste your ${what} address, or pick an Ethereum, Arbitrum or Base asset to pay from MetaMask.`
      : `That does not look like ${/^[AEIOU]/.test(what) ? "an" : "a"} ${what} address.`;
  if (EVM_CHAINS.has(chain)) return evm ? null : named(chain);
  if (chain === "Solana") return base58 ? null : named("Solana");
  if (chain === "NEAR") {
    const implicit = /^[0-9a-f]{64}$/.test(v);
    const account =
      v.length >= 2 &&
      v.length <= 64 &&
      /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(v);
    return !evm && (implicit || account) ? null : named("NEAR") + " A NEAR address looks like yourname.near.";
  }
  const prefixes: Record<string, RegExp> = {
    Bitcoin: /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/,
    Dogecoin: /^[DA9][1-9A-HJ-NP-Za-km-z]{25,34}$/,
    Litecoin: /^(ltc1|[LM3])[a-zA-HJ-NP-Z0-9]{25,62}$/,
  };
  const pattern = prefixes[chain];
  return !pattern || pattern.test(v) ? null : named(chain);
}

const storageKey = (listingId: string) => `port66:intents:${listingId}`;

function remember(listingId: string, id: string | null) {
  try {
    if (id) localStorage.setItem(storageKey(listingId), id);
    else localStorage.removeItem(storageKey(listingId));
  } catch {
    // Private mode: the payment still works, it just cannot resume on reload.
  }
}

function recall(listingId: string): string | null {
  try {
    return localStorage.getItem(storageKey(listingId));
  } catch {
    return null;
  }
}

function countdown(deadline: string, now: number): string {
  const left = Math.max(0, Date.parse(deadline) - now);
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function eta(seconds: number): string {
  return seconds < 90
    ? `about ${seconds} seconds`
    : `about ${Math.round(seconds / 60)} minutes`;
}

export function NearIntentsPayStep({
  listingId,
  usdcAmount,
  assets,
  shippingAddress,
  evmAddress,
  settlementChain = "Solana",
  onPaid,
  onBack,
}: Props) {
  const api = useApiClient();
  const apiRef = useRef(api);
  apiRef.current = api;

  const [asset, setAsset] = useState<IntentAsset | null>(null);
  const [refundTo, setRefundTo] = useState("");
  const [checkout, setCheckout] = useState<IntentCheckout | null>(null);
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"address" | "amount" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const paidRef = useRef(false);

  const live = !!checkout && LIVE.includes(checkout.state);

  // Resume a payment started earlier on this item.
  useEffect(() => {
    let cancelled = false;
    const saved = recall(listingId);
    if (!saved) {
      setResuming(false);
      return;
    }
    apiRef.current
      .get<IntentCheckout>(`/near-intents/checkouts/${saved}`)
      .then((found) => {
        if (cancelled) return;
        // An ended, unpaid checkout is history: start clean.
        if (LIVE.includes(found.state) || found.state === "paid" || found.state === "review")
          setCheckout(found);
        else remember(listingId, null);
      })
      .catch(() => remember(listingId, null))
      .finally(() => {
        if (!cancelled) setResuming(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listingId]);

  // Poll while money can still move.
  useEffect(() => {
    if (!checkout || !live) return;
    const id = checkout.id;
    const timer = setInterval(() => {
      apiRef.current
        .get<IntentCheckout>(`/near-intents/checkouts/${id}`)
        .then(setCheckout)
        .catch(() => {
          // A missed poll is not a failed payment; the next one catches up.
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [checkout?.id, live]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  useEffect(() => {
    if (checkout?.state === "paid" && !paidRef.current) {
      paidRef.current = true;
      remember(listingId, null);
      onPaid();
    }
  }, [checkout?.state, listingId, onPaid]);

  const pickAsset = useCallback(
    (next: IntentAsset) => {
      setAsset(next);
      setError(null);
      // On EVM chains the connected wallet is the natural refund address.
      setRefundTo(EVM_CHAINS.has(next.chain) && evmAddress ? evmAddress : "");
    },
    [evmAddress],
  );

  const refundIssue = asset ? refundProblem(asset.chain, refundTo) : null;

  async function getQuote() {
    if (!asset || busy || refundIssue) return;
    setBusy(true);
    setError(null);
    try {
      const quoted = await api.post<IntentCheckout>("/near-intents/quote", {
        listingId,
        originAsset: asset.assetId,
        refundTo: refundTo.trim(),
        shippingAddress,
      });
      remember(listingId, quoted.id);
      setCheckout(quoted);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not get a quote. Nothing was charged.",
      );
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string, what: "address" | "amount") {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what);
        setTimeout(() => setCopied(null), 1500);
      },
      () => {},
    );
  }

  function startOver() {
    remember(listingId, null);
    setCheckout(null);
    setError(null);
  }

  const indicative = useMemo(() => {
    if (!asset || !asset.priceUsd) return null;
    const amount = Number(usdcAmount) / asset.priceUsd;
    return `${amount.toPrecision(4)} ${asset.symbol}`;
  }, [asset, usdcAmount]);

  if (resuming) {
    return (
      <div className="flex items-center justify-center gap-2 p-10 text-[12px] text-[var(--dsc-ink-2)]">
        <RefreshCw size={13} className="animate-spin" />
        Checking for a payment in progress
      </div>
    );
  }

  // ── A quote exists: show how to pay, then progress ─────────────────────────
  if (checkout) {
    const { pay, state } = checkout;
    const stages = [
      { label: "Send", done: state !== "awaiting_deposit" },
      {
        label: "Deposit seen",
        done: ["processing", "paid"].includes(state),
      },
      { label: "Seller paid", done: state === "paid" },
    ];
    return (
      <div className="space-y-5 p-6">
        <div className="border-y border-[var(--dsc-rule)] py-6 text-center">
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--dsc-ink-2)]">
            Send exactly, from any {pay.chain} wallet
          </p>
          <button
            onClick={() => copy(pay.amount, "amount")}
            className="mt-2 inline-flex items-baseline gap-2 transition-opacity hover:opacity-60"
            title="Copy amount"
          >
            <span className="text-[30px] font-semibold tracking-[-0.05em] tabular-nums">
              {pay.amount}
            </span>
            <span className="text-[16px] text-[var(--dsc-ink-2)]">
              {pay.symbol}
            </span>
            {copied === "amount" ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <p className="mt-1 text-[12px] text-[var(--dsc-ink-2)]">
            About ${Number(pay.amountUsd).toFixed(2)}. The seller receives{" "}
            {checkout.sellerReceivesUsdc} USDC on{" "}
            {checkout.settlementChain ?? settlementChain}.
          </p>
        </div>

        {state === "awaiting_deposit" && (
          <>
            <div className="flex flex-col items-center gap-4">
              <div className="rounded-xl bg-white p-3 shadow-[0_0_0_1px_var(--dsc-rule-soft)]">
                <QRCodeSVG value={pay.depositAddress} size={148} />
              </div>
              <button
                onClick={() => copy(pay.depositAddress, "address")}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--dsc-rule)] bg-[var(--dsc-surface)] px-4 py-3 text-left transition-colors hover:border-[var(--dsc-ink-3)]"
              >
                <span className="min-w-0">
                  <span className="block text-[9px] uppercase tracking-[0.16em] text-[var(--dsc-ink-2)]">
                    {pay.chain} deposit address
                  </span>
                  <span className="mt-1 block break-all font-mono text-[12px]">
                    {pay.depositAddress}
                  </span>
                </span>
                {copied === "address" ? (
                  <Check size={14} className="shrink-0" />
                ) : (
                  <Copy size={14} className="shrink-0" />
                )}
              </button>
              {pay.depositMemo && (
                <p className="w-full rounded-xl border border-[var(--dsc-rule)] bg-[var(--dsc-surface)] px-4 py-3 text-[12px]">
                  <span className="block text-[9px] uppercase tracking-[0.16em] text-[var(--dsc-ink-2)]">
                    Required memo
                  </span>
                  <span className="mt-1 block break-all font-mono">
                    {pay.depositMemo}
                  </span>
                </p>
              )}
            </div>
            <p className="text-center text-[11.5px] text-[var(--dsc-ink-2)]">
              Quote held for{" "}
              <span className="tabular-nums text-[var(--dsc-ink)]">
                {countdown(checkout.deadline, now)}
              </span>
              . Arrives {eta(checkout.timeEstimate)} after your transfer
              confirms.
            </p>
          </>
        )}

        <div className="flex items-center justify-between text-[11px]">
          {stages.map((s, i) => (
            <span
              key={s.label}
              className="flex items-center gap-1.5"
              style={{
                color: s.done ? "var(--dsc-ink)" : "var(--dsc-ink-3)",
              }}
            >
              <span
                className="flex h-4 w-4 items-center justify-center rounded-full border"
                style={{
                  borderColor: s.done ? "var(--dsc-ink)" : "var(--dsc-rule)",
                }}
              >
                {s.done ? <Check size={10} /> : i + 1}
              </span>
              {s.label}
            </span>
          ))}
        </div>

        {(state === "deposit_seen" || state === "processing") && (
          <p className="flex items-center justify-center gap-2 text-[12px] text-[var(--dsc-ink-2)]">
            <RefreshCw size={12} className="animate-spin" />
            {state === "deposit_seen"
              ? "Your transfer was seen. Waiting for it to confirm."
              : "Paying the seller. You can close this window; your order is recorded automatically."}
          </p>
        )}

        {state === "incomplete_deposit" && (
          <Notice>
            Less than {pay.amount} {pay.symbol} arrived. Send the remainder to
            the same address before the quote ends, or everything you sent is
            refunded to your address.
          </Notice>
        )}
        {state === "refunded" && (
          <Notice>
            The payment could not complete and{" "}
            {checkout.refundedAmount
              ? `${checkout.refundedAmount} ${pay.symbol} was`
              : "your funds were"}{" "}
            refunded to your {pay.chain} address. No order was placed.
          </Notice>
        )}
        {state === "expired" && (
          <Notice>
            This quote ended before a transfer arrived. Nothing was charged.
          </Notice>
        )}
        {state === "failed" && (
          <Notice>
            The payment failed. Anything you sent is returned to your{" "}
            {pay.chain} address. No order was placed.
          </Notice>
        )}
        {state === "review" && (
          <Notice>
            Your payment arrived but the order needs a manual check. Do not
            pay again. Contact support with reference {checkout.id}.
          </Notice>
        )}

        {[...checkout.originTx, ...checkout.deliveryTx].length > 0 && (
          <div className="space-y-1 text-[11px]">
            {checkout.originTx.map((tx) => (
              <TxLink key={tx.hash} label="Your transfer" tx={tx} />
            ))}
            {checkout.deliveryTx.map((tx) => (
              <TxLink key={tx.hash} label="Paid to seller" tx={tx} />
            ))}
          </div>
        )}

        {["refunded", "expired", "failed"].includes(state) ? (
          <button
            onClick={startOver}
            className="h-12 w-full bg-[var(--dsc-ink)] text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--dsc-ground)]"
          >
            Start again
          </button>
        ) : (
          state === "awaiting_deposit" && (
            <button
              onClick={startOver}
              className="w-full text-[13px] font-medium text-[var(--dsc-ink-2)] transition-colors hover:text-[var(--dsc-ink)]"
            >
              Pay with something else
            </button>
          )
        )}
        <p className="text-center text-[10.5px] text-[var(--dsc-ink-3)]">
          Routed by NEAR Intents. Port66 never holds your funds.
        </p>
      </div>
    );
  }

  // ── No quote yet: choose what to pay with ──────────────────────────────────
  return (
    <div className="space-y-5 p-6">
      <div>
        <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--dsc-ink-2)]">
          Pay with
        </p>
        <div className="grid grid-cols-2 gap-2">
          {assets.map((a) => {
            const selected = asset?.assetId === a.assetId;
            return (
              <button
                key={a.assetId}
                onClick={() => pickAsset(a)}
                aria-pressed={selected}
                className="flex items-center gap-3 rounded-xl border bg-[var(--dsc-surface)] px-3 py-3 text-left transition-colors hover:border-[var(--dsc-ink-3)]"
                style={{
                  borderColor: selected ? "var(--dsc-accent)" : "var(--dsc-rule)",
                  boxShadow: selected ? "0 0 0 1px var(--dsc-accent)" : undefined,
                }}
              >
                <NetworkMark name={a.chain} size={30} />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold">
                    {a.symbol}
                  </span>
                  <span className="block text-[10.5px] text-[var(--dsc-ink-2)]">
                    {a.chain}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {asset && (
        <label className="block">
          <span className="mb-1.5 block text-[12px] text-[var(--dsc-ink-2)]">
            Your {asset.chain} address, for refunds
          </span>
          <input
            value={refundTo}
            onChange={(e) => setRefundTo(e.target.value)}
            placeholder={
              asset.chain === "NEAR"
                ? "yourname.near"
                : `Your ${asset.chain} wallet address`
            }
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-xl border border-[var(--dsc-rule)] bg-[var(--dsc-surface)] px-3 py-3 font-mono text-[16px] text-[var(--dsc-ink)] outline-none transition-colors focus:border-[var(--dsc-accent)] focus:ring-1 focus:ring-[var(--dsc-accent)]"
          />
          <span className="mt-2 block text-[11px] leading-relaxed text-[var(--dsc-ink-2)]">
            If the payment cannot complete, your {asset.symbol} is sent back
            here. Use a wallet you control, not an exchange deposit address.
            {indicative ? ` You will send roughly ${indicative}.` : ""}
          </span>
          {refundIssue && (
            <span role="alert" className="mt-2 block text-[11px] leading-relaxed text-[var(--dsc-danger)]">
              {refundIssue}
            </span>
          )}
        </label>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 border-y border-[var(--dsc-rule)] py-4 text-[var(--dsc-danger)]"
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <p className="text-[11px] leading-relaxed">{error}</p>
        </div>
      )}

      <button
        onClick={getQuote}
        disabled={!asset || !refundTo.trim() || !!refundIssue || busy}
        className="flex h-12 w-full items-center justify-center gap-2 bg-[var(--dsc-ink)] text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--dsc-ground)] disabled:opacity-40"
      >
        {busy && <RefreshCw size={12} className="animate-spin" />}
        {busy ? "Getting your quote" : "Get deposit address"}
      </button>

      <p className="text-center text-[11px] leading-relaxed text-[var(--dsc-ink-2)]">
        The seller receives exactly {usdcAmount} USDC on {settlementChain}. The item is
        held for you while you pay. Routed by NEAR Intents.
      </p>

      <button
        onClick={onBack}
        className="w-full text-[13px] font-medium text-[var(--dsc-ink-2)] transition-colors hover:text-[var(--dsc-ink)]"
      >
        Back
      </button>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-y border-[var(--dsc-rule)] py-4">
      <AlertCircle size={14} className="mt-0.5 shrink-0" />
      <p className="text-[11.5px] leading-relaxed">{children}</p>
    </div>
  );
}

function TxLink({
  label,
  tx,
}: {
  label: string;
  tx: { hash: string; explorerUrl: string };
}) {
  return (
    <a
      href={tx.explorerUrl}
      target="_blank"
      rel="noreferrer"
      className="flex items-center justify-between gap-3 text-[var(--dsc-ink-2)] underline-offset-2 hover:underline"
    >
      <span>{label}</span>
      <span className="font-mono">
        {tx.hash.slice(0, 8)}...{tx.hash.slice(-6)}
      </span>
    </a>
  );
}
