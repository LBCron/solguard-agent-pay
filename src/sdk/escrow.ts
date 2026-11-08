import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

export enum EscrowStatus {
  Funded = 1,
  Released = 2,
  Refunded = 3,
}

export interface MilestoneEscrowState {
  escrowAddress: PublicKey;
  client: PublicKey;
  provider: PublicKey;
  verifier: PublicKey;
  tokenMint: PublicKey;
  escrowId: bigint;
  amount: bigint;
  expectedDeliverableHashHex: string;
  submittedDeliverableHashHex: string | null;
  deadlineTs: number;
  status: EscrowStatus;
  bump: number;
}

/**
 * Manages Milestone Escrow state transitions and cryptographic SHA-256 deliverable verification.
 */
export class MilestoneEscrowEngine {
  /**
   * Computes the 32-byte SHA-256 hash of a deliverable artifact or JSON specification.
   */
  static hashDeliverable(artifactContent: string | Buffer): Buffer {
    return createHash("sha256").update(artifactContent).digest();
  }

  /**
   * Creates a new Funded MilestoneEscrow state.
   */
  static createEscrow(params: {
    escrowAddress: PublicKey;
    client: PublicKey;
    provider: PublicKey;
    verifier: PublicKey;
    tokenMint: PublicKey;
    escrowId: bigint;
    amount: bigint;
    expectedDeliverableHash: Buffer;
    deadlineTs: number;
    bump: number;
    nowTs?: number;
  }): MilestoneEscrowState {
    if (params.amount <= 0n) {
      throw new Error("ZeroSettlementAmount: escrow amount must be > 0");
    }
    const nowTs = params.nowTs ?? Math.floor(Date.now() / 1000);
    if (params.deadlineTs <= nowTs) {
      throw new Error("InvalidDeadline: deadlineTs must be in the future");
    }
    if (params.expectedDeliverableHash.length !== 32) {
      throw new Error("expectedDeliverableHash must be exactly 32 bytes (SHA-256)");
    }

    return {
      escrowAddress: params.escrowAddress,
      client: params.client,
      provider: params.provider,
      verifier: params.verifier,
      tokenMint: params.tokenMint,
      escrowId: params.escrowId,
      amount: params.amount,
      expectedDeliverableHashHex: params.expectedDeliverableHash.toString("hex"),
      submittedDeliverableHashHex: null,
      deadlineTs: params.deadlineTs,
      status: EscrowStatus.Funded,
      bump: params.bump,
    };
  }

  /**
   * Verifies the submitted deliverable hash and transitions the escrow to Released.
   */
  static releaseEscrow(
    escrow: MilestoneEscrowState,
    params: {
      authority: PublicKey;
      actualDeliverableHash: Buffer;
    }
  ): MilestoneEscrowState {
    if (escrow.status !== EscrowStatus.Funded) {
      throw new Error("EscrowNotActive: escrow is not in Funded state");
    }
    if (
      !params.authority.equals(escrow.client) &&
      !params.authority.equals(escrow.verifier)
    ) {
      throw new Error(
        "UnauthorizedSigner: only client or verifier can release milestone escrow"
      );
    }

    const actualHex = params.actualDeliverableHash.toString("hex");
    if (actualHex !== escrow.expectedDeliverableHashHex) {
      throw new Error(
        `DeliverableHashMismatch: expected ${escrow.expectedDeliverableHashHex}, got ${actualHex}`
      );
    }

    escrow.submittedDeliverableHashHex = actualHex;
    escrow.status = EscrowStatus.Released;
    return escrow;
  }
}
