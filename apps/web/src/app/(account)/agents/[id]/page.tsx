"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Bot, Loader2, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { HouseNav } from "@/components/merchant/house-nav";
import { StudioFooter } from "@/components/studio/studio-footer";
import { useApiClient } from "@/lib/api/client";
import { useOptionalAuth } from "@/hooks/use-optional-auth";
import { pieceColor } from "@/lib/piece-color";
import { ago, usd, type AgentDetail, type AgentMatch } from "@/lib/agents";
import { AutoBuyCard } from "@/components/agents/auto-buy-card";

const STATUS_LABEL: Record<AgentMatch["status"], string> = {
  PENDING: "Ready for you",
  OFFERED: "Offer sent, waiting for the seller",
  BUYING: "Paid by your agent, completing the order",
  FAILED: "Not bought",
  PURCHASED: "Bought",
  DISMISSED: "Dismissed",
  GONE: "No longer available",
};

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApiClient();
  const router = useRouter();
  const { isSignedIn, userId } = useOptionalAuth();
  const color = pieceColor(userId ?? "port66-agents");
  const [data, setData] = useState<AgentDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "run" | "status" | "delete">("");

  const load = useCallback(() => {
    api
      .get<AgentDetail>(`/shopping-agents/${id}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the agent."));
     
  }, [id]);

  useEffect(() => {
    if (isSignedIn) load();
  }, [isSignedIn, load]);

  async function act(kind: "run" | "status" | "delete") {
    if (!data) return;
    setBusy(kind);
    setError("");
    try {
      if (kind === "run") setData(await api.post<AgentDetail>(`/shopping-agents/${id}/run`, {}));
      if (kind === "status")
        setData(
          await api.patch<AgentDetail>(`/shopping-agents/${id}`, {
            status: data.agent.status === "ACTIVE" ? "PAUSED" : "ACTIVE",
          }),
        );
      if (kind === "delete") {
        if (!confirm("Delete this agent and its history?")) return;
        await api.delete(`/shopping-agents/${id}`);
        router.push("/agents");
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy("");
    }
  }

  async function dismiss(matchId: string) {
    await api.post(`/shopping-agents/matches/${matchId}/dismiss`, {}).catch(() => undefined);
    load();
  }

  const agent = data?.agent;
  const isOpen = (m: AgentMatch) => m.status === "PENDING" || m.status === "OFFERED" || m.status === "BUYING";
  const open = data?.matches.filter(isOpen) ?? [];
  const closed = data?.matches.filter((m) => !isOpen(m)) ?? [];

  return (
    <div className="dsc-page min-h-screen" style={{ background: "var(--dsc-ground)", color: "var(--dsc-ink)" }}>
      <HouseNav />
      <main className="mx-auto max-w-[1100px] px-4 pb-24 pt-32 sm:px-10">
        <Link href="/agents" className="inline-flex items-center gap-2 text-[13px]" style={{ color: "var(--dsc-ink-2)" }}>
          <ArrowLeft size={14} /> All agents
        </Link>

        {!data && !error ? (
          <div className="flex justify-center py-24" style={{ color: "var(--dsc-ink-2)" }}>
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : !agent ? (
          <p className="mt-10 text-[14px]" style={{ color: "var(--dsc-danger, #c0392b)" }}>
            {error}
          </p>
        ) : (
          <>
            <div className="mt-6 flex flex-col gap-6 pb-8 dsc-rule-b sm:flex-row sm:items-end sm:justify-between">
              <div className="flex items-start gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full" style={{ background: color.tint }}>
                  <Bot size={22} strokeWidth={1.6} />
                </span>
                <div>
                  <h1 style={{ fontFamily: "var(--dsc-font)", fontWeight: 700, fontSize: "clamp(1.6rem,3.5vw,2.4rem)", letterSpacing: "-0.02em", lineHeight: 1.1 }}>
                    {agent.name}
                  </h1>
                  <p className="mt-2 text-[13px]" style={{ color: "var(--dsc-ink-2)", lineHeight: 1.6 }}>
                    Looking for “{agent.query}” · up to {usd(agent.maxItemUsd)} an item · {usd(agent.dailyBudgetUsd)} a day ·
                    pays with {agent.payWith.join(", ")}
                    {agent.negotiate ? " · negotiates once" : ""}
                    <br />
                    {agent.status === "ACTIVE" ? `Watching. Last checked ${ago(agent.lastRunAt)}; checks again every 30 minutes.` : "Paused."}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => act("run")}
                  disabled={!!busy}
                  className="sell-action-solid inline-flex items-center gap-2 disabled:opacity-50"
                  style={{ background: color.gradient, color: "var(--dsc-ink)" }}
                >
                  {busy === "run" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  Search now
                </button>
                <button onClick={() => act("status")} disabled={!!busy} className="sell-action-quiet inline-flex items-center gap-2">
                  {agent.status === "ACTIVE" ? <Pause size={14} /> : <Play size={14} />}
                  {agent.status === "ACTIVE" ? "Pause" : "Resume"}
                </button>
                <button onClick={() => act("delete")} disabled={!!busy} className="sell-action-quiet inline-flex items-center gap-2" aria-label="Delete agent">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {error && (
              <p role="alert" className="mt-4 text-[13px]" style={{ color: "var(--dsc-danger, #c0392b)" }}>
                {error}
              </p>
            )}

            <AutoBuyCard agent={agent} gradient={color.gradient} onChange={setData} />

            <section className="mt-10">
              <h2 className="dsc-label" style={{ color: "var(--dsc-ink-2)" }}>
                {agent.autoBuy ? "Found and bought" : "For you to review"}
              </h2>
              {open.length === 0 ? (
                <div className="sell-card mt-4 px-6 py-10 text-center text-[14px]" style={{ color: "var(--dsc-ink-2)" }}>
                  Nothing yet. The agent keeps watching and will notify you when it finds something that fits.
                </div>
              ) : (
                <div className="mt-4 grid gap-4">
                  {open.map((m) => (
                    <MatchCard key={m.id} m={m} gradient={color.gradient} onDismiss={() => dismiss(m.id)} />
                  ))}
                </div>
              )}
            </section>

            <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_1fr]">
              <section>
                <h2 className="dsc-label" style={{ color: "var(--dsc-ink-2)" }}>
                  Activity
                </h2>
                <ol className="mt-4 space-y-3">
                  {data!.events.map((e) => (
                    <li key={e.id} className="sell-card px-4 py-3">
                      <p className="text-[13px]" style={{ lineHeight: 1.5 }}>
                        {e.message}
                      </p>
                      <p className="mt-1 text-[11px]" style={{ color: "var(--dsc-ink-2)" }}>
                        {ago(e.createdAt)}
                        {typeof e.data?.tx === "string" && (
                          <>
                            {" · "}
                            <a href={e.data.tx} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                              View payment
                            </a>
                          </>
                        )}
                        {typeof e.data?.delivery === "string" && (
                          <>
                            {" · "}
                            <a href={e.data.delivery} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                              Seller paid
                            </a>
                          </>
                        )}
                      </p>
                    </li>
                  ))}
                </ol>
              </section>
              <section>
                <h2 className="dsc-label" style={{ color: "var(--dsc-ink-2)" }}>
                  Earlier matches
                </h2>
                {closed.length === 0 ? (
                  <p className="mt-4 text-[13px]" style={{ color: "var(--dsc-ink-2)" }}>
                    None yet.
                  </p>
                ) : (
                  <ul className="mt-4 space-y-3">
                    {closed.map((m) => (
                      <li key={m.id} className="sell-card flex items-center justify-between gap-3 px-4 py-3 text-[13px]">
                        <span className="min-w-0 truncate">{m.listing?.title ?? "A listing"}</span>
                        <span className="shrink-0" style={{ color: "var(--dsc-ink-2)" }}>
                          {STATUS_LABEL[m.status]}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </main>
      <StudioFooter />
    </div>
  );
}

function MatchCard({ m, gradient, onDismiss }: { m: AgentMatch; gradient: string; onDismiss: () => void }) {
  const l = m.listing;
  return (
    <div className="sell-card flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
      {l?.image ? (
         
        <img src={l.image} alt="" className="h-24 w-24 shrink-0 rounded-2xl object-cover" style={{ background: "var(--dsc-ground)" }} />
      ) : (
        <div className="h-24 w-24 shrink-0 rounded-2xl" style={{ background: "var(--dsc-ground)" }} />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-wide" style={{ color: "var(--dsc-ink-2)" }}>
          {l?.brand ?? ""} {STATUS_LABEL[m.status]}
        </p>
        <p className="mt-1 text-[15px] font-semibold">{l?.title ?? "A listing"}</p>
        <p className="mt-1 text-[13px]" style={{ color: "var(--dsc-ink-2)" }}>
          {m.reason}
        </p>
        {l && (
          <p className="mt-1 text-[13px]">
            {usd(l.priceUsd)}
            {l.shippingUsd ? ` + ${usd(l.shippingUsd)} postage` : " · free postage"}
          </p>
        )}
      </div>
      {m.status === "PENDING" && l && (
        <div className="flex shrink-0 gap-2">
          <Link href={`/listing/${l.slug}?buy=1`} className="sell-action-solid" style={{ background: gradient, color: "var(--dsc-ink)" }}>
            Review &amp; pay
          </Link>
          <button onClick={onDismiss} className="sell-action-quiet">
            Dismiss
          </button>
        </div>
      )}
      {m.status === "OFFERED" && l && (
        <Link href={`/listing/${l.slug}`} className="sell-action-quiet shrink-0">
          View piece
        </Link>
      )}
    </div>
  );
}
