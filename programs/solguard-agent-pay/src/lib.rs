use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("SGPay11111111111111111111111111111111111111");

/// Rolling window duration in seconds (24 hours)
pub const ROLLING_WINDOW_SECS: i64 = 86_400;
/// Maximum number of allowlisted recipient pubkeys per agent vault
pub const MAX_ALLOWED_RECIPIENTS: usize = 8;

#[program]
pub mod solguard_agent_pay {
    use super::*;

    /// Initializes a PDA-backed Agent Treasury Vault with SPL token guardrails,
    /// scoped session key authority, per-transaction cap, 24h rolling window cap,
    /// and a strict recipient allowlist.
    pub fn initialize_agent_vault(
        ctx: Context<InitializeAgentVault>,
        vault_id: u64,
        session_delegate: Pubkey,
        max_per_tx: u64,
        daily_spend_cap: u64,
        session_expiry_ts: i64,
        allowed_recipients: Vec<Pubkey>,
    ) -> Result<()> {
        require!(max_per_tx > 0, SolGuardError::InvalidGuardrailLimit);
        require!(
            daily_spend_cap >= max_per_tx,
            SolGuardError::DailyCapBelowPerTxLimit
        );
        require!(
            allowed_recipients.len() <= MAX_ALLOWED_RECIPIENTS,
            SolGuardError::TooManyAllowedRecipients
        );

        let clock = Clock::get()?;
        require!(
            session_expiry_ts > clock.unix_timestamp,
            SolGuardError::SessionKeyExpired
        );

        let vault = &mut ctx.accounts.agent_vault;
        vault.owner = ctx.accounts.owner.key();
        vault.token_mint = ctx.accounts.token_mint.key();
        vault.vault_id = vault_id;
        vault.session_delegate = session_delegate;
        vault.max_per_tx = max_per_tx;
        vault.daily_spend_cap = daily_spend_cap;
        vault.current_window_spend = 0;
        vault.window_start_ts = clock.unix_timestamp;
        vault.session_expiry_ts = session_expiry_ts;
        vault.paused = false;
        vault.total_settled_volume = 0;
        vault.settlement_count = 0;
        vault.bump = ctx.bumps.agent_vault;

        vault.allowed_count = allowed_recipients.len() as u8;
        vault.allowed_recipients = [Pubkey::default(); MAX_ALLOWED_RECIPIENTS];
        for (idx, recipient) in allowed_recipients.iter().enumerate() {
            vault.allowed_recipients[idx] = *recipient;
        }

        emit!(AgentVaultInitializedEvent {
            vault: vault.key(),
            owner: vault.owner,
            session_delegate,
            token_mint: vault.token_mint,
            max_per_tx,
            daily_spend_cap,
            session_expiry_ts,
        });

        Ok(())
    }

