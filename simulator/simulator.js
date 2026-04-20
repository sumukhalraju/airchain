const axios = require("axios");

const NODE_ID = "node_1";
const SERVER_URL = "http://localhost:3001/submit";

// Generates a random number between min and max
function randomBetween(min, max) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(2));
}

// Simulates realistic AQI sensor readings
function generateReading() {
  const co2 = randomBetween(400, 800);        // ppm
  const temperature = randomBetween(24, 38);  // celsius
  const humidity = randomBetween(40, 90);     // percentage
  const aqi = randomBetween(50, 300);         // air quality index

  return { node_id: NODE_ID, co2, temperature, humidity, aqi };
}

async function sendReading() {
  const reading = generateReading();

  try {
    console.log("Sending reading:", reading);
    const response = await axios.post(SERVER_URL, reading);
    console.log("✅ Stored on Solana! Tx:", response.data.signature);
    console.log("---");
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

// Send a reading every 15 seconds
console.log("AirChain simulator started...");
sendReading(); // send one immediately on start
setInterval(sendReading, 15000);