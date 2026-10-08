import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// web3.js and Anchor expect Node's Buffer and `global` in the browser.
export default defineConfig({
  plugins: [react()],
  define: { global: "globalThis" },
  resolve: { alias: { buffer: "buffer/" } },
  optimizeDeps: { include: ["buffer"] },
  // The page imports the workspace SDK (../sdk/typescript).
  server: { fs: { allow: [".."] } },
  build: { target: "es2022", chunkSizeWarningLimit: 4096 },
});
