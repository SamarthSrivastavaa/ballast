import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import idl from "./ballast.json";
import { loadFloor, type Floor } from "../../sdk/typescript/src/floor";
import { buildRedeemTx, explorerUrl, loadModel, REDEEM_FEE_BPS, type Model } from "./model";

const HEADLINE = "This is an executable buyback floor on Meteora, not a promise about prices elsewhere.";
const LIMITS =
  "F is in SOL, not dollars. Selling directly on DAMM v2 can execute below F; the bid and redemption don't. Late buyers can lose most of what they paid.";

export function rpcFromUrl(): string {
  return new URLSearchParams(window.location.search).get("rpc") ?? "http://127.0.0.1:8899";
}

const sol = (x: number) => (x === 0 ? "0" : x < 1e-6 ? x.toExponential(4) : x.toLocaleString(undefined, { maximumFractionDigits: 9 }));
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

function Price({ label, value, note }: { label: string; value: number | null; note?: string }) {
  return (
    <div className="price">
      <div className="label">{label}</div>
      <div className="value">{value === null ? "—" : `${sol(value)} SOL/token`}</div>
      {note && <div className="note">{note}</div>}
    </div>
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

  if (!launchParam) {
    return (
      <main>
        <h1>Ballast</h1>
        <p className="headline">{HEADLINE}</p>
        <p>Open a launch: <code>?launch=&lt;launch address&gt;&amp;rpc=&lt;rpc url&gt;</code></p>
      </main>
    );
  }
  const rpc = connection.rpcEndpoint;
  const tx = (id: string | null) => (id ? <a href={explorerUrl(rpc, "tx", id)} target="_blank" rel="noreferrer">{id.slice(0, 16)}…</a> : "—");

  return (
    <main>
      <header>
        <h1>Ballast floor</h1>
        <WalletMultiButton />
      </header>
      <p className="headline">{HEADLINE}</p>
      {error && <p className="error">{error}</p>}
      {model && (
        <>
          {!model.floorMatches && (
            <p className="error">The program's floor() and the floor crate disagree on these accounts — F is not shown as verified.</p>
          )}
          <section className="grid">
            <Price label="Market price (DAMM v2 price)" value={model.prices.damm} />
            <Price label="Floor F (theoretical floor)" value={model.prices.F} note={`Predicted before any third-party trade: ${sol(model.predictedF)}`} />
            <div className="price">
              <div className="label">Price ÷ F</div>
              <div className="value">{(model.prices.damm / model.prices.F).toFixed(3)}×</div>
            </div>
            <div className="price">
              <div className="label">Max loss if you buy now (in SOL terms)</div>
              <div className="value">{pct(model.maxLossIfBuyNow)}</div>
            </div>
          </section>

          <section>
            <h2>Floor composition at F</h2>
            <p>
              Locked DAMM v2 liquidity absorbs <b>{pct(model.composition.lockedPool)}</b> of outstanding supply; the vault's DLMM
              bid absorbs <b>{pct(model.composition.vaultBid)}</b>.
            </p>
          </section>

          <section>
            <h2>Bid wall (DLMM)</h2>
            {model.bid.suspended ? (
              <p className="warn">
                The DLMM bid is suspended: a third-party order holds the active bin more than 70 bins below F's bin, so the vault
                rests unplaced. It still counts toward F, and redemption still pays F less 0.5%.
              </p>
            ) : model.bid.restingSol === 0 ? (
              <p>No bid is resting: the vault is empty.</p>
            ) : (
              <>
                {model.bid.capped && (
                  <p className="warn">
                    The bid is capped at the DLMM active bin, below F's bin, because a third-party order holds the active bin there.
                    It is still a bid at or below F; redemption still pays F less 0.5%.
                  </p>
                )}
                <div className="grid">
                  <Price label="Bid bin price" value={model.prices.bidBin} note={`bin ${model.bid.binId}, ${sol(model.bid.restingSol)} SOL resting`} />
                  <Price label="You receive at least (executable bid, net)" value={model.prices.bidNet} note={`after DLMM's fee, ${model.bid.dlmmFeeBps} bps now (${model.bid.dlmmBaseFeeBps} bps base; it rises with volatility)`} />
                  <Price label="DAMM v2 sell, net" value={model.prices.dammSellNet} note="at the current pool price, after the 1% pool fee" />
                </div>
              </>
            )}
          </section>

          <section>
            <h2>Redeem</h2>
            <Price label="Redemption (F less 0.5%)" value={model.prices.redemption} />
            <label>
              Tokens to redeem <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1000000" />
            </label>
            <p>
              Exact payout: <b>{sol(Number(payout) / 1e9)} SOL</b>
              {payout > 0n && payout < 1_000_000n && " — below the 0.001 SOL minimum; the program will refuse it"}
            </p>
            <label>
              Minimum to receive (SOL){" "}
              <input value={minOut ?? (Number(payout) / 1e9).toString()} onChange={(e) => setMinOut(e.target.value)} />
            </label>
            <button disabled={!wallet.publicKey || baseUnits === 0n} onClick={redeem}>
              {wallet.publicKey ? "Redeem" : "Connect a wallet to redeem"}
            </button>
            {status && <p className="note">{status}</p>}
          </section>

          <section>
            <h2>Proof</h2>
            <table>
              <tbody>
                <tr><td>Prediction (register_launch, in the pool-creation transaction)</td><td>{tx(model.proof.predictionTx)}</td></tr>
                <tr><td>open</td><td>{tx(model.proof.openTx)}</td></tr>
                {Object.entries(model.proof.addresses).map(([k, a]) => (
                  <tr key={k}><td>{k}</td><td><a href={explorerUrl(rpc, "address", a)} target="_blank" rel="noreferrer">{a}</a></td></tr>
                ))}
              </tbody>
            </table>
            <p>Check it without this page:</p>
            <pre>ballast verify {model.launch.toBase58()} --rpc {rpc}</pre>
          </section>

          <section>
            <h2>Limits</h2>
            <p>{LIMITS}</p>
          </section>
        </>
      )}
    </main>
  );
}
