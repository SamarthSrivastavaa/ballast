import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import idl from "./ballast.json";
import { loadFloor, type Floor } from "../../sdk/typescript/src/floor";
import { buildRedeemTx, explorerUrl, loadModel, REDEEM_FEE_BPS, type Model } from "./model";

const HEADLINE_A = "This is an executable buyback floor on Meteora,";
const HEADLINE_B = "not a promise about prices elsewhere.";
const LIMITS =
  "F is in SOL, not dollars. Selling directly on DAMM v2 can execute below F; the bid and redemption don't. Late buyers can lose most of what they paid.";

export function rpcFromUrl(): string {
  return new URLSearchParams(window.location.search).get("rpc") ?? "http://127.0.0.1:8899";
}

const sol = (x: number) => (x === 0 ? "0" : x < 1e-6 ? x.toExponential(4) : x.toLocaleString(undefined, { maximumFractionDigits: 9 }));
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const clusterName = (rpc: string) => (rpc.includes("devnet") ? "Devnet" : rpc.includes("mainnet") ? "Mainnet" : "Local validator");

/** One labelled price: the label says which of §9's six prices the value is. */
function Price({ label, value, note, hero }: { label: string; value: number | null; note?: ReactNode; hero?: boolean }) {
  return (
    <div className={hero ? "figure hero-figure" : "figure"}>
      <div className="label">{label}</div>
      <div className="value">
        {value === null ? "—" : sol(value)} {value !== null && <span className="unit">SOL/token</span>}
      </div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: ReactNode }) {
  return (
    <div className="figure">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

/** One step of the hero's timeline: which product, what happened, the figures, a link to check it. */
function Step({ tone, where, href, title, facts }: { tone: "teal" | "amber" | "blue"; where: string; href?: string; title: string; facts: [string, string][] }) {
  return (
    <li className={`step ${tone}`}>
      <div className="where">
        {where}
        {href && (
          <a href={href} target="_blank" rel="noreferrer">
            View
          </a>
        )}
      </div>
      <div className="what">{title}</div>
      <div className="facts">
        {facts.map(([k, v]) => (
          <span key={k}>
            <i>{k}</i> {v}
          </span>
        ))}
      </div>
    </li>
  );
}

export function App() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const launchParam = useMemo(() => new URLSearchParams(window.location.search).get("launch"), []);
  const [floor, setFloor] = useState<Floor | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [minOut, setMinOut] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch("/floor_wasm.wasm").then((r) => r.arrayBuffer()).then(loadFloor).then(setFloor, (e) => setError(String(e)));
  }, []);

  const refresh = useCallback(async () => {
    if (!floor || !launchParam) return;
    try {
      setModel(await loadModel(connection, idl, new PublicKey(launchParam), floor));
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [connection, floor, launchParam]);
  useEffect(() => void refresh(), [refresh]);

  // Redemption quote from the floor crate: ⌊T·s²·(1 − 0.5%)/2^128⌋ (§10).
  const baseUnits = useMemo(() => {
    const t = Number(amount);
    return Number.isFinite(t) && t > 0 ? BigInt(Math.floor(t * 1e6)) : 0n;
  }, [amount]);
  const payout = model && floor && baseUnits > 0n ? floor.payout(baseUnits, model.s, REDEEM_FEE_BPS) : 0n;
  const minOutLamports = minOut === null ? payout : BigInt(Math.floor(Number(minOut) * 1e9));

  const redeem = async () => {
    if (!wallet.publicKey || !model || baseUnits === 0n) return;
    try {
      setStatus("building…");
      const { tx, order } = await buildRedeemTx(connection, idl, model.launch, wallet.publicKey, baseUnits, minOutLamports);
      tx.sign([order]);
      const sig = await wallet.sendTransaction(tx, connection);
      setStatus(`sent ${sig}`);
      await connection.confirmTransaction(sig, "confirmed");
      setStatus(`redeemed: ${sig}`);
      await refresh();
    } catch (e) {
      setStatus(`refused: ${String((e as Error).message ?? e)}`);
    }
  };

  const rpc = connection.rpcEndpoint;
  const addr = (a: string, text?: string) => (
    <a href={explorerUrl(rpc, "address", a)} target="_blank" rel="noreferrer">
      {text ?? a}
    </a>
  );
  const tx = (id: string | null) =>
    id ? (
      <a href={explorerUrl(rpc, "tx", id)} target="_blank" rel="noreferrer">
        {id.slice(0, 16)}…
      </a>
    ) : (
      "—"
    );
  const m = model;
  const a = m?.proof.addresses;
  const bidState = !m ? "" : m.bid.suspended ? "Bid suspended" : m.bid.restingSol === 0 ? "No bid resting" : m.bid.capped ? "Bid capped below F's bin" : "Bid resting at F's bin or just under";

  const ticker: string[] = m
    ? [
        `Floor F ${sol(m.prices.F)} SOL/token`,
        `DAMM v2 price ${sol(m.prices.damm)}`,
        `Price ÷ F ${(m.prices.damm / m.prices.F).toFixed(3)}×`,
        ...(m.prices.bidBin !== null ? [`Bid bin price ${sol(m.prices.bidBin)}`, `${sol(m.bid.restingSol)} SOL resting in bin ${m.bid.binId}`] : [bidState]),
        `Redemption ${sol(m.prices.redemption)} (F less 0.5%)`,
        `Locked pool absorbs ${pct(m.composition.lockedPool)} of supply at F`,
        `Predicted ${sol(m.predictedF)} before any third-party trade`,
      ]
    : ["Every number on this page is read from chain", "F comes from the floor crate, never from this page", "Check it with ballast verify"];

  return (
    <div className="page" id="top">
      <nav className="top">
        <a className="brand" href="#top">
          <span className="mark" />
          Ballast
        </a>
        <div className="links">
          <a href="#floor">Floor</a>
          <a href="#bid">Bid</a>
          <a href="#redeem">Redeem</a>
          <a href="#proof">Proof</a>
          <a href="#limits">Limits</a>
        </div>
        <div className="right">
          <span className="cluster">
            <i className="dot" />
            {clusterName(rpc)}
          </span>
          <WalletMultiButton />
        </div>
      </nav>

      <div className="sub">
        {m && a ? (
          <>
            <span>
              <i>Launch</i> {addr(a.launch, short(a.launch))}
            </span>
            <span>
              <i>Mint</i> {addr(a["base mint"], short(a["base mint"]))}
            </span>
            <span className="push">Read from chain by this page · no backend</span>
          </>
        ) : (
          <span className="push">Read from chain by this page · no backend</span>
        )}
      </div>

      <div className="ticker" aria-hidden="true">
        <div className="track">
          {[...ticker, ...ticker].map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
      </div>

      <header className="hero">
        <div className="pitch">
          <div className="eyebrow">Executable buyback floor · Meteora</div>
          <h1>
            {HEADLINE_A} <span>{HEADLINE_B}</span>
          </h1>
          <p className="lede dim">
            F is the price at which the locked DAMM v2 liquidity and the vault's DLMM bid can together absorb every outstanding token.
          </p>
          <p className="lede">
            It is predicted on-chain in the pool-creation transaction, before any third-party trade, and anyone can recompute it from raw
            accounts.
          </p>
          <div className="cta">
            <a className="btn solid" href="#redeem">
              Redeem at F less 0.5%
            </a>
            <a className="btn" href="#proof">
              Verify it yourself
            </a>
          </div>
          {m && a && (
            <div className="meta">
              <div>
                <i>Launch curve · DBC</i>
                {addr(a["DBC pool"], short(a["DBC pool"]))}
              </div>
              <div>
                <i>Locked liquidity · DAMM v2</i>
                {addr(a["DAMM v2 pool"], short(a["DAMM v2 pool"]))}
              </div>
              <div>
                <i>Vault bid · DLMM</i>
                {addr(a["DLMM pair"], short(a["DLMM pair"]))}
              </div>
            </div>
          )}
        </div>

        <div className="trail">
          <div className="eyebrow">One launch, end to end</div>
          {!launchParam ? (
            <p className="lede dim">
              Open a launch: <code>?launch=&lt;launch address&gt;&amp;rpc=&lt;rpc url&gt;</code>
            </p>
          ) : !m ? (
            <p className="lede dim">{error ? "The launch could not be read." : "Reading the launch from chain…"}</p>
          ) : (
            <>
              <ol className="steps">
                <Step
                  tone="teal"
                  where="DBC"
                  href={m.proof.predictionTx ? explorerUrl(rpc, "tx", m.proof.predictionTx) : undefined}
                  title="The floor is predicted"
                  facts={[
                    ["Predicted F", sol(m.predictedF)],
                    ["In", "the pool-creation transaction"],
                  ]}
                />
                <Step
                  tone="teal"
                  where="DAMM v2"
                  href={explorerUrl(rpc, "address", a!["DAMM v2 pool"])}
                  title="The liquidity is locked"
                  facts={[
                    ["Positions", "2, permanent"],
                    ["Absorbs at F", pct(m.composition.lockedPool)],
                  ]}
                />
                <Step
                  tone="teal"
                  where="Ballast"
                  href={m.proof.openTx ? explorerUrl(rpc, "tx", m.proof.openTx) : undefined}
                  title="The floor opens"
                  facts={[
                    ["F at open", sol(m.openF)],
                    ["Vs prediction", `${m.openF >= m.predictedF ? "+" : ""}${((m.openF / m.predictedF - 1) * 100).toFixed(2)}%`],
                  ]}
                />
                <Step
                  tone={m.bid.suspended || m.bid.capped ? "amber" : "blue"}
                  where="DLMM"
                  href={explorerUrl(rpc, "address", a!["DLMM pair"])}
                  title={m.bid.suspended ? "The bid is suspended" : m.bid.restingSol === 0 ? "No bid is resting" : "The vault rests as one bid"}
                  facts={
                    m.bid.restingSol === 0
                      ? [["Vault", m.bid.suspended ? "unplaced, still counted in F" : "empty"]]
                      : [
                          ["Bin", String(m.bid.binId)],
                          ["Resting", `${sol(m.bid.restingSol)} SOL`],
                        ]
                  }
                />
                <Step
                  tone="blue"
                  where="Now"
                  title="The floor today"
                  facts={[
                    ["Floor F", sol(m.prices.F)],
                    ["Vs open", `${m.prices.F >= m.openF ? "+" : ""}${((m.prices.F / m.openF - 1) * 100).toFixed(2)}%`],
                  ]}
                />
              </ol>
              <p className="caption">Read from this launch's accounts a moment ago. Prices are in SOL per token. Every step links to an explorer.</p>
            </>
          )}
        </div>
      </header>

      {error && <p className="banner error">{error}</p>}
      {m && !m.floorMatches && (
        <p className="banner error">The program's floor() and the floor crate disagree on these accounts — F is not shown as verified.</p>
      )}

      {m && a && (
        <>
          <div className="statusline">
            <span>
              <i className="dot" />
              Open
            </span>
            <span>{bidState}</span>
            <span>
              floor() {m.floorMatches ? "=" : "≠"} floor crate on the same accounts
            </span>
            <a className="push" href="#proof">
              Check it without this page →
            </a>
          </div>

          <main>
            <section id="floor" className="intro">
              <div>
                <div className="eyebrow">The floor, now</div>
                <h2>Six prices, each one named.</h2>
              </div>
              <p>
                A token has more than one price. F is theoretical; what you receive depends on where you sell. Every figure on this page says
                which of the six it is.
              </p>
            </section>

            <p className="token">
              Token: <b>{m.token ? `${m.token.name} (${m.token.symbol})` : "unnamed"}</b> {addr(m.baseMint.toBase58())}
            </p>

            <section className="figures lead">
              <Price hero label="Floor F (theoretical floor)" value={m.prices.F} note={`Predicted before any third-party trade: ${sol(m.predictedF)}`} />
              <Price label="Market price (DAMM v2 price)" value={m.prices.damm} />
              <Stat label="Price ÷ F" value={`${(m.prices.damm / m.prices.F).toFixed(3)}×`} />
              <Stat label="Max loss if you buy now (in SOL terms)" value={pct(m.maxLossIfBuyNow)} note="1 − F ÷ DAMM v2 price" />
            </section>

            <section className="composition">
              <div className="eyebrow">Floor composition at F</div>
              <p>
                Locked DAMM v2 liquidity absorbs <b>{pct(m.composition.lockedPool)}</b> of outstanding supply; the vault's DLMM bid absorbs{" "}
                <b>{pct(m.composition.vaultBid)}</b>.
              </p>
              <div
                className="meter"
                role="img"
                aria-label={`Locked pool ${pct(m.composition.lockedPool)}, vault bid ${pct(m.composition.vaultBid)} of outstanding supply at F`}
                title={`Locked pool ${pct(m.composition.lockedPool)} · vault bid ${pct(m.composition.vaultBid)}`}
              >
                <div className="fill" style={{ width: `${Math.min(100, m.composition.lockedPool * 100)}%` }} />
              </div>
              <div className="legend">
                <span>
                  <i className="swatch fill" />
                  Locked pool {pct(m.composition.lockedPool)}
                </span>
                <span>
                  <i className="swatch track" />
                  Vault bid {pct(m.composition.vaultBid)}
                </span>
              </div>
            </section>

            <div className="pair">
              <section id="bid">
                <h3>
                  <i>01</i> Bid wall
                </h3>
                <p className="q">Where does the vault buy?</p>
                {m.bid.suspended ? (
                  <p className="warn">
                    The DLMM bid is suspended: a third-party order holds the active bin more than 70 bins below F's bin, so the vault rests
                    unplaced. It still counts toward F, and redemption still pays F less 0.5%.
                  </p>
                ) : m.bid.restingSol === 0 ? (
                  <p>No bid is resting: the vault is empty.</p>
                ) : (
                  <>
                    {m.bid.capped && (
                      <p className="warn">
                        The bid is capped at the DLMM active bin, below F's bin, because a third-party order holds the active bin there. It is
                        still a bid at or below F; redemption still pays F less 0.5%.
                      </p>
                    )}
                    <div className="figures stack">
                      <Price label="Bid bin price" value={m.prices.bidBin} note={`bin ${m.bid.binId}, ${sol(m.bid.restingSol)} SOL resting`} />
                      <Price
                        label="You receive at least (executable bid, net)"
                        value={m.prices.bidNet}
                        note={`after DLMM's fee, ${m.bid.dlmmFeeBps} bps now (${m.bid.dlmmBaseFeeBps} bps base; it rises with volatility)`}
                      />
                      <Price label="DAMM v2 sell, net" value={m.prices.dammSellNet} note="at the current pool price, after the 1% pool fee" />
                    </div>
                  </>
                )}
                <div className="foot">
                  <span>DLMM limit order</span>
                  {addr(a["DLMM pair"], "See the pair →")}
                </div>
              </section>

              <section id="redeem">
                <h3>
                  <i>02</i> Redeem
                </h3>
                <p className="q">What does the program pay for a token?</p>
                <div className="figures stack">
                  <Price label="Redemption (F less 0.5%)" value={m.prices.redemption} note="the 0.5% stays in the vault and raises F" />
                </div>
                <label>
                  <span>Tokens to redeem</span>
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1000000" inputMode="decimal" />
                </label>
                <p className="payout">
                  Exact payout: <b>{sol(Number(payout) / 1e9)} SOL</b>
                  {payout > 0n && payout < 1_000_000n && " — below the 0.001 SOL minimum; the program will refuse it"}
                </p>
                <label>
                  <span>Minimum to receive (SOL)</span>
                  <input value={minOut ?? (Number(payout) / 1e9).toString()} onChange={(e) => setMinOut(e.target.value)} inputMode="decimal" />
                </label>
                <button className="btn solid" disabled={!wallet.publicKey || baseUnits === 0n} onClick={redeem}>
                  {wallet.publicKey ? "Redeem" : "Connect a wallet to redeem"}
                </button>
                {status && <p className="note status">{status}</p>}
                <div className="foot">
                  <span>Atomic: cancel, burn, pay, re-place</span>
                  {addr(a.vault, "See the vault →")}
                </div>
              </section>
            </div>

            <section id="proof">
              <div className="intro">
                <div>
                  <div className="eyebrow">Proof</div>
                  <h2>Check it without this page.</h2>
                </div>
                <p>The verifier recomputes the prediction, F, its whole history and the vault's ledger from raw accounts. It needs an RPC URL and nothing from Ballast.</p>
              </div>
              <pre>ballast verify {m.launch.toBase58()} --rpc {rpc}</pre>
              <table>
                <tbody>
                  <tr>
                    <td>Prediction (register_launch, in the pool-creation transaction)</td>
                    <td>{tx(m.proof.predictionTx)}</td>
                  </tr>
                  <tr>
                    <td>open</td>
                    <td>{tx(m.proof.openTx)}</td>
                  </tr>
                  {Object.entries(a).map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{addr(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section id="limits" className="limits">
              <div className="eyebrow">Limits</div>
              <p>{LIMITS}</p>
            </section>
          </main>
        </>
      )}

      <footer>
        <span>Ballast</span>
        <span>An executable buyback floor on Meteora: DBC, DAMM v2, DLMM</span>
        <span className="push">Every number is read from chain; F comes from the floor crate</span>
      </footer>
    </div>
  );
}
