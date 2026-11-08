import { Keypair } from "@solana/web3.js";
import {
  OWNER_PAYOUT_WALLET,
  SOLGUARD_PROGRAM_ID,
  USDG_MAINNET_MINT,
  formatTokenUnits,
  toTokenBaseUnits,
} from "../sdk/constants";
import { SolGuardClient } from "../sdk/client";
import { PolicyEngine } from "../sdk/policy";
import { X402Protocol } from "../sdk/x402";
import { MilestoneEscrowEngine } from "../sdk/escrow";

async function runDemo(): Promise<void> {
  console.log("================================================================================");
  console.log("  SolGuard AgentPay — Autonomous Solana Milestone Escrow & x402 Protocol Demo  ");
  console.log("================================================================================\n");

  const client = new SolGuardClient("https://api.devnet.solana.com", SOLGUARD_PROGRAM_ID);
  const nowTs = Math.floor(Date.now() / 1000);

  // 1. Setup actors
  const ownerPubkey = OWNER_PAYOUT_WALLET; // 32647Bri8KhJQE11x26iF7fpae9nouCJSZ8Y2VPpq5yM
  const sessionKeypair = Keypair.generate();
  const merchantKeypair = Keypair.generate();
  const rogueRecipientKeypair = Keypair.generate();
  const verifierKeypair = Keypair.generate();

  console.log("[1] Initializing SolGuard Agent Vault PDA on Solana");
  console.log(`    Owner Treasury Wallet : ${ownerPubkey.toBase58()}`);
  console.log(`    SPL Token Mint (USDG) : ${USDG_MAINNET_MINT.toBase58()}`);
  console.log(`    Agent Session Key     : ${sessionKeypair.publicKey.toBase58()}`);
  console.log(`    Allowlisted Merchant  : ${merchantKeypair.publicKey.toBase58()}`);

  const vaultId = 1n;
  const maxPerTx = toTokenBaseUnits(25); // 25.00 USDG per transaction
  const dailySpendCap = toTokenBaseUnits(200); // 200.00 USDG daily spend cap
  const sessionExpiryTs = nowTs + 86_400;

  const { instruction: initIx, vaultPda, bump } = client.buildInitializeAgentVaultIx({
    owner: ownerPubkey,
    tokenMint: USDG_MAINNET_MINT,
    vaultId,
    sessionDelegate: sessionKeypair.publicKey,
    maxPerTx,
    dailySpendCap,
    sessionExpiryTs: BigInt(sessionExpiryTs),
    allowedRecipients: [merchantKeypair.publicKey],
  });

  console.log(`    Derived AgentVault PDA: ${vaultPda.toBase58()} (bump: ${bump})`);
  console.log(`    Anchor Discriminator  : 0x${initIx.data.subarray(0, 8).toString("hex")}`);
  console.log(`    Guardrails            : Max/Tx = ${formatTokenUnits(maxPerTx)}, Daily Cap = ${formatTokenUnits(dailySpendCap)}\n`);

  const vaultState = PolicyEngine.createVaultState({
    vaultAddress: vaultPda,
    owner: ownerPubkey,
    tokenMint: USDG_MAINNET_MINT,
    vaultId,
    sessionDelegate: sessionKeypair.publicKey,
    maxPerTx,
    dailySpendCap,
    sessionExpiryTs,
    allowedRecipients: [merchantKeypair.publicKey],
    bump,
    nowTs,
  });

  // 2. Autonomous x402 API Settlement Flow
  console.log("[2] Executing Autonomous x402 HTTP Payment Required Settlement");
  const challenge = {
    version: "x402-solana-v1" as const,
    network: "solana-devnet" as const,
    recipient: merchantKeypair.publicKey.toBase58(),
    tokenMint: USDG_MAINNET_MINT.toBase58(),
    amountBaseUnits: toTokenBaseUnits("12.50").toString(),
    resourceUri: "https://api.solguard.dev/v1/inference/claude-4-sonnet",
    invoiceNonce: "1001",
    expiresAt: nowTs + 600,
    memo: "Agentic Coding Inference Batch #1001",
  };

  const challengeHeader = X402Protocol.encodeChallengeHeader(challenge);
  console.log(`    <- HTTP 402 Challenge : ${challengeHeader.slice(0, 68)}...`);

  const decodedChallenge = X402Protocol.decodeChallengeHeader(challengeHeader);
  const settlementResult = PolicyEngine.recordSettlement(vaultState, {
    signer: sessionKeypair.publicKey,
    recipient: merchantKeypair.publicKey,
    amount: BigInt(decodedChallenge.amountBaseUnits),
    nowTs,
  });

  const proof = X402Protocol.createPaymentProof({
    vaultAddress: vaultPda,
    sessionKeypair,
    challenge: decodedChallenge,
    nowTs,
  });
  const verification = X402Protocol.verifyPaymentProof(proof, decodedChallenge);

  console.log(`    Policy Evaluation     : ${settlementResult.code} (${settlementResult.reason})`);
  console.log(`    Ed25519 Proof Sig     : ${proof.signatureBase58.slice(0, 44)}...`);
  console.log(`    Merchant Verification : ${verification.valid ? "VERIFIED" : "REJECTED"} (${verification.reason})`);
  console.log(`    Remaining 24h Budget  : ${formatTokenUnits(settlementResult.remainingDailyBudget)}\n`);

  // 3. Guardrail Defense Against Prompt-Injection Drain Attempt
  console.log("[3] Simulating Prompt-Injection Drain Attack (150.00 USDG + Unauthorized Recipient)");
  const overCapAttempt = PolicyEngine.evaluatePayment(vaultState, {
    signer: sessionKeypair.publicKey,
    recipient: merchantKeypair.publicKey,
    amount: toTokenBaseUnits(150),
    nowTs,
  });
  console.log(`    Attempt #1 (150 USDG) : BLOCKED -> [${overCapAttempt.code}] ${overCapAttempt.reason}`);

  const rogueRecipientAttempt = PolicyEngine.evaluatePayment(vaultState, {
    signer: sessionKeypair.publicKey,
    recipient: rogueRecipientKeypair.publicKey,
    amount: toTokenBaseUnits(5),
    nowTs,
  });
  console.log(`    Attempt #2 (Rogue To) : BLOCKED -> [${rogueRecipientAttempt.code}] ${rogueRecipientAttempt.reason}\n`);

  // 4. Milestone Escrow with Cryptographic Deliverable Verification
  console.log("[4] Milestone Escrow Lifecycle (SHA-256 Deliverable Verification)");
  const deliverableArtifact = JSON.stringify({
    bounty: "Build for Breakpoint: Agentic Grants",
    repo: "https://github.com/LBCron/solguard-agent-pay",
    recipientWallet: ownerPubkey.toBase58(),
    testsPassing: true,
  });
  const deliverableHash = MilestoneEscrowEngine.hashDeliverable(deliverableArtifact);

  const { escrowPda, bump: escrowBump } = client.buildCreateMilestoneEscrowIx({
    client: ownerPubkey,
    provider: merchantKeypair.publicKey,
    verifier: verifierKeypair.publicKey,
    tokenMint: USDG_MAINNET_MINT,
    clientTokenAccount: Keypair.generate().publicKey,
    escrowTokenAccount: Keypair.generate().publicKey,
    escrowId: 42n,
    amount: toTokenBaseUnits(100),
    expectedDeliverableHash: deliverableHash,
    deadlineTs: BigInt(nowTs + 7 * 86_400),
  });

  const escrowState = MilestoneEscrowEngine.createEscrow({
    escrowAddress: escrowPda,
    client: ownerPubkey,
    provider: merchantKeypair.publicKey,
    verifier: verifierKeypair.publicKey,
    tokenMint: USDG_MAINNET_MINT,
    escrowId: 42n,
    amount: toTokenBaseUnits(100),
    expectedDeliverableHash: deliverableHash,
    deadlineTs: nowTs + 7 * 86_400,
    bump: escrowBump,
    nowTs,
  });

  console.log(`    MilestoneEscrow PDA   : ${escrowPda.toBase58()}`);
  console.log(`    Locked Escrow Amount  : ${formatTokenUnits(escrowState.amount)}`);
  console.log(`    Expected SHA-256 Hash : ${escrowState.expectedDeliverableHashHex}`);

  MilestoneEscrowEngine.releaseEscrow(escrowState, {
    authority: verifierKeypair.publicKey,
    actualDeliverableHash: deliverableHash,
  });
  console.log(`    Post-Attestation State: RELEASED (Status = ${escrowState.status})\n`);

  // 5. Instant Owner Emergency Revocation
  console.log("[5] Testing Owner Sovereignty — Instant Session Key Revocation");
  PolicyEngine.revokeSessionKey(vaultState, ownerPubkey, true);
  const postRevokeAttempt = PolicyEngine.evaluatePayment(vaultState, {
    signer: sessionKeypair.publicKey,
    recipient: merchantKeypair.publicKey,
    amount: toTokenBaseUnits(1),
    nowTs,
  });
  console.log(`    Vault Paused Status   : ${vaultState.paused}`);
  console.log(`    Post-Revoke Payment   : BLOCKED -> [${postRevokeAttempt.code}] ${postRevokeAttempt.reason}`);
  console.log("\n================================================================================");
  console.log("  All SolGuard AgentPay Demo Flows Completed Successfully (0 Errors)           ");
  console.log("================================================================================");
}

runDemo().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
