const express = require("express");
const anchor = require("@coral-xyz/anchor");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors());

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const privateKeyArray = JSON.parse(process.env.PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));
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
  try {
    fs.writeFileSync(txSignatureStorePath, JSON.stringify(store, null, 2), "utf8");
  } catch (err) {
    console.warn("Failed to save tx signature store:", err.message);
  }
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
    console.warn("Failed to confirm tx signature:", err.message);
    return null;
  }
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function ensureLocality(name) {
  const localityPDA = await findLocalityPDA(name);
  try {
    await program.account.locality.fetch(localityPDA);
    console.log("Locality already exists:", name);
  } catch {
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
  }
  return localityPDA;
}

async function ensureNode(nodeId, localityName) {
  const nodePDA = await findNodePDA(nodeId);
  const localityPDA = await findLocalityPDA(localityName);
  try {
    await program.account.node.fetch(nodePDA);
    console.log("Node already exists:", nodeId);
  } catch {
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
  }
  return nodePDA;
}

app.post("/submit", async (req, res) => {
  try {
    let node_id, co2, temperature, humidity, aqi, signature;

    if (req.body.data) {
      ({ node_id, co2, temperature, humidity, aqi } = req.body.data);
      signature = req.body.signature;
    } else {
      ({ node_id, co2, temperature, humidity, aqi, signature } = req.body);
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
        parseFloat(co2),
        parseFloat(temperature),
        parseFloat(humidity),
        parseFloat(aqi),
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
    const nodeAccount = await withTimeout(
      program.account.node.fetch(nodePDA),
      8000,
      null
    );
    if (!nodeAccount) {
      return res.status(404).json({ success: false, error: "Node not found or RPC timeout" });
    }
    const readingCount = nodeAccount.readingCount.toNumber();

    const readings = await Promise.all(
      Array.from({ length: readingCount }, async (_, i) => {
        const readingPDA = await findReadingPDA(nodeId, i);
        const reading = await program.account.reading.fetch(readingPDA);
        let txSignature = getStoredTxSignature(readingPDA);
        if (!txSignature) {
          txSignature = await withTimeout(
            getConfirmedSignatureForAddress(readingPDA),
            3000,
            null
          );
          if (txSignature) storeTxSignature(readingPDA, txSignature);
        }
        return normalizeReading(reading, i, txSignature);
      })
    );

    res.json({ success: true, readings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/tx-signature/:nodeId/:index", async (req, res) => {
  try {
    const { nodeId, index } = req.params;
    const readingIdx = parseInt(index, 10);
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
    const locality = await withTimeout(
      program.account.locality.fetch(localityPDA),
      8000,
      null
    );
    if (!locality) {
      return res.status(404).json({ success: false, error: "Locality not found or RPC timeout" });
    }
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