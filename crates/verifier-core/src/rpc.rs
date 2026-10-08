//! The only reads the verifier makes: standard Solana JSON-RPC, against whatever RPC URL the user
//! names. No Ballast service is contacted, ever (§20).

use anchor_lang::prelude::Pubkey;
use base64::Engine;
use serde_json::{json, Value};

use crate::Error;

pub struct Rpc {
    url: String,
    agent: ureq::Agent,
}

/// A raw account as the chain holds it.
#[derive(Clone, Debug)]
pub struct Account {
    pub owner: Pubkey,
    pub lamports: u64,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct SigInfo {
    pub signature: String,
    pub slot: u64,
    pub failed: bool,
}

/// The parts of a confirmed transaction the checks read.
#[derive(Clone, Debug, Default)]
pub struct Tx {
    pub slot: u64,
    pub failed: bool,
    pub logs: Vec<String>,
    pub fee: u64,
    /// Every account key, loaded addresses included, in message order.
    pub keys: Vec<Pubkey>,
    pub pre_lamports: Vec<u64>,
    pub post_lamports: Vec<u64>,
    /// `(account index, mint, owner, amount)` before and after.
    pub pre_tokens: Vec<(usize, Pubkey, Pubkey, u64)>,
    pub post_tokens: Vec<(usize, Pubkey, Pubkey, u64)>,
    /// Every instruction, top-level then inner: `(program, accounts, data)`.
    pub instructions: Vec<(Pubkey, Vec<Pubkey>, Vec<u8>)>,
}

fn key(v: &Value) -> Result<Pubkey, Error> {
    v.as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| Error::Rpc(format!("not a pubkey: {v}")))
}

