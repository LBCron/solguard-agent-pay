# BountySweep `x402` — Swap.io Agent API + SolGuard Autonomous Payout Auto-Sweeper

An autonomous Solana treasury sweeper built for open-source contributors and Superteam bounty hunters (`@LBCron`). Instead of paying `$49/month` (`$588/year`) for an idle DEX API subscription or exposing static API keys inside ephemeral GitHub Actions runners, **BountySweep** uses [**Swap.io's `x402` Agent API**](https://hermes.swap.io) (`HTTP 402 Payment Required`) guarded by **SolGuard AgentPay** on-chain spending caps.

## Why `x402` Wins for Autonomous Treasury Agents

| Metric | Traditional SaaS Swap API | Swap.io `x402` Agent API (`hermes.swap.io`) |
| :--- | :--- | :--- |
| **Authentication** | Static API key + credit card | **Zero API keys** (`HTTP 402` per call) |
| **Network Gas for API Payment** | N/A | **`0 SOL`** (`extra.feePayer` gasless facilitator) |
| **40 Bounty Sweeps / Year** | **`$588.00 / yr`** (`$49/mo`) | **`$0.24 / yr`** (`~$0.003` quote + `$0.003` build-tx) |
| **Prompt-Injection Blast Radius** | Full rate-limit / account drain | **Capped at `$0.05/tx` & `$1.00/day` by SolGuard** |

## Live Wire Flow (`auto-sweeper.ts`)

1. **Free Capability Discovery**: `GET https://hermes.swap.io/v1/info` discovers all 12 endpoints and base atomic USDC pricing.
2. **Unpaid Quote Challenge**: `POST https://hermes.swap.io/v1/swap/quote` for `+25,000,000 BONK -> USDC` (`50 bps` slippage) returns live `HTTP 402 Payment Required`:
   - `x402Version: 1`, `scheme: "exact"`, `network: "solana"`
   - `maxAmountRequired: "3007"` (`$0.003007 USDC`)
   - `payTo: "BPz2u6eoWLervxEqfpsMCVmKk7h6fEVsd7L5rvEibMfD"`
   - `extra.feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4"`
3. **SolGuard `PolicyEngine` Pre-Flight**:
   - Blocks simulated `$25.00 USDC` malicious `402` challenge (`EXCEEDS_PER_TX_CAP`).
   - Approves legitimate `$0.003007 USDC` Swap.io quote (`ALLOWED`).
4. **Gasless Solana `v0` `X-PAYMENT` Construction**:
   - Builds `ComputeBudget` + SPL `TransferChecked` (`opcode 12`) in a `VersionedTransaction` with Swap.io's facilitator as `payerKey`, partially signs the agent's authority slot, and submits `X-PAYMENT` to `https://hermes.swap.io/v1/swap/quote` (followed by `POST /v1/swap/build-tx` passing raw `best.providerQuote` when funded with `>= $0.006 USDC`).

## Quickstart

```bash
npm install
npm test
npm run demo:swapio

# Optional: fund an agent wallet with $0.01 USDC (0 SOL needed!) for live mainnet Solscan receipt:
AGENT_SECRET_KEY_BS58="<base58_secret_key>" npm run demo:swapio
```
