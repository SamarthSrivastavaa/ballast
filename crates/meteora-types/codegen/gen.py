#!/usr/bin/env python3
"""Generate crates/meteora-types from the vendored Meteora IDLs (STEP 3, Q12).

Only zero-copy (bytemuck, repr C) accounts are generated, as `#[repr(C, packed)]` Pod structs:
field order and types come from the IDL, and every field is placed with NO implicit padding.
That is correct only if the on-chain struct has no implicit padding either, which the tests
prove two ways: (1) `size_of` equals the size of a real account read from the mainnet binary
(minus the 8-byte discriminator), and (2) every field decodes to the same value as the SDK's own
decoder on the same bytes.

    python3 crates/meteora-types/codegen/gen.py      # rewrites src/generated.rs + tests/support/generated_fields.rs

Never hand-edit the generated files.
"""
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPECS = [
    # (module, idl file, root account types)
    ("dbc", "dynamic_bonding_curve.json", ["PoolConfig", "VirtualPool"]),
    ("damm_v2", "cp_amm.json", ["Pool", "Position"]),
    ("dlmm", "lb_clmm.json", ["LbPair", "LimitOrder"]),
]
PRIM = {
    "u8": ("u8", 1), "i8": ("i8", 1), "u16": ("u16", 2), "i16": ("i16", 2),
    "u32": ("u32", 4), "i32": ("i32", 4), "u64": ("u64", 8), "i64": ("i64", 8),
    "u128": ("u128", 16), "i128": ("i128", 16), "bool": ("u8", 1), "pubkey": ("[u8; 32]", 32),
}
RUST_KEYWORDS = {"type", "match", "ref", "move", "fn", "struct", "enum", "mod", "use", "pub", "self"}


def snake(name: str) -> str:
    return name  # IDL v0.30+ already uses snake_case field names


def camel(name: str) -> str:
    """Anchor TS's camelCase: leading underscores dropped (`_padding_0` → `padding0`)."""
    parts = name.lstrip("_").split("_")
    return parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])


def rust_ident(name: str) -> str:
    return f"r#{name}" if name in RUST_KEYWORDS else name


class Gen:
    def __init__(self, idl: dict):
        self.types = {t["name"]: t for t in idl["types"]}
        self.accounts = {a["name"]: a for a in idl.get("accounts", [])}
        self.order: list[str] = []
        self.sizes: dict[str, int] = {}

    def size_of(self, ty) -> int:
        if isinstance(ty, str):
            return PRIM[ty][1]
        if "array" in ty:
            inner, n = ty["array"]
            return self.size_of(inner) * n
        if "defined" in ty:
            return self.struct_size(ty["defined"]["name"])
        raise ValueError(f"unsupported type in zero-copy struct: {ty}")

    def struct_size(self, name: str) -> int:
        if name not in self.sizes:
            t = self.types[name]
            if t["type"]["kind"] != "struct":
                raise ValueError(f"{name}: zero-copy field of kind {t['type']['kind']}")
            self.sizes[name] = sum(self.size_of(f["type"]) for f in t["type"]["fields"])
        return self.sizes[name]

    def visit(self, name: str):
        if name in self.order:
            return
        for f in self.types[name]["type"]["fields"]:
            self.visit_ty(f["type"])
        self.order.append(name)

    def visit_ty(self, ty):
        if isinstance(ty, dict):
            if "array" in ty:
                self.visit_ty(ty["array"][0])
            elif "defined" in ty:
                self.visit(ty["defined"]["name"])

    def rust_ty(self, ty) -> str:
        if isinstance(ty, str):
            return PRIM[ty][0]
        if "array" in ty:
            inner, n = ty["array"]
            return f"[{self.rust_ty(inner)}; {n}]"
        return ty["defined"]["name"]

    # ---- flatten (test-only): path names match the SDK's camelCase JSON decode -----------------
    def flatten_expr(self, ty, expr: str, path: str, out: list[str], depth: int = 0):
        """Emit Rust statements pushing (path, string value) for a value `expr` of IDL type `ty`."""
        if isinstance(ty, str):
            if ty == "pubkey":
                out.append(f'out.push(({path}, bs58(&{expr})));')
            else:
                out.append(f'out.push(({path}, {{ let v = {expr}; v.to_string() }}));')
            return
        if "array" in ty:
            inner, n = ty["array"]
            i, a = f"i{depth}", f"a{depth}"
            sub: list[str] = []
            self.flatten_expr(inner, f"{a}[{i}]", f'format!("{{}}[{{}}]", {path}, {i})', sub, depth + 1)
            # Copy the whole array out of the packed struct first: no reference to a packed field.
            out.append(f"{{ let {a} = {expr}; for {i} in 0..{n} {{ " + " ".join(sub) + " } }")
            return
        name = ty["defined"]["name"]
        out.append(f'{{ let inner = {expr}; inner.flatten(&{path}, out); }}')


