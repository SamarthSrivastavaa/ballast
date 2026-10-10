// web3.js, Anchor and the Meteora SDKs read Node's `Buffer` global while their modules load. Imports
// are evaluated before the importing module's own statements, so the global must be set by a module
// that is imported first — setting it in main.tsx itself runs too late and the page stays blank.
import { Buffer } from "buffer";

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