    /// Executes an autonomous x402 HTTP Payment Required settlement signed by the
    /// scoped `session_delegate` (or `owner`), strictly enforcing:
    /// 1. Vault not paused
    /// 2. Session key not expired
    /// 3. Recipient in allowlist
    /// 4. Amount <= max_per_tx
    /// 5. Current 24h window spend + amount <= daily_spend_cap
    pub fn settle_x402_payment(
        ctx: Context<SettleX402Payment>,
        amount: u64,
        resource_hash: [u8; 32],
        invoice_nonce: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let vault = &mut ctx.accounts.agent_vault;

        require!(!vault.paused, SolGuardError::VaultPaused);
        require!(amount > 0, SolGuardError::ZeroSettlementAmount);

        let signer_key = ctx.accounts.authority.key();
        let is_owner = signer_key == vault.owner;
        let is_delegate = signer_key == vault.session_delegate;
        require!(is_owner || is_delegate, SolGuardError::UnauthorizedSigner);

        if is_delegate && !is_owner {
            require!(
                clock.unix_timestamp <= vault.session_expiry_ts,
                SolGuardError::SessionKeyExpired
            );
        }

        // Enforce recipient allowlist if configured
        if vault.allowed_count > 0 {
            let recipient_owner = ctx.accounts.recipient_token_account.owner;
            let mut allowed = false;
            for i in 0..(vault.allowed_count as usize) {
                if vault.allowed_recipients[i] == recipient_owner {
                    allowed = true;
                    break;
                }
            }
            require!(allowed, SolGuardError::RecipientNotAllowlisted);
        }

        // Enforce per-transaction spend cap
        require!(
            amount <= vault.max_per_tx,
            SolGuardError::ExceedsPerTxSpendCap
        );

        // Reset rolling 24h window if elapsed
        if clock.unix_timestamp.saturating_sub(vault.window_start_ts) >= ROLLING_WINDOW_SECS {
            vault.window_start_ts = clock.unix_timestamp;
            vault.current_window_spend = 0;
        }

        let new_window_spend = vault
            .current_window_spend
            .checked_add(amount)
            .ok_or(SolGuardError::MathOverflow)?;
        require!(
            new_window_spend <= vault.daily_spend_cap,
            SolGuardError::ExceedsDailySpendCap
        );

        vault.current_window_spend = new_window_spend;
        vault.total_settled_volume = vault
            .total_settled_volume
            .checked_add(amount)
            .ok_or(SolGuardError::MathOverflow)?;
        vault.settlement_count = vault.settlement_count.saturating_add(1);

        // Execute SPL Token transfer from Vault ATA to Merchant ATA via PDA signer
        let owner_key = vault.owner;
        let vault_id_bytes = vault.vault_id.to_le_bytes();
        let bump = vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"agent_vault",
            owner_key.as_ref(),
            vault_id_bytes.as_ref(),
            &[bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.agent_vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;

        emit!(X402SettlementEvent {
            vault: ctx.accounts.agent_vault.key(),
            authority: signer_key,
            recipient: ctx.accounts.recipient_token_account.owner,
            amount,
            resource_hash,
            invoice_nonce,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Creates a milestone-gated SPL token escrow between an Agent Vault (or Client)
    /// and a Provider Agent, requiring cryptographic deliverable attestation before release.
    pub fn create_milestone_escrow(
        ctx: Context<CreateMilestoneEscrow>,
        escrow_id: u64,
        amount: u64,
        expected_deliverable_hash: [u8; 32],
        deadline_ts: i64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(amount > 0, SolGuardError::ZeroSettlementAmount);
        require!(
            deadline_ts > clock.unix_timestamp,
            SolGuardError::InvalidDeadline
        );

        let escrow = &mut ctx.accounts.milestone_escrow;
        escrow.client = ctx.accounts.client.key();
        escrow.provider = ctx.accounts.provider.key();
        escrow.verifier = ctx.accounts.verifier.key();
        escrow.token_mint = ctx.accounts.token_mint.key();
        escrow.escrow_id = escrow_id;
        escrow.amount = amount;
        escrow.expected_deliverable_hash = expected_deliverable_hash;
        escrow.submitted_deliverable_hash = [0u8; 32];
        escrow.deadline_ts = deadline_ts;
        escrow.status = EscrowStatus::Funded as u8;
        escrow.bump = ctx.bumps.milestone_escrow;

        // Transfer SPL tokens from client into escrow vault token account
        let cpi_accounts = Transfer {
            from: ctx.accounts.client_token_account.to_account_info(),
            to: ctx.accounts.escrow_token_account.to_account_info(),
            authority: ctx.accounts.client.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(MilestoneEscrowCreatedEvent {
            escrow: escrow.key(),
            client: escrow.client,
            provider: escrow.provider,
            verifier: escrow.verifier,
            amount,
            expected_deliverable_hash,
            deadline_ts,
        });

        Ok(())
    }

    /// Verifies the submitted deliverable hash and atomically releases the escrowed
    /// SPL tokens (USDG / USDC) to the provider.
    pub fn release_milestone_escrow(
        ctx: Context<ReleaseMilestoneEscrow>,
        actual_deliverable_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.milestone_escrow;
        require!(
            escrow.status == EscrowStatus::Funded as u8,
            SolGuardError::EscrowNotActive
        );

        let caller = ctx.accounts.authority.key();
        require!(
            caller == escrow.client || caller == escrow.verifier,
            SolGuardError::UnauthorizedSigner
        );
        require!(
            actual_deliverable_hash == escrow.expected_deliverable_hash,
            SolGuardError::DeliverableHashMismatch
        );

        escrow.submitted_deliverable_hash = actual_deliverable_hash;
        escrow.status = EscrowStatus::Released as u8;

        let client_key = escrow.client;
        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let bump = escrow.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"milestone_escrow",
            client_key.as_ref(),
            escrow_id_bytes.as_ref(),
            &[bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.provider_token_account.to_account_info(),
            authority: ctx.accounts.milestone_escrow.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, escrow.amount)?;

        emit!(MilestoneEscrowReleasedEvent {
            escrow: ctx.accounts.milestone_escrow.key(),
            provider: escrow.provider,
            amount: escrow.amount,
            deliverable_hash: actual_deliverable_hash,
        });

        Ok(())
    }

    /// Instant owner sovereignty control: revokes the active session key and/or pauses the vault.
    pub fn revoke_session_key(ctx: Context<UpdateVaultSecurity>, pause_vault: bool) -> Result<()> {
        let vault = &mut ctx.accounts.agent_vault;
        require_keys_eq!(
            ctx.accounts.owner.key(),
            vault.owner,
            SolGuardError::UnauthorizedSigner
        );
        vault.session_delegate = Pubkey::default();
        vault.session_expiry_ts = 0;
        vault.paused = pause_vault;

        emit!(SessionKeyRevokedEvent {
            vault: vault.key(),
            owner: vault.owner,
            paused: pause_vault,
        });

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EscrowStatus {
    Funded = 1,
    Released = 2,
    Refunded = 3,
}

#[account]
pub struct AgentVault {
    pub owner: Pubkey,
    pub token_mint: Pubkey,
    pub vault_id: u64,
    pub session_delegate: Pubkey,
    pub max_per_tx: u64,
    pub daily_spend_cap: u64,
    pub current_window_spend: u64,
    pub window_start_ts: i64,
    pub session_expiry_ts: i64,
    pub paused: bool,
    pub total_settled_volume: u64,
    pub settlement_count: u64,
    pub allowed_count: u8,
    pub allowed_recipients: [Pubkey; MAX_ALLOWED_RECIPIENTS],
    pub bump: u8,
}

impl AgentVault {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 8 + 8 + 1 + (32 * MAX_ALLOWED_RECIPIENTS) + 1;
}

#[account]
pub struct MilestoneEscrow {
    pub client: Pubkey,
    pub provider: Pubkey,
    pub verifier: Pubkey,
    pub token_mint: Pubkey,
    pub escrow_id: u64,
    pub amount: u64,
    pub expected_deliverable_hash: [u8; 32],
    pub submitted_deliverable_hash: [u8; 32],
    pub deadline_ts: i64,
    pub status: u8,
    pub bump: u8,
}

impl MilestoneEscrow {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 32 + 32 + 8 + 1 + 1;
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializeAgentVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = owner,
        space = AgentVault::LEN,
        seeds = [b"agent_vault", owner.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub agent_vault: Account<'info, AgentVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleX402Payment<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"agent_vault", agent_vault.owner.as_ref(), &agent_vault.vault_id.to_le_bytes()],
        bump = agent_vault.bump
    )]
    pub agent_vault: Account<'info, AgentVault>,
    #[account(
        mut,
        constraint = vault_token_account.owner == agent_vault.key(),
        constraint = vault_token_account.mint == agent_vault.token_mint
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = recipient_token_account.mint == agent_vault.token_mint
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CreateMilestoneEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    /// CHECK: Provider recipient pubkey
    pub provider: UncheckedAccount<'info>,
    /// CHECK: Arbiter / Verifier pubkey
    pub verifier: UncheckedAccount<'info>,
    pub token_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = client,
        space = MilestoneEscrow::LEN,
        seeds = [b"milestone_escrow", client.key().as_ref(), &escrow_id.to_le_bytes()],
        bump
    )]
    pub milestone_escrow: Account<'info, MilestoneEscrow>,
    #[account(mut)]
    pub client_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseMilestoneEscrow<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"milestone_escrow", milestone_escrow.client.as_ref(), &milestone_escrow.escrow_id.to_le_bytes()],
        bump = milestone_escrow.bump
    )]
    pub milestone_escrow: Account<'info, MilestoneEscrow>,
    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub provider_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateVaultSecurity<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"agent_vault", owner.key().as_ref(), &agent_vault.vault_id.to_le_bytes()],
        bump = agent_vault.bump
    )]
    pub agent_vault: Account<'info, AgentVault>,
}

