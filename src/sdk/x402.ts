import { Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";

export interface X402PaymentChallenge {
  version: "x402-solana-v1";
  network: "solana-mainnet" | "solana-devnet";
  recipient: string;
  tokenMint: string;
  amountBaseUnits: string;
  resourceUri: string;
  invoiceNonce: string;
  expiresAt: number;
  memo?: string;
}

export interface X402PaymentProof {
  version: "x402-solana-v1";
  vaultAddress: string;
  signerPublicKey: string;
  recipient: string;
  tokenMint: string;
  amountBaseUnits: string;
  resourceHashHex: string;
  invoiceNonce: string;
  timestamp: number;
  signatureBase58: string;
}

/**
 * Implements the x402 HTTP 402 Payment Required challenge/response protocol for Solana AI Agents.
 */
export class X402Protocol {
  /**
   * Computes a 32-byte SHA-256 digest of a target resource URI + invoice nonce.
   */
  static computeResourceHash(resourceUri: string, invoiceNonce: bigint): Buffer {
    return createHash("sha256")
      .update(`${resourceUri}:${invoiceNonce.toString()}`)
      .digest();
  }

  /**
   * Serializes an HTTP `WWW-Authenticate: X402` challenge header value.
   */
  static encodeChallengeHeader(challenge: X402PaymentChallenge): string {
    const payload = Buffer.from(JSON.stringify(challenge), "utf8").toString(
      "base64url"
    );
    return `X402 challenge="${payload}"`;
  }

  /**
   * Parses an HTTP `WWW-Authenticate: X402 challenge="..."` header value.
   */
  static decodeChallengeHeader(headerValue: string): X402PaymentChallenge {
    const match = headerValue.match(/challenge="([^"]+)"/);
    const rawBase64 = match ? match[1] : headerValue.trim();
    const decoded = Buffer.from(rawBase64, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as X402PaymentChallenge;
    if (parsed.version !== "x402-solana-v1") {
      throw new Error(`Unsupported x402 version: ${parsed.version}`);
    }
    return parsed;
  }

  /**
   * Canonical message bytes signed by the agent's Ed25519 session key to prove x402 settlement.
   */
  static buildSigningPayload(params: {
    vaultAddress: PublicKey;
    recipient: PublicKey;
    tokenMint: PublicKey;
    amountBaseUnits: bigint;
    resourceHash: Buffer;
    invoiceNonce: bigint;
    timestamp: number;
  }): Uint8Array {
    const canonical = [
      "x402-solana-v1",
      params.vaultAddress.toBase58(),
      params.recipient.toBase58(),
      params.tokenMint.toBase58(),
      params.amountBaseUnits.toString(),
      params.resourceHash.toString("hex"),
      params.invoiceNonce.toString(),
      params.timestamp.toString(),
    ].join("|");
    return new Uint8Array(Buffer.from(canonical, "utf8"));
  }

  /**
   * Signs an x402 payment proof using the agent's Ed25519 Session Keypair.
   */
  static createPaymentProof(params: {
    vaultAddress: PublicKey;
    sessionKeypair: Keypair;
    challenge: X402PaymentChallenge;
    nowTs?: number;
  }): X402PaymentProof {
    const nowTs = params.nowTs ?? Math.floor(Date.now() / 1000);
    if (nowTs > params.challenge.expiresAt) {
      throw new Error(
        `x402 challenge expired at ${params.challenge.expiresAt} (now: ${nowTs})`
      );
    }

    const recipient = new PublicKey(params.challenge.recipient);
    const tokenMint = new PublicKey(params.challenge.tokenMint);
    const amountBaseUnits = BigInt(params.challenge.amountBaseUnits);
    const invoiceNonce = BigInt(params.challenge.invoiceNonce);
    const resourceHash = X402Protocol.computeResourceHash(
      params.challenge.resourceUri,
      invoiceNonce
    );

    const messageBytes = X402Protocol.buildSigningPayload({
      vaultAddress: params.vaultAddress,
      recipient,
      tokenMint,
      amountBaseUnits,
      resourceHash,
      invoiceNonce,
      timestamp: nowTs,
    });

    const sigBytes = nacl.sign.detached(
      messageBytes,
      params.sessionKeypair.secretKey
    );

    return {
      version: "x402-solana-v1",
      vaultAddress: params.vaultAddress.toBase58(),
      signerPublicKey: params.sessionKeypair.publicKey.toBase58(),
      recipient: recipient.toBase58(),
      tokenMint: tokenMint.toBase58(),
      amountBaseUnits: amountBaseUnits.toString(),
      resourceHashHex: resourceHash.toString("hex"),
      invoiceNonce: invoiceNonce.toString(),
      timestamp: nowTs,
      signatureBase58: bs58.encode(sigBytes),
    };
  }

  /**
   * Verifies an `X-Payment-Proof` header signature and matches it against the original x402 challenge.
   */
  static verifyPaymentProof(
    proof: X402PaymentProof,
    challenge: X402PaymentChallenge
  ): { valid: boolean; reason: string } {
    if (proof.version !== "x402-solana-v1") {
      return { valid: false, reason: "Invalid protocol version" };
    }
    if (proof.recipient !== challenge.recipient) {
      return { valid: false, reason: "Recipient mismatch" };
    }
    if (proof.tokenMint !== challenge.tokenMint) {
      return { valid: false, reason: "Token mint mismatch" };
    }
    if (BigInt(proof.amountBaseUnits) < BigInt(challenge.amountBaseUnits)) {
      return { valid: false, reason: "Insufficient payment amount" };
    }
    if (proof.invoiceNonce !== challenge.invoiceNonce) {
      return { valid: false, reason: "Invoice nonce mismatch" };
    }
    if (proof.timestamp > challenge.expiresAt) {
      return { valid: false, reason: "Proof timestamp exceeds challenge expiry" };
    }

    const expectedHash = X402Protocol.computeResourceHash(
      challenge.resourceUri,
      BigInt(challenge.invoiceNonce)
    ).toString("hex");
    if (proof.resourceHashHex !== expectedHash) {
      return { valid: false, reason: "Resource hash mismatch" };
    }

    const messageBytes = X402Protocol.buildSigningPayload({
      vaultAddress: new PublicKey(proof.vaultAddress),
      recipient: new PublicKey(proof.recipient),
      tokenMint: new PublicKey(proof.tokenMint),
      amountBaseUnits: BigInt(proof.amountBaseUnits),
      resourceHash: Buffer.from(proof.resourceHashHex, "hex"),
      invoiceNonce: BigInt(proof.invoiceNonce),
      timestamp: proof.timestamp,
    });

    const sigBytes = bs58.decode(proof.signatureBase58);
    const pubkeyBytes = new PublicKey(proof.signerPublicKey).toBytes();
    const verified = nacl.sign.detached.verify(
      messageBytes,
      sigBytes,
      pubkeyBytes
    );

    return verified
      ? { valid: true, reason: "Valid Ed25519 x402 payment proof" }
      : { valid: false, reason: "Invalid Ed25519 signature" };
  }
}
