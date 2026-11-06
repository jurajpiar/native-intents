// Compile Settlement.sol + TestToken.sol with solc (evmVersion istanbul, no PUSH0/recent opcodes).
// Writes build/*.json (abi + bytecode) and prints Settlement runtime bytecode for genesis deploy.
// Run: node compile.js   (from poc/contracts, with solc installed at ../../../soltmp or npm i solc@0.8.19)
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const sources = {
  "Settlement.sol": { content: fs.readFileSync(path.join(__dirname, "Settlement.sol"), "utf8") },
  "TestToken.sol": { content: fs.readFileSync(path.join(__dirname, "TestToken.sol"), "utf8") },
  "Bond.sol": { content: fs.readFileSync(path.join(__dirname, "Bond.sol"), "utf8") },
  "Auction.sol": { content: fs.readFileSync(path.join(__dirname, "Auction.sol"), "utf8") },
  "Vault.sol": { content: fs.readFileSync(path.join(__dirname, "Vault.sol"), "utf8") },
  "Pool.sol": { content: fs.readFileSync(path.join(__dirname, "Pool.sol"), "utf8") },
  "TokenVault.sol": { content: fs.readFileSync(path.join(__dirname, "TokenVault.sol"), "utf8") },
  "Griefer.sol": { content: fs.readFileSync(path.join(__dirname, "Griefer.sol"), "utf8") },
  "Turncoat.sol": { content: fs.readFileSync(path.join(__dirname, "Turncoat.sol"), "utf8") },
  "PoisonToken.sol": { content: fs.readFileSync(path.join(__dirname, "PoisonToken.sol"), "utf8") },
  "Reenterer.sol": { content: fs.readFileSync(path.join(__dirname, "Reenterer.sol"), "utf8") },
  "BadToken.sol": { content: fs.readFileSync(path.join(__dirname, "BadToken.sol"), "utf8") },
};

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "istanbul", // rskj-safe: no PUSH0 / transient storage / MCOPY
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
if (out.errors) {
  const fatal = out.errors.filter((e) => e.severity === "error");
  for (const e of out.errors) console.error(e.formattedMessage);
  if (fatal.length) process.exit(1);
}

const build = path.join(__dirname, "build");
fs.mkdirSync(build, { recursive: true });
const result = {};
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    result[name] = {
      abi: c.abi,
      bytecode: "0x" + c.evm.bytecode.object,          // deploy (constructor) bytecode
      deployedBytecode: "0x" + c.evm.deployedBytecode.object, // runtime bytecode (for genesis)
    };
    fs.writeFileSync(path.join(build, name + ".json"), JSON.stringify(result[name], null, 2));
  }
}

console.log("compiled:", Object.keys(result).join(", "));

/**
 * Sync the SDK's own ABI copies. This used to be a manual step, and it drifted exactly as you would
 * expect: the Auction gained `failedAt`, the contract was recompiled and injected into genesis, and
 * the harness then died on `a.failedAt is not a function` HALFWAY THROUGH a live run — after the
 * assertions that mattered had already passed. Compiling is the only moment at which the truth is
 * known, so the copy belongs here rather than in someone's memory.
 *
 * The existing shape of each file is PRESERVED, because it is not uniform: Settlement.json is a bare
 * ABI array (consumed as `new Interface(settlementAbi)`) while every other file is `{abi, bytecode}`
 * (consumed as `artifact.abi` / `artifact.bytecode`). Rewriting a file into the other shape silently
 * breaks its importers — it has done so before — so normalising them is a deliberate job, not
 * something to do as a side effect of a build.
 */
// A couple of SDK files are named after the ROLE rather than the contract, so the sync would skip
// them silently — the drift this whole block exists to prevent, one indirection later.
const ABI_ALIASES = { BtcVault: "Vault" };

const sdkAbi = path.join(__dirname, "..", "sdk", "src", "abi");
if (fs.existsSync(sdkAbi)) {
  const synced = [];
  for (const [name, art] of Object.entries(result)) {
    const dest = path.join(sdkAbi, (ABI_ALIASES[name] ?? name) + ".json");
    if (!fs.existsSync(dest)) continue; // the SDK only carries the contracts it actually uses
    const wasBareArray = Array.isArray(JSON.parse(fs.readFileSync(dest, "utf8")));
    const next = wasBareArray ? art.abi : art;
    const before = fs.readFileSync(dest, "utf8");
    const after = JSON.stringify(next, null, 2) + "\n";
    if (before !== after) { fs.writeFileSync(dest, after); synced.push(name); }
  }
  console.log(synced.length
    ? `sdk/src/abi synced: ${synced.join(", ")}`
    : "sdk/src/abi already current");
} else {
  console.warn(`sdk/src/abi not found at ${sdkAbi} — the harness will run against stale ABIs`);
}

// genesis runtime bytecode for the fixed-address contracts (kept as provenance alongside rskj-patch/)
const genesisDir = path.join(__dirname, "..", "rskj-patch", "genesis");
fs.mkdirSync(genesisDir, { recursive: true });
for (const name of ["Settlement", "Auction"]) {
  const hex = result[name].deployedBytecode.slice(2);
  fs.writeFileSync(path.join(genesisDir, name.toLowerCase() + ".runtime.hex"), hex + "\n");
  console.log(`${name} runtime: ${hex.length / 2} bytes -> rskj-patch/genesis/${name.toLowerCase()}.runtime.hex`);
}

// Inject the runtime bytecode straight into the local rskj clone's genesis (rsk-dev.json).
// The clone at the repo root is authoritative — rskj-patch/apply.py is retired provenance and no
// longer part of the build loop. Override the clone location with RSKJ_DIR if needed.
const GENESIS_CONTRACTS = [
  ["Settlement", "0000000000000000000000000000000001000021"],
  ["Auction",    "0000000000000000000000000000000001000022"],
];
const rskjRoot = process.env.RSKJ_DIR || path.join(__dirname, "..", "..", "rskj");
const genesisJson = path.join(rskjRoot, "rskj-core", "src", "main", "resources", "genesis", "rsk-dev.json");
if (fs.existsSync(genesisJson)) {
  const genesis = JSON.parse(fs.readFileSync(genesisJson, "utf8"));
  const alloc = genesis.alloc || (genesis.alloc = {});
  let changed = false;
  for (const [name, addr] of GENESIS_CONTRACTS) {
    const code = result[name].deployedBytecode.slice(2);
    if (alloc[addr] && alloc[addr].contract && alloc[addr].contract.code === code) {
      console.log(`genesis: ${name} unchanged at 0x${addr}`);
      continue;
    }
    alloc[addr] = { balance: "0", contract: { code, data: {} } };
    changed = true;
    console.log(`genesis: ${name} injected at 0x${addr} (${code.length / 2} bytes)`);
  }
  if (changed) fs.writeFileSync(genesisJson, JSON.stringify(genesis, null, 2) + "\n");
} else {
  console.warn(`genesis: rskj clone not found at ${rskjRoot} — set RSKJ_DIR to inject (hex files written above regardless)`);
}