#[event]
pub struct AgentVaultInitializedEvent {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub session_delegate: Pubkey,
    pub token_mint: Pubkey,
    pub max_per_tx: u64,
    pub daily_spend_cap: u64,
    pub session_expiry_ts: i64,
}

#[event]
pub struct X402SettlementEvent {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub resource_hash: [u8; 32],
    pub invoice_nonce: u64,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneEscrowCreatedEvent {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub provider: Pubkey,
    pub verifier: Pubkey,
    pub amount: u64,
    pub expected_deliverable_hash: [u8; 32],
    pub deadline_ts: i64,
}

#[event]
pub struct MilestoneEscrowReleasedEvent {
    pub escrow: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub deliverable_hash: [u8; 32],
}

#[event]
pub struct SessionKeyRevokedEvent {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub paused: bool,
}

#[error_code]
pub enum SolGuardError {
    #[msg("Guardrail limit must be greater than zero")]
    InvalidGuardrailLimit,
    #[msg("Daily spend cap cannot be smaller than per-transaction limit")]
    DailyCapBelowPerTxLimit,
    #[msg("Allowed recipients list exceeds MAX_ALLOWED_RECIPIENTS (8)")]
    TooManyAllowedRecipients,
    #[msg("Session key has expired")]
    SessionKeyExpired,
    #[msg("Agent vault is currently paused by the owner")]
    VaultPaused,
    #[msg("Settlement or escrow amount must be greater than zero")]
    ZeroSettlementAmount,
    #[msg("Signer is neither the vault owner nor the authorized session delegate")]
    UnauthorizedSigner,
    #[msg("Recipient is not in the vault's allowlist")]
    RecipientNotAllowlisted,
    #[msg("Payment exceeds the vault's per-transaction spend cap")]
    ExceedsPerTxSpendCap,
    #[msg("Payment exceeds the vault's 24-hour rolling spend cap")]
    ExceedsDailySpendCap,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Escrow deadline must be in the future")]
    InvalidDeadline,
    #[msg("Escrow is not in the active Funded state")]
    EscrowNotActive,
    #[msg("Submitted deliverable SHA-256 hash does not match expected hash")]
    DeliverableHashMismatch,
}
