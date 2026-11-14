"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Loader2, Plus } from "lucide-react";
import { HouseNav } from "@/components/merchant/house-nav";
import { StudioFooter } from "@/components/studio/studio-footer";
import { useApiClient } from "@/lib/api/client";
import { useOptionalAuth } from "@/hooks/use-optional-auth";
import { pieceColor } from "@/lib/piece-color";
import { ago, PAY_WITH_OPTIONS, usd, type AgentDetail, type ShoppingAgent } from "@/lib/agents";

const EXAMPLES = ["KAWS figure", "Chrome Hearts tee", "Miu Miu bag", "Jordan 1 low"];

export default function AgentsPage() {
  const api = useApiClient();
  const router = useRouter();
  const { isSignedIn, userId } = useOptionalAuth();
  const color = pieceColor(userId ?? "port66-agents");
  const [agents, setAgents] = useState<ShoppingAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const [form, setForm] = useState({
    query: "",
    maxItemUsd: "300",
    // Blank means "work it out": three times the item limit.
    dailyBudgetUsd: "",
    payWith: ["USDC", "ETH", "SOL"] as string[],
    negotiate: true,
  });

  useEffect(() => {
    if (isSignedIn === false) {
      setLoading(false);
      return;
    }
    if (!isSignedIn) return;
    api
      .get<ShoppingAgent[]>("/shopping-agents")
      .then((r) => {
        const list = Array.isArray(r) ? r : [];
        setAgents(list);
        // Arriving from a search ("Have an agent watch for …") opens the form
        // with that search filled in.
        const q = new URLSearchParams(window.location.search).get("q")?.trim();
        if (q) setForm((f) => ({ ...f, query: q.slice(0, 120) }));
        if (!list.length || q) setCreating(true);
      })
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  }, [isSignedIn]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const max = Number(form.maxItemUsd);
    const daily = form.dailyBudgetUsd.trim() ? Number(form.dailyBudgetUsd) : max * 3;
    if (form.query.trim().length < 2) return setError("Tell the agent what to look for.");
    if (!(max >= 1)) return setError("Set the most it may spend on one item.");
    if (!(daily >= max)) return setError("The daily limit must be at least the price limit for one item.");
    setBusy(true);
    setError("");
    try {
      const made = await api.post<AgentDetail>("/shopping-agents", {
        name: form.query.trim().slice(0, 60),
        query: form.query.trim(),
        maxItemUsd: max,
        dailyBudgetUsd: daily,
        payWith: form.payWith,
        negotiate: form.negotiate,
      });
      router.push(`/agents/${made.agent.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the agent.");
      setBusy(false);
    }
  }

  const togglePay = (s: string) =>
    setForm((f) => ({
      ...f,
      payWith: f.payWith.includes(s) ? f.payWith.filter((x) => x !== s) : [...f.payWith, s],
    }));

  return (
    <div className="dsc-page min-h-screen" style={{ background: "var(--dsc-ground)", color: "var(--dsc-ink)" }}>
      <HouseNav />

      <main className="mx-auto max-w-[1100px] px-4 pb-24 pt-32 sm:px-10">
        <div className="flex flex-col gap-6 pb-10 dsc-rule-b sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="dsc-label" style={{ color: "var(--dsc-ink-2)" }}>
              Account
            </p>
            <h1
              className="mt-3"
              style={{
                fontFamily: "var(--dsc-font)",
                fontWeight: 700,
                fontSize: "clamp(2rem,4.5vw,3rem)",
                letterSpacing: "-0.02em",
                lineHeight: 1.05,
              }}
            >
              Shopping agents
            </h1>
            <p className="mt-3 max-w-[52ch] text-[14px]" style={{ color: "var(--dsc-ink-2)", lineHeight: 1.6 }}>
              Tell an agent what you want and what you will spend. It searches Port66 now and keeps watching,
              makes an offer if you allow it, and asks you before anything is bought. You pay from your own
              wallet, from any chain.
            </p>
          </div>
          {!creating && isSignedIn && (
            <button
              onClick={() => setCreating(true)}
              className="sell-action-solid inline-flex w-fit shrink-0 items-center gap-2"
              style={{ background: color.gradient, color: "var(--dsc-ink)" }}
            >
              <Plus size={16} /> New agent
            </button>
          )}
        </div>

        {isSignedIn === false ? (
          <div className="sell-card mt-12 py-16 text-center">
            <p className="text-[15px] font-semibold">Sign in to create a shopping agent.</p>
          </div>
        ) : loading ? (
          <div className="flex justify-center py-24" style={{ color: "var(--dsc-ink-2)" }}>
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : (
          <>
            {creating && (
              <form onSubmit={create} className="sell-card mt-10 space-y-6 p-5 sm:p-8">
                <div>
                  <label className="sell-field-label" htmlFor="agent-query">
                    What should it look for?
                  </label>
                  <input
                    id="agent-query"
                    className="sell-field"
                    placeholder="e.g. KAWS Sesame Street figure"
                    value={form.query}
                    onChange={(e) => setForm({ ...form, query: e.target.value })}
                    autoFocus
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {EXAMPLES.map((ex) => (
                      <button
                        type="button"
                        key={ex}
                        onClick={() => setForm({ ...form, query: ex })}
                        className="sell-pill px-3 py-1.5 text-[12px]"
                        style={{ color: "var(--dsc-ink-2)" }}
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="sm:max-w-[320px]">
                  <label className="sell-field-label" htmlFor="agent-max">
                    Most you would pay for one piece (USD)
                  </label>
                  <input
                    id="agent-max"
                    className="sell-field"
                    inputMode="decimal"
                    value={form.maxItemUsd}
                    onChange={(e) => setForm({ ...form, maxItemUsd: e.target.value })}
                  />
                  <p className="mt-2 text-[12px]" style={{ color: "var(--dsc-ink-2)" }}>
                    Postage included. It never suggests anything above this.
                  </p>
                </div>

                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={form.negotiate}
                    onChange={(e) => setForm({ ...form, negotiate: e.target.checked })}
                  />
                  <span className="text-[14px]" style={{ lineHeight: 1.5 }}>
                    Let it negotiate
                    <span className="block text-[12px]" style={{ color: "var(--dsc-ink-2)" }}>
                      When a piece is up to 15% over your limit, it makes one offer at your limit. If the seller
                      accepts, you are asked to pay.
                    </span>
                  </span>
                </label>

                <div>
                  <button
                    type="button"
                    onClick={() => setMore((v) => !v)}
                    className="text-[13px] font-medium underline underline-offset-4"
                    style={{ color: "var(--dsc-ink-2)" }}
                    aria-expanded={more}
                  >
                    {more ? "Fewer options" : "More options"}
                  </button>
                  {more && (
                    <div className="mt-5 space-y-6">
                      <div>
                        <span className="sell-field-label">I can pay with</span>
                        <div className="flex flex-wrap gap-2">
                          {PAY_WITH_OPTIONS.map((s) => (
                            <button
                              type="button"
                              key={s}
                              onClick={() => togglePay(s)}
                              className={`sell-pill px-4 py-2 text-[13px] font-medium ${form.payWith.includes(s) ? "is-active" : ""}`}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="sm:max-w-[320px]">
                        <label className="sell-field-label" htmlFor="agent-daily">
                          Daily limit (USD)
                        </label>
                        <input
                          id="agent-daily"
                          className="sell-field"
                          inputMode="decimal"
                          placeholder={`${(Number(form.maxItemUsd) || 0) * 3} (three pieces)`}
                          value={form.dailyBudgetUsd}
                          onChange={(e) => setForm({ ...form, dailyBudgetUsd: e.target.value })}
                        />
                        <p className="mt-2 text-[12px]" style={{ color: "var(--dsc-ink-2)", lineHeight: 1.5 }}>
                          The most it will put in front of you in one day, all suggestions together. Pieces you buy
                          count against it; anything past it waits until tomorrow.
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                <div className="rounded-2xl px-4 py-3 text-[12px]" style={{ background: "var(--dsc-ground)", color: "var(--dsc-ink-2)", lineHeight: 1.6 }}>
                  The agent never pays on its own. When it finds something, you get a notification and review it
                  first. You pay from your own wallet; Port66 never holds your money.
                </div>

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
                    style={{ background: color.gradient, color: "var(--dsc-ink)" }}
                  >
                    {busy && <Loader2 size={14} className="animate-spin" />}
                    {busy ? "Searching…" : "Start agent"}
                  </button>
                  {agents.length > 0 && (
                    <button type="button" onClick={() => setCreating(false)} className="sell-action-quiet">
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            )}

            {agents.length > 0 && (
              <div className="mt-10 grid gap-4 sm:grid-cols-2">
                {agents.map((a) => (
                  <Link key={a.id} href={`/agents/${a.id}`} className="sell-card block p-5 transition-transform hover:-translate-y-0.5 sm:p-6">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                          style={{ background: color.tint }}
                        >
                          <Bot size={18} strokeWidth={1.6} />
                        </span>
                        <div>
                          <p className="text-[15px] font-semibold">{a.name}</p>
                          <p className="text-[12px]" style={{ color: "var(--dsc-ink-2)" }}>
                            Up to {usd(a.maxItemUsd)} · {a.status === "ACTIVE" ? `checked ${ago(a.lastRunAt)}` : "paused"}
                          </p>
                        </div>
                      </div>
                      {a.pendingMatches ? (
                        <span
                          className="shrink-0 rounded-full px-3 py-1 text-[12px] font-semibold"
                          style={{ background: color.gradient }}
                        >
                          {a.pendingMatches} to review
                        </span>
                      ) : null}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </main>
      <StudioFooter />
    </div>
  );
}
