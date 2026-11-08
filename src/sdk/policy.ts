import { PublicKey } from "@solana/web3.js";
import { MAX_ALLOWED_RECIPIENTS, ROLLING_WINDOW_SECONDS } from "./constants";

export interface AgentVaultState {
  vaultAddress: PublicKey;
  owner: PublicKey;
  tokenMint: PublicKey;
  vaultId: bigint;
  sessionDelegate: PublicKey;
  maxPerTx: bigint;
  dailySpendCap: bigint;
  currentWindowSpend: bigint;
  windowStartTs: number;
  sessionExpiryTs: number;
  paused: boolean;
  totalSettledVolume: bigint;
  settlementCount: bigint;
  allowedRecipients: PublicKey[];
  bump: number;
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  code:
    | "ALLOWED"
    | "VAULT_PAUSED"
    | "ZERO_AMOUNT"
    | "UNAUTHORIZED_SIGNER"
    | "SESSION_KEY_EXPIRED"
    | "RECIPIENT_NOT_ALLOWLISTED"
    | "EXCEEDS_PER_TX_CAP"
    | "EXCEEDS_DAILY_SPEND_CAP";
  reason: string;
  projectedWindowSpend: bigint;
  remainingDailyBudget: bigint;
}

/**
 * Deterministic TypeScript mirror of the on-chain SolGuard AgentVault guardrail engine.
 * Evaluates whether an autonomous AI agent payment satisfies all vault constraints before
 * broadcasting a Solana transaction or signing an x402 payment header.
 */
export class PolicyEngine {
  /**
   * Initializes a new in-memory AgentVault state representation.
   */
  static createVaultState(params: {
    vaultAddress: PublicKey;
    owner: PublicKey;
    tokenMint: PublicKey;
    vaultId: bigint;
    sessionDelegate: PublicKey;
    maxPerTx: bigint;
    dailySpendCap: bigint;
    sessionExpiryTs: number;
    allowedRecipients: PublicKey[];
    bump: number;
    nowTs?: number;
  }): AgentVaultState {
    if (params.maxPerTx <= 0n) {
      throw new Error("InvalidGuardrailLimit: maxPerTx must be > 0");
    }
    if (params.dailySpendCap < params.maxPerTx) {
      throw new Error("DailyCapBelowPerTxLimit: dailySpendCap must be >= maxPerTx");
    }
    if (params.allowedRecipients.length > MAX_ALLOWED_RECIPIENTS) {
      throw new Error(
        `TooManyAllowedRecipients: max ${MAX_ALLOWED_RECIPIENTS} allowed`
      );
    }
    const nowTs = params.nowTs ?? Math.floor(Date.now() / 1000);
    if (params.sessionExpiryTs <= nowTs) {
      throw new Error("SessionKeyExpired: sessionExpiryTs must be in the future");
    }

    return {
      vaultAddress: params.vaultAddress,
      owner: params.owner,
      tokenMint: params.tokenMint,
      vaultId: params.vaultId,
      sessionDelegate: params.sessionDelegate,
      maxPerTx: params.maxPerTx,
      dailySpendCap: params.dailySpendCap,
      currentWindowSpend: 0n,
      windowStartTs: nowTs,
      sessionExpiryTs: params.sessionExpiryTs,
      paused: false,
      totalSettledVolume: 0n,
      settlementCount: 0n,
      allowedRecipients: [...params.allowedRecipients],
      bump: params.bump,
    };
  }

