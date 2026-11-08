import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import { SOLGUARD_PROGRAM_ID } from "./constants";

/**
 * Computes the 8-byte Anchor instruction discriminator for `global:<ix_name>`.
 */
export function anchorDiscriminator(ixName: string): Buffer {
  return createHash("sha256")
    .update(`global:${ixName}`)
    .digest()
    .subarray(0, 8);
}

/**
 * Encodes a uint64 (bigint) as an 8-byte little-endian Buffer.
 */
export function u64ToLeBuffer(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

/**
 * Encodes an int64 (bigint) as an 8-byte little-endian Buffer.
 */
export function i64ToLeBuffer(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value, 0);
  return buf;
}

/**
 * Derives the deterministic AgentVault PDA (`["agent_vault", owner, vault_id_le]`).
 */
export function deriveAgentVaultPda(
  owner: PublicKey,
  vaultId: bigint,
  programId: PublicKey = SOLGUARD_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent_vault"), owner.toBuffer(), u64ToLeBuffer(vaultId)],
    programId
  );
}

/**
 * Derives the deterministic MilestoneEscrow PDA (`["milestone_escrow", client, escrow_id_le]`).
 */
export function deriveMilestoneEscrowPda(
  client: PublicKey,
  escrowId: bigint,
  programId: PublicKey = SOLGUARD_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("milestone_escrow"), client.toBuffer(), u64ToLeBuffer(escrowId)],
    programId
  );
}

/**
 * Derives a deterministic x402 settlement receipt PDA (`["x402_receipt", vault, invoice_nonce_le]`).
 */
export function deriveX402ReceiptPda(
  vault: PublicKey,
  invoiceNonce: bigint,
  programId: PublicKey = SOLGUARD_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("x402_receipt"), vault.toBuffer(), u64ToLeBuffer(invoiceNonce)],
    programId
  );
}
