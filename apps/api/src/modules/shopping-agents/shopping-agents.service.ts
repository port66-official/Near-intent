import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../../node_modules/.prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ListingsService } from "../listings/listings.service";
import { evaluate, NEGOTIATION_STRETCH, searchWords, type AgentRules } from "./shopping-agent.rules";
import type { CreateShoppingAgentDto, UpdateShoppingAgentDto } from "./shopping-agents.dto";
import { NearIntentsService } from "../near-intents/near-intents.service";
import { AgentSpender, BASE_CHAIN_ID, USDC_BASE, validatePermission, type SignedSpendPermission } from "./agent-spender";

/** What the agent pays with when it buys on its own: USDC on Base, via NEAR Intents. */
const USDC_BASE_INTENTS_ASSET = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
/** Most the route may add on top of the price before the agent refuses to pay. */
const MAX_ROUTING_PCT = 5;

/** Same statements as packages/database/migrations/manual/20261114_shopping_agents.sql. */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS "ShoppingAgent" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "query" TEXT NOT NULL, "brandName" TEXT, "size" TEXT, "condition" TEXT, "maxItemUsd" DECIMAL(12,2) NOT NULL, "dailyBudgetUsd" DECIMAL(12,2) NOT NULL, "payWith" TEXT[], "negotiate" BOOLEAN NOT NULL DEFAULT false, "status" TEXT NOT NULL DEFAULT 'ACTIVE', "lastRunAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ShoppingAgent_pkey" PRIMARY KEY ("id"), CONSTRAINT "ShoppingAgent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS "ShoppingAgent_userId_idx" ON "ShoppingAgent"("userId")`,
  `CREATE INDEX IF NOT EXISTS "ShoppingAgent_status_idx" ON "ShoppingAgent"("status")`,
  `CREATE TABLE IF NOT EXISTS "ShoppingAgentMatch" ("id" TEXT NOT NULL, "agentId" TEXT NOT NULL, "listingId" TEXT NOT NULL, "priceUsd" DECIMAL(12,2) NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "reason" TEXT NOT NULL, "offerId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ShoppingAgentMatch_pkey" PRIMARY KEY ("id"), CONSTRAINT "ShoppingAgentMatch_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ShoppingAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ShoppingAgentMatch_agentId_listingId_key" ON "ShoppingAgentMatch"("agentId", "listingId")`,
  `CREATE INDEX IF NOT EXISTS "ShoppingAgentMatch_status_idx" ON "ShoppingAgentMatch"("status")`,
  `CREATE TABLE IF NOT EXISTS "ShoppingAgentEvent" ("id" TEXT NOT NULL, "agentId" TEXT NOT NULL, "kind" TEXT NOT NULL, "message" TEXT NOT NULL, "data" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ShoppingAgentEvent_pkey" PRIMARY KEY ("id"), CONSTRAINT "ShoppingAgentEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ShoppingAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS "ShoppingAgentEvent_agentId_createdAt_idx" ON "ShoppingAgentEvent"("agentId", "createdAt")`,
  `ALTER TABLE "ShoppingAgent" ADD COLUMN IF NOT EXISTS "autoBuy" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "ShoppingAgent" ADD COLUMN IF NOT EXISTS "spendPermission" JSONB`,
  `ALTER TABLE "ShoppingAgent" ADD COLUMN IF NOT EXISTS "buyerWallet" TEXT`,
  `ALTER TABLE "ShoppingAgent" ADD COLUMN IF NOT EXISTS "shipTo" JSONB`,
  `ALTER TABLE "ShoppingAgentMatch" ADD COLUMN IF NOT EXISTS "checkoutId" TEXT`,
  `ALTER TABLE "ShoppingAgentMatch" ADD COLUMN IF NOT EXISTS "payTx" TEXT`,
];

const MAX_AGENTS_PER_USER = 10;
const NEW_MATCHES_PER_RUN = 5;
const CANDIDATES_PER_RUN = 40;
/** The cron revisits an active agent at most this often. */
const RUN_INTERVAL_MS = 30 * 60_000;

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? null : Number(d));

