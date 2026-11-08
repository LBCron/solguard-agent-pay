# SolGuard AgentPay

**Autonomous Solana Milestone Escrow, SPL Token Guardrails & `x402` Agent Settlement Protocol**

[![Solana](https://img.shields.io/badge/Solana-Anchor%200.30.1-14F195?logo=solana&logoColor=black)](https://solana.com)
[![Token](https://img.shields.io/badge/Stablecoin-USDG%20%7C%20USDC-2563EB)](https://www.paxos.com/usdg/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

> Built for **Superteam UK — Build for Breakpoint: Agentic Grants (London)** & **Colosseum Solana Accelerator**.  
> **Owner / Treasury Recipient Wallet (Solana Mainnet)**: `32647Bri8KhJQE11x26iF7fpae9nouCJSZ8Y2VPpq5yM`

---

## 1. Problem Statement

Autonomous AI coding and commerce agents increasingly need to pay for inference APIs, compute sandboxes, and sub-agent bounties using **USDG** (`2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH`) and **USDC** (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) on Solana. However:

1. **Unbounded Private Keys Are Catastrophic**: Giving an LLM agent raw access to a funded Solana treasury wallet exposes the entire balance to prompt injection, hallucinated loops, or malicious MCP tools.
2. **No Verifiable Deliverable Gate for Agent-to-Agent Bounties**: When a primary agent delegates a task to a specialist agent, releasing SPL tokens upfront creates counterparty risk.
3. **Fragmented `x402` Settlement on Solana**: HTTP `402 Payment Required` endpoints lack a standardized, session-key-bounded SPL token settlement and Ed25519 proof verification layer.

---

## 2. Solution & Architecture

**SolGuard AgentPay** solves autonomous agent treasury safety on Solana through three tightly integrated layers:

```
+-------------------------------------------------------------------------+
|                   Human / Founder Treasury Owner                        |
|           32647Bri8KhJQE11x26iF7fpae9nouCJSZ8Y2VPpq5yM                  |
+------------------------------------+------------------------------------+
                                     |
        1. initialize_agent_vault()  |  4. revoke_session_key() / pause
                                     v
+-------------------------------------------------------------------------+
|              SolGuard Anchor Program (programs/solguard-agent-pay)      |
|                                                                         |
|  +----------------------------------+  +-----------------------------+  |
|  |        AgentVault PDA            |  |     MilestoneEscrow PDA     |  |
|  | - session_delegate: Pubkey       |  | - client / provider / arb   |  |
|  | - max_per_tx: 25.00 USDG         |  | - amount: 100.00 USDG       |  |
|  | - daily_spend_cap: 200.00 USDG   |  | - expected_sha256: [u8; 32] |  |
|  | - window_start_ts (24h rolling)  |  | - status: Funded->Released  |  |
|  | - allowed_recipients: Pubkey[8]  |  +--------------+--------------+  |
|  +----------------+-----------------+                 |                 |
+-------------------|-----------------------------------|-----------------+
                    | 2. settle_x402_payment()          | 3. release_milestone_escrow()
                    v                                   v
+------------------------------------+  +---------------------------------+
|   x402 API / Inference Merchant    |  |   Sub-Agent / Bounty Provider   |
|  Verifies Ed25519 X-Payment-Proof  |  |   Submits SHA-256 Deliverable   |
+------------------------------------+  +---------------------------------+
```

### Core Capabilities

1. **PDA-Backed SPL Token Guardrails (`AgentVault`)**:
   - **Scoped Session Delegate**: The AI agent holds an ephemeral Ed25519 session key that can *only* invoke `settle_x402_payment` within strict on-chain bounds.
   - **Per-Transaction Cap (`max_per_tx`)**: Rejects any single settlement exceeding the configured threshold (e.g., `25.00 USDG`).
   - **24-Hour Rolling Window Cap (`daily_spend_cap`)**: Tracks cumulative spend across a rolling `86,400`-second window (e.g., `200.00 USDG/day`) and automatically resets when a new 24h window begins.
   - **Recipient Allowlist (`allowed_recipients`)**: Restricts settlements to up to 8 pre-approved merchant owner addresses, neutralizing prompt-injection drain attacks to attacker wallets.
   - **Instant Owner Revocation (`revoke_session_key`)**: The owner (`32647Bri8KhJQE11x26iF7fpae9nouCJSZ8Y2VPpq5yM`) can revoke the session delegate and pause the vault in a single transaction.
2. **Atomic `x402` HTTP Payment Required Protocol (`X402Protocol`)**:
   - Encodes and decodes `WWW-Authenticate: X402 challenge="..."` headers carrying recipient, SPL token mint (`USDG`/`USDC`), amount in base units (`6` decimals), resource URI, invoice nonce, and expiry.
   - Signs canonical `x402-solana-v1` payment proofs with the agent's Ed25519 session key and verifies proofs on the merchant server before unlocking API responses.
3. **Cryptographic Milestone Escrow (`MilestoneEscrow`)**:
   - Locks `USDG`/`USDC` in a deterministic `["milestone_escrow", client, escrow_id]` PDA and requires the provider's submitted deliverable SHA-256 digest (`actual_deliverable_hash`) to match `expected_deliverable_hash` before releasing funds.

---

## 3. Repository Structure

```text
solguard-agent-pay/
├── Anchor.toml                                # Anchor cluster & program configuration
├── programs/
│   └── solguard-agent-pay/
│       ├── Cargo.toml                         # Rust Anchor 0.30.1 + anchor-spl crate config
│       └── src/
│           └── lib.rs                         # On-chain Solana Anchor program (5 instructions)
├── src/
│   ├── index.ts                               # Public SDK entrypoint
│   ├── sdk/
│   │   ├── constants.ts                       # Program ID, Owner Wallet, USDG/USDC mints
│   │   ├── pda.ts                             # Deterministic PDA derivations & discriminators
│   │   ├── policy.ts                          # Rolling 24h guardrail & policy evaluation engine
│   │   ├── x402.ts                            # HTTP 402 challenge/proof encoder & Ed25519 verifier
│   │   ├── escrow.ts                          # SHA-256 milestone escrow engine
│   │   └── client.ts                          # SolGuardClient Anchor instruction builder
│   ├── cli/
│   │   └── demo.ts                            # End-to-end interactive CLI demonstration
│   └── server/
│       └── dashboard.ts                       # Interactive web dashboard + JSON API server
└── tests/
    └── solguard.test.ts                       # Automated unit & integration test suite
```

---

## 4. Quickstart & Verification

### Prerequisites
- Node.js `>= 18`
- npm `>= 9`

### Install & Build
```bash
git clone https://github.com/LBCron/solguard-agent-pay.git
cd solguard-agent-pay
npm install --ignore-scripts
npm run build
```

### Run Automated Test Suite
```bash
npm test
```

### Run End-to-End CLI Demo
```bash
npm run demo
```

### Launch Interactive Web Dashboard
```bash
npm run dashboard
# Open http://localhost:3402 in your browser
```

---

## 5. Key Solana Addresses

| Entity | Solana Address |
| :--- | :--- |
| **Owner / Grant Payout Wallet** | `32647Bri8KhJQE11x26iF7fpae9nouCJSZ8Y2VPpq5yM` |
| **SolGuard Program ID** | `SGPay11111111111111111111111111111111111111` |
| **USDG Mainnet Mint (6 Decimals)** | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` |
| **USDC Mainnet Mint (6 Decimals)** | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

---

## 6. License

Released under the [MIT License](./LICENSE). Built by **Ronan Chen Lopes (`@LBCron`)**.
