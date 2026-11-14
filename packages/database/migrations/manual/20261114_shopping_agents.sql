-- Shopping agents: a user's own agent that proposes matches inside the user's
-- rules. Additive only: three new tables, cascading with their user. The API
-- also runs these exact statements on first use (IF NOT EXISTS), so applying
-- this by hand is optional.
CREATE TABLE IF NOT EXISTS "ShoppingAgent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "brandName" TEXT,
    "size" TEXT,
    "condition" TEXT,
    "maxItemUsd" DECIMAL(12,2) NOT NULL,
    "dailyBudgetUsd" DECIMAL(12,2) NOT NULL,
    "payWith" TEXT[],
    "negotiate" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShoppingAgent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShoppingAgent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ShoppingAgent_userId_idx" ON "ShoppingAgent"("userId");
CREATE INDEX IF NOT EXISTS "ShoppingAgent_status_idx" ON "ShoppingAgent"("status");

CREATE TABLE IF NOT EXISTS "ShoppingAgentMatch" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "priceUsd" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "offerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShoppingAgentMatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShoppingAgentMatch_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ShoppingAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ShoppingAgentMatch_agentId_listingId_key" ON "ShoppingAgentMatch"("agentId", "listingId");
CREATE INDEX IF NOT EXISTS "ShoppingAgentMatch_status_idx" ON "ShoppingAgentMatch"("status");

CREATE TABLE IF NOT EXISTS "ShoppingAgentEvent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShoppingAgentEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShoppingAgentEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ShoppingAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ShoppingAgentEvent_agentId_createdAt_idx" ON "ShoppingAgentEvent"("agentId", "createdAt");

-- Automatic buying (agent pays through a Base spend permission). Additive.
ALTER TABLE "ShoppingAgent" ADD COLUMN IF NOT EXISTS "autoBuy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShoppingAgent" ADD COLUMN IF NOT EXISTS "spendPermission" JSONB;
ALTER TABLE "ShoppingAgent" ADD COLUMN IF NOT EXISTS "buyerWallet" TEXT;
ALTER TABLE "ShoppingAgent" ADD COLUMN IF NOT EXISTS "shipTo" JSONB;
ALTER TABLE "ShoppingAgentMatch" ADD COLUMN IF NOT EXISTS "checkoutId" TEXT;
ALTER TABLE "ShoppingAgentMatch" ADD COLUMN IF NOT EXISTS "payTx" TEXT;
