import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  MAX_ALLOWED_RECIPIENTS,
  SOLGUARD_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "./constants";
import {
  anchorDiscriminator,
  deriveAgentVaultPda,
  deriveMilestoneEscrowPda,
  i64ToLeBuffer,
  u64ToLeBuffer,
} from "./pda";

/**
 * High-level TypeScript SDK client for constructing SolGuard AgentPay Anchor instructions
 * and querying Solana cluster telemetry.
 */
export class SolGuardClient {
  public readonly connection: Connection;
  public readonly programId: PublicKey;

  constructor(
    rpcEndpoint = "https://api.devnet.solana.com",
    programId: PublicKey = SOLGUARD_PROGRAM_ID
  ) {
    this.connection = new Connection(rpcEndpoint, "confirmed");
    this.programId = programId;
  }

  /**
   * Builds the `initialize_agent_vault` Anchor instruction.
   */
  buildInitializeAgentVaultIx(params: {
    owner: PublicKey;
    tokenMint: PublicKey;
    vaultId: bigint;
    sessionDelegate: PublicKey;
    maxPerTx: bigint;
    dailySpendCap: bigint;
    sessionExpiryTs: bigint;
    allowedRecipients: PublicKey[];
  }): { instruction: TransactionInstruction; vaultPda: PublicKey; bump: number } {
    if (params.allowedRecipients.length > MAX_ALLOWED_RECIPIENTS) {
      throw new Error(
        `Allowed recipients cannot exceed ${MAX_ALLOWED_RECIPIENTS}`
      );
    }

    const [vaultPda, bump] = deriveAgentVaultPda(
      params.owner,
      params.vaultId,
      this.programId
    );

    const vecLenBuf = Buffer.alloc(4);
    vecLenBuf.writeUInt32LE(params.allowedRecipients.length, 0);

    const data = Buffer.concat([
      anchorDiscriminator("initialize_agent_vault"),
      u64ToLeBuffer(params.vaultId),
      params.sessionDelegate.toBuffer(),
      u64ToLeBuffer(params.maxPerTx),
      u64ToLeBuffer(params.dailySpendCap),
      i64ToLeBuffer(params.sessionExpiryTs),
      vecLenBuf,
      ...params.allowedRecipients.map((r) => r.toBuffer()),
    ]);

    const instruction = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: params.owner, isSigner: true, isWritable: true },
        { pubkey: params.tokenMint, isSigner: false, isWritable: false },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    return { instruction, vaultPda, bump };
  }

  /**
   * Builds the `settle_x402_payment` Anchor instruction.
   */
  buildSettleX402PaymentIx(params: {
    authority: PublicKey;
    agentVault: PublicKey;
    vaultTokenAccount: PublicKey;
    recipientTokenAccount: PublicKey;
    amount: bigint;
    resourceHash: Buffer;
    invoiceNonce: bigint;
  }): TransactionInstruction {
    if (params.resourceHash.length !== 32) {
      throw new Error("resourceHash must be 32 bytes");
    }

    const data = Buffer.concat([
      anchorDiscriminator("settle_x402_payment"),
      u64ToLeBuffer(params.amount),
      params.resourceHash,
      u64ToLeBuffer(params.invoiceNonce),
    ]);

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: params.authority, isSigner: true, isWritable: false },
        { pubkey: params.agentVault, isSigner: false, isWritable: true },
        { pubkey: params.vaultTokenAccount, isSigner: false, isWritable: true },
        {
          pubkey: params.recipientTokenAccount,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Builds the `create_milestone_escrow` Anchor instruction.
   */
  buildCreateMilestoneEscrowIx(params: {
    client: PublicKey;
    provider: PublicKey;
    verifier: PublicKey;
    tokenMint: PublicKey;
    clientTokenAccount: PublicKey;
    escrowTokenAccount: PublicKey;
    escrowId: bigint;
    amount: bigint;
    expectedDeliverableHash: Buffer;
    deadlineTs: bigint;
  }): {
    instruction: TransactionInstruction;
    escrowPda: PublicKey;
    bump: number;
  } {
    if (params.expectedDeliverableHash.length !== 32) {
      throw new Error("expectedDeliverableHash must be 32 bytes");
    }

    const [escrowPda, bump] = deriveMilestoneEscrowPda(
      params.client,
      params.escrowId,
      this.programId
    );

    const data = Buffer.concat([
      anchorDiscriminator("create_milestone_escrow"),
      u64ToLeBuffer(params.escrowId),
      u64ToLeBuffer(params.amount),
      params.expectedDeliverableHash,
      i64ToLeBuffer(params.deadlineTs),
    ]);

    const instruction = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: params.client, isSigner: true, isWritable: true },
        { pubkey: params.provider, isSigner: false, isWritable: false },
        { pubkey: params.verifier, isSigner: false, isWritable: false },
        { pubkey: params.tokenMint, isSigner: false, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: params.clientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: params.escrowTokenAccount, isSigner: false, isWritable: true },
        { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    return { instruction, escrowPda, bump };
  }

  /**
   * Builds the `release_milestone_escrow` Anchor instruction.
   */
  buildReleaseMilestoneEscrowIx(params: {
    authority: PublicKey;
    milestoneEscrow: PublicKey;
    escrowTokenAccount: PublicKey;
    providerTokenAccount: PublicKey;
    actualDeliverableHash: Buffer;
  }): TransactionInstruction {
    if (params.actualDeliverableHash.length !== 32) {
      throw new Error("actualDeliverableHash must be 32 bytes");
    }

    const data = Buffer.concat([
      anchorDiscriminator("release_milestone_escrow"),
      params.actualDeliverableHash,
    ]);

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: params.authority, isSigner: true, isWritable: false },
        { pubkey: params.milestoneEscrow, isSigner: false, isWritable: true },
        { pubkey: params.escrowTokenAccount, isSigner: false, isWritable: true },
        {
          pubkey: params.providerTokenAccount,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Builds the `revoke_session_key` Anchor instruction.
   */
  buildRevokeSessionKeyIx(params: {
    owner: PublicKey;
    agentVault: PublicKey;
    pauseVault: boolean;
  }): TransactionInstruction {
    const data = Buffer.concat([
      anchorDiscriminator("revoke_session_key"),
      Buffer.from([params.pauseVault ? 1 : 0]),
    ]);

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: params.owner, isSigner: true, isWritable: false },
        { pubkey: params.agentVault, isSigner: false, isWritable: true },
      ],
      data,
    });
  }
}
