import { Logger } from "@nestjs/common";
import { Contract, Interface, JsonRpcProvider, getAddress } from "ethers";

/**
 * Pays for an agent's purchase from the user's own Coinbase Smart Wallet,
 * through a Base spend permission the user signed ("Port66's agent may spend
 * up to $X USDC a day").
 *
 * The spender is a Coinbase CDP server smart account. One user operation
 * runs, atomically: approveWithSignature (first use only), spend (USDC moves
 * from the user's wallet to the spender) and an ERC-20 transfer of exactly
 * that amount on to the NEAR Intents deposit address. If any step fails the
 * whole operation reverts, so the spender never ends up holding a user's
 * money. The daily cap is enforced on chain by Coinbase's SpendPermissionManager
 * (0xf85210B21cC50302F477BA56686d2019dC9b67Ad), whatever Port66's server does.
 *
 * Needs CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET. Gas is paid
 * by the spender smart account in ETH on Base unless CDP_PAYMASTER_URL is set.
 */

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Coinbase's SpendPermissionManager on Base (same as @base-org/account uses). */
export const SPEND_PERMISSION_MANAGER = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad";
export const BASE_CHAIN_ID = 8453;
const OWNER_NAME = "port66-agent-owner";
const SPENDER_NAME = "port66-agent-spender";

/** The signed permission as @base-org/account returns it. */
export interface SignedSpendPermission {
  signature: string;
  chainId?: number;
  permissionHash?: string;
  permission: {
    account: string;
    spender: string;
    token: string;
    allowance: string;
    period: number;
    start: number;
    end: number;
    salt: string;
    extraData: string;
  };
}

export interface PermissionStatus {
  remainingSpend: bigint;
  isActive: boolean;
  isRevoked: boolean;
  isExpired: boolean;
  nextPeriodStart: Date;
}

const PERMISSION_TUPLE =
  "tuple(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)";
const MANAGER = new Interface([
  `function approveWithSignature(${PERMISSION_TUPLE} spendPermission, bytes signature) returns (bool)`,
  `function spend(${PERMISSION_TUPLE} spendPermission, uint160 value)`,
  `function getCurrentPeriod(${PERMISSION_TUPLE} spendPermission) view returns (tuple(uint48 start,uint48 end,uint160 spend))`,
  `function isRevoked(${PERMISSION_TUPLE} spendPermission) view returns (bool)`,
  `function isValid(${PERMISSION_TUPLE} spendPermission) view returns (bool)`,
]);
const ERC20 = new Interface(["function transfer(address to, uint256 amount) returns (bool)"]);

/** The struct as the contract takes it (same conversion as @base-org/account). */
function toArgs(p: SignedSpendPermission) {
  const q = p.permission;
  return {
    account: getAddress(q.account),
    spender: getAddress(q.spender),
    token: getAddress(q.token),
    allowance: BigInt(q.allowance),
    period: q.period,
    start: q.start,
    end: q.end,
    salt: BigInt(q.salt),
    extraData: q.extraData,
  };
}

export class AgentSpender {
  private readonly logger = new Logger(AgentSpender.name);
  private smartAccount: Promise<{ address: string; account: unknown; cdp: any }> | null = null;