  /**
   * Evaluates a proposed payment against all on-chain SolGuard guardrails without mutating state.
   */
  static evaluatePayment(
    vault: AgentVaultState,
    params: {
      signer: PublicKey;
      recipient: PublicKey;
      amount: bigint;
      nowTs?: number;
    }
  ): PolicyEvaluationResult {
    const nowTs = params.nowTs ?? Math.floor(Date.now() / 1000);

    // Compute active window spend (reset if 24h elapsed)
    const windowExpired = nowTs - vault.windowStartTs >= ROLLING_WINDOW_SECONDS;
    const baseWindowSpend = windowExpired ? 0n : vault.currentWindowSpend;
    const remainingBefore = vault.dailySpendCap - baseWindowSpend;

    if (vault.paused) {
      return {
        allowed: false,
        code: "VAULT_PAUSED",
        reason: "Agent vault is currently paused by the owner",
        projectedWindowSpend: baseWindowSpend,
        remainingDailyBudget: remainingBefore,
      };
    }

    if (params.amount <= 0n) {
      return {
        allowed: false,
        code: "ZERO_AMOUNT",
        reason: "Settlement amount must be greater than zero",
        projectedWindowSpend: baseWindowSpend,
        remainingDailyBudget: remainingBefore,
      };
    }

    const isOwner = params.signer.equals(vault.owner);
    const isDelegate =
      !vault.sessionDelegate.equals(PublicKey.default) &&
      params.signer.equals(vault.sessionDelegate);

    if (!isOwner && !isDelegate) {
      return {
        allowed: false,
        code: "UNAUTHORIZED_SIGNER",
        reason: "Signer is neither the vault owner nor the active session delegate",
        projectedWindowSpend: baseWindowSpend,
        remainingDailyBudget: remainingBefore,
      };
    }

    if (isDelegate && !isOwner && nowTs > vault.sessionExpiryTs) {
      return {
        allowed: false,
        code: "SESSION_KEY_EXPIRED",
        reason: `Session key expired at unix timestamp ${vault.sessionExpiryTs} (now: ${nowTs})`,
        projectedWindowSpend: baseWindowSpend,
        remainingDailyBudget: remainingBefore,
      };
    }

    if (vault.allowedRecipients.length > 0) {
      const inAllowlist = vault.allowedRecipients.some((r) =>
        r.equals(params.recipient)
      );
      if (!inAllowlist) {
        return {
          allowed: false,
          code: "RECIPIENT_NOT_ALLOWLISTED",
          reason: `Recipient ${params.recipient.toBase58()} is not in the vault allowlist`,
          projectedWindowSpend: baseWindowSpend,
          remainingDailyBudget: remainingBefore,
        };
      }
    }

    if (params.amount > vault.maxPerTx) {
      return {
        allowed: false,
        code: "EXCEEDS_PER_TX_CAP",
        reason: `Amount ${params.amount} exceeds per-transaction cap of ${vault.maxPerTx}`,
        projectedWindowSpend: baseWindowSpend,
        remainingDailyBudget: remainingBefore,
      };
    }

    const projectedSpend = baseWindowSpend + params.amount;
    if (projectedSpend > vault.dailySpendCap) {
      return {
        allowed: false,
        code: "EXCEEDS_DAILY_SPEND_CAP",
        reason: `Projected 24h spend ${projectedSpend} exceeds daily cap of ${vault.dailySpendCap}`,
        projectedWindowSpend: projectedSpend,
        remainingDailyBudget: remainingBefore,
      };
    }

    return {
      allowed: true,
      code: "ALLOWED",
      reason: "Payment satisfies all SolGuard on-chain guardrails",
      projectedWindowSpend: projectedSpend,
      remainingDailyBudget: vault.dailySpendCap - projectedSpend,
    };
  }

  /**
   * Applies a validated settlement to the vault state (updating rolling window spend and counters).
   */
  static recordSettlement(
    vault: AgentVaultState,
    params: {
      signer: PublicKey;
      recipient: PublicKey;
      amount: bigint;
      nowTs?: number;
    }
  ): PolicyEvaluationResult {
    const nowTs = params.nowTs ?? Math.floor(Date.now() / 1000);
    const evalResult = PolicyEngine.evaluatePayment(vault, { ...params, nowTs });
    if (!evalResult.allowed) {
      return evalResult;
    }

    if (nowTs - vault.windowStartTs >= ROLLING_WINDOW_SECONDS) {
      vault.windowStartTs = nowTs;
      vault.currentWindowSpend = 0n;
    }
    vault.currentWindowSpend += params.amount;
    vault.totalSettledVolume += params.amount;
    vault.settlementCount += 1n;

    return evalResult;
  }

  /**
   * Revokes the active session key and optionally pauses the vault.
   */
  static revokeSessionKey(
    vault: AgentVaultState,
    caller: PublicKey,
    pauseVault: boolean
  ): void {
    if (!caller.equals(vault.owner)) {
      throw new Error("UnauthorizedSigner: only the vault owner can revoke session keys");
    }
    vault.sessionDelegate = PublicKey.default;
    vault.sessionExpiryTs = 0;
    vault.paused = pauseVault;
  }
}
