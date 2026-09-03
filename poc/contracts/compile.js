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
