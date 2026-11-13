import bs58 from "bs58";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

/**
 * The agent's spending wallet: a Solana keypair holding a small float of SOL.
 *
 * The agent pays by sending SOL to the one-time deposit address NEAR Intents
 * issued for a purchase; solvers turn it into the seller's USDC. It can send
 * nothing else and nowhere else: `pay` refuses any destination that did not
 * come from a Port66 quote, and the CLI only ever calls it with one.
 */
export class SolanaWallet {
  private readonly keypair: Keypair;
  private readonly connection: Connection;

  constructor(secretKeyBase58: string, rpcUrl: string) {
    this.keypair = Keypair.fromSecretKey(bs58.decode(secretKeyBase58.trim()));
    this.connection = new Connection(rpcUrl, "confirmed");
  }

  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  async balanceSol(): Promise<number> {
    return (await this.connection.getBalance(this.keypair.publicKey)) / LAMPORTS_PER_SOL;
  }

  /** Send exactly `lamports` to a quote's deposit address. Returns the signature. */
  async pay(depositAddress: string, lamports: bigint): Promise<string> {
    if (lamports <= 0n) throw new Error("Nothing to pay.");
    const to = new PublicKey(depositAddress);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey: to,
        lamports,
      }),
    );
    return sendAndConfirmTransaction(this.connection, tx, [this.keypair], {
      commitment: "confirmed",
    });
  }
}

/** "0.024633584" SOL as a string -> lamports, without floating point. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  if (!/^\d+$/.test(whole || "0") || !/^\d*$/.test(frac))
    throw new Error(`Not an amount: ${amount}`);
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}
