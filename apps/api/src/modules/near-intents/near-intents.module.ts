import { Module } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { PaymentsModule } from "../payments/payments.module";
import { NearIntentsController } from "./near-intents.controller";
import { NearIntentsService } from "./near-intents.service";

@Module({
  imports: [PaymentsModule],
  controllers: [NearIntentsController],
  // PrismaService is also required by ClerkAuthGuard; there is no shared
  // PrismaModule, so each module provides it directly.
  providers: [NearIntentsService, PrismaService],
})
export class NearIntentsModule {}
