const express = require("express");
const anchor = require("@coral-xyz/anchor");
const cors = require("cors");
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

    const readings = [];
    for (let i = 0; i < readingCount; i++) {
      const readingPDA = await findReadingPDA(nodeId, i);
      const reading = await program.account.reading.fetch(readingPDA);
      readings.push({ ...reading, index: i });
    }

    res.json({ success: true, readings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/locality/:name", async (req, res) => {
  try {
    const localityPDA = await findLocalityPDA(req.params.name);
    const locality = await program.account.locality.fetch(localityPDA);
    res.json({ success: true, locality });
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