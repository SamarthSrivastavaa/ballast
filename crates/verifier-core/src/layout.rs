//! Decoders for the raw accounts the verifier reads. Ballast's own accounts are Anchor/borsh
//! (types from the program crate, discriminator checked); Meteora's are the vendored zero-copy
//! layouts (proven field-for-field against real accounts, Q12); SPL accounts are read by offset.

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AnchorDeserialize, Discriminator};

use crate::Error;

/// SPL Token, Token-2022 and the programs whose accounts the verifier accepts.
pub const TOKEN_PROGRAM: Pubkey =
    anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey =
    anchor_lang::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Pubkey =
    anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const WSOL: Pubkey = anchor_lang::pubkey!("So11111111111111111111111111111111111111112");

/// An Anchor account of type `T`: discriminator first, then borsh.
pub fn anchor<T: AnchorDeserialize + Discriminator>(data: &[u8], what: &str) -> Result<T, Error> {
    if data.len() < 8 || &data[..8] != T::DISCRIMINATOR {
        return Err(Error::Layout(format!("{what}: wrong discriminator")));
    }
    T::deserialize(&mut &data[8..]).map_err(|e| Error::Layout(format!("{what}: {e}")))
}

/// A Meteora zero-copy account: discriminator and exact size, then the packed struct.
pub fn meteora<T: bytemuck::Pod>(data: &[u8], disc: &[u8; 8], what: &str) -> Result<T, Error> {
    meteora_types::decode::<T>(data, disc)
        .copied()
        .ok_or_else(|| Error::Layout(format!("{what}: wrong discriminator or size")))
}

/// SPL mint: supply, mint authority, freeze authority (`COption` = u32 tag + key).
pub struct Mint {
    pub supply: u64,
    pub mint_authority: Option<Pubkey>,
    pub freeze_authority: Option<Pubkey>,
}

pub fn mint(data: &[u8]) -> Result<Mint, Error> {
    if data.len() < 82 {
        return Err(Error::Layout("mint: too short".into()));
    }
    let opt = |at: usize| -> Option<Pubkey> {
        (u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) == 1)
            .then(|| Pubkey::new_from_array(data[at + 4..at + 36].try_into().unwrap()))
    };
    Ok(Mint {
        mint_authority: opt(0),
        supply: u64::from_le_bytes(data[36..44].try_into().unwrap()),
        freeze_authority: opt(46),
    })
}

/// SPL token account: `(mint, owner, amount)`.
pub fn token(data: &[u8]) -> Result<(Pubkey, Pubkey, u64), Error> {
    if data.len() < 72 {
        return Err(Error::Layout("token account: too short".into()));
    }
    Ok((
        Pubkey::new_from_array(data[0..32].try_into().unwrap()),
        Pubkey::new_from_array(data[32..64].try_into().unwrap()),
        u64::from_le_bytes(data[64..72].try_into().unwrap()),
    ))
}

/// The associated token account of `owner` for `mint` (SPL Token).
pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
    .0
}

pub fn pk(b: [u8; 32]) -> Pubkey {
    Pubkey::new_from_array(b)
}
