import { connect, keyStores, KeyPair, type Account } from "near-api-js";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, mainnet } from "viem/chains";
import { SolanaWallet } from "./wallet.js";

/**
 * How the agent pays a NEAR Intents deposit address, per chain.
 *
 * Every payer does one thing: send an exact amount of one asset to a deposit
 * address that came from a Port66 quote. None of them can be pointed
 * anywhere else by the agent: the CLI only ever passes a quote's address.
 */

export interface PayAsset {
  /** NEAR Intents asset id, e.g. nep141:arb-0xaf88...omft.near */
  assetId: string;
  symbol: string;
  /** Chain name as Port66 lists it: Solana, Ethereum, Arbitrum, Base, NEAR. */
  chain: string;
}

export interface Payer {
  chain: string;
  /** Where refunds go: the agent's own address on this chain. */
  address: string;
  /** Spendable balance of `asset`, in base units. */
  balance(asset: PayAsset): Promise<bigint>;
  /** Send `amount` base units of `asset` to `depositAddress`; returns the tx hash. */
  pay(asset: PayAsset, depositAddress: string, amount: bigint): Promise<string>;
  explorer(hash: string): string;
}

/** Chains the agent can pay from live, and which key each needs. */
export const LIVE_CHAINS: Record<string, string> = {
  Solana: "AGENT_SOLANA_KEY",
  Ethereum: "AGENT_EVM_PAY_KEY",
  Arbitrum: "AGENT_EVM_PAY_KEY",
  Base: "AGENT_EVM_PAY_KEY",
  NEAR: "AGENT_NEAR_ACCOUNT_ID + AGENT_NEAR_KEY",
};

// ── Solana: native SOL ───────────────────────────────────────────────────────

class SolanaPayer implements Payer {
  readonly chain = "Solana";
  constructor(private readonly wallet: SolanaWallet) {}
  get address() {
    return this.wallet.address;
  }
  async balance(asset: PayAsset) {
    if (asset.symbol !== "SOL") throw new Error("The Solana payer only sends native SOL.");
    // Keep a little back for the network fee.
    const lamports = BigInt(Math.floor((await this.wallet.balanceSol()) * 1e9));
    return lamports > 10_000n ? lamports - 10_000n : 0n;
  }
  pay(_asset: PayAsset, depositAddress: string, amount: bigint) {
    return this.wallet.pay(depositAddress, amount);
  }
  explorer(hash: string) {
    return `https://solscan.io/tx/${hash}`;
  }
}

// ── EVM: native ETH, or an ERC-20 such as USDC ──────────────────────────────

const EVM: Record<string, { chain: Chain; explorer: string; rpcEnv: string }> = {
  Ethereum: { chain: mainnet, explorer: "https://etherscan.io/tx/", rpcEnv: "AGENT_ETHEREUM_RPC" },
  Arbitrum: { chain: arbitrum, explorer: "https://arbiscan.io/tx/", rpcEnv: "AGENT_ARBITRUM_RPC" },
  Base: { chain: base, explorer: "https://basescan.org/tx/", rpcEnv: "AGENT_BASE_RPC" },
};

/** "nep141:arb-0xaf88...omft.near" -> 0xaf88...; native assets -> null. */
export function evmToken(assetId: string): `0x${string}` | null {
  const match = assetId.match(/-(0x[0-9a-fA-F]{40})\./);
  return match ? (match[1] as `0x${string}`) : null;
}

class EvmPayer implements Payer {
  private readonly account;
  private readonly config;
  private readonly wallet;
  private readonly reader;

  constructor(
    readonly chain: string,
    privateKey: `0x${string}`,
  ) {
    this.config = EVM[chain];
    this.account = privateKeyToAccount(privateKey);
    const transport = http(process.env[this.config.rpcEnv]);
    this.wallet = createWalletClient({ account: this.account, chain: this.config.chain, transport });
    this.reader = createPublicClient({ chain: this.config.chain, transport });
  }

  get address() {
    return this.account.address;
  }

  async balance(asset: PayAsset) {
    const token = evmToken(asset.assetId);
    if (!token) {
      // Native ETH: keep enough back for gas on a simple transfer.
      const wei = await this.reader.getBalance({ address: this.account.address });
      const gas = (await this.reader.getGasPrice()) * 30_000n;
      return wei > gas ? wei - gas : 0n;
    }
    return this.reader.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.account.address],
    });
  }

  async pay(asset: PayAsset, depositAddress: string, amount: bigint) {
    const to = depositAddress as `0x${string}`;
    const token = evmToken(asset.assetId);
    const hash = token
      ? await this.wallet.writeContract({
          address: token,
          abi: erc20Abi,
          functionName: "transfer",
          args: [to, amount],
          chain: this.config.chain,
          account: this.account,
        })
      : await this.wallet.sendTransaction({
          to,
          value: amount,
          chain: this.config.chain,
          account: this.account,
        });
    const receipt = await this.reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`The payment reverted: ${hash}`);
    return hash;
  }

  explorer(hash: string) {
    return `${this.config.explorer}${hash}`;
  }
}

