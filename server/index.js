const express = require("express");
const {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  PublicKey,
} = require("@solana/web3.js");
require("dotenv").config();

const app = express();
app.use(express.json());

// Connect to Solana Devnet
const connection = new Connection("https://api.devnet.solana.com", "confirmed");

// Load wallet from .env
const privateKeyArray = JSON.parse(process.env.PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));

console.log("Server wallet address:", wallet.publicKey.toString());

// Memo program ID — this is a fixed Solana program, don't change it
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

app.post("/submit", async (req, res) => {
  try {
    const { node_id, co2, temperature, humidity, aqi } = req.body;

    // Build the data object
    const sensorData = JSON.stringify({
      node_id,
      co2,
      temperature,
      humidity,
      aqi,
      timestamp: new Date().toISOString(),
    });

    console.log("Received data:", sensorData);

    // Create a memo transaction
    const transaction = new Transaction().add(
      new TransactionInstruction({
        keys: [],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(sensorData, "utf-8"),
      })
    );

    // Send to Solana
    const signature = await sendAndConfirmTransaction(connection, transaction, [wallet]);

    console.log("Stored on Solana! Tx:", signature);

    res.json({
      success: true,
      signature,
      data: sensorData,
    });

  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "AirChain server running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AirChain server running on port ${PORT}`);
});