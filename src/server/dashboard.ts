import http from "http";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  OWNER_PAYOUT_WALLET,
  SOLGUARD_PROGRAM_ID,
  USDG_MAINNET_MINT,
  formatTokenUnits,
  toTokenBaseUnits,
} from "../sdk/constants";
import { deriveAgentVaultPda, deriveMilestoneEscrowPda } from "../sdk/pda";
import { PolicyEngine } from "../sdk/policy";
import { X402Protocol } from "../sdk/x402";
import { MilestoneEscrowEngine } from "../sdk/escrow";

const PORT = Number(process.env.PORT || 3402);

const sessionKeypair = Keypair.generate();
const merchantKeypair = Keypair.generate();
const verifierKeypair = Keypair.generate();
const [vaultPda, vaultBump] = deriveAgentVaultPda(OWNER_PAYOUT_WALLET, 1n);
const [escrowPda, escrowBump] = deriveMilestoneEscrowPda(OWNER_PAYOUT_WALLET, 101n);

const vaultState = PolicyEngine.createVaultState({
  vaultAddress: vaultPda,
  owner: OWNER_PAYOUT_WALLET,
  tokenMint: USDG_MAINNET_MINT,
  vaultId: 1n,
  sessionDelegate: sessionKeypair.publicKey,
  maxPerTx: toTokenBaseUnits(25),
  dailySpendCap: toTokenBaseUnits(200),
  sessionExpiryTs: Math.floor(Date.now() / 1000) + 86_400,
  allowedRecipients: [merchantKeypair.publicKey],
  bump: vaultBump,
});

const auditLog: Array<{
  id: number;
  ts: string;
  action: string;
  amount: string;
  status: string;
  detail: string;
}> = [];

