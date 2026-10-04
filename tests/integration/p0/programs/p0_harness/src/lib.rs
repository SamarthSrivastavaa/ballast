//! P0 harness — a test harness, NOT `programs/ballast` (the P0 gate rule allows nothing more).
//!
//! It owns the PDAs that stand in for Ballast's `partner_auth` (DBC fee_claimer and
//! leftover_receiver, DLMM limit-order owner), `creator_auth` (DBC pool creator) and `vault`, and
//! exposes one instruction, `proxy`, which re-issues arbitrary instructions as CPIs signed by
//! those PDAs. The SDKs build the real Meteora instruction with the PDA as signer/owner; the proxy
//! is what makes "can a PDA do X via CPI?" (Q4, Q5, Q8) a real question asked of the real
//! mainnet binaries rather than an assumption.
//!
//! **Deliberately unrestricted:** anyone may make the harness PDAs sign anything. That is fine
//! for a local-validator harness and is exactly what `programs/ballast` must never do.
//!
//! `proxy` takes several calls so one instruction can carry a whole sequence (Q18 measures
//! cancel + burn + transfer + place in a single instruction).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

declare_id!("8NXYd5YYAw8GhS3oNYSY98yovznADBoLroTGuSvNrnqu");

/// Seed prefixes; a harness PDA is `[prefix, key, bump]`. Mirrors §19's "derive partner_auth from
/// the config address": `key` is the account the PDA is scoped to.
pub const PARTNER_AUTH: &[u8] = b"partner_auth";
pub const CREATOR_AUTH: &[u8] = b"creator_auth";
pub const VAULT: &[u8] = b"vault";

#[program]
pub mod p0_harness {
    use super::*;

    /// Execute `calls` in order. Each call's accounts are indices into `remaining_accounts`.
    pub fn proxy<'info>(
        ctx: Context<'_, '_, 'info, 'info, Proxy>,
        calls: Vec<Call>,
    ) -> Result<()> {
        let accs = ctx.remaining_accounts;
        for call in &calls {
            let program = accs.get(call.program as usize).ok_or(HarnessError::BadIndex)?;
            let mut metas = Vec::with_capacity(call.accounts.len());
            let mut infos = Vec::with_capacity(call.accounts.len() + 1);
            for a in &call.accounts {
                let info = accs.get(a.index as usize).ok_or(HarnessError::BadIndex)?;
                metas.push(AccountMeta {
                    pubkey: *info.key,
                    is_signer: a.is_signer,
                    is_writable: a.is_writable,
                });
                infos.push(info.clone());
            }
            infos.push(program.clone());

            let bumps: Vec<[u8; 1]> = call.signers.iter().map(|s| [s.bump]).collect();
            let mut seeds: Vec<[&[u8]; 3]> = Vec::with_capacity(call.signers.len());
            for (s, bump) in call.signers.iter().zip(bumps.iter()) {
                seeds.push([prefix(s.kind)?, s.key.as_ref(), bump.as_ref()]);
            }
            let seed_refs: Vec<&[&[u8]]> = seeds.iter().map(|s| s.as_slice()).collect();

            let ix = Instruction {
                program_id: *program.key,
                accounts: metas,
                data: call.data.clone(),
            };
            invoke_signed(&ix, &infos, &seed_refs)?;
        }
        Ok(())
    }
}

fn prefix(kind: u8) -> Result<&'static [u8]> {
    match kind {
        0 => Ok(PARTNER_AUTH),
        1 => Ok(CREATOR_AUTH),
        2 => Ok(VAULT),
        _ => err!(HarnessError::BadPdaKind),
    }
}

#[derive(Accounts)]
pub struct Proxy {}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Call {
    /// Index of the target program in `remaining_accounts`.
    pub program: u8,
    pub accounts: Vec<Acct>,
    pub data: Vec<u8>,
    /// Harness PDAs that sign this call.
    pub signers: Vec<PdaSigner>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Acct {
    pub index: u8,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PdaSigner {
    /// 0 = partner_auth, 1 = creator_auth, 2 = vault.
    pub kind: u8,
    pub key: Pubkey,
    pub bump: u8,
}

#[error_code]
pub enum HarnessError {
    #[msg("account index out of range")]
    BadIndex,
    #[msg("unknown PDA kind")]
    BadPdaKind,
}
