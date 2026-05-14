const express = require("express");
const anchor = require("@coral-xyz/anchor");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const nacl = require("tweetnacl");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors());

const connection = new Connection("https://api.devnet.solana.com", "confirmed");

function loadWallet() {
  if (!process.env.PRIVATE_KEY) {
    console.error("FATAL: PRIVATE_KEY environment variable is not set. Create a .env file or set it in the environment.");
    process.exit(1);
  }
  try {
    const privateKeyArray = JSON.parse(process.env.PRIVATE_KEY);
    if (!Array.isArray(privateKeyArray) || privateKeyArray.length !== 64) {
      console.error("FATAL: PRIVATE_KEY must be a JSON array of 64 integers (Solana keypair secret key).");
      process.exit(1);
    }
    return Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));
  } catch (err) {
    console.error("FATAL: Failed to parse PRIVATE_KEY:", err.message);
    process.exit(1);
  }
}
const wallet = loadWallet();
const anchorWallet = new anchor.Wallet(wallet);
const PROGRAM_ID = new PublicKey("5UB7ModzcxkMMx93sSemD7NR3S5NKBx1RhEg6VPQHeDd");

const IDL = {
  version: "0.1.0",
  name: "airchain",
  instructions: [
    {
      name: "initializeLocality",
      accounts: [
        { name: "locality", isMut: true, isSigner: false },
        { name: "authority", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [{ name: "name", type: "string" }],
    },
    {
      name: "registerNode",
      accounts: [
        { name: "node", isMut: true, isSigner: false },
        { name: "locality", isMut: true, isSigner: false },
        { name: "authority", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "nodeId", type: "string" },
        { name: "localityName", type: "string" },
      ],
    },
    {
      name: "submitReading",
      accounts: [
        { name: "reading", isMut: true, isSigner: false },
        { name: "node", isMut: true, isSigner: false },
        { name: "locality", isMut: true, isSigner: false },
        { name: "authority", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "co2", type: "f32" },
        { name: "temperature", type: "f32" },
        { name: "humidity", type: "f32" },
        { name: "aqi", type: "f32" },
        { name: "signature", type: "string" },
      ],
    },
  ],
  accounts: [
    {
      name: "Locality",
      type: {
        kind: "struct",
        fields: [
          { name: "name", type: "string" },
          { name: "nodeCount", type: "u32" },
          { name: "averageAqi", type: "u32" },
          { name: "authority", type: "publicKey" },
        ],
      },
    },
    {
      name: "Node",
      type: {
        kind: "struct",
        fields: [
          { name: "nodeId", type: "string" },
          { name: "locality", type: "string" },
          { name: "readingCount", type: "u64" },
          { name: "publicKey", type: "publicKey" },
          { name: "authority", type: "publicKey" },
        ],
      },
    },
    {
      name: "Reading",
      type: {
        kind: "struct",
        fields: [
          { name: "nodeId", type: "string" },
          { name: "co2", type: "f32" },
          { name: "temperature", type: "f32" },
          { name: "humidity", type: "f32" },
          { name: "aqi", type: "f32" },
          { name: "signature", type: "string" },
          { name: "timestamp", type: "i64" },
          { name: "locality", type: "string" },
        ],
      },
    },
  ],
};

const provider = new anchor.AnchorProvider(connection, anchorWallet, {
  commitment: "confirmed",
});
const program = new anchor.Program(IDL, PROGRAM_ID, provider);

const txSignatureStorePath = path.join(__dirname, "tx-signatures.json");
const txSignatureStore = loadTxSignatureStore();

function hexToBytes(hex) {
  const bytes = Buffer.alloc(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function verifyNodeSignature(nodeId, co2, temp, humidity, aqi, signatureHex, publicKeyHex) {
  if (!signatureHex || !publicKeyHex) return false;
  try {
    const sig = hexToBytes(signatureHex);
    const pub = hexToBytes(publicKeyHex);
    if (sig.length !== 64 || pub.length !== 32) return false;

    const dataStr = `{"node_id":"${nodeId}","temperature":${parseFloat(temp).toFixed(2)},"humidity":${parseFloat(humidity).toFixed(2)},"aqi":${parseFloat(aqi).toFixed(2)},"co2":${parseFloat(co2).toFixed(2)}}`;
    const message = Buffer.from(dataStr, "utf8");

    return nacl.sign.detached.verify(message, sig, pub);
  } catch {
    return false;
  }
}

function loadTxSignatureStore() {
  try {
    if (!fs.existsSync(txSignatureStorePath)) return {};
    const raw = fs.readFileSync(txSignatureStorePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.warn("Failed to load tx signature store:", err.message);
    return {};
  }
}

function saveTxSignatureStore(store) {
  fs.writeFile(txSignatureStorePath, JSON.stringify(store, null, 2), "utf8", (err) => {
    if (err) console.warn("Failed to save tx signature store:", err.message);
  });
}

function getStoredTxSignature(address) {
  return txSignatureStore[address.toString()] || null;
}

function storeTxSignature(address, signature) {
  if (!signature) return;
  const key = address.toString();
  if (txSignatureStore[key] === signature) return;
  txSignatureStore[key] = signature;
  saveTxSignatureStore(txSignatureStore);
}

function normalizeAnchorValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value.toNumber === "function") return value.toNumber();
  if (typeof value.toString === "function" && value.constructor?.name === "BN") {
    return BigInt(value.toString()).toString();
  }
  return value;
}

function normalizeReading(reading, i, txSignature) {
  return {
    nodeId: reading.nodeId,
    co2: normalizeAnchorValue(reading.co2),
    temperature: normalizeAnchorValue(reading.temperature),
    humidity: normalizeAnchorValue(reading.humidity),
    aqi: normalizeAnchorValue(reading.aqi),
    signature: reading.signature,
    timestamp: normalizeAnchorValue(reading.timestamp),
    locality: reading.locality,
    index: i,
    txSignature: txSignature || null,
  };
}

async function findLocalityPDA(name) {
  const [pda] = await PublicKey.findProgramAddress(
    [Buffer.from("locality"), Buffer.from(name)],
    PROGRAM_ID
  );
  return pda;
}

async function findNodePDA(nodeId) {
  const [pda] = await PublicKey.findProgramAddress(
    [Buffer.from("node"), Buffer.from(nodeId)],
    PROGRAM_ID
  );
  return pda;
}

async function findReadingPDA(nodeId, readingCount) {
  const countBuffer = Buffer.alloc(8);
  countBuffer.writeBigUInt64LE(BigInt(readingCount));
  const [pda] = await PublicKey.findProgramAddress(
    [Buffer.from("reading"), Buffer.from(nodeId), countBuffer],
    PROGRAM_ID
  );
  return pda;
}

async function getConfirmedSignatureForAddress(address) {
  try {
    const signatures = await connection.getSignaturesForAddress(address, { limit: 5 });
    for (const sigInfo of signatures) {
      if (sigInfo.err) continue;
      const tx = await connection.getTransaction(sigInfo.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx) return sigInfo.signature;
    }
    return null;
  } catch (err) {
    if (err?.message?.includes("version") || err?.message?.includes("unsupported")) {
      try {
        const signatures = await connection.getSignaturesForAddress(address, { limit: 5 });
        for (const sigInfo of signatures) {
          if (sigInfo.err) continue;
          return sigInfo.signature;
        }
      } catch { /* fall through */ }
    } else {
      console.warn("Failed to confirm tx signature:", err.message);
    }
    return null;
  }
}

function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function ensureLocality(name) {
  const localityPDA = await findLocalityPDA(name);
  try {
    await program.account.locality.fetch(localityPDA);
    console.log("Locality already exists:", name);
    return localityPDA;
  } catch (err) {
    if (err.message && err.message.includes("Account does not exist")) {
      console.log("Creating locality:", name);
      await program.methods
        .initializeLocality(name)
        .accounts({
          locality: localityPDA,
          authority: wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();
      return localityPDA;
    }
    throw err;
  }
}

async function ensureNode(nodeId, localityName) {
  const nodePDA = await findNodePDA(nodeId);
  const localityPDA = await findLocalityPDA(localityName);
  try {
    await program.account.node.fetch(nodePDA);
    console.log("Node already exists:", nodeId);
    return nodePDA;
  } catch (err) {
    if (err.message && err.message.includes("Account does not exist")) {
      console.log("Registering node:", nodeId);
      await program.methods
        .registerNode(nodeId, localityName)
        .accounts({
          node: nodePDA,
          locality: localityPDA,
          authority: wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();
      return nodePDA;
    }
    throw err;
  }
}

app.post("/submit", async (req, res) => {
  try {
    let node_id, co2, temperature, humidity, aqi, signature, publicKey;

    if (req.body.data) {
      ({ node_id, co2, temperature, humidity, aqi } = req.body.data);
      signature = req.body.signature;
      publicKey = req.body.publicKey;
    } else {
      ({ node_id, co2, temperature, humidity, aqi, signature, publicKey } = req.body);
    }

    if (!node_id || typeof node_id !== "string") {
      return res.status(400).json({ success: false, error: "Missing or invalid node_id" });
    }

    co2 = parseFloat(co2);
    temperature = parseFloat(temperature);
    humidity = parseFloat(humidity);
    aqi = parseFloat(aqi);

    if (isNaN(co2) || isNaN(temperature) || isNaN(humidity) || isNaN(aqi)) {
      return res.status(400).json({ success: false, error: "co2, temperature, humidity, and aqi must be valid numbers" });
    }

    if (signature && publicKey) {
      const valid = verifyNodeSignature(node_id, co2, temperature, humidity, aqi, signature, publicKey);
      if (!valid) {
        console.warn(`Invalid signature from node ${node_id}`);
        return res.status(401).json({ success: false, error: "Invalid node signature" });
      }
      console.log(`Node ${node_id} signature verified`);
    } else {
      console.warn(`Missing signature or publicKey from node ${node_id}`);
    }

    if (!node_id || typeof node_id !== "string") {
      return res.status(400).json({ success: false, error: "Missing or invalid node_id" });
    }

    co2 = parseFloat(co2);
    temperature = parseFloat(temperature);
    humidity = parseFloat(humidity);
    aqi = parseFloat(aqi);

    if (isNaN(co2) || isNaN(temperature) || isNaN(humidity) || isNaN(aqi)) {
      return res.status(400).json({ success: false, error: "co2, temperature, humidity, and aqi must be valid numbers" });
    }

    const localityName = "Bengaluru";
    console.log(`Received from ${node_id}:`, { co2, temperature, humidity, aqi });

    const localityPDA = await ensureLocality(localityName);
    const nodePDA = await ensureNode(node_id, localityName);
    const nodeAccount = await program.account.node.fetch(nodePDA);
    const readingCount = nodeAccount.readingCount.toNumber();
    const readingPDA = await findReadingPDA(node_id, readingCount);

    const tx = await program.methods
      .submitReading(
        co2,
        temperature,
        humidity,
        aqi,
        signature || "no-signature"
      )
      .accounts({
        reading: readingPDA,
        node: nodePDA,
        locality: localityPDA,
        authority: wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();

    console.log("Reading stored on-chain! Tx:", tx);
    storeTxSignature(readingPDA, tx);
    res.json({ success: true, signature: tx, readingCount });

  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/readings/:nodeId", async (req, res) => {
  try {
    const { nodeId } = req.params;
    const nodePDA = await findNodePDA(nodeId);
    const nodeAccount = await program.account.node.fetch(nodePDA);
    const readingCount = nodeAccount.readingCount.toNumber();

    const MAX_CONCURRENT = 10;
    const BATCH_DELAY = 300;
    const readings = [];

    for (let i = 0; i < readingCount; i += MAX_CONCURRENT) {
      const batch = Array.from(
        { length: Math.min(MAX_CONCURRENT, readingCount - i) },
        (_, j) => i + j
      );
      const batchResults = await Promise.all(
        batch.map(async (idx) => {
          try {
            const readingPDA = await findReadingPDA(nodeId, idx);
            const reading = await program.account.reading.fetch(readingPDA);
            const txSignature = getStoredTxSignature(readingPDA);
            return normalizeReading(reading, idx, txSignature);
          } catch (err) {
            console.warn(`Skipping reading index ${idx}: ${err.message}`);
            return null;
          }
        })
      );
      readings.push(...batchResults.filter(Boolean));
      if (i + MAX_CONCURRENT < readingCount) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY));
      }
    }

    res.json({ success: true, readings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/tx-signature/:nodeId/:index", async (req, res) => {
  try {
    const { nodeId, index } = req.params;
    const readingIdx = parseInt(index, 10);
    if (isNaN(readingIdx) || readingIdx < 0) {
      return res.status(400).json({ success: false, error: "index must be a non-negative integer" });
    }
    const readingPDA = await findReadingPDA(nodeId, readingIdx);

    const stored = getStoredTxSignature(readingPDA);
    if (stored) {
      return res.json({ success: true, signature: stored, cached: true });
    }

    const confirmed = await withTimeout(
      getConfirmedSignatureForAddress(readingPDA),
      6000,
      null
    );
    if (confirmed) {
      storeTxSignature(readingPDA, confirmed);
      return res.json({ success: true, signature: confirmed, cached: false });
    }

    res.json({ success: false, signature: null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/locality/:name", async (req, res) => {
  try {
    const localityPDA = await findLocalityPDA(req.params.name);
    const locality = await program.account.locality.fetch(localityPDA);
    res.json({
      success: true,
      locality: {
        name: locality.name,
        nodeCount: normalizeAnchorValue(locality.nodeCount),
        averageAqi: normalizeAnchorValue(locality.averageAqi),
        authority: locality.authority.toString(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "AirChain server running with Anchor" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AirChain server running on port ${PORT}`);
  console.log(`Wallet: ${wallet.publicKey.toString()}`);
  console.log(`Program: ${PROGRAM_ID.toString()}`);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason?.message || reason);
});