  static configured(): boolean {
    return !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET);
  }

  private manager() {
    const provider = new JsonRpcProvider(process.env.BASE_RPC_URL || "https://mainnet.base.org", BASE_CHAIN_ID, { staticNetwork: true });
    return new Contract(SPEND_PERMISSION_MANAGER, MANAGER, provider);
  }

  /** The CDP smart account that holds the spend permissions (created once). */
  private account() {
    this.smartAccount ??= (async () => {
      if (!AgentSpender.configured())
        throw new Error("Automatic buying is not set up: CDP_WALLET_SECRET is missing.");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { CdpClient } = require("@coinbase/cdp-sdk");
      const cdp = new CdpClient();
      const owner = await cdp.evm.getOrCreateAccount({ name: OWNER_NAME });
      const account = await cdp.evm.getOrCreateSmartAccount({ name: SPENDER_NAME, owner });
      this.logger.log(`Agent spender smart account: ${account.address}`);
      return { address: account.address as string, account, cdp };
    })().catch((error) => {
      this.smartAccount = null;
      throw error;
    });
    return this.smartAccount;
  }

  async address(): Promise<string> {
    return (await this.account()).address;
  }

  /** USDC (base units) the shopper's wallet holds on Base right now. */
  async balance(account: string): Promise<bigint> {
    const provider = new JsonRpcProvider(process.env.BASE_RPC_URL || "https://mainnet.base.org", BASE_CHAIN_ID, { staticNetwork: true });
    const usdc = new Contract(USDC_BASE, ["function balanceOf(address) view returns (uint256)"], provider);
    return BigInt(await usdc.balanceOf(getAddress(account)));
  }

  /** Same reads as @base-org/account's getPermissionStatus. */
  async status(permission: SignedSpendPermission): Promise<PermissionStatus & { isApprovedOnchain: boolean }> {
    const args = toArgs(permission);
    const now = Math.floor(Date.now() / 1000);
    const m = this.manager();
    const [revoked, valid] = await Promise.all([m.isRevoked(args) as Promise<boolean>, m.isValid(args) as Promise<boolean>]);
    const expired = now >= args.end;
    const started = now >= args.start;
    let spent = 0n;
    let periodEnd = args.start + args.period;
    if (started && !expired) {
      const period = (await m.getCurrentPeriod(args)) as { end: bigint; spend: bigint };
      spent = BigInt(period.spend);
      periodEnd = Number(period.end) + 1;
    }
    return {
      remainingSpend: started && !expired ? args.allowance - spent : 0n,
      isActive: started && !expired && !revoked,
      isRevoked: revoked,
      isExpired: expired,
      isApprovedOnchain: valid,
      nextPeriodStart: new Date(periodEnd * 1000),
    };
  }

  /**
   * Moves `amount` USDC base units from the user's wallet to `recipient` in
   * one atomic user operation. Returns the Base transaction hash.
   */
  async pay(permission: SignedSpendPermission, amount: bigint, recipient: string): Promise<string> {
    const { account, cdp } = await this.account();
    if (amount <= 0n) throw new Error("Nothing to pay.");
    const status = await this.status(permission);
    if (status.isRevoked || !status.isActive) throw new Error("The spend permission is not active.");
    if (amount > status.remainingSpend) throw new Error("The amount is above today's remaining allowance.");
    const args = toArgs(permission);
    // Same three calls as @base-org/account's prepareSpendCallData with a
    // recipient: approve (first use), spend to us, forward to the recipient.
    // They run as one user operation, so the forward cannot be skipped.
    const calls = [
      ...(status.isApprovedOnchain
        ? []
        : [{ to: SPEND_PERMISSION_MANAGER, data: MANAGER.encodeFunctionData("approveWithSignature", [args, permission.signature]), value: 0n }]),
      { to: SPEND_PERMISSION_MANAGER, data: MANAGER.encodeFunctionData("spend", [args, amount]), value: 0n },
      { to: getAddress(permission.permission.token), data: ERC20.encodeFunctionData("transfer", [getAddress(recipient), amount]), value: 0n },
    ];
    const op = await cdp.evm.sendUserOperation({
      smartAccount: account,
      network: "base",
      calls,
      ...(process.env.CDP_PAYMASTER_URL ? { paymasterUrl: process.env.CDP_PAYMASTER_URL } : {}),
    });
    const done = await cdp.evm.waitForUserOperation({
      smartAccountAddress: (account as { address: string }).address,
      userOpHash: op.userOpHash,
    });
    if (done.status !== "complete" || !done.transactionHash)
      throw new Error(`The payment did not complete (${done.status}).`);
    return done.transactionHash as string;
  }
}

/**
 * Checks a permission the browser hands us before we store it: it must name
 * our spender, USDC on Base, and a sane daily allowance.
 */
export function validatePermission(
  p: SignedSpendPermission,
  spender: string,
  maxDailyUsd: number,
): string | null {
  const q = p?.permission;
  if (!p?.signature || !q) return "The wallet did not return a signed permission.";
  if (q.spender?.toLowerCase() !== spender.toLowerCase()) return "That permission is for a different spender.";
  if (q.token?.toLowerCase() !== USDC_BASE.toLowerCase()) return "That permission is not for USDC on Base.";
  if (p.chainId !== undefined && Number(p.chainId) !== BASE_CHAIN_ID) return "That permission is not on Base.";
  if (Number(q.period) !== 86_400) return "The permission must reset daily.";
  const allowanceUsd = Number(BigInt(q.allowance)) / 1e6;
  if (!(allowanceUsd > 0) || allowanceUsd > maxDailyUsd + 0.01)
    return `The daily allowance must be between $0 and your $${maxDailyUsd} daily limit.`;
  if (Number(q.end) * 1000 < Date.now()) return "That permission has already expired.";
  return null;
}