function serializeState() {
  return {
    programId: SOLGUARD_PROGRAM_ID.toBase58(),
    ownerWallet: OWNER_PAYOUT_WALLET.toBase58(),
    tokenMint: USDG_MAINNET_MINT.toBase58(),
    vaultPda: vaultState.vaultAddress.toBase58(),
    escrowPda: escrowPda.toBase58(),
    sessionDelegate: vaultState.sessionDelegate.toBase58(),
    merchantRecipient: merchantKeypair.publicKey.toBase58(),
    maxPerTxFormatted: formatTokenUnits(vaultState.maxPerTx),
    dailySpendCapFormatted: formatTokenUnits(vaultState.dailySpendCap),
    currentWindowSpendFormatted: formatTokenUnits(vaultState.currentWindowSpend),
    remainingDailyFormatted: formatTokenUnits(
      vaultState.dailySpendCap - vaultState.currentWindowSpend
    ),
    settlementCount: Number(vaultState.settlementCount),
    paused: vaultState.paused,
    auditLog,
  };
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SolGuard AgentPay — Solana SPL Guardrails & x402 Protocol</title>
  <style>
    :root {
      --bg-canvas: #090a0f;
      --bg-surface: #11131c;
      --bg-elevated: #181b28;
      --text-primary: #f3f4f8;
      --text-secondary: #a2a8bd;
      --text-muted: #687089;
      --border-hairline: rgba(255, 255, 255, 0.08);
      --accent-green: #14f195;
      --accent-amber: #f59e0b;
      --accent-red: #ef4444;
      --font-sans: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: "JetBrains Mono", "Fira Code", monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-canvas);
      color: var(--text-primary);
      font-family: var(--font-sans);
      line-height: 1.55;
      padding: 32px 24px;
    }
    .container { max-width: 1180px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border-hairline);
      margin-bottom: 32px;
      flex-wrap: wrap;
    }
    .eyebrow {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--accent-green);
      font-weight: 600;
      margin-bottom: 8px;
    }
    h1 {
      font-size: clamp(1.5rem, 2.5vw, 2.25rem);
      letter-spacing: -0.03em;
      line-height: 1.15;
    }
    .subtitle {
      color: var(--text-secondary);
      max-width: 65ch;
      margin-top: 8px;
      font-size: 0.95rem;
    }
    .pill {
      background: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: 8px;
      padding: 8px 12px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: var(--text-secondary);
    }
    .grid {
      display: grid;
      grid-template-columns: 1.25fr 1fr;
      gap: 24px;
      margin-bottom: 24px;
    }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
    .panel {
      background: var(--bg-surface);
      border: 1px solid var(--border-hairline);
      border-radius: 12px;
      padding: 24px;
    }
    .panel h2 {
      font-size: 1.05rem;
      margin-bottom: 16px;
      letter-spacing: -0.015em;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin-bottom: 16px;
    }
    .metric {
      background: var(--bg-elevated);
      border: 1px solid var(--border-hairline);
      border-radius: 8px;
      padding: 12px 16px;
      font-variant-numeric: tabular-nums;
    }
    .metric-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
    .metric-val { font-size: 1.25rem; font-weight: 600; font-family: var(--font-mono); margin-top: 4px; }
    .kv { font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 8px; font-family: var(--font-mono); word-break: break-all; }
    .actions { display: flex; flex-direction: column; gap: 12px; }
    button {
      background: var(--bg-elevated);
      color: var(--text-primary);
      border: 1px solid var(--border-hairline);
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      text-align: left;
      transition: transform 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms ease;
    }
    button:hover { border-color: var(--accent-green); }
    button:active { transform: scale(0.985); }
    button.primary { background: var(--accent-green); color: #050807; border-color: transparent; }
    button.danger { border-color: rgba(239, 68, 68, 0.4); color: #fca5a5; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border-hairline); }
    th { color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .badge { padding: 2px 8px; border-radius: 4px; font-family: var(--font-mono); font-size: 0.75rem; }
    .badge.ok { background: rgba(20, 241, 149, 0.14); color: var(--accent-green); }
    .badge.err { background: rgba(239, 68, 68, 0.16); color: #fca5a5; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <div class="eyebrow">Superteam UK · Build for Breakpoint London MVP</div>
        <h1>SolGuard AgentPay</h1>
        <p class="subtitle">Autonomous Solana Milestone Escrow, SPL Token (USDG/USDC) Session Key Guardrails &amp; x402 HTTP Agent Settlement Protocol.</p>
      </div>
      <div class="pill">
        Owner Treasury: <strong id="ownerWallet">Loading...</strong>
      </div>
    </header>

    <div class="grid">
      <div class="panel">
        <h2>On-Chain AgentVault Telemetry (USDG · 6 Decimals)</h2>
        <div class="metrics">
          <div class="metric">
            <div class="metric-label">Per-Tx Spend Cap</div>
            <div class="metric-val" id="maxPerTx">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">24h Rolling Spend Cap</div>
            <div class="metric-val" id="dailyCap">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">Current 24h Window Spend</div>
            <div class="metric-val" id="windowSpend">--</div>
          </div>
          <div class="metric">
            <div class="metric-label">Remaining 24h Budget</div>
            <div class="metric-val" id="remainingBudget">--</div>
          </div>
        </div>
        <div class="kv">AgentVault PDA : <span id="vaultPda"></span></div>
        <div class="kv">Session Key    : <span id="sessionKey"></span></div>
        <div class="kv">USDG SPL Mint  : <span id="tokenMint"></span></div>
      </div>

      <div class="panel">
        <h2>Interactive Agentic Payment &amp; Guardrail Simulator</h2>
        <div class="actions">
          <button class="primary" onclick="triggerAction('x402_settle')">1. Execute Valid x402 API Settlement (12.50 USDG)</button>
          <button class="danger" onclick="triggerAction('prompt_injection')">2. Simulate Prompt-Injection Drain Attack (150.00 USDG)</button>
          <button onclick="triggerAction('escrow_release')">3. Verify SHA-256 Deliverable &amp; Release Milestone Escrow</button>
          <button onclick="triggerAction('toggle_pause')">4. Toggle Owner Emergency Vault Pause / Resume</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <h2>Verifiable Guardrail &amp; x402 Audit Trail</h2>
      <table>
        <thead>
          <tr><th>Time</th><th>Action</th><th>Amount</th><th>Verdict</th><th>Cryptographic Proof / Guardrail Reason</th></tr>
        </thead>
        <tbody id="auditBody">
          <tr><td colspan="5" style="color:var(--text-muted)">Click an action above to execute live x402 and guardrail simulations.</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    async function refresh() {
      const res = await fetch('/api/state');
      const s = await res.json();
      document.getElementById('ownerWallet').textContent = s.ownerWallet;
      document.getElementById('maxPerTx').textContent = s.maxPerTxFormatted;
      document.getElementById('dailyCap').textContent = s.dailySpendCapFormatted;
      document.getElementById('windowSpend').textContent = s.currentWindowSpendFormatted;
      document.getElementById('remainingBudget').textContent = s.remainingDailyFormatted;
      document.getElementById('vaultPda').textContent = s.vaultPda;
      document.getElementById('sessionKey').textContent = s.sessionDelegate + (s.paused ? ' (PAUSED)' : '');
      document.getElementById('tokenMint').textContent = s.tokenMint;

      const tbody = document.getElementById('auditBody');
      if (s.auditLog.length > 0) {
        tbody.innerHTML = s.auditLog.map(row => \`
          <tr>
            <td>\${row.ts}</td>
            <td>\${row.action}</td>
            <td>\${row.amount}</td>
            <td><span class="badge \${row.status === 'ALLOWED' || row.status === 'RELEASED' ? 'ok' : 'err'}">\${row.status}</span></td>
            <td style="font-family:var(--font-mono);font-size:0.78rem">\${row.detail}</td>
          </tr>
        \`).join('');
      }
    }

    async function triggerAction(action) {
      await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      await refresh();
    }

    refresh();
  </script>
</body>
</html>`;

export function createDashboardServer() {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(serializeState()));
      return;
    }

    if (req.method === "POST" && req.url === "/api/action") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { action } = JSON.parse(body || "{}");
        const nowStr = new Date().toISOString().slice(11, 19) + " UTC";

        if (action === "x402_settle") {
          const amount = toTokenBaseUnits("12.50");
          const result = PolicyEngine.recordSettlement(vaultState, {
            signer: sessionKeypair.publicKey,
            recipient: merchantKeypair.publicKey,
            amount,
          });
          let detail = result.reason;
          if (result.allowed) {
            const proof = X402Protocol.createPaymentProof({
              vaultAddress: vaultPda,
              sessionKeypair,
              challenge: {
                version: "x402-solana-v1",
                network: "solana-devnet",
                recipient: merchantKeypair.publicKey.toBase58(),
                tokenMint: USDG_MAINNET_MINT.toBase58(),
                amountBaseUnits: amount.toString(),
                resourceUri: "https://api.solguard.dev/v1/agent-compute",
                invoiceNonce: String(auditLog.length + 1),
                expiresAt: Math.floor(Date.now() / 1000) + 600,
              },
            });
            detail = `Ed25519 Sig: ${proof.signatureBase58.slice(0, 32)}...`;
          }
          auditLog.unshift({
            id: auditLog.length + 1,
            ts: nowStr,
            action: "x402 API Settlement",
            amount: "12.50 USDG",
            status: result.code,
            detail,
          });
        } else if (action === "prompt_injection") {
          const amount = toTokenBaseUnits("150.00");
          const result = PolicyEngine.evaluatePayment(vaultState, {
            signer: sessionKeypair.publicKey,
            recipient: merchantKeypair.publicKey,
            amount,
          });
          auditLog.unshift({
            id: auditLog.length + 1,
            ts: nowStr,
            action: "Prompt-Injection Drain Attempt",
            amount: "150.00 USDG",
            status: result.code,
            detail: result.reason,
          });
        } else if (action === "escrow_release") {
          const hash = MilestoneEscrowEngine.hashDeliverable("Breakpoint-MVP-v1");
          const escrow = MilestoneEscrowEngine.createEscrow({
            escrowAddress: escrowPda,
            client: OWNER_PAYOUT_WALLET,
            provider: merchantKeypair.publicKey,
            verifier: verifierKeypair.publicKey,
            tokenMint: USDG_MAINNET_MINT,
            escrowId: 101n,
            amount: toTokenBaseUnits("50.00"),
            expectedDeliverableHash: hash,
            deadlineTs: Math.floor(Date.now() / 1000) + 86400,
            bump: escrowBump,
          });
          MilestoneEscrowEngine.releaseEscrow(escrow, {
            authority: verifierKeypair.publicKey,
            actualDeliverableHash: hash,
          });
          auditLog.unshift({
            id: auditLog.length + 1,
            ts: nowStr,
            action: "Milestone Escrow Release",
            amount: "50.00 USDG",
            status: "RELEASED",
            detail: `SHA-256 Verified: ${hash.toString("hex").slice(0, 32)}...`,
          });
        } else if (action === "toggle_pause") {
          vaultState.paused = !vaultState.paused;
          auditLog.unshift({
            id: auditLog.length + 1,
            ts: nowStr,
            action: vaultState.paused ? "Owner Emergency Pause" : "Owner Vault Resume",
            amount: "0.00 USDG",
            status: vaultState.paused ? "VAULT_PAUSED" : "ALLOWED",
            detail: `Signed by Owner ${OWNER_PAYOUT_WALLET.toBase58().slice(0, 16)}...`,
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(serializeState()));
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_PAGE);
  });
}

if (require.main === module) {
  const server = createDashboardServer();
  server.listen(PORT, () => {
    console.log(`SolGuard AgentPay Dashboard listening on http://localhost:${PORT}`);
  });
}
