import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from "class-validator";

export const AGENT_PAY_WITH = ["USDC", "ETH", "SOL", "BTC", "NEAR", "USDT", "DOGE", "LTC"] as const;
const CONDITIONS = ["DEADSTOCK", "MINT", "EXCELLENT", "VERY_GOOD", "GOOD", "FAIR"] as const;

export class CreateShoppingAgentDto {
  @ApiProperty({ example: "KAWS figure" })
  @IsString()
  @Length(1, 60)
  name: string;

  @ApiProperty({ example: "kaws sesame street", description: "What to look for" })
  @IsString()
  @Length(2, 120)
  query: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 60) brandName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 20) size?: string;
  @ApiPropertyOptional({ enum: CONDITIONS }) @IsOptional() @IsIn(CONDITIONS) condition?: string;

  @ApiProperty({ example: 300, description: "Most it may propose for one item, postage included" })
  @IsNumber()
  @Min(1)
  @Max(100_000)
  maxItemUsd: number;

  @ApiProperty({ example: 500 })
  @IsNumber()
  @Min(1)
  @Max(250_000)
  dailyBudgetUsd: number;

  @ApiPropertyOptional({ enum: AGENT_PAY_WITH, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(AGENT_PAY_WITH, { each: true })
  payWith?: string[];

  @ApiPropertyOptional({ description: "May make one offer at the limit when the price is up to 15% above it" })
  @IsOptional()
  @IsBoolean()
  negotiate?: boolean;
}

export class UpdateShoppingAgentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 60) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 120) query?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(1) @Max(100_000) maxItemUsd?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(1) @Max(250_000) dailyBudgetUsd?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() negotiate?: boolean;
  @ApiPropertyOptional({ enum: ["ACTIVE", "PAUSED"] }) @IsOptional() @IsIn(["ACTIVE", "PAUSED"]) status?: string;
}

export class EnableAutoBuyDto {
  @ApiProperty({ description: "The signed spend permission returned by the user's Coinbase Smart Wallet" })
  @IsObject()
  permission: Record<string, unknown>;

  @ApiProperty({ description: "Delivery address: name, line1, line2, city, region, postal, country, phone" })
  @IsObject()
  shipTo: Record<string, string>;
}
