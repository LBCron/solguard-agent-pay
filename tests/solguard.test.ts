import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  OWNER_PAYOUT_WALLET,
  SOLGUARD_PROGRAM_ID,
  USDG_MAINNET_MINT,
  USDC_MAINNET_MINT,
  formatTokenUnits,
  toTokenBaseUnits,
  ROLLING_WINDOW_SECONDS,
} from "../src/sdk/constants";
import {
  anchorDiscriminator,
  deriveAgentVaultPda,
  deriveMilestoneEscrowPda,
  deriveX402ReceiptPda,
} from "../src/sdk/pda";
import { PolicyEngine } from "../src/sdk/policy";
import { X402Protocol } from "../src/sdk/x402";
import { EscrowStatus, MilestoneEscrowEngine } from "../src/sdk/escrow";
import { SolGuardClient } from "../src/sdk/client";

describe("SolGuard AgentPay — Comprehensive Protocol & SDK Suite", () => {
  it("verifies canonical owner Solana wallet and stablecoin mint constants", () => {
    assert.equal(
      OWNER_PAYOUT_WALLET.toBase58(),
      "32647Bri8KhJQE11x26iF7fpae9nouCJSZ8Y2VPpq5yM"
    );
    assert.equal(
      USDG_MAINNET_MINT.toBase58(),
      "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH"
    );
    assert.equal(
      USDC_MAINNET_MINT.toBase58(),
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    );
    assert.equal(toTokenBaseUnits("200"), 200_000_000n);
    assert.equal(toTokenBaseUnits("12.5"), 12_500_000n);
    assert.equal(formatTokenUnits(200_000_000n, "USDG"), "200.00 USDG");
    assert.equal(formatTokenUnits(12_500_000n, "USDG"), "12.5 USDG");
  });

  it("derives deterministic AgentVault, MilestoneEscrow, and X402Receipt PDAs", () => {
    const [vaultPda1, bump1] = deriveAgentVaultPda(OWNER_PAYOUT_WALLET, 1n);
    const [vaultPda2, bump2] = deriveAgentVaultPda(OWNER_PAYOUT_WALLET, 1n);
    const [vaultPdaOther] = deriveAgentVaultPda(OWNER_PAYOUT_WALLET, 2n);

    assert.equal(vaultPda1.toBase58(), vaultPda2.toBase58());
    assert.equal(bump1, bump2);
    assert.notEqual(vaultPda1.toBase58(), vaultPdaOther.toBase58());

    const [escrowPda] = deriveMilestoneEscrowPda(OWNER_PAYOUT_WALLET, 99n);
    const [receiptPda] = deriveX402ReceiptPda(vaultPda1, 1001n);
    assert.ok(PublicKey.isOnCurve(escrowPda.toBytes()) === false);
    assert.ok(PublicKey.isOnCurve(receiptPda.toBytes()) === false);
  });

  it("enforces per-transaction cap, 24h rolling window cap, allowlist, and expiry in PolicyEngine", () => {
    const sessionDelegate = Keypair.generate().publicKey;
    const allowedMerchant = Keypair.generate().publicKey;
    const unauthorizedMerchant = Keypair.generate().publicKey;
    const [vaultPda, bump] = deriveAgentVaultPda(OWNER_PAYOUT_WALLET, 7n);
    const startTs = 1_760_000_000;

    const vault = PolicyEngine.createVaultState({
      vaultAddress: vaultPda,
      owner: OWNER_PAYOUT_WALLET,
      tokenMint: USDG_MAINNET_MINT,
      vaultId: 7n,
      sessionDelegate,
      maxPerTx: toTokenBaseUnits(50),
      dailySpendCap: toTokenBaseUnits(120),
      sessionExpiryTs: startTs + 86_400,
      allowedRecipients: [allowedMerchant],
      bump,
      nowTs: startTs,
    });

    // 1. Valid 40 USDG settlement
    const res1 = PolicyEngine.recordSettlement(vault, {
      signer: sessionDelegate,
      recipient: allowedMerchant,
      amount: toTokenBaseUnits(40),
      nowTs: startTs + 10,
    });
    assert.equal(res1.allowed, true);
    assert.equal(res1.code, "ALLOWED");
    assert.equal(res1.remainingDailyBudget, toTokenBaseUnits(80));

    // 2. Reject per-tx cap violation (60 USDG > 50 USDG maxPerTx)
    const resPerTx = PolicyEngine.evaluatePayment(vault, {
      signer: sessionDelegate,
      recipient: allowedMerchant,
      amount: toTokenBaseUnits(60),
      nowTs: startTs + 20,
    });
    assert.equal(resPerTx.allowed, false);
    assert.equal(resPerTx.code, "EXCEEDS_PER_TX_CAP");

    // 3. Reject non-allowlisted recipient
    const resAllowlist = PolicyEngine.evaluatePayment(vault, {
      signer: sessionDelegate,
      recipient: unauthorizedMerchant,
      amount: toTokenBaseUnits(10),
      nowTs: startTs + 30,
    });
    assert.equal(resAllowlist.allowed, false);
    assert.equal(resAllowlist.code, "RECIPIENT_NOT_ALLOWLISTED");

    // 4. Valid second settlement (50 USDG -> total 90/120 USDG)
    const res2 = PolicyEngine.recordSettlement(vault, {
      signer: sessionDelegate,
      recipient: allowedMerchant,
      amount: toTokenBaseUnits(50),
      nowTs: startTs + 40,
    });
    assert.equal(res2.allowed, true);
    assert.equal(res2.remainingDailyBudget, toTokenBaseUnits(30));

    // 5. Reject daily cap violation (40 USDG when only 30 USDG remaining in 24h window)
    const resDailyCap = PolicyEngine.evaluatePayment(vault, {
      signer: sessionDelegate,
      recipient: allowedMerchant,
      amount: toTokenBaseUnits(40),
      nowTs: startTs + 50,
    });
    assert.equal(resDailyCap.allowed, false);
    assert.equal(resDailyCap.code, "EXCEEDS_DAILY_SPEND_CAP");

    // 6. Rolling 24h window resets after ROLLING_WINDOW_SECONDS (provided session key hasn't expired)
    vault.sessionExpiryTs = startTs + 2 * ROLLING_WINDOW_SECONDS;
    const resNextDay = PolicyEngine.recordSettlement(vault, {
      signer: sessionDelegate,
      recipient: allowedMerchant,
      amount: toTokenBaseUnits(45),
      nowTs: startTs + ROLLING_WINDOW_SECONDS + 100,
    });
    assert.equal(resNextDay.allowed, true);
    assert.equal(resNextDay.remainingDailyBudget, toTokenBaseUnits(75));

    // 7. Reject expired session key
    const resExpired = PolicyEngine.evaluatePayment(vault, {
      signer: sessionDelegate,
      recipient: allowedMerchant,
      amount: toTokenBaseUnits(5),
      nowTs: vault.sessionExpiryTs + 1,
    });
    assert.equal(resExpired.allowed, false);
    assert.equal(resExpired.code, "SESSION_KEY_EXPIRED");

    // 8. Owner can revoke session key and pause vault
    PolicyEngine.revokeSessionKey(vault, OWNER_PAYOUT_WALLET, true);
    assert.equal(vault.paused, true);
    const resPaused = PolicyEngine.evaluatePayment(vault, {
      signer: OWNER_PAYOUT_WALLET,
      recipient: allowedMerchant,
      amount: toTokenBaseUnits(5),
      nowTs: startTs + 100,
    });
    assert.equal(resPaused.allowed, false);
    assert.equal(resPaused.code, "VAULT_PAUSED");
  });

  it("encodes, signs, and verifies x402 HTTP Payment Required proofs with Ed25519", () => {
    const sessionKeypair = Keypair.generate();
    const merchant = Keypair.generate().publicKey;
    const [vaultPda] = deriveAgentVaultPda(OWNER_PAYOUT_WALLET, 1n);
    const nowTs = 1_760_000_500;

    const challenge = {
      version: "x402-solana-v1" as const,
      network: "solana-devnet" as const,
      recipient: merchant.toBase58(),
      tokenMint: USDG_MAINNET_MINT.toBase58(),
      amountBaseUnits: toTokenBaseUnits("15.25").toString(),
      resourceUri: "https://api.solguard.dev/v1/agent-tool",
      invoiceNonce: "777",
      expiresAt: nowTs + 300,
    };

    const header = X402Protocol.encodeChallengeHeader(challenge);
    const decoded = X402Protocol.decodeChallengeHeader(header);
    assert.deepEqual(decoded, challenge);

    const proof = X402Protocol.createPaymentProof({
      vaultAddress: vaultPda,
      sessionKeypair,
      challenge: decoded,
      nowTs,
    });

    const verification = X402Protocol.verifyPaymentProof(proof, decoded);
    assert.equal(verification.valid, true);

    // Tamper with amount and verify rejection
    const tamperedProof = { ...proof, amountBaseUnits: "100" };
    const tamperedCheck = X402Protocol.verifyPaymentProof(tamperedProof, decoded);
    assert.equal(tamperedCheck.valid, false);
  });

  it("manages MilestoneEscrow creation, SHA-256 deliverable verification, and release", () => {
    const provider = Keypair.generate().publicKey;
    const verifier = Keypair.generate().publicKey;
    const [escrowPda, bump] = deriveMilestoneEscrowPda(OWNER_PAYOUT_WALLET, 55n);
    const nowTs = 1_760_000_000;

    const expectedHash = MilestoneEscrowEngine.hashDeliverable(
      "milestone-1:production-solana-mvp"
    );
    const wrongHash = MilestoneEscrowEngine.hashDeliverable("incomplete-build");

    const escrow = MilestoneEscrowEngine.createEscrow({
      escrowAddress: escrowPda,
      client: OWNER_PAYOUT_WALLET,
      provider,
      verifier,
      tokenMint: USDG_MAINNET_MINT,
      escrowId: 55n,
      amount: toTokenBaseUnits(100),
      expectedDeliverableHash: expectedHash,
      deadlineTs: nowTs + 86_400,
      bump,
      nowTs,
    });

    assert.equal(escrow.status, EscrowStatus.Funded);

    // Reject wrong deliverable hash
    assert.throws(() => {
      MilestoneEscrowEngine.releaseEscrow(escrow, {
        authority: verifier,
        actualDeliverableHash: wrongHash,
      });
    }, /DeliverableHashMismatch/);

    // Release with valid deliverable hash
    const released = MilestoneEscrowEngine.releaseEscrow(escrow, {
      authority: verifier,
      actualDeliverableHash: expectedHash,
    });
    assert.equal(released.status, EscrowStatus.Released);
    assert.equal(
      released.submittedDeliverableHashHex,
      expectedHash.toString("hex")
    );
  });

  it("serializes Anchor instructions via SolGuardClient with valid 8-byte discriminators", () => {
    const client = new SolGuardClient("https://api.devnet.solana.com");
    const delegate = Keypair.generate().publicKey;
    const merchant = Keypair.generate().publicKey;

    const { instruction: initIx, vaultPda } = client.buildInitializeAgentVaultIx({
      owner: OWNER_PAYOUT_WALLET,
      tokenMint: USDG_MAINNET_MINT,
      vaultId: 1n,
      sessionDelegate: delegate,
      maxPerTx: toTokenBaseUnits(25),
      dailySpendCap: toTokenBaseUnits(200),
      sessionExpiryTs: 1_800_000_000n,
      allowedRecipients: [merchant],
    });

    assert.equal(initIx.programId.toBase58(), SOLGUARD_PROGRAM_ID.toBase58());
    assert.deepEqual(
      initIx.data.subarray(0, 8),
      anchorDiscriminator("initialize_agent_vault")
    );

    const settleIx = client.buildSettleX402PaymentIx({
      authority: delegate,
      agentVault: vaultPda,
      vaultTokenAccount: Keypair.generate().publicKey,
      recipientTokenAccount: Keypair.generate().publicKey,
      amount: toTokenBaseUnits(10),
      resourceHash: X402Protocol.computeResourceHash("https://example.com", 1n),
      invoiceNonce: 1n,
    });
    assert.deepEqual(
      settleIx.data.subarray(0, 8),
      anchorDiscriminator("settle_x402_payment")
    );
  });
});
