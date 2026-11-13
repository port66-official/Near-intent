import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export class IntentQuoteDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  listingId!: string;

  @ApiProperty({
    description: "NEAR Intents asset id of what the buyer pays with",
    example: "nep141:btc.omft.near",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  originAsset!: string;

  @ApiProperty({
    description:
      "Buyer's address on the chain they pay from; refunds are sent here",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  refundTo!: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  shippingAddress?: Record<string, string>;
}

export class IntentDepositDto {
  @ApiProperty({ description: "Hash of the buyer's deposit transaction" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  txHash!: string;
}
