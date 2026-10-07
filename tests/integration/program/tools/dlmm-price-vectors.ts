/**
 * Prints DLMM Q64 bin prices from the SDK's exact BN `getQPriceFromId` (dlmm 1.9.10), as Rust tuples
 * for `programs/ballast/src/dlmm.rs` tests. The SDK is a LEAD; the integration suite additionally
 * checks the vendored function against the `price` DLMM stores in the bid bin on the mainnet binary.
 *
 *   pnpm exec tsx tests/integration/program/tools/dlmm-price-vectors.ts
 */
import BN from "bn.js";
import { binIdToBinArrayIndex, getQPriceFromId } from "@meteora-ag/dlmm";

const rows: string[] = [];
for (const step of [1, 10, 25, 50])
  for (const id of [0, 1, -1, 2, -2, 69, -69, 70, -70, -71, 1000, -1000, -11003, -11004, -11920, -11921, -12000, 20000, -50000, 100000, -100000])
    rows.push(`(${id}, ${step}, ${getQPriceFromId(new BN(id), new BN(step)).toString()}),`);
console.log(rows.join("\n"));
console.log("// bin array index: " + [-1, -69, -70, -71, -140, -141, -11920, 0, 69, 70].map((i) => `(${i}, ${binIdToBinArrayIndex(new BN(i)).toString()})`).join(", "));
