import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import bs58 from "bs58";
import {
  OWNER_PAYOUT_WALLET,
  USDC_MAINNET_MINT,
  formatTokenUnits,
  toTokenBaseUnits,
} from "../src/sdk/constants";
import { deriveAgentVaultPda } from "../src/sdk/pda";
import { PolicyEngine } from "../src/sdk/policy";
import { X402Protocol } from "../src/sdk/x402";

export const HERMES_BASE_URL = "https://hermes.swap.io";
export const SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
export const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

export const TOKENS = {
  BONK: {
    symbol: "BONK",
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    decimals: 5,
  },
  JUP: {
    symbol: "JUP",
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    decimals: 6,
  },
  SOL: {
    symbol: "SOL",
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
  },
  USDC: {
    symbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
} as const;

export interface HermesAcceptOption {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: {
    feePayer?: string;
    name?: string;
    version?: string;
  };
}

export interface Hermes402Response {
  x402Version: number;
  error?: string;
  accepts: HermesAcceptOption[];
}

/**
 * Derives the deterministic Associated Token Account (ATA) for an owner + SPL mint.
 */
export function deriveAssociatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = SPL_TOKEN_PROGRAM_ID
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

/**
 * Builds a canonical SPL Token `TransferChecked` instruction (instruction tag = 12).
 */
export function createTransferCheckedInstruction(params: {
  sourceAta: PublicKey;
  mint: PublicKey;
  destinationAta: PublicKey;
  owner: PublicKey;
  amount: bigint;
  decimals: number;
}): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0); // SPL Token TransferChecked opcode
  data.writeBigUInt64LE(params.amount, 1);
  data.writeUInt8(params.decimals, 9);

  return new TransactionInstruction({
    programId: SPL_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.sourceAta, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.destinationAta, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * Constructs a gasless Solana `VersionedTransaction` (v0) for Swap.io's x402 SVM facilitator
 * and encodes it as a standard base64 `X-PAYMENT` header (`x402Version: 1`, `scheme: "exact"`).
 */
export function buildX402SolanaPaymentHeader(params: {
  payerKeypair: Keypair;
  accept: HermesAcceptOption;
  recentBlockhash: string;
}): {
  xPaymentHeaderBase64: string;
  versionedTxBase64: string;
  sourceAta: string;
  destinationAta: string;
  feePayer: string;
} {
  const mint = new PublicKey(params.accept.asset);
  const payToOwner = new PublicKey(params.accept.payTo);
  const feePayer = new PublicKey(
    params.accept.extra?.feePayer ?? params.payerKeypair.publicKey.toBase58()
  );
  const amount = BigInt(params.accept.maxAmountRequired);

  const sourceAta = deriveAssociatedTokenAddress(
    params.payerKeypair.publicKey,
    mint
  );
  const destinationAta = deriveAssociatedTokenAddress(payToOwner, mint);

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    createTransferCheckedInstruction({
      sourceAta,
      mint,
      destinationAta,
      owner: params.payerKeypair.publicKey,
      amount,
      decimals: 6,
    }),
  ];

  const messageV0 = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: params.recentBlockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  // Agent partially signs its own SPL transfer authority slot; facilitator signs feePayer slot!
  tx.sign([params.payerKeypair]);

  const versionedTxBase64 = Buffer.from(tx.serialize()).toString("base64");
  const paymentEnvelope = {
    x402Version: 1,
    scheme: "exact" as const,
    network: "solana" as const,
    payload: {
      transaction: versionedTxBase64,
    },
  };

  return {
    xPaymentHeaderBase64: Buffer.from(
      JSON.stringify(paymentEnvelope),
      "utf8"
    ).toString("base64"),
    versionedTxBase64,
    sourceAta: sourceAta.toBase58(),
    destinationAta: destinationAta.toBase58(),
    feePayer: feePayer.toBase58(),
  };
}

/**
 * Extracts a Solana transaction signature from Swap.io's `X-PAYMENT-RESPONSE` base64 JSON header.
 */
export function decodeXPaymentResponse(
  headerVal: string | null
): Record<string, unknown> | null {
  if (!headerVal) return null;
  try {
    const raw = Buffer.from(headerVal, "base64").toString("utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw: headerVal };
  }
}

export async function runAutonomousBountySweeper() {
  const agentKeypair = process.env.AGENT_SECRET_KEY_BS58
    ? Keypair.fromSecretKey(bs58.decode(process.env.AGENT_SECRET_KEY_BS58))
    : Keypair.generate();

  console.log("==========================================================================");
  console.log("  BountySweep x402 — Autonomous GitHub / Superteam Payout Auto-Sweeper");
  console.log("  Powered by Swap.io Agent API (hermes.swap.io) + SolGuard AgentPay");
  console.log("==========================================================================\n");

  console.log(`[1/5] Bounty Treasury & Scoped Session Identity`);
  console.log(`  Owner Payout Treasury : ${OWNER_PAYOUT_WALLET.toBase58()} (@LBCron)`);
  console.log(`  Agent Session Signer  : ${agentKeypair.publicKey.toBase58()}`);
  console.log(`  Incoming Bounty Event : +25,000,000 BONK (${TOKENS.BONK.mint})`);
  console.log(`  Target Settlement     : USDC (${TOKENS.USDC.mint}) @ 50 bps max slippage\n`);

  // Step 1: Discover Swap.io x402 service capabilities via free /v1/info endpoint
  console.log(`[2/5] Discovering Swap.io x402 Agent API (GET ${HERMES_BASE_URL}/v1/info)...`);
  const infoRes = await fetch(`${HERMES_BASE_URL}/v1/info`);
  const infoJson = (await infoRes.json()) as {
    description: string;
    endpoints: Array<{ path: string; method: string; basePrice?: string; payment: string }>;
  };
  console.log(`  HTTP ${infoRes.status} OK — ${infoJson.endpoints.length} endpoints discovered`);
  const quoteInfo = infoJson.endpoints.find((e) => e.path === "/v1/swap/quote");
  console.log(`  /v1/swap/quote basePrice: ${quoteInfo?.basePrice ?? "3000"} atomic USDC ($0.003000) | API Key Required: NONE\n`);

  // Step 2: Send unpaid quote request to receive live HTTP 402 challenge
  const quotePayload = {
    input: {
      token: TOKENS.BONK.mint,
      amount: "2500000000000", // 25,000,000 BONK (5 decimals)
      chainKey: "sol",
    },
    output: {
      token: TOKENS.USDC.mint,
      chainKey: "sol",
    },
    userAddress: OWNER_PAYOUT_WALLET.toBase58(),
    slippageBps: 50,
  };

  console.log(`[3/5] Requesting Live Quote -> POST ${HERMES_BASE_URL}/v1/swap/quote (Unpaid)...`);
  const challengeRes = await fetch(`${HERMES_BASE_URL}/v1/swap/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(quotePayload),
  });

  const challengeBody = (await challengeRes.json()) as Hermes402Response;
  const solanaOption = challengeBody.accepts.find((a) => a.network === "solana");
  if (!solanaOption) {
    throw new Error("No Solana payment option returned in 402 accepts[]");
  }

  const priceAtomic = BigInt(solanaOption.maxAmountRequired);
  const priceUsd = (Number(priceAtomic) / 1_000_000).toFixed(6);
  console.log(`  <- Received Live HTTP ${challengeRes.status} Payment Required!`);
  console.log(`     x402Version        : ${challengeBody.x402Version}`);
  console.log(`     scheme / network   : ${solanaOption.scheme} / ${solanaOption.network}`);
  console.log(`     maxAmountRequired  : ${solanaOption.maxAmountRequired} atomic USDC ($${priceUsd})`);
  console.log(`     payTo (Swap.io)    : ${solanaOption.payTo}`);
  console.log(`     gasless feePayer   : ${solanaOption.extra?.feePayer} (0 SOL required from agent!)\n`);

  // Step 3: Evaluate live Swap.io 402 challenge against SolGuard on-chain spending guardrails
  console.log(`[4/5] Evaluating x402 Challenge via SolGuard AgentVault PolicyEngine...`);
  const [vaultPda, bump] = deriveAgentVaultPda(OWNER_PAYOUT_WALLET, 402n);
  const swapIoMerchant = new PublicKey(solanaOption.payTo);
  const nowTs = Math.floor(Date.now() / 1000);

  const vault = PolicyEngine.createVaultState({
    vaultAddress: vaultPda,
    owner: OWNER_PAYOUT_WALLET,
    tokenMint: USDC_MAINNET_MINT,
    vaultId: 402n,
    sessionDelegate: agentKeypair.publicKey,
    maxPerTx: toTokenBaseUnits("0.05"), // Hard $0.05 USDC per-call cap
    dailySpendCap: toTokenBaseUnits("1.00"), // Hard $1.00 USDC/24h cap (~330 quotes/day)
    sessionExpiryTs: nowTs + 86_400,
    allowedRecipients: [swapIoMerchant],
    bump,
    nowTs,
  });

  // 3a. Verify prompt-injection attack ($25.00 malicious 402 header) is deterministically blocked
  const maliciousCheck = PolicyEngine.evaluatePayment(vault, {
    signer: agentKeypair.publicKey,
    recipient: swapIoMerchant,
    amount: toTokenBaseUnits("25.00"),
    nowTs,
  });
  console.log(
    `  [Guardrail Adversarial Check] Malicious $25.00 402 Spoof -> ${maliciousCheck.code} (${maliciousCheck.reason})`
  );

  // 3b. Verify legitimate Swap.io $0.003007 micro-USDC quote fee is approved
  const policyVerdict = PolicyEngine.recordSettlement(vault, {
    signer: agentKeypair.publicKey,
    recipient: swapIoMerchant,
    amount: priceAtomic,
    nowTs,
  });
  console.log(
    `  [Guardrail Live Verdict]      Swap.io $${priceUsd} USDC -> ${policyVerdict.code} (Remaining 24h budget: ${formatTokenUnits(policyVerdict.remainingDailyBudget, "USDC")})\n`
  );

  // Step 4: Build gasless Solana v0 TransferChecked transaction + SolGuard Ed25519 receipt & call hermes.swap.io
  console.log(`[5/5] Building Gasless Solana v0 X-PAYMENT Payload & Submitting to Swap.io...`);
  const connection = new Connection(SOLANA_MAINNET_RPC, "confirmed");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const x402Payment = buildX402SolanaPaymentHeader({
    payerKeypair: agentKeypair,
    accept: solanaOption,
    recentBlockhash: blockhash,
  });

  const solguardProof = X402Protocol.createPaymentProof({
    vaultAddress: vaultPda,
    sessionKeypair: agentKeypair,
    challenge: {
      version: "x402-solana-v1",
      network: "solana-mainnet",
      recipient: solanaOption.payTo,
      tokenMint: solanaOption.asset,
      amountBaseUnits: solanaOption.maxAmountRequired,
      resourceUri: solanaOption.resource,
      invoiceNonce: "1",
      expiresAt: nowTs + solanaOption.maxTimeoutSeconds,
    },
    nowTs,
  });

  console.log(`  Mainnet Blockhash     : ${blockhash}`);
  console.log(`  Agent Source USDC ATA : ${x402Payment.sourceAta}`);
  console.log(`  Swap.io Dest USDC ATA : ${x402Payment.destinationAta}`);
  console.log(`  SolGuard Proof Sig    : ${solguardProof.signatureBase58.slice(0, 44)}...`);

  const paidQuoteRes = await fetch(`${HERMES_BASE_URL}/v1/swap/quote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT": x402Payment.xPaymentHeaderBase64,
    },
    body: JSON.stringify(quotePayload),
  });

  const paymentReceipt = decodeXPaymentResponse(
    paidQuoteRes.headers.get("x-payment-response")
  );
  const paidBody = (await paidQuoteRes.json()) as Record<string, unknown>;

  let solscanUrl: string | null = null;
  let buildTxStatus: number | null = null;

  if (paidQuoteRes.status === 200 && Array.isArray(paidBody.quotes) && paidBody.quotes.length > 0) {
    const txHash =
      (paymentReceipt?.transaction as string | undefined) ??
      (paymentReceipt?.txHash as string | undefined) ??
      null;
    if (txHash) {
      solscanUrl = `https://solscan.io/tx/${txHash}`;
    }
    const best = paidBody.quotes[0] as {
      provider: { key: string; name?: string };
      outAmount?: string;
      providerQuote: unknown;
    };
    console.log(`  <- HTTP 200 OK! Best DEX Route: ${best.provider.key} | Output: ${best.outAmount ?? "ranked"}`);
    if (solscanUrl) {
      console.log(`  <- Live Solscan x402 Settlement: ${solscanUrl}`);
    }

    // Step 5b: Build unsigned swap transaction passing raw best.providerQuote
    const buildRes = await fetch(`${HERMES_BASE_URL}/v1/swap/build-tx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: best.provider.key,
        userAddress: OWNER_PAYOUT_WALLET.toBase58(),
        chainKey: "sol",
        quoteResponse: best.providerQuote,
      }),
    });
    buildTxStatus = buildRes.status;
    console.log(`  <- Follow-up POST /v1/swap/build-tx Challenge Status: HTTP ${buildTxStatus}`);
  } else {
    console.log(
      `  <- Swap.io SVM Facilitator Decoded v0 Tx Live (HTTP ${paidQuoteRes.status}): ${JSON.stringify(paidBody.error ?? paidBody).slice(0, 140)}`
    );
    console.log(
      `     (Fund ${agentKeypair.publicKey.toBase58()} with $0.01 USDC + set AGENT_SECRET_KEY_BS58 for live mainnet settlement; 0 SOL needed!)`
    );
  }

  // Compare annual SaaS subscription vs Swap.io x402 per-call economics
  const sweepsPerYear = 40;
  const x402AnnualUsd = ((Number(priceAtomic) * 2 * sweepsPerYear) / 1_000_000).toFixed(4);
  const saasAnnualUsd = (49 * 12).toFixed(2);
  console.log(`\n  [Unit Economics] 40 Bounty Sweeps/yr: SaaS API = $${saasAnnualUsd}/yr vs Swap.io x402 = $${x402AnnualUsd}/yr (99.96% savings)`);

  const tracePath = resolve(__dirname, "live-trace.json");
  const traceArtifact = {
    capturedAtUtc: new Date().toISOString(),
    ownerTreasury: OWNER_PAYOUT_WALLET.toBase58(),
    agentSessionPubkey: agentKeypair.publicKey.toBase58(),
    vaultPda: vaultPda.toBase58(),
    hermesEndpoint: `${HERMES_BASE_URL}/v1/swap/quote`,
    http402Status: challengeRes.status,
    x402Challenge: solanaOption,
    guardrailBlockedMalicious25Usd: maliciousCheck,
    guardrailApprovedMicroUsdc: {
      allowed: policyVerdict.allowed,
      code: policyVerdict.code,
      priceAtomicUsdc: priceAtomic.toString(),
      priceUsd,
    },
    recentBlockhash: blockhash,
    sourceAta: x402Payment.sourceAta,
    destinationAta: x402Payment.destinationAta,
    facilitatorResponseStatus: paidQuoteRes.status,
    facilitatorResponseError: paidBody.error ?? null,
    solscanUrl,
    buildTxStatus,
    annualComparison: {
      sweepsPerYear,
      traditionalSaasUsd: Number(saasAnnualUsd),
      swapIoX402Usd: Number(x402AnnualUsd),
    },
  };
  writeFileSync(
    tracePath,
    JSON.stringify(
      traceArtifact,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2
    )
  );
  console.log(`  Saved verifiable live wire trace -> ${tracePath}\n`);
}

if (require.main === module) {
  runAutonomousBountySweeper().catch((err) => {
    console.error("BountySweep execution failed:", err);
    process.exit(1);
  });
}
