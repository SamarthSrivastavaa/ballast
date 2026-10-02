import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";

/**
 * Toolchain probe (D-002 condition 3, requirement b).
 *
 * Proves `anchor test` works end to end in this environment: a local validator boots, the program
 * that links `crates/floor` deploys, and `floor_sqrt_q64` reproduces the §27 Public vector when it
 * runs on-chain. The program itself asserts exactness and fails the transaction on any mismatch,
 * so a successful send is the proof; the log assertions below just make the numbers visible.
 */
describe("toolchain probe", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.probe as Program;

  it("reproduces the §27 Public vector on-chain", async () => {
    const sig = await program.methods.checkPublicVector().rpc({ commitment: "confirmed" });
    console.log("    signature:", sig);

    const tx = await program.provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = tx?.meta?.logMessages ?? [];
    logs.filter((l) => l.includes("probe") || l.includes("->")).forEach((l) => console.log("   ", l));

    assert.isTrue(
      logs.some((l) => l.includes("s = 75507360421341854")),
      "on-chain s did not match the §27 Public vector"
    );
    assert.isTrue(
      logs.some((l) => l.includes("16671021 lamports")),
      "on-chain redeem_payout did not match the §27 Public vector"
    );
    assert.isTrue(
      logs.some((l) => l.includes("probe: OK")),
      "probe did not reach its success log"
    );

    const cu = logs.find((l) => l.includes("consumed"));
    if (cu) console.log("   ", cu.trim());
  });
});
