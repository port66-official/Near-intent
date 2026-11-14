"use client";

import { useEffect, useState } from "react";
import { Loader2, ShieldCheck, Zap } from "lucide-react";
import { useApiClient } from "@/lib/api/client";
import { usd, type AgentDetail, type ShoppingAgent } from "@/lib/agents";

interface Setup {
  available: boolean;
  reason?: string;
  spender?: string;
  token?: string;
  chainId?: number;
}

interface Status {
  autoBuy: boolean;
  remainingTodayUsd?: number;
  resetsAt?: string;
  active?: boolean;
}

const EMPTY_SHIP = { name: "", line1: "", line2: "", city: "", region: "", postal: "", country: "", phone: "" };

/**
 * Lets the agent pay on its own, from the user's Coinbase Smart Wallet,
 * through a Base spend permission: "Port66's agent may spend up to $X USDC a
 * day". The cap is enforced on chain; the money stays in the user's wallet
 * until a purchase, and the user can revoke it in their wallet at any time.
 */
export function AutoBuyCard({
  agent,
  gradient,
  onChange,
}: {
  agent: ShoppingAgent;
  gradient: string;
  onChange: (next: AgentDetail) => void;
}) {
  const api = useApiClient();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [ship, setShip] = useState(EMPTY_SHIP);
  const [daily, setDaily] = useState(String(agent.dailyBudgetUsd));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<Setup>("/shopping-agents/autobuy/setup").then(setSetup).catch(() => setSetup({ available: false }));
     
  }, []);

  useEffect(() => {
    if (!agent.autoBuy) return setStatus(null);
    api.get<Status>(`/shopping-agents/${agent.id}/autobuy`).then(setStatus).catch(() => setStatus(null));
     
  }, [agent.autoBuy, agent.id]);

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    if (!setup?.spender) return;
    const allowance = Number(daily);
    if (!(allowance > 0) || allowance > agent.dailyBudgetUsd)
      return setError(`Choose a daily amount between $1 and your ${usd(agent.dailyBudgetUsd)} daily limit.`);
    for (const [field, label] of [["name", "name"], ["line1", "address"], ["city", "city"], ["postal", "postcode"], ["country", "country"]] as const)
      if (!ship[field].trim()) return setError(`Add the delivery ${label}.`);
    setBusy(true);
    setError("");
    try {
      const { createBaseAccountSDK } = await import("@base-org/account");
      const { requestSpendPermission } = await import("@base-org/account/spend-permission");
      const provider = createBaseAccountSDK({
        appName: "Port66",
        appLogoUrl: `${window.location.origin}/icon-192.png`,
        appChainIds: [8453],
      }).getProvider();
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const account = accounts?.[0];
      if (!account) throw new Error("No wallet was connected.");
      const permission = await requestSpendPermission({
        account,
        spender: setup.spender,
        token: setup.token!,
        chainId: 8453,
        allowance: BigInt(Math.round(allowance * 1e6)),
        periodInDays: 1,
        provider,
      });
      onChange(await api.post<AgentDetail>(`/shopping-agents/${agent.id}/autobuy`, { permission, shipTo: ship }));
      setOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(/reject|denied|cancel/i.test(msg) ? "You cancelled in your wallet. Nothing was changed." : msg);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      onChange(await api.delete<AgentDetail>(`/shopping-agents/${agent.id}/autobuy`));
    } finally {
      setBusy(false);
    }
  }

  if (!setup) return null;

  if (agent.autoBuy && agent.permission) {
    return (
      <div className="sell-card mt-8 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: gradient }}>
            <Zap size={16} />
          </span>
          <div>
            <p className="text-[15px] font-semibold">Buys for you automatically</p>
            <p className="mt-1 text-[13px]" style={{ color: "var(--dsc-ink-2)", lineHeight: 1.6 }}>
              Pays from your Coinbase wallet {short(agent.permission.account)}, up to {usd(agent.permission.dailyUsd)} USDC a day.
              {status?.remainingTodayUsd !== undefined ? ` ${usd(status.remainingTodayUsd)} left today.` : ""} Your wallet enforces
              the limit; you can revoke it there at any time.
            </p>
          </div>
        </div>
        <button onClick={disable} disabled={busy} className="sell-action-quiet shrink-0">
          {busy ? "Turning off…" : "Turn off"}
        </button>
      </div>
    );
  }

  return (
    <div className="sell-card mt-8 p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--dsc-ground)" }}>
            <ShieldCheck size={16} />
          </span>
          <div>
            <p className="text-[15px] font-semibold">Let it buy for you</p>
            <p className="mt-1 max-w-[60ch] text-[13px]" style={{ color: "var(--dsc-ink-2)", lineHeight: 1.6 }}>
              Skip the approval step: the agent pays from your own Coinbase wallet when it finds a piece within your rules, up to a
              daily amount you set. The money stays in your wallet until then, and the daily cap is enforced on chain.
            </p>
          </div>
        </div>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            disabled={!setup.available}
            className="sell-action-solid shrink-0 disabled:opacity-50"
            style={{ background: gradient, color: "var(--dsc-ink)" }}
          >
            Set up
          </button>
        )}
      </div>
      {!setup.available && (
        <p className="mt-3 text-[12px]" style={{ color: "var(--dsc-ink-2)" }}>
          {setup.reason ?? "Not available yet."}
        </p>
      )}

      {open && (
        <form onSubmit={enable} className="mt-6 space-y-5 dsc-rule-t pt-6">
          <div className="sm:max-w-[320px]">
            <label className="sell-field-label" htmlFor="ab-daily">
              It may spend up to (USDC a day)
            </label>
            <input id="ab-daily" className="sell-field" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
            <p className="mt-2 text-[12px]" style={{ color: "var(--dsc-ink-2)" }}>
              At most your {usd(agent.dailyBudgetUsd)} daily limit. Each piece is still capped at {usd(agent.maxItemUsd)}.
            </p>
          </div>

          <div>
            <span className="sell-field-label">Deliver to</span>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["name", "Full name"],
                  ["phone", "Phone"],
                  ["line1", "Address"],
                  ["line2", "Apartment, suite (optional)"],
                  ["city", "City"],
                  ["region", "State or region"],
                  ["postal", "Postcode"],
                  ["country", "Country"],
                ] as const
              ).map(([k, label]) => (
                <input
                  key={k}
                  aria-label={label}
                  placeholder={label}
                  className="sell-field"
                  value={ship[k]}
                  onChange={(e) => setShip({ ...ship, [k]: e.target.value })}
                />
              ))}
            </div>
          </div>

          <p className="rounded-2xl px-4 py-3 text-[12px]" style={{ background: "var(--dsc-ground)", color: "var(--dsc-ink-2)", lineHeight: 1.6 }}>
            Next, your Coinbase wallet opens and asks you to allow Port66&apos;s agent to spend up to ${daily || "0"} USDC a day
            on Base. If you do not have one, you can create it there with a passkey in a few seconds.
          </p>

          {error && (
            <p role="alert" className="text-[13px]" style={{ color: "var(--dsc-danger, #c0392b)" }}>
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy}
              className="sell-action-solid inline-flex items-center gap-2 disabled:opacity-50"
              style={{ background: gradient, color: "var(--dsc-ink)" }}
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {busy ? "Waiting for your wallet…" : "Connect wallet and allow"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="sell-action-quiet">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