impl Rpc {
    pub fn new(url: &str) -> Self {
        Rpc {
            url: url.to_string(),
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(60))
                .build(),
        }
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, Error> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let mut last = String::new();
        for attempt in 0..4 {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(400 << attempt));
            }
            match self.agent.post(&self.url).send_json(body.clone()) {
                Ok(resp) => {
                    let v: Value = resp
                        .into_json()
                        .map_err(|e| Error::Rpc(format!("{method}: {e}")))?;
                    if let Some(err) = v.get("error") {
                        return Err(Error::Rpc(format!("{method}: {err}")));
                    }
                    return Ok(v["result"].clone());
                }
                // Rate limits and transient failures are retried; anything else is final.
                Err(ureq::Error::Status(code, _)) if code == 429 || code >= 500 => {
                    last = format!("HTTP {code}");
                }
                Err(e) => return Err(Error::Rpc(format!("{method}: {e}"))),
            }
        }
        Err(Error::Rpc(format!("{method}: {last} after retries")))
    }

    fn decode_account(v: &Value) -> Result<Option<Account>, Error> {
        if v.is_null() {
            return Ok(None);
        }
        let data = v["data"][0]
            .as_str()
            .ok_or_else(|| Error::Rpc("account data not base64".into()))?;
        Ok(Some(Account {
            owner: key(&v["owner"])?,
            lamports: v["lamports"].as_u64().unwrap_or(0),
            data: base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|e| Error::Rpc(format!("base64: {e}")))?,
        }))
    }

    pub fn account(&self, k: &Pubkey) -> Result<Option<Account>, Error> {
        let r = self.call(
            "getAccountInfo",
            json!([k.to_string(), { "encoding": "base64", "commitment": "confirmed" }]),
        )?;
        Self::decode_account(&r["value"])
    }

    /// The account, or an error naming what was expected there (a missing account is never 0).
    pub fn must(&self, k: &Pubkey, what: &str) -> Result<Account, Error> {
        self.account(k)?
            .ok_or_else(|| Error::Missing(format!("{what} {k}")))
    }

    pub fn slot(&self) -> Result<u64, Error> {
        self.call("getSlot", json!([{ "commitment": "confirmed" }]))?
            .as_u64()
            .ok_or_else(|| Error::Rpc("getSlot".into()))
    }

    /// Every signature touching `addr`, oldest first (paginated; at most `max`).
    pub fn signatures(&self, addr: &Pubkey, max: usize) -> Result<Vec<SigInfo>, Error> {
        let mut out = Vec::new();
        let mut before: Option<String> = None;
        loop {
            let mut opts = json!({ "limit": 1000, "commitment": "confirmed" });
            if let Some(b) = &before {
                opts["before"] = json!(b);
            }
            let page = self.call("getSignaturesForAddress", json!([addr.to_string(), opts]))?;
            let items = page.as_array().cloned().unwrap_or_default();
            for it in &items {
                out.push(SigInfo {
                    signature: it["signature"].as_str().unwrap_or_default().to_string(),
                    slot: it["slot"].as_u64().unwrap_or(0),
                    failed: !it["err"].is_null(),
                });
            }
            if items.len() < 1000 || out.len() >= max {
                break;
            }
            before = out.last().map(|s| s.signature.clone());
        }
        out.reverse();
        Ok(out)
    }

    /// One page of signatures touching `addr`, newest first, older than `before`.
    pub fn signatures_page(
        &self,
        addr: &Pubkey,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SigInfo>, Error> {
        let mut opts = json!({ "limit": limit.min(1000), "commitment": "confirmed" });
        if let Some(b) = before {
            opts["before"] = json!(b);
        }
        let page = self.call("getSignaturesForAddress", json!([addr.to_string(), opts]))?;
        Ok(page
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|it| SigInfo {
                signature: it["signature"].as_str().unwrap_or_default().to_string(),
                slot: it["slot"].as_u64().unwrap_or(0),
                failed: !it["err"].is_null(),
            })
            .collect())
    }

    /// Up to 100 accounts per call, in order (`None` where an account does not exist).
    pub fn accounts(&self, keys: &[Pubkey]) -> Result<Vec<Option<Account>>, Error> {
        let mut out = Vec::with_capacity(keys.len());
        for chunk in keys.chunks(100) {
            let r = self.call(
                "getMultipleAccounts",
                json!([chunk.iter().map(|k| k.to_string()).collect::<Vec<_>>(), { "encoding": "base64", "commitment": "confirmed" }]),
            )?;
            for v in r["value"].as_array().cloned().unwrap_or_default() {
                out.push(Self::decode_account(&v)?);
            }
        }
        Ok(out)
    }

    pub fn transaction(&self, sig: &str) -> Result<Option<Tx>, Error> {
        let r = self.call(
            "getTransaction",
            json!([sig, { "encoding": "json", "commitment": "confirmed", "maxSupportedTransactionVersion": 0 }]),
        )?;
        if r.is_null() {
            return Ok(None);
        }
        let meta = &r["meta"];
        let mut keys = Vec::new();
        for k in r["transaction"]["message"]["accountKeys"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            keys.push(key(&k)?);
        }
        for part in ["writable", "readonly"] {
            for k in meta["loadedAddresses"][part]
                .as_array()
                .cloned()
                .unwrap_or_default()
            {
                keys.push(key(&k)?);
            }
        }
        let u64s = |v: &Value| -> Vec<u64> {
            v.as_array()
                .map(|a| a.iter().map(|x| x.as_u64().unwrap_or(0)).collect())
                .unwrap_or_default()
        };
        let tokens = |v: &Value| -> Vec<(usize, Pubkey, Pubkey, u64)> {
            v.as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|t| {
                            Some((
                                t["accountIndex"].as_u64()? as usize,
                                t["mint"].as_str()?.parse().ok()?,
                                t["owner"].as_str()?.parse().ok()?,
                                t["uiTokenAmount"]["amount"].as_str()?.parse().ok()?,
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let decode_ix = |ix: &Value| -> Option<(Pubkey, Vec<Pubkey>, Vec<u8>)> {
            let program = *keys.get(ix["programIdIndex"].as_u64()? as usize)?;
            let accounts = ix["accounts"]
                .as_array()?
                .iter()
                .filter_map(|a| keys.get(a.as_u64()? as usize).copied())
                .collect();
            let data = bs58::decode(ix["data"].as_str()?).into_vec().ok()?;
            Some((program, accounts, data))
        };
        let mut instructions: Vec<(Pubkey, Vec<Pubkey>, Vec<u8>)> = r["transaction"]["message"]
            ["instructions"]
            .as_array()
            .map(|a| a.iter().filter_map(decode_ix).collect())
            .unwrap_or_default();
        for group in meta["innerInstructions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            for ix in group["instructions"]
                .as_array()
                .cloned()
                .unwrap_or_default()
            {
                if let Some(d) = decode_ix(&ix) {
                    instructions.push(d);
                }
            }
        }
        Ok(Some(Tx {
            instructions,
            slot: r["slot"].as_u64().unwrap_or(0),
            failed: !meta["err"].is_null(),
            logs: meta["logMessages"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|l| l.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            fee: meta["fee"].as_u64().unwrap_or(0),
            keys,
            pre_lamports: u64s(&meta["preBalances"]),
            post_lamports: u64s(&meta["postBalances"]),
            pre_tokens: tokens(&meta["preTokenBalances"]),
            post_tokens: tokens(&meta["postTokenBalances"]),
        }))
    }
}
