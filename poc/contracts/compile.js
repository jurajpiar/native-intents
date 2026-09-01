// Compile Settlement.sol + TestToken.sol with solc (evmVersion istanbul, no PUSH0/recent opcodes).
// Writes build/*.json (abi + bytecode) and prints Settlement runtime bytecode for genesis deploy.
// Run: node compile.js   (from poc/contracts, with solc installed at ../../../soltmp or npm i solc@0.8.19)
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const sources = {
  "Settlement.sol": { content: fs.readFileSync(path.join(__dirname, "Settlement.sol"), "utf8") },
  "TestToken.sol": { content: fs.readFileSync(path.join(__dirname, "TestToken.sol"), "utf8") },
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
console.log("\nSettlement runtime bytecode length:", (result.Settlement.deployedBytecode.length - 2) / 2, "bytes");
console.log("Settlement runtime (for genesis, no 0x):");
console.log(result.Settlement.deployedBytecode.slice(2));
