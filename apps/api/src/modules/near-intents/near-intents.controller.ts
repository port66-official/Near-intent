import { timingSafeEqual } from "crypto";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ClerkAuthGuard } from "../../common/guards/clerk-auth.guard";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { NearIntentsService } from "./near-intents.service";
import { IntentDepositDto, IntentQuoteDto } from "./near-intents.dto";

@ApiTags("NEAR Intents checkout")
@ApiBearerAuth()
@UseGuards(ClerkAuthGuard)
@Controller({ path: "near-intents", version: "1" })
export class NearIntentsController {
  constructor(private readonly intents: NearIntentsService) {}

  @Public()
  @Get("options")
  @ApiOperation({
    summary: "Assets a buyer can pay with from other chains via NEAR Intents",
  })
  options() {
    return this.intents.options();
  }

  @Post("quote")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "Reserve a listing and get a deposit address: pay in any asset, the seller receives exact USDC on Solana",
  })
  quote(@CurrentUser() user: { id: string }, @Body() body: IntentQuoteDto) {
    return this.intents.quote(user.id, body);
  }

  @Get("sales.csv")
  @ApiOperation({
    summary: "Seller's NEAR Intents sales as CSV, one row per order",
  })
  async sales(@CurrentUser() user: { id: string }, @Res() res: Response) {
    // Sent directly, not returned: the global interceptor would otherwise
    // wrap the file in a {"data": ...} JSON envelope.
    const csv = await this.intents.salesCsv(user.id);
    res
      .status(200)
      .setHeader("content-type", "text/csv; charset=utf-8")
      .setHeader(
        "content-disposition",
        'attachment; filename="port66-intents-sales.csv"',
      )
      .send(csv);
  }

  @Get("offers/:listingId")
  @ApiOperation({
    summary:
      "The buyer's latest offer on a listing, and the agreed price if the seller accepted it",
  })
  offer(
    @CurrentUser() user: { id: string },
    @Param("listingId") listingId: string,
  ) {
    return this.intents.offerFor(user.id, listingId);
  }

  @Get("checkouts/:id")
  @ApiOperation({
    summary:
      "Payment progress; records the order once the seller is verifiably paid",
  })
  status(@CurrentUser() user: { id: string }, @Param("id") id: string) {
    return this.intents.status(user.id, id);
  }

  @Post("checkouts/:id/deposit")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Report the deposit transaction hash to speed up detection",
  })
  deposit(
    @CurrentUser() user: { id: string },
    @Param("id") id: string,
    @Body() body: IntentDepositDto,
  ) {
    return this.intents.submitDeposit(user.id, id, body.txHash);
  }

  // Scheduler target: settles payments whose buyer closed the tab. Vercel
  // Cron sends `Authorization: Bearer ${CRON_SECRET}`, same as the other crons.
  @Public()
  @Get("cron/reconcile")
  reconcile(@Headers("authorization") header?: string) {
    const expected = process.env.CRON_SECRET
      ? `Bearer ${process.env.CRON_SECRET}`
      : "";
    if (
      !expected ||
      !header ||
      Buffer.byteLength(header) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(header), Buffer.from(expected))
    )
      throw new UnauthorizedException();
    return this.intents.reconcile();
  }
}
