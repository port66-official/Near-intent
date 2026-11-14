import { timingSafeEqual } from "crypto";
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ClerkAuthGuard } from "../../common/guards/clerk-auth.guard";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { ShoppingAgentsService } from "./shopping-agents.service";
import { CreateShoppingAgentDto, EnableAutoBuyDto, UpdateShoppingAgentDto } from "./shopping-agents.dto";
import type { SignedSpendPermission } from "./agent-spender";

type Me = { id: string };

@ApiTags("Shopping agents")
@ApiBearerAuth()
@UseGuards(ClerkAuthGuard)
@Controller({ path: "shopping-agents", version: "1" })
export class ShoppingAgentsController {
  constructor(private readonly agents: ShoppingAgentsService) {}

  @Get()
  @ApiOperation({ summary: "Your shopping agents" })
  list(@CurrentUser() user: Me) {
    return this.agents.list(user.id);
  }

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Create an agent; it searches straight away" })
  create(@CurrentUser() user: Me, @Body() body: CreateShoppingAgentDto) {
    return this.agents.create(user.id, body);
  }

  @Get("autobuy/setup")
  @ApiOperation({ summary: "Spender address, token and chain for a spend permission" })
  autoBuySetup() {
    return this.agents.autoBuySetup();
  }

  @Post(":id/autobuy")
  @ApiOperation({ summary: "Turn on automatic buying with a signed spend permission" })
  enableAutoBuy(@CurrentUser() user: Me, @Param("id") id: string, @Body() body: EnableAutoBuyDto) {
    return this.agents.enableAutoBuy(user.id, id, {
      permission: body.permission as unknown as SignedSpendPermission,
      shipTo: body.shipTo,
    });
  }

  @Delete(":id/autobuy")
  disableAutoBuy(@CurrentUser() user: Me, @Param("id") id: string) {
    return this.agents.disableAutoBuy(user.id, id);
  }

  @Get(":id/autobuy")
  @ApiOperation({ summary: "Remaining on-chain allowance today" })
  autoBuyStatus(@CurrentUser() user: Me, @Param("id") id: string) {
    return this.agents.autoBuyStatus(user.id, id);
  }

  @Get(":id")
  @ApiOperation({ summary: "An agent with its matches and activity" })
  detail(@CurrentUser() user: Me, @Param("id") id: string) {
    return this.agents.detail(user.id, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit, pause or resume an agent" })
  update(@CurrentUser() user: Me, @Param("id") id: string, @Body() body: UpdateShoppingAgentDto) {
    return this.agents.update(user.id, id, body);
  }

  @Delete(":id")
  remove(@CurrentUser() user: Me, @Param("id") id: string) {
    return this.agents.remove(user.id, id);
  }

  @Post(":id/run")
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: "Search now" })
  run(@CurrentUser() user: Me, @Param("id") id: string) {
    return this.agents.runNow(user.id, id);
  }

  @Post("matches/:matchId/dismiss")
  dismiss(@CurrentUser() user: Me, @Param("matchId") matchId: string) {
    return this.agents.dismiss(user.id, matchId);
  }

  // Cron sends `Authorization: Bearer ${CRON_SECRET}`, same as the other crons.
  @Public()
  @Get("cron/run")
  cron(@Headers("authorization") header?: string) {
    const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "";
    if (
      !expected ||
      !header ||
      Buffer.byteLength(header) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(header), Buffer.from(expected))
    )
      throw new UnauthorizedException();
    return this.agents.runDue();
  }
}