// ── NEAR: wNEAR (wrapping NEAR if needed) or USDC on NEAR ────────────────────

const GAS = 30_000_000_000_000n;
const ONE_YOCTO = 1n;
/** What NEP-145 storage registration on a fungible token typically costs. */
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

/** "nep141:wrap.near" -> "wrap.near"; the token contract on NEAR. */
export function nearToken(assetId: string): string {
  if (!assetId.startsWith("nep141:")) throw new Error(`Not a NEAR token: ${assetId}`);
  return assetId.slice("nep141:".length);
}

class NearPayer implements Payer {
  readonly chain = "NEAR";
  private account?: Account;

  constructor(
    readonly address: string,
    private readonly secretKey: string,
  ) {}

  private async signer(): Promise<Account> {
    if (this.account) return this.account;
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey("mainnet", this.address, KeyPair.fromString(this.secretKey as never));
    const near = await connect({
      networkId: "mainnet",
      keyStore,
      nodeUrl: process.env.AGENT_NEAR_RPC ?? "https://rpc.mainnet.near.org",
    });
    this.account = await near.account(this.address);
    return this.account;
  }

  private async ftBalance(contractId: string, accountId: string): Promise<bigint> {
    const account = await this.signer();
    const raw = await account.viewFunction({
      contractId,
      methodName: "ft_balance_of",
      args: { account_id: accountId },
    });
    return BigInt(raw as string);
  }

  async balance(asset: PayAsset) {
    const contractId = nearToken(asset.assetId);
    const held = await this.ftBalance(contractId, this.address);
    if (contractId !== "wrap.near") return held;
    // Native NEAR can be wrapped on the way; keep 0.1 NEAR for gas and storage.
    const state = await (await this.signer()).getAccountBalance();
    const spare = BigInt(state.available) - 100_000_000_000_000_000_000_000n;
    return held + (spare > 0n ? spare : 0n);
  }

  async pay(asset: PayAsset, depositAddress: string, amount: bigint) {
    const account = await this.signer();
    const contractId = nearToken(asset.assetId);

    if (contractId === "wrap.near") {
      const held = await this.ftBalance(contractId, this.address);
      if (held < amount)
        await account.functionCall({
          contractId,
          methodName: "near_deposit",
          args: {},
          gas: GAS,
          attachedDeposit: amount - held,
        });
    }

    // The deposit address must be registered on the token before it can
    // receive it (NEP-145). Registering is idempotent.
    const registered = await account.viewFunction({
      contractId,
      methodName: "storage_balance_of",
      args: { account_id: depositAddress },
    });
    if (!registered)
      await account.functionCall({
        contractId,
        methodName: "storage_deposit",
        args: { account_id: depositAddress, registration_only: true },
        gas: GAS,
        attachedDeposit: STORAGE_DEPOSIT,
      });

    const outcome = await account.functionCall({
      contractId,
      methodName: "ft_transfer",
      args: { receiver_id: depositAddress, amount: amount.toString() },
      gas: GAS,
      attachedDeposit: ONE_YOCTO,
    });
    return outcome.transaction.hash as string;
  }

  explorer(hash: string) {
    return `https://nearblocks.io/txns/${hash}`;
  }
}

/** The payer for an asset's chain, or an explanation of what is missing. */
export function payerFor(asset: PayAsset): Payer {
  const env = (name: string) => process.env[name]?.trim();
  if (asset.chain === "Solana") {
    const key = env("AGENT_SOLANA_KEY");
    if (!key) throw new Error("Paying from Solana needs AGENT_SOLANA_KEY.");
    return new SolanaPayer(
      new SolanaWallet(key, env("AGENT_SOLANA_RPC") ?? "https://api.mainnet-beta.solana.com"),
    );
  }
  if (EVM[asset.chain]) {
    const key = env("AGENT_EVM_PAY_KEY");
    if (!key) throw new Error(`Paying from ${asset.chain} needs AGENT_EVM_PAY_KEY.`);
    return new EvmPayer(asset.chain, key as `0x${string}`);
  }
  if (asset.chain === "NEAR") {
    const id = env("AGENT_NEAR_ACCOUNT_ID");
    const key = env("AGENT_NEAR_KEY");
    if (!id || !key) throw new Error("Paying from NEAR needs AGENT_NEAR_ACCOUNT_ID and AGENT_NEAR_KEY.");
    return new NearPayer(id, key);
  }
  throw new Error(
    `The agent cannot pay from ${asset.chain} live yet (it can quote it in a dry run). Live chains: ${Object.keys(LIVE_CHAINS).join(", ")}.`,
  );
}
