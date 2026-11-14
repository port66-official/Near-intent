import { Module } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ListingsModule } from "../listings/listings.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { NearIntentsModule } from "../near-intents/near-intents.module";
import { ShoppingAgentsController } from "./shopping-agents.controller";
import { ShoppingAgentsService } from "./shopping-agents.service";

@Module({
  imports: [ListingsModule, NotificationsModule, NearIntentsModule],
  controllers: [ShoppingAgentsController],
  // PrismaService is also required by ClerkAuthGuard; there is no shared
  // PrismaModule, so each module provides it directly.
  providers: [ShoppingAgentsService, PrismaService],
})
export class ShoppingAgentsModule {}
