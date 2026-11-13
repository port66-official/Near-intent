/**
 * Dry run of Port66's "pay from any chain" checkout on NEAR Intents.
 *
 *   pnpm --filter api intents:dry-run            # a 280 USDC item
 *   pnpm --filter api intents:dry-run 1250       # any price in USD
 *
 * Needs no keys, no funds and no database. For every asset the checkout
 * offers, it asks NEAR Intents' live solvers what a buyer would pay so that
 * the seller receives EXACTLY the item price in USDC on Solana. `dry: true`
 * means no deposit address is issued, so nothing here can move money.
 */
import { OneClickClient } from "../src/modules/near-intents/one-click.client";
import {
  SETTLEMENT_ASSET_ID,
  payableAssets,
  platformFee,
} from "../src/modules/near-intents/intent-assets";

// Where a refund would go, per chain. Public, well-known addresses: a dry
// quote only needs them to be well-formed.
const SAMPLE_REFUND: Record<string, string> = {
  Bitcoin: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  Solana: "DmT8iUarUdx5p1HbMxc642zAuPNm8C2chL62rcAena5w",
  NEAR: "alice.near",
  Ethereum: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  Arbitrum: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  Base: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  Dogecoin: "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L",
  Litecoin: "ltc1qhzjptwpym9afcdjhs7jcz6fd0jma0l0rc0e5yr",
};
// The seller in this run: any Solana wallet works for a dry quote.
const SELLER = process.env.SELLER_SOLANA_WALLET ?? SAMPLE_REFUND.Solana;

const pad = (text: string, width: number) => text.padEnd(width);

async function main() {
  const priceUsd = Number(process.argv[2] ?? "280");
  if (!Number.isFinite(priceUsd) || priceUsd <= 0)
    throw new Error("Pass the item price in USD, e.g. 280");
  const amount = BigInt(Math.round(priceUsd * 1_000_000)).toString();
  const client = new OneClickClient({
    apiKey: process.env.NEAR_INTENTS_API_KEY,
  });
  const assets = payableAssets(await client.tokens());

  console.log(
    `\nItem price: ${priceUsd.toFixed(2)} USDC, delivered to the seller on Solana (${SELLER.slice(0, 4)}...${SELLER.slice(-4)})\n`,
  );
  console.log(
    pad("Pay with", 18) +
      pad("You send", 24) +
      pad("In USD", 10) +
      pad("Seller gets", 14) +
      "Arrives in",
  );
  let quoted = 0;
  for (const asset of assets) {
    const label = pad(`${asset.symbol} / ${asset.chain}`, 18);
    try {
      const { quote } = await client.quote({
        dry: true,
        swapType: "EXACT_OUTPUT",
        slippageTolerance: 100,
        originAsset: asset.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: SETTLEMENT_ASSET_ID,
        amount,
        recipient: SELLER,
        recipientType: "DESTINATION_CHAIN",
        refundTo: SAMPLE_REFUND[asset.chain],
        refundType: "ORIGIN_CHAIN",
        deadline: new Date(
          Date.now() + asset.windowMinutes * 60_000,
        ).toISOString(),
        referral: "port66",
        ...(platformFee() ? { appFees: [platformFee()!] } : {}),
      });
      quoted += 1;
      const eta =
        quote.timeEstimate < 90
          ? `about ${quote.timeEstimate}s`
          : `about ${Math.round(quote.timeEstimate / 60)} min`;
      console.log(
        label +
          pad(
            `${Number(quote.amountInFormatted).toPrecision(6)} ${asset.symbol}`,
            24,
          ) +
          pad(`$${Number(quote.amountInUsd).toFixed(2)}`, 10) +
          pad(`${quote.amountOutFormatted} USDC`, 14) +
          eta,
      );
    } catch (error) {
      console.log(
        `${label}unavailable right now (${(error as Error).message})`,
      );
    }
  }
  console.log(
    `\n${quoted}/${assets.length} routes quoted live by NEAR Intents solvers. Nothing was charged: these were dry quotes.\n`,
  );
  if (!quoted) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