def emit(module: str, idl_file: str, roots: list[str]):
    idl = json.loads((ROOT / "idl" / idl_file).read_text())
    g = Gen(idl)
    for r in roots:
        t = g.types[r]
        if t.get("serialization") != "bytemuck" or t.get("repr", {}).get("kind") != "c":
            raise SystemExit(f"{r} is not a bytemuck repr(C) account")
        g.visit(r)

    src: list[str] = [f"/// Generated from `idl/{idl_file}` ({idl['metadata']['name']} {idl['metadata']['version']}, program `{idl['address']}`).",
                      f"pub mod {module} {{",
                      "    use bytemuck::{Pod, Zeroable};",
                      f'    pub const PROGRAM_ID: &str = "{idl["address"]}";',
                      f'    pub const IDL_VERSION: &str = "{idl["metadata"]["version"]}";']
    flat: list[str] = ["#[allow(clippy::all)] // generated, include-only test support",
                       f"pub mod {module}_fields {{",
                       f"    use meteora_types::{module}::*;",
                       "    use super::{bs58, Flatten};"]
    for name in g.order:
        t = g.types[name]
        fields = t["type"]["fields"]
        src.append("")
        src.append("    #[repr(C, packed)]")
        src.append("    #[derive(Clone, Copy, Pod, Zeroable)]")
        src.append(f"    pub struct {name} {{")
        for f in fields:
            src.append(f"        pub {rust_ident(snake(f['name']))}: {g.rust_ty(f['type'])},")
        src.append("    }")
        size = g.struct_size(name)
        offs, off = [], 0
        for f in fields:
            offs.append((f["name"], off))
            off += g.size_of(f["type"])
        src.append(f"    impl {name} {{")
        src.append(f"        /// Packed size; equals the on-chain account size minus the 8-byte discriminator.")
        src.append(f"        pub const SIZE: usize = {size};")
        if name in g.accounts:
            disc = list(g.accounts[name]["discriminator"])
            want = list(hashlib.sha256(f"account:{name}".encode()).digest()[:8])
            assert disc == want, f"{name}: IDL discriminator != sha256(account:{name})"
            src.append(f"        pub const DISCRIMINATOR: [u8; 8] = {disc};")
        src.append("        /// (field, offset within the struct) as computed by the generator.")
        src.append("        pub const OFFSETS: &'static [(&'static str, usize)] = &[")
        for fname, o in offs:
            src.append(f'            ("{fname}", {o}),')
        src.append("        ];")
        src.append("    }")
        src.append(f"    const _: () = assert!(core::mem::size_of::<{name}>() == {size});")

        body: list[str] = []
        for f in fields:
            g.flatten_expr(f["type"], f"self.{rust_ident(snake(f['name']))}",
                           f'format!("{{}}{{}}", prefix, "{camel(f["name"])}")', body)
        flat.append(f"    pub fn offsets_{name.lower()}() {{")
        for fname, o in offs:
            flat.append(f"        assert_eq!(core::mem::offset_of!({name}, {rust_ident(snake(fname))}), {o}, \"{name}.{fname}\");")
        flat.append("    }")
        flat.append(f"    impl Flatten for {name} {{")
        flat.append("        fn flatten(&self, path: &str, out: &mut Vec<(String, String)>) {")
        flat.append('            let prefix = if path.is_empty() { String::new() } else { format!("{}.", path) };')
        for line in body:
            flat.append("            " + line)
        flat.append("        }")
        flat.append("    }")
    src.append("}")
    flat.append("}")
    return src, flat


def main():
    header = ["// @generated by codegen/gen.py from the vendored IDLs — do not edit.", ""]
    src_all, flat_all = list(header), list(header)
    flat_all += ["use meteora_types as _;", ""]
    for module, idl_file, roots in SPECS:
        s, f = emit(module, idl_file, roots)
        src_all += s + [""]
        flat_all += f + [""]
    out = [ROOT / "src" / "generated.rs", ROOT / "tests" / "support" / "generated_fields.rs"]
    out[0].write_text("\n".join(src_all) + "\n")
    out[1].write_text("\n".join(flat_all) + "\n")
    # Keep `cargo fmt --check` (CI) green on generated code.
    subprocess.run(["rustfmt", "--edition", "2021", *map(str, out)], check=True)
    print("wrote src/generated.rs and tests/support/generated_fields.rs")


if __name__ == "__main__":
    main()
