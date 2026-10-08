//! Ballast's events, decoded from transaction logs (§25): the floor's history is rebuilt from them,
//! so "F never fell" is checked across every instruction ever sent, not just at one moment.

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AnchorDeserialize, Discriminator};
use base64::Engine;

/// One decoded event for the launch being verified.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Registered {
        predicted_s: u128,
        slot: u64,
    },
    Settled {
        migration_fee: u64,
        partner_fees: u64,
    },
    LeftoverBurned {
        amount: u64,
        surplus: u64,
    },
    Opened {
        s_open: u128,
        predicted_s: u128,
        bin: i32,
        committed: u64,
    },
    Refreshed {
        s_new: u128,
        filled: u64,
        burned: u64,
        quote_returned: u64,
        bin: i32,
    },
    Redeemed {
        s_before: u128,
        s_after: u128,
        amount: u64,
        payout: u64,
    },
    Harvested {
        s_new: u128,
        to_vault: u64,
        to_treasury: u64,
    },
    Deposited {
        s_new: u128,
        amount: u64,
    },
    CreatorPaid {
        dbc_fees: u64,
        lp_fees: u64,
    },
    BidCapped {
        bin: i32,
    },
    BidSuspended {
        active_bin: i32,
    },
    BackingDecreased {
        position: Pubkey,
        l_recorded: u128,
        l_read: u128,
    },
}

impl Event {
    /// The `s` this event leaves behind (the instruction's monotone-checked end value).
    pub fn s(&self) -> Option<u128> {
        match self {
            Event::Opened { s_open, .. } => Some(*s_open),
            Event::Refreshed { s_new, .. }
            | Event::Harvested { s_new, .. }
            | Event::Deposited { s_new, .. } => Some(*s_new),
            Event::Redeemed { s_after, .. } => Some(*s_after),
            _ => None,
        }
    }
}

fn try_event<T: AnchorDeserialize + Discriminator>(data: &[u8]) -> Option<T> {
    if data.len() < 8 || &data[..8] != T::DISCRIMINATOR {
        return None;
    }
    T::deserialize(&mut &data[8..]).ok()
}

fn decode(data: &[u8], launch: &Pubkey) -> Option<Event> {
    use ::ballast::{
        BackingDecreased, BidCapped, BidSuspended, CreatorPaid, Deposited, FloorOpened,
        FloorRefreshed, GraduationSettled, Harvested, LaunchRegistered, LeftoverBurned, Redeemed,
    };
    if let Some(e) = try_event::<LaunchRegistered>(data) {
        return (e.launch == *launch).then_some(Event::Registered {
            predicted_s: e.predicted_s,
            slot: e.slot,
        });
    }
    if let Some(e) = try_event::<GraduationSettled>(data) {
        return (e.launch == *launch).then_some(Event::Settled {
            migration_fee: e.migration_fee,
            partner_fees: e.partner_fees,
        });
    }
    if let Some(e) = try_event::<LeftoverBurned>(data) {
        return (e.launch == *launch).then_some(Event::LeftoverBurned {
            amount: e.amount,
            surplus: e.surplus,
        });
    }
    if let Some(e) = try_event::<FloorOpened>(data) {
        return (e.launch == *launch).then_some(Event::Opened {
            s_open: e.s_open,
            predicted_s: e.predicted_s,
            bin: e.bin_id,
            committed: e.committed,
        });
    }
    if let Some(e) = try_event::<FloorRefreshed>(data) {
        return (e.launch == *launch).then_some(Event::Refreshed {
            s_new: e.s_new,
            filled: e.filled_tokens,
            burned: e.burned,
            quote_returned: e.quote_returned,
            bin: e.bin_id,
        });
    }
    if let Some(e) = try_event::<Redeemed>(data) {
        return (e.launch == *launch).then_some(Event::Redeemed {
            s_before: e.s_before,
            s_after: e.s_after,
            amount: e.amount,
            payout: e.payout,
        });
    }
    if let Some(e) = try_event::<Harvested>(data) {
        return (e.launch == *launch).then_some(Event::Harvested {
            s_new: e.s_new,
            to_vault: e.to_vault,
            to_treasury: e.to_treasury,
        });
    }
    if let Some(e) = try_event::<Deposited>(data) {
        return (e.launch == *launch).then_some(Event::Deposited {
            s_new: e.s_new,
            amount: e.amount,
        });
    }
    if let Some(e) = try_event::<CreatorPaid>(data) {
        return (e.launch == *launch).then_some(Event::CreatorPaid {
            dbc_fees: e.dbc_fees,
            lp_fees: e.lp_fees,
        });
    }
    if let Some(e) = try_event::<BidCapped>(data) {
        return (e.launch == *launch).then_some(Event::BidCapped { bin: e.bin });
    }
    if let Some(e) = try_event::<BidSuspended>(data) {
        return (e.launch == *launch).then_some(Event::BidSuspended {
            active_bin: e.active_bin,
        });
    }
    if let Some(e) = try_event::<BackingDecreased>(data) {
        return (e.launch == *launch).then_some(Event::BackingDecreased {
            position: e.position,
            l_recorded: e.l_recorded,
            l_read: e.l_read,
        });
    }
    None
}

/// The launch's events in one transaction's logs, in order. Only `Program data:` lines logged
/// while Ballast itself is executing count — a CPI'd program or a caller cannot forge them.
pub fn parse(logs: &[String], program: &Pubkey, launch: &Pubkey) -> Vec<Event> {
    let me = program.to_string();
    let mut stack: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for line in logs {
        if let Some(rest) = line.strip_prefix("Program ") {
            if let Some((id, tail)) = rest.split_once(' ') {
                if tail.starts_with("invoke [") {
                    stack.push(id.to_string());
                    continue;
                }
                if (tail == "success" || tail.starts_with("failed"))
                    && stack.last().map(|s| s == id).unwrap_or(false)
                {
                    stack.pop();
                    continue;
                }
            }
        }
        if let Some(b64) = line.strip_prefix("Program data: ") {
            if stack.last().map(|s| s == &me).unwrap_or(false) {
                if let Ok(data) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                    if let Some(e) = decode(&data, launch) {
                        out.push(e);
                    }
                }
            }
        }
    }
    out
}
