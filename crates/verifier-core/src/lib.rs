//! `verifier-core` (§20): check a Ballast launch from raw chain data alone.
//!
//! Every number is re-derived with the shared `ballast-floor` crate from accounts fetched over
//! plain JSON-RPC; the prediction and the config hash are recomputed from the DBC config by this
//! crate's own code; the floor's history is rebuilt from the program's events. Nothing here calls a
//! Ballast app or API — a judge needs only an RPC URL.

pub mod events;
pub mod layout;
pub mod ledger;
pub mod predict;
pub mod rpc;
pub mod scan;
pub mod verify;

pub use rpc::Rpc;
pub use verify::{verify, Options, Report, Status};

#[derive(Debug)]
pub enum Error {
    /// The RPC failed or answered something unreadable.
    Rpc(String),
    /// An account that must exist does not (never read as zero, D-012).
    Missing(String),
    /// An account is not the type or layout it must be.
    Layout(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Rpc(e) => write!(f, "RPC: {e}"),
            Error::Missing(e) => write!(f, "missing: {e}"),
            Error::Layout(e) => write!(f, "layout: {e}"),
        }
    }
}

impl std::error::Error for Error {}
