import "./polyfills";

import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { App, rpcFromUrl } from "./App";
import "./styles.css";

function Root() {
  const rpc = useMemo(rpcFromUrl, []);
  // Wallets that implement the Wallet Standard (Phantom, Solflare, Backpack…) are detected automatically.
  return (
    <ConnectionProvider endpoint={rpc}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
