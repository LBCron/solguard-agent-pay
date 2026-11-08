import { PublicKey } from "@solana/web3.js";

/**
 * Canonical SolGuard AgentPay Anchor Program ID
 */
export const SOLGUARD_PROGRAM_ID = new PublicKey(
  "SGPay11111111111111111111111111111111111111"
);

/**
 * Canonical Owner / Treasury Payout Wallet on Solana (Superteam Earn Recipient)
 */
export const OWNER_PAYOUT_WALLET = new PublicKey(
  "32647Bri8KhJQE11x26iF7fpae9nouCJSZ8Y2VPpq5yM"
);

/**
 * Global Dollar (USDG) SPL Token Mint on Solana Mainnet (6 decimals)
 */
export const USDG_MAINNET_MINT = new PublicKey(
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH"
);

/**
 * Circle USD Coin (USDC) SPL Token Mint on Solana Mainnet (6 decimals)
 */
export const USDC_MAINNET_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

/**
 * SPL Token Program ID
 */
export const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

/**
 * Rolling 24-hour window in seconds
 */
export const ROLLING_WINDOW_SECONDS = 86_400;

/**
 * Maximum allowlisted recipients per AgentVault PDA
 */
export const MAX_ALLOWED_RECIPIENTS = 8;

/**
 * Token decimals for USDG and USDC on Solana
 */
export const STABLECOIN_DECIMALS = 6;

/**
 * Helper to convert human-readable USDG/USDC amount to base units (6 decimals)
 */
export function toTokenBaseUnits(amount: number | string): bigint {
  const [whole, frac = ""] = String(amount).split(".");
  const paddedFrac = (frac + "000000").slice(0, STABLECOIN_DECIMALS);
  return BigInt(whole) * 1_000_000n + BigInt(paddedFrac);
}

/**
 * Helper to format base units (6 decimals) into human-readable USDG/USDC string
 */
export function formatTokenUnits(baseUnits: bigint, symbol = "USDG"): string {
  const whole = baseUnits / 1_000_000n;
  const frac = (baseUnits % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac} ${symbol}` : `${whole}.00 ${symbol}`;
}