@Injectable()
export class ShoppingAgentsService {
  private readonly logger = new Logger(ShoppingAgentsService.name);
  private tablesReady: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly listings: ListingsService,
    private readonly intents: NearIntentsService,
  ) {}

  private readonly spender = new AgentSpender();

  /** Creates the tables on first use (additive, idempotent). */
  private ready(): Promise<void> {
    this.tablesReady ??= (async () => {
      for (const sql of TABLES) await this.prisma.$executeRawUnsafe(sql);
    })().catch((error) => {
      this.tablesReady = null;
      throw error;
    });
    return this.tablesReady;
  }

  private async owned(userId: string, id: string) {
    await this.ready();
    const agent = await this.prisma.shoppingAgent.findUnique({ where: { id } });
    if (!agent || agent.userId !== userId) throw new NotFoundException("Agent not found");
    return agent;
  }

  private event(agentId: string, kind: string, message: string, data?: Record<string, unknown>) {
    return this.prisma.shoppingAgentEvent.create({
      data: { agentId, kind, message, data: (data ?? undefined) as Prisma.InputJsonValue | undefined },
    });
  }

  private view(agent: Awaited<ReturnType<ShoppingAgentsService["owned"]>>) {
    const { spendPermission, ...rest } = agent;
    const permission = spendPermission as unknown as SignedSpendPermission | null;
    return {
      ...rest,
      maxItemUsd: num(agent.maxItemUsd),
      dailyBudgetUsd: num(agent.dailyBudgetUsd),
      // The signature stays server-side; the page only needs the terms.
      permission: permission
        ? {
            dailyUsd: Number(BigInt(permission.permission.allowance)) / 1e6,
            account: permission.permission.account,
            // Coinbase uses the largest uint48 (about year 8.9 million) for
            // "no end date", which is past what a JS Date can hold.
            end: isoOrNull(permission.permission.end),
          }
        : null,
    };
  }

  // ── automatic buying (spend permissions) ────────────────────────────────

  /** What the browser needs to ask the user's wallet for a permission. */
  async autoBuySetup() {
    if (!AgentSpender.configured())
      return { available: false, reason: "Automatic buying is not switched on for Port66 yet." };
    try {
      return { available: true, spender: await this.spender.address(), token: USDC_BASE, chainId: BASE_CHAIN_ID };
    } catch (error) {
      // Coinbase's error says what is wrong with the setup (bad wallet secret,
      // missing key permission...) and never contains the secrets themselves.
      const e = error as { name?: string; message?: string; statusCode?: number; errorType?: string };
      this.logger.error(`Agent spender setup failed: ${e.name ?? "Error"} ${e.statusCode ?? ""} ${e.errorType ?? ""} ${e.message ?? error}`);
      return {
        available: false,
        reason: `Coinbase could not set up the agent's payment account: ${String(e.message ?? e.errorType ?? "unknown error").slice(0, 200)}`,
      };
    }
  }

  async enableAutoBuy(
    userId: string,
    id: string,
    body: { permission: SignedSpendPermission; shipTo: Record<string, string> },
  ) {
    const agent = await this.owned(userId, id);
    if (!AgentSpender.configured()) throw new BadRequestException("Automatic buying is not switched on for Port66 yet.");
    const ship = body.shipTo ?? {};
    for (const field of ["name", "line1", "city", "postal", "country"])
      if (!String(ship[field] ?? "").trim()) throw new BadRequestException(`Add the delivery ${field === "line1" ? "address" : field}.`);
    const problem = validatePermission(body.permission, await this.spender.address(), num(agent.dailyBudgetUsd)!);
    if (problem) throw new BadRequestException(problem);
    const status = await this.spender.status(body.permission).catch(() => null);
    if (status && (status.isRevoked || status.isExpired)) throw new BadRequestException("That permission is revoked or expired.");
    const clean = Object.fromEntries(
      ["name", "line1", "line2", "city", "region", "postal", "country", "phone"].map((k) => [k, String(ship[k] ?? "").trim().slice(0, 120)]),
    );
    await this.prisma.shoppingAgent.update({
      where: { id },
      data: {
        autoBuy: true,
        spendPermission: body.permission as unknown as Prisma.InputJsonValue,
        buyerWallet: body.permission.permission.account,
        shipTo: clean,
      },
    });
    const daily = Number(BigInt(body.permission.permission.allowance)) / 1e6;
    await this.event(id, "AUTOBUY_ON", `Automatic buying on: up to $${daily} USDC a day from ${short(body.permission.permission.account)}, enforced on chain.`);
    return this.detail(userId, id);
  }

  async disableAutoBuy(userId: string, id: string) {
    await this.owned(userId, id);
    await this.prisma.shoppingAgent.update({ where: { id }, data: { autoBuy: false, spendPermission: Prisma.DbNull } });
    await this.event(id, "AUTOBUY_OFF", "Automatic buying off. Revoke the permission in your Coinbase wallet to remove it on chain too.");
    return this.detail(userId, id);
  }

  /** Remaining on-chain allowance today, for the agent page. */
  async autoBuyStatus(userId: string, id: string) {
    const agent = await this.owned(userId, id);
    const permission = agent.spendPermission as unknown as SignedSpendPermission | null;
    if (!agent.autoBuy || !permission) return { autoBuy: false };
    const s = await this.spender.status(permission);
    return {
      autoBuy: true,
      remainingTodayUsd: Number(s.remainingSpend) / 1e6,
      resetsAt: s.nextPeriodStart,
      active: s.isActive && !s.isRevoked && !s.isExpired,
    };
  }

  /**
   * The agent buys one listing on its own: reserve and quote through NEAR
   * Intents (refunds go to the user's own wallet), check the on-chain
   * allowance, then pay from the user's wallet straight to the deposit
   * address in one atomic operation.
   */
  private async buy(
    agent: { id: string; userId: string; name: string; maxItemUsd: Prisma.Decimal; spendPermission: unknown; buyerWallet: string | null; shipTo: unknown },
    listing: { id: string; title: string; slug: string },
    totalUsd: number,
  ): Promise<"bought" | "failed"> {
    const permission = agent.spendPermission as SignedSpendPermission;

    // Check the shopper's wallet can cover it before reserving anything or
    // spending gas. Not recorded as a match, so it is retried once topped up.
    const needed = BigInt(Math.ceil(totalUsd * (1 + MAX_ROUTING_PCT / 100) * 1e6));
    const held = await this.spender.balance(permission.permission.account).catch(() => null);
    if (held !== null && held < needed) {
      const recent = await this.prisma.shoppingAgentEvent.findFirst({
        where: { agentId: agent.id, kind: "LOW_BALANCE", createdAt: { gte: new Date(Date.now() - 6 * 3_600_000) } },
      });
      if (!recent) {
        const have = (Number(held) / 1e6).toFixed(2);
        const want = (Number(needed) / 1e6).toFixed(2);
        await this.event(agent.id, "LOW_BALANCE", `Found "${listing.title}" for $${totalUsd}, but your wallet has $${have} USDC on Base. Add about $${want} and it will buy on its next check.`, {
          listingId: listing.id,
          slug: listing.slug,
        });
        await this.notifications
          .notify(agent.userId, "SAVED_SEARCH_MATCH", `${agent.name}: add USDC to buy ${listing.title}`, `Your Coinbase wallet needs about $${want} USDC on Base.`, {
            shoppingAgentId: agent.id,
            url: `/agents/${agent.id}`,
          })
          .catch(() => undefined);
      }
      return "failed";
    }

    // The unique (agent, listing) row is the lock: a second run cannot buy twice.
    let match = await this.prisma.shoppingAgentMatch
      .create({ data: { agentId: agent.id, listingId: listing.id, priceUsd: totalUsd, status: "BUYING", reason: `Buying for $${totalUsd} within your rules` } })
      .catch(() => null);
    if (!match) {
      // Already on the list as waiting for the user (found before automatic
      // buying was on, or an accepted offer): claim it. Only one run can win.
      const claimed = await this.prisma.shoppingAgentMatch.updateMany({
        where: { agentId: agent.id, listingId: listing.id, status: "PENDING" },
        data: { status: "BUYING", reason: `Buying for $${totalUsd} within your rules` },
      });
      if (claimed.count !== 1) return "failed";
      match = await this.prisma.shoppingAgentMatch.findUnique({ where: { agentId_listingId: { agentId: agent.id, listingId: listing.id } } });
      if (!match) return "failed";
    }

    let paidTx: string | null = null;
    try {
      const checkout = await this.intents.quote(agent.userId, {
        listingId: listing.id,
        originAsset: USDC_BASE_INTENTS_ASSET,
        refundTo: agent.buyerWallet!,
        shippingAddress: agent.shipTo as Record<string, string>,
      });
      const amount = BigInt(checkout.pay.amountBaseUnits);
      const amountUsd = Number(amount) / 1e6;
      const ceiling = Math.min(totalUsd * (1 + MAX_ROUTING_PCT / 100), num(agent.maxItemUsd)! * (1 + MAX_ROUTING_PCT / 100));
      if (amountUsd > ceiling)
        throw new Error(`The route would cost $${amountUsd.toFixed(2)}, more than ${MAX_ROUTING_PCT}% over the price`);
      const status = await this.spender.status(permission);
      if (!status.isActive || status.isRevoked || status.isExpired) throw new Error("Your spend permission is no longer active");
      if (status.remainingSpend < amount)
        throw new Error(`Today's on-chain allowance has $${(Number(status.remainingSpend) / 1e6).toFixed(2)} left`);

      paidTx = await this.spender.pay(permission, amount, checkout.pay.depositAddress);
      await this.prisma.shoppingAgentMatch.update({
        where: { id: match.id },
        data: { checkoutId: checkout.id, payTx: paidTx, priceUsd: amountUsd, reason: `Paid ${amountUsd.toFixed(2)} USDC from your wallet; the seller receives ${checkout.sellerReceivesUsdc} USDC` },
      });
      await this.intents.submitDeposit(agent.userId, checkout.id, paidTx).catch(() => undefined);
      await this.event(agent.id, "BOUGHT", `Bought "${listing.title}": paid ${amountUsd.toFixed(2)} USDC from your wallet. The order completes when the seller is paid.`, {
        listingId: listing.id,
        slug: listing.slug,
        tx: `https://basescan.org/tx/${paidTx}`,
        checkoutId: checkout.id,
      });
      await this.notifications
        .notify(agent.userId, "ORDER_UPDATE", `${agent.name}: bought ${listing.title}`, `Paid ${amountUsd.toFixed(2)} USDC from your wallet, within your limits.`, {
          shoppingAgentId: agent.id,
          url: `/agents/${agent.id}`,
        })
        .catch(() => undefined);
      return "bought";
    } catch (error) {
      const reason = (error as Error).message;
      if (paidTx) {
        // Money moved: keep it BUYING so the order is still tracked.
        this.logger.error(`Agent ${agent.id} paid (${paidTx}) but follow-up failed: ${reason}`);
        return "bought";
      }
      await this.prisma.shoppingAgentMatch.update({ where: { id: match.id }, data: { status: "FAILED", reason: `Not bought: ${reason}` } });
      await this.event(agent.id, "FAILED", `Did not buy "${listing.title}": ${reason}. Nothing was paid.`, { listingId: listing.id });
      return "failed";
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  async list(userId: string) {
    await this.ready();
    const agents = await this.prisma.shoppingAgent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { matches: { where: { status: "PENDING" } } } } },
    });
    return agents.map(({ _count, ...a }) => ({ ...this.view(a), pendingMatches: _count.matches }));
  }

  async create(userId: string, dto: CreateShoppingAgentDto) {
    await this.ready();
    if ((await this.prisma.shoppingAgent.count({ where: { userId } })) >= MAX_AGENTS_PER_USER)
      throw new BadRequestException(`You can have up to ${MAX_AGENTS_PER_USER} agents.`);
    if (dto.dailyBudgetUsd < dto.maxItemUsd)
      throw new BadRequestException("The daily limit must be at least the price limit for one item.");
    const agent = await this.prisma.shoppingAgent.create({
      data: {
        userId,
        name: dto.name.trim(),
        query: dto.query.trim(),
        brandName: dto.brandName?.trim() || null,
        size: dto.size?.trim() || null,
        condition: dto.condition ?? null,
        maxItemUsd: dto.maxItemUsd,
        dailyBudgetUsd: dto.dailyBudgetUsd,
        payWith: dto.payWith?.length ? dto.payWith : ["USDC", "ETH", "SOL"],
        negotiate: dto.negotiate ?? false,
      },
    });
    await this.event(agent.id, "CREATED", `Created to look for "${agent.query}" up to $${dto.maxItemUsd}.`);
    // First search straight away, so the user sees results at once.
    await this.run(agent.id).catch((error) => this.logger.warn(`First run failed: ${error}`));
    return this.detail(userId, agent.id);
  }

  async update(userId: string, id: string, dto: UpdateShoppingAgentDto) {
    const agent = await this.owned(userId, id);
    const max = dto.maxItemUsd ?? num(agent.maxItemUsd)!;
    const daily = dto.dailyBudgetUsd ?? num(agent.dailyBudgetUsd)!;
    if (daily < max) throw new BadRequestException("The daily limit must be at least the price limit for one item.");
    await this.prisma.shoppingAgent.update({ where: { id }, data: { ...dto } });
    if (dto.status && dto.status !== agent.status)
      await this.event(id, dto.status === "PAUSED" ? "PAUSED" : "RESUMED", dto.status === "PAUSED" ? "Paused by you." : "Resumed by you.");
    return this.detail(userId, id);
  }

  async remove(userId: string, id: string) {
    await this.owned(userId, id);
    await this.prisma.shoppingAgent.delete({ where: { id } });
    return { deleted: true };
  }

  async detail(userId: string, id: string) {
    const agent = await this.owned(userId, id);
    const [matches, events] = await Promise.all([
      this.prisma.shoppingAgentMatch.findMany({ where: { agentId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
      this.prisma.shoppingAgentEvent.findMany({ where: { agentId: id }, orderBy: { createdAt: "desc" }, take: 60 }),
    ]);
    const listings = await this.prisma.listing.findMany({
      where: { id: { in: matches.map((m) => m.listingId) } },
      select: {
        id: true, slug: true, title: true, images: true, price: true, shippingCost: true, status: true,
        brand: { select: { name: true } },
        seller: { select: { username: true } },
      },
    });
    const byId = new Map(listings.map((l) => [l.id, l]));
    return {
      agent: this.view(agent),
      matches: matches.map((m) => {
        const l = byId.get(m.listingId);
        return {
          id: m.id,
          status: m.status,
          reason: m.reason,
          priceUsd: num(m.priceUsd),
          offerId: m.offerId,
          createdAt: m.createdAt,
          listing: l
            ? {
                slug: l.slug,
                title: l.title,
                image: l.images?.[0] ?? null,
                priceUsd: num(l.price),
                shippingUsd: num(l.shippingCost) ?? 0,
                status: l.status,
                brand: l.brand?.name ?? null,
                seller: l.seller?.username ?? null,
              }
            : null,
        };
      }),
      events,
    };
  }

  async dismiss(userId: string, matchId: string) {
    await this.ready();
    const match = await this.prisma.shoppingAgentMatch.findUnique({ where: { id: matchId }, include: { agent: true } });
    if (!match || match.agent.userId !== userId) throw new NotFoundException("Match not found");
    await this.prisma.shoppingAgentMatch.update({ where: { id: matchId }, data: { status: "DISMISSED" } });
    await this.event(match.agentId, "DISMISSED", "You dismissed a match; the agent will not propose it again.", { listingId: match.listingId });
    return { status: "DISMISSED" };
  }

  // ── the agent's work ────────────────────────────────────────────────────

  /** Runs one agent now (the "Search now" button). */
  async runNow(userId: string, id: string) {
    await this.owned(userId, id);
    await this.run(id);
    return this.detail(userId, id);
  }

  /** Cron: revisit every active agent that has not run recently. */
  async runDue() {
    await this.ready();
    const due = await this.prisma.shoppingAgent.findMany({
      where: {
        status: "ACTIVE",
        OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(Date.now() - RUN_INTERVAL_MS) } }],
      },
      orderBy: { lastRunAt: { sort: "asc", nulls: "first" } },
      take: 25,
    });
    let proposed = 0;
    for (const agent of due) {
      try {
        proposed += await this.run(agent.id);
      } catch (error) {
        this.logger.warn(`Agent ${agent.id} run failed: ${error}`);
      }
    }
    return { ran: due.length, proposed };
  }

  /** One pass: refresh old matches, search, decide, propose. Returns new matches. */
  async run(agentId: string): Promise<number> {
    await this.ready();
    const agent = await this.prisma.shoppingAgent.findUnique({ where: { id: agentId } });
    if (!agent) return 0;
    const rules: AgentRules = {
      userId: agent.userId,
      maxItemUsd: num(agent.maxItemUsd)!,
      dailyBudgetUsd: num(agent.dailyBudgetUsd)!,
      negotiate: agent.negotiate,
    };

    await this.refreshMatches(agent.id, agent.userId);

    let boughtWaiting = 0;
    if (agent.autoBuy && agent.spendPermission && agent.buyerWallet && AgentSpender.configured()) {
      const waiting = await this.prisma.shoppingAgentMatch.findMany({ where: { agentId, status: "PENDING" }, take: NEW_MATCHES_PER_RUN });
      for (const m of waiting) {
        const l = await this.prisma.listing.findUnique({
          where: { id: m.listingId },
          select: { id: true, sellerId: true, title: true, slug: true, status: true, price: true, shippingCost: true },
        });
        if (!l || l.status !== "ACTIVE") continue;
        // An accepted offer is priced at the agreed amount; otherwise re-check the rules.
        const accepted = !!m.offerId;
        const verdict = accepted
          ? null
          : evaluate({ id: l.id, sellerId: l.sellerId, title: l.title, priceUsd: num(l.price), shippingUsd: num(l.shippingCost) ?? 0 }, rules, 0);
        if (verdict && verdict.kind !== "match") continue;
        const total = verdict && verdict.kind === "match" ? verdict.totalUsd : Number(m.priceUsd) + (num(l.shippingCost) ?? 0);
        if ((await this.buy(agent, { id: l.id, title: l.title, slug: l.slug }, total)) === "bought") boughtWaiting++;
      }
    }

    const words = searchWords(agent.query);
    const priceCap = rules.negotiate ? rules.maxItemUsd * (1 + NEGOTIATION_STRETCH) : rules.maxItemUsd;
    const known = new Set(
      (await this.prisma.shoppingAgentMatch.findMany({ where: { agentId }, select: { listingId: true } })).map((m) => m.listingId),
    );
    const candidates = await this.prisma.listing.findMany({
      where: {
        status: "ACTIVE",
        sellerId: { not: agent.userId },
        price: { not: null, lte: priceCap },
        ...(agent.brandName ? { brand: { name: { contains: agent.brandName, mode: "insensitive" } } } : {}),
        ...(agent.size ? { size: { equals: agent.size, mode: "insensitive" } } : {}),
        ...(agent.condition ? { condition: agent.condition as never } : {}),
        AND: words.map((w) => ({
          OR: [
            { title: { contains: w, mode: "insensitive" as const } },
            { description: { contains: w, mode: "insensitive" as const } },
            { brand: { name: { contains: w, mode: "insensitive" as const } } },
          ],
        })),
      },
      orderBy: { price: "asc" },
      take: CANDIDATES_PER_RUN,
      select: { id: true, sellerId: true, title: true, price: true, shippingCost: true, slug: true },
    });

    // Budget already committed today: purchases, plus proposals still waiting.
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const committed = await this.prisma.shoppingAgentMatch.findMany({
      where: { agentId, status: { in: ["PENDING", "OFFERED", "BUYING", "PURCHASED"] }, updatedAt: { gte: since } },
      select: { priceUsd: true },
    });
    let spent = committed.reduce((sum, m) => sum + Number(m.priceUsd), 0);

    const proposed: { title: string; slug: string; reason: string }[] = Array.from({ length: boughtWaiting }, () => ({
      title: "a piece you had on your list",
      slug: "",
      reason: "bought",
    }));
    let skipped = 0;
    for (const l of candidates) {
      if (known.has(l.id) || proposed.length >= NEW_MATCHES_PER_RUN) continue;
      const verdict = evaluate(
        { id: l.id, sellerId: l.sellerId, title: l.title, priceUsd: num(l.price), shippingUsd: num(l.shippingCost) ?? 0 },
        rules,
        spent,
      );
      if (verdict.kind === "skip") {
        skipped++;
        continue;
      }
      if (verdict.kind === "match" && agent.autoBuy && agent.spendPermission && agent.buyerWallet && AgentSpender.configured()) {
        const outcome = await this.buy(agent, { id: l.id, title: l.title, slug: l.slug }, verdict.totalUsd);
        if (outcome === "bought") {
          spent += verdict.totalUsd;
          proposed.push({ title: l.title, slug: l.slug, reason: "bought" });
        }
        continue;
      }
      if (verdict.kind === "match") {
        await this.prisma.shoppingAgentMatch.create({
          data: { agentId, listingId: l.id, priceUsd: verdict.totalUsd, reason: verdict.reason },
        });
        spent += verdict.totalUsd;
        proposed.push({ title: l.title, slug: l.slug, reason: verdict.reason });
        await this.event(agentId, "MATCH", `Found "${l.title}": ${verdict.reason}.`, { listingId: l.id, slug: l.slug });
      } else {
        // One offer at the user's limit, through Port66's normal offers.
        try {
          const offer = await this.listings.makeOffer(agent.userId, l.id, {
            amount: verdict.offerUsd,
            message: "Offer made by the buyer's Port66 shopping agent, within the buyer's limit.",
          });
          await this.prisma.shoppingAgentMatch.create({
            data: { agentId, listingId: l.id, priceUsd: verdict.offerUsd, reason: verdict.reason, status: "OFFERED", offerId: offer.id },
          });
          spent += rules.maxItemUsd;
          proposed.push({ title: l.title, slug: l.slug, reason: verdict.reason });
          await this.event(agentId, "OFFER", `Offered $${verdict.offerUsd} for "${l.title}".`, { listingId: l.id, slug: l.slug, offerId: offer.id });
        } catch (error) {
          await this.event(agentId, "SKIP", `Could not make an offer on "${l.title}": ${(error as Error).message}`, { listingId: l.id });
        }
      }
    }

    await this.prisma.shoppingAgent.update({ where: { id: agentId }, data: { lastRunAt: new Date() } });
    await this.event(
      agentId,
      "RUN",
      `Searched for "${agent.query}": ${candidates.length} candidate(s), ${proposed.length} new, ${skipped} outside your rules.`,
      { words },
    );

    if (proposed.length)
      await this.notifications
        .notify(
          agent.userId,
          "SAVED_SEARCH_MATCH",
          proposed.some((p) => p.reason === "bought")
            ? `${agent.name}: bought ${proposed.filter((p) => p.reason === "bought").length} piece(s)`
            : proposed.length === 1
              ? `${agent.name}: found a match`
              : `${agent.name}: found ${proposed.length} matches`,
          proposed.map((p) => p.title).slice(0, 3).join(", "),
          { shoppingAgentId: agentId, url: `/agents/${agentId}` },
        )
        .catch((error) => this.logger.warn(`Notify failed: ${error}`));

    return proposed.length;
  }

  /** Marks matches whose listing sold (to this user, or someone else) or vanished. */
  private async refreshMatches(agentId: string, userId: string) {
    const open = await this.prisma.shoppingAgentMatch.findMany({
      where: { agentId, status: { in: ["PENDING", "OFFERED", "BUYING"] } },
    });
    if (!open.length) return;
    for (const m of open.filter((x) => x.status === "BUYING" && x.checkoutId)) {
      const checkout = await this.intents.status(userId, m.checkoutId!).catch(() => null);
      if (!checkout) continue;
      if (checkout.state === "paid") {
        await this.prisma.shoppingAgentMatch.update({ where: { id: m.id }, data: { status: "PURCHASED" } });
        await this.event(agentId, "PURCHASED", `Order complete: the seller received ${checkout.sellerReceivesUsdc} USDC.`, {
          listingId: m.listingId,
          orderId: checkout.orderId,
          delivery: checkout.deliveryTx[0]?.explorerUrl,
        });
      } else if (["refunded", "failed", "expired"].includes(checkout.state)) {
        await this.prisma.shoppingAgentMatch.update({ where: { id: m.id }, data: { status: "FAILED", reason: `Payment ${checkout.state}; any funds go back to your wallet` } });
        await this.event(agentId, "FAILED", `The payment was ${checkout.state}. Any funds are returned to your wallet.`, { listingId: m.listingId });
      }
    }
    const listings = await this.prisma.listing.findMany({
      where: { id: { in: open.map((m) => m.listingId) } },
      select: { id: true, status: true, title: true },
    });
    const byId = new Map(listings.map((l) => [l.id, l]));
    for (const m of open.filter((x) => x.status !== "BUYING")) {
      const l = byId.get(m.listingId);
      if (l?.status === "ACTIVE" && m.status === "OFFERED" && m.offerId) {
        const offer = await this.prisma.offer.findUnique({ where: { id: m.offerId }, select: { status: true, amount: true } });
        if (offer?.status === "ACCEPTED") {
          await this.prisma.shoppingAgentMatch.update({ where: { id: m.id }, data: { status: "PENDING", reason: `Seller accepted the agent's $${Number(offer.amount)} offer` } });
          await this.event(agentId, "ACCEPTED", `The seller accepted the offer on "${l.title}". Review and pay to buy it.`, { listingId: m.listingId });
          await this.notifications
            .notify(userId, "OFFER_ACCEPTED", "Your agent's offer was accepted", `${l.title}: review and pay to buy it.`, { shoppingAgentId: agentId, url: `/agents/${agentId}` })
            .catch(() => undefined);
        } else if (offer && ["DECLINED", "EXPIRED", "CANCELLED"].includes(String(offer.status))) {
          await this.prisma.shoppingAgentMatch.update({ where: { id: m.id }, data: { status: "GONE", reason: `Offer ${String(offer.status).toLowerCase()}` } });
          await this.event(agentId, "GONE", `The offer on "${l.title}" was ${String(offer.status).toLowerCase()}.`, { listingId: m.listingId });
        }
        continue;
      }
      if (l?.status === "ACTIVE") continue;
      const bought = await this.prisma.order.findFirst({ where: { listingId: m.listingId, buyerId: userId }, select: { id: true } });
      const status = bought ? "PURCHASED" : "GONE";
      await this.prisma.shoppingAgentMatch.update({ where: { id: m.id }, data: { status } });
      await this.event(
        agentId,
        status,
        bought ? `You bought "${l?.title ?? "an item"}". Done.` : `"${l?.title ?? "An item"}" is no longer available.`,
        { listingId: m.listingId, orderId: bought?.id },
      );
    }
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Unix seconds as ISO, or null when it is "never" (beyond what Date can represent). */
export function isoOrNull(seconds: number): string | null {
  const ms = Number(seconds) * 1000;
  return Number.isFinite(ms) && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
}
