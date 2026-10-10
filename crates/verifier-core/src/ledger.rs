//! §10's accounting ledger, re-run from chain data: every lamport backing the floor is accounted
//! for by a counter the program wrote in the instruction that moved it, and every counter by the
//! events of those instructions. Pure arithmetic; `verify` feeds it the raw accounts.

use ballast::state::Launch;

/// The quote flows of one launch, in lamports. Inflows: the migration fee and partner trading fees
/// (`settle_graduation`), the partner surplus (`burn_leftover`), harvested LP fees net of the
/// treasury's share (`harvest`) and deposits. Outflows — the vault's only two exits (§10): quote
/// the bid spent on fills, and redemption payouts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct QuoteLedger {
    pub migration_fee: u64,
    pub partner_fees: u64,
    pub surplus: u64,
    pub harvested: u64,
    pub deposited: u64,
    pub fill_quote_spent: u64,
    pub redeemed_lamports: u64,
}

impl QuoteLedger {
    pub fn from_launch(l: &Launch) -> Self {
        Self {
            migration_fee: l.migration_fee,
            partner_fees: l.partner_fees,
            surplus: l.surplus,
            harvested: l.harvested,
            deposited: l.deposited,
            fill_quote_spent: l.fill_quote_spent,
            redeemed_lamports: l.redeemed_lamports,
        }
    }

    pub fn inflows(&self) -> Option<u64> {
        self.migration_fee
            .checked_add(self.partner_fees)?
            .checked_add(self.surplus)?
            .checked_add(self.harvested)?
            .checked_add(self.deposited)
    }

    pub fn outflows(&self) -> Option<u64> {
        self.fill_quote_spent.checked_add(self.redeemed_lamports)
    }

    /// V the counters account for: inflows less outflows. `None` if they do not reconcile at all.
    pub fn expected_v(&self) -> Option<u64> {
        self.inflows()?.checked_sub(self.outflows()?)
    }

    /// Live V (vault + resting bid) less the V the counters account for. `Some(0)`: reconciled to
    /// the lamport. `Some(x)`: x lamports reached the vault outside any instruction — a transfer
    /// straight to the vault account, or DLMM fee credits above a cancel's fills; they back the
    /// floor like any other. `None`: quote is missing, which is a failure.
    pub fn quote_excess(&self, v: u64) -> Option<u64> {
        v.checked_sub(self.expected_v()?)
    }

    /// Base units that left the supply outside the program: `minted − burned − supply`. `Some(0)`:
    /// reconciled. `Some(x)`: holders burned x of their own. `None`: more supply exists than was
    /// minted less burned, which cannot happen once the mint authority is removed.
    pub fn token_excess(minted: u64, supply: u64, burned: u64) -> Option<u64> {
        minted.checked_sub(burned)?.checked_sub(supply)
    }
}

/// The same flows summed from the program's events over the launch's whole history.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EventTotals {
    pub migration_fee: u64,
    pub partner_fees: u64,
    pub surplus: u64,
    pub harvested: u64,
    pub deposited: u64,
    pub redeemed_lamports: u64,
}

/// Every counter that has an event equals the sum of its events. (`fill_quote_spent` has none of
/// its own: it is bounded by the vault identity instead.)
pub fn event_totals_match(l: &QuoteLedger, e: &EventTotals) -> bool {
    l.migration_fee == e.migration_fee
        && l.partner_fees == e.partner_fees
        && l.surplus == e.surplus
        && l.harvested == e.harvested
        && l.deposited == e.deposited
        && l.redeemed_lamports == e.redeemed_lamports
}
