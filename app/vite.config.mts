import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// web3.js and Anchor expect Node's Buffer and `global` in the browser.
export default defineConfig({
  plugins: [react()],
  define: { global: "globalThis" },
  // wallet-adapter-react-ui's own dependency range resolves to a second copy of wallet-adapter-react,
  // whose WalletContext the app's WalletProvider never fills ("read publicKey on a WalletContext
  // without providing one"). One copy of each, the app's pinned one.
  resolve: { alias: { buffer: "buffer/" }, dedupe: ["@solana/wallet-adapter-react", "@solana/wallet-adapter-base", "react", "react-dom"] },
  optimizeDeps: { include: ["buffer"] },
  // The page imports the workspace SDK (../sdk/typescript).
  server: { fs: { allow: [".."] } },
  build: { target: "es2022", chunkSizeWarningLimit: 4096 },
});
