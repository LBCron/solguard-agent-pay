import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  buildX402SolanaPaymentHeader,
  deriveAssociatedTokenAddress,
  TOKENS,
} from "../swapio-x402-demo/auto-sweeper";

describe("Swap.io x402 BountySweep Integration Suite", () => {
  it("derives valid off-curve Associated Token Accounts for USDC", () => {
    const owner = new PublicKey("32647Bri8KhJQE11x26iF7fpae9nouCJSZ8Y2VPpq5yM");
    const usdcMint = new PublicKey(TOKENS.USDC.mint);
    const ata = deriveAssociatedTokenAddress(owner, usdcMint);
    assert.equal(PublicKey.isOnCurve(ata.toBytes()), false);
  });

  it("builds a gasless Solana v0 X-PAYMENT envelope preserving feePayer slot for Swap.io facilitator", () => {
    const agent = Keypair.generate();
    const facilitator = Keypair.generate().publicKey.toBase58();
    const payTo = "BPz2u6eoWLervxEqfpsMCVmKk7h6fEVsd7L5rvEibMfD";

    const built = buildX402SolanaPaymentHeader({
      payerKeypair: agent,
      accept: {
        scheme: "exact",
        network: "solana",
        maxAmountRequired: "3007",
        resource: "https://hermes.swap.io/v1/swap/quote",
        description: "Paid swap API",
        mimeType: "application/json",
        payTo,
        maxTimeoutSeconds: 60,
        asset: TOKENS.USDC.mint,
        extra: { feePayer: facilitator },
      },
      recentBlockhash: "11111111111111111111111111111111",
    });

    const decodedEnvelope = JSON.parse(
      Buffer.from(built.xPaymentHeaderBase64, "base64").toString("utf8")
    );
    assert.equal(decodedEnvelope.x402Version, 1);
    assert.equal(decodedEnvelope.scheme, "exact");
    assert.equal(decodedEnvelope.network, "solana");

    const v0Tx = VersionedTransaction.deserialize(
      Buffer.from(decodedEnvelope.payload.transaction, "base64")
    );
    // Slot 0 is facilitator feePayer (unsigned = 64 zero bytes), Slot 1 is agent signer (non-zero Ed25519 sig)
    assert.equal(v0Tx.message.staticAccountKeys[0].toBase58(), facilitator);
    assert.equal(v0Tx.signatures.length, 2);
    assert.equal(
      Buffer.from(v0Tx.signatures[0]).equals(Buffer.alloc(64, 0)),
      true
    );
    assert.equal(
      Buffer.from(v0Tx.signatures[1]).equals(Buffer.alloc(64, 0)),
      false
    );
  });
});
