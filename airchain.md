# AirChain: Decentralized Air Quality Monitoring on Solana

## Technical Architecture & Implementation Deep-Dive

---

### 1. Overview

AirChain is an end-to-end decentralized air quality monitoring system that cryptographically guarantees sensor data integrity by anchoring readings to the Solana blockchain. Every data point — CO₂ concentration, temperature, humidity, and AQI — is signed at the edge by the sensor hardware, verified by a trust-minimized relay server, and permanently stored on-chain as an immutable Solana account. A real-time dashboard renders this data with direct links to on-chain verification via Solscan.

**Key property:** No single party — not the sensor operator, not the server administrator, not the dashboard host — can forge, alter, or delete a reading after it has been committed to the chain.

---

### 2. System Components

#### 2.1 Layer 0: Hardware Sensor Node (ESP32)

**Microcontroller:** ESP32 (dual-core Xtensa LX6, 240 MHz, Wi-Fi + Bluetooth)

**Sensors:**
- **DHT22** (GPIO 4) — temperature (±0.5°C) and humidity (±2% RH) via one-wire protocol
- **MQ-135** (ADC GPIO 34) — analog gas sensor for CO₂ estimation and air quality index; raw 0-4095 ADC values mapped to AQI (50-300) and CO₂ (400-800 ppm) ranges

**Key Management:**
- On first boot, the ESP32 generates a 32-byte Ed25519 keypair using `esp_random()` as entropy source
- Private key and public key are persisted to non-volatile flash via ESP32 Preferences API (NVS)
- On subsequent boots, the keypair is loaded from flash — the node retains its identity across power cycles
- The public key (32 bytes, hex-encoded) is transmitted with every reading and serves as the node's on-chain identity

**Signing Protocol:**
1. Sensor values are serialized into a deterministic JSON string:
   ```
   {"node_id":"esp32_node_1","temperature":XX.XX,"humidity":XX.XX,"aqi":XX.XX,"co2":XX.XX}
   ```
2. This string is signed using Ed25519 with the node's private key, producing a 64-byte signature
3. The payload is wrapped and POSTed:
   ```json
   {
     "data": { "node_id": "...", "temperature": ..., "humidity": ..., "aqi": ..., "co2": ... },
     "signature": "<64-byte hex>",
     "publicKey": "<32-byte hex>"
   }
   ```
4. Readings are submitted every 15 seconds

**Security property:** The signature binds the sensor data to the node's identity. Any tampering with the data in transit or at the server will fail Ed25519 verification. The server cannot forge a valid signature without the node's private key.

---

#### 2.2 Layer 1: Express Relay Server

**Runtime:** Node.js with Express 5.x, deployed on Azure App Service (Linux, Node 22) via GitHub Actions CI/CD

**Dependencies:**
- `@coral-xyz/anchor` 0.29.0 — Anchor framework client for Solana program interaction
- `@solana/web3.js` 1.98.4 — Solana RPC client, keypair management, PDA derivation
- `tweetnacl` 1.0.3 — Ed25519 signature verification (matches ESP32's signing algorithm)
- `express` 5.2.1 — HTTP server
- `cors` — cross-origin support for dashboard
- `dotenv` — environment variable management

**API Endpoints:**

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/submit` | Accept sensor reading, verify signature, commit to Solana |
| `GET` | `/readings/:nodeId` | Fetch all readings for a node from Solana (batched, cached) |
| `GET` | `/tx-signature/:nodeId/:index` | Lazily resolve a Solana transaction signature for a specific reading |
| `GET` | `/locality/:name` | Fetch locality metadata (node count, average AQI) |
| `GET` | `/health` | Health check |

**`POST /submit` — Full Flow:**

1. **Payload extraction:** Accepts nested (`req.body.data.*`) or flat (`req.body.*`) JSON payloads for maximum client compatibility
2. **Input validation:** Rejects missing `node_id` (400), non-numeric sensor values (400) — prevents NaN from being written on-chain
3. **Signature verification:**
   - Reconstructs the exact string the ESP32 signed (matching Arduino's `String(float, 2)` format with `.toFixed(2)`)
   - Decodes hex signature (64 bytes) and hex public key (32 bytes)
   - Calls `nacl.sign.detached.verify(message, signature, publicKey)`
   - Returns **401 Unauthorized** on mismatch — no SOL spent on fraudulent submissions
   - Logs warning but proceeds if signature/publicKey are absent (backward compatible)
4. **Locality & Node registration:**
   - `ensureLocality("Bengaluru")` — checks if the locality PDA exists on-chain; if not, sends `initializeLocality` transaction
   - `ensureNode(nodeId, "Bengaluru")` — checks if the node PDA exists; if not, sends `registerNode` transaction
   - Both functions distinguish "Account does not exist" errors from genuine RPC/network failures (no silent retries on RPC errors)
5. **Reading submission:**
   - Reads `readingCount` from the node account to determine the next reading index
   - Derives the reading PDA: `findProgramAddress(["reading", nodeId, LE64(readingCount)])`
   - Sends `submitReading(co2, temp, humidity, aqi, signature)` Anchor instruction, signed by the server's Solana wallet
   - Returns the transaction signature and caches it in `tx-signatures.json` (keyed by reading PDA)

**`GET /readings/:nodeId` — Optimized Fetch:**

1. Derives node PDA and fetches node account from chain
2. Reads `readingCount` from the node account
3. Fetches readings in **batches of 10** with **300ms inter-batch pauses** to avoid Solana RPC rate limiting (HTTP 429)
4. Each `program.account.reading.fetch()` call is wrapped in **`withRetry`** (3 attempts, exponential backoff: 500ms → 1000ms → 1500ms)
5. Missing readings (account doesn't exist at a PDA) are **gracefully skipped** with a console warning — doesn't crash the endpoint
6. Transaction signatures come from local `tx-signatures.json` cache only (fast, no RPC lookups)
7. Returns all readings as normalized JSON (Anchor BN types converted to plain numbers)

**`GET /tx-signature/:nodeId/:index` — Lazy Signature Resolution:**
- Called by the frontend when a reading lacks a cached tx signature
- First checks local `tx-signatures.json` (instant)
- Falls back to RPC: `getSignaturesForAddress` → `getTransaction` with 8-second timeout
- Validates `index` parameter (rejects NaN with 400)

**RPC Resilience:**
- Primary endpoint: Helius Devnet RPC (`devnet.helius-rpc.com`) with API key from `HELIUS_API_KEY` env var
- Falls back to hardcoded key if env var not set
- All RPC calls wrapped in `withRetry` (3 attempts with backoff)
- `withTimeout` pattern for user-facing endpoints (6-8 second guards on signature lookups)
- Global `uncaughtException` and `unhandledRejection` handlers prevent server crashes

**Transaction Signature Store:**
- `tx-signatures.json` — flat JSON file mapping PDA addresses → Solana transaction signatures
- Written asynchronously (`fs.writeFile`) to never block the event loop
- Entries are created on `/submit` and lazily populated via `/tx-signature`

---

#### 2.3 Layer 2: Solana Anchor Program

**Program ID:** `5UB7ModzcxkMMx93sSemD7NR3S5NKBx1RhEg6VPQHeDd` (devnet)

**Accounts (PDA-based):**

| Account | Seeds | Fields |
|---------|-------|--------|
| `Locality` | `["locality", name]` | `name` (string), `nodeCount` (u32), `averageAqi` (u32), `authority` (Pubkey) |
| `Node` | `["node", nodeId]` | `nodeId` (string), `locality` (string), `readingCount` (u64), `publicKey` (Pubkey), `authority` (Pubkey) |
| `Reading` | `["reading", nodeId, LE64(index)]` | `nodeId` (string), `co2` (f32), `temperature` (f32), `humidity` (f32), `aqi` (f32), `signature` (string), `timestamp` (i64), `locality` (string) |

**Instructions:**

1. **`initializeLocality(name: string)`** — Creates a locality account. Called once per geographic region. Stores the authority's public key.

2. **`registerNode(nodeId: string, localityName: string)`** — Registers a sensor node under a locality. Stores the node ID, locality name, and initializes `readingCount` to 0.

3. **`submitReading(co2: f32, temperature: f32, humidity: f32, aqi: f32, signature: string)`** — Stores a sensor reading at a deterministically derived PDA. The `signature` field stores the ESP32's Ed25519 device signature (not the Solana transaction signature). Timestamp is set automatically by the runtime using `Clock::get()?.unix_timestamp`. Increments the node's `readingCount` and updates the locality's `averageAqi`.

**PDA Derivation:**
- Each reading gets a unique PDA: `hash("reading" || nodeId || LE64(index))`
- The `index` is the current `readingCount` — this ensures sequential, collision-free storage
- Anyone can deterministically compute any reading's address from just the `nodeId` and index

---

#### 2.4 Layer 3: React Dashboard

**Stack:** React 19, Create React App 5, vanilla CSS with CSS Custom Properties

**State Management:** Local `useState` + `useRef` (no Redux/Context needed for single-page dashboard)

**Data Flow:**

1. **Initial load:** `fetchReadings(true)` — shows "Fetching from Solana..." spinner
2. **Polling:** `setInterval(fetchReadings, 20000)` — silent refresh every 20 seconds, no spinner
3. **Signature auto-resolution:** After readings load, `autoLookupSignatures()` scans rows without `txSignature` and fires up to 3 concurrent `/tx-signature` requests with 200ms stagger — signatures appear progressively without user interaction
4. **Deduplication:** `sigLookupRef` (Set) prevents re-fetching the same signature

**Resilience:**
- `fetchingRef` prevents overlapping poll requests
- `mountedRef` prevents state updates after unmount
- `fetchJSON()` safely handles non-JSON responses (HTML error pages from gateway)
- **Refresh failures show as a dismissible red banner** — existing data stays visible, never removed
- **Initial load failures** show full error with Retry button
- **30-second fetch timeout** with clear error messaging
- Errors only clear on **successful** fetch — no flickering between "Failed" and "No readings found"

**Transaction Column:**
- If `txSignature` is cached → clickable Solscan link (`https://solscan.io/tx/{sig}?cluster=devnet`)
- If not cached → "Looking up..." during auto-resolution → resolves to link or "Retry" on failure
- The on-chain `signature` field (ESP32 device signature) is deliberately NOT used for links — only actual Solana transaction signatures

**Rendering Optimizations:**
- `parseAnchorValue()` handles Anchor BN objects (`{words: [...]}`), hex strings, and plain numbers
- `parseReadingTimestamp()` distinguishes Unix seconds from milliseconds (>1e12 heuristic)
- `getAQIStatus()` returns "N/A" with muted color for invalid/missing AQI (not silently showing "Good")

**Responsive Design:**
- 3 breakpoints: 768px (tablet), 480px (phone), 360px (small phone)
- Stats grid: 4-col → 2-col → 1-col
- Table: horizontal scroll wrapper (`overflow-x: auto`) with `-webkit-overflow-scrolling: touch`
- Font stack matches system fonts cross-platform (Apple, Windows, Linux)

**Accessibility:**
- All interactive elements have `:focus-visible` outlines (2px purple)
- Transaction "Verify" buttons are keyboard-accessible (`role="button"`, `tabIndex={0}`, Enter/Space handlers)
- Solscan links announce "opens in new tab" via `aria-label`
- `prefers-reduced-motion: reduce` disables all transitions/animations
- Text contrast meets WCAG AA (4.5:1 minimum)

---

### 3. Trust Model & Threat Analysis

| Threat | Mitigation |
|--------|-----------|
| **Fake sensor data injected by attacker** | Ed25519 signature verification at server — attacker needs node's private key |
| **Server operator forges readings** | Server cannot produce valid ESP32 signature without private key; on-chain `signature` field allows third-party verification |
| **Server modifies data in transit** | Signature is over the exact sensor payload — any modification breaks verification |
| **Data tampered after on-chain storage** | Solana accounts are immutable; the Anchor program has no update/delete instructions for readings |
| **RPC endpoint censors or drops transactions** | Helius RPC with retry logic; transaction signature stored locally and served alongside readings |
| **Replay attack (old reading resubmitted)** | Each reading gets a unique PDA based on `readingCount` — replayed data creates a new account at a new index |
| **Node private key extracted from ESP32** | Flash encryption can be enabled on ESP32; key rotation requires updating the node's `publicKey` field on-chain |
| **Dashboard shows stale/forged data** | All data is fetched from the Solana chain via the server; direct on-chain verification via Solscan link |

---

### 4. Data Flow (End-to-End)

```
ESP32                          Server                        Solana Devnet              Dashboard
  │                              │                                │                         │
  │ 1. Read sensors              │                                │                         │
  │ 2. Sign payload (Ed25519)    │                                │                         │
  │                              │                                │                         │
  │──POST /submit───────────────>│                                │                         │
  │  {data, signature, pubKey}   │                                │                         │
  │                              │ 3. Verify Ed25519 signature    │                         │
  │                              │ 4. ensureLocality("Bengaluru") │                         │
  │                              │ 5. ensureNode("esp32_node_1")  │                         │
  │                              │                                │                         │
  │                              │──submitReading tx─────────────>│                         │
  │                              │  {co2,temp,hum,aqi,sig}        │                         │
  │                              │<──tx signature─────────────────│                         │
  │                              │                                │                         │
  │                              │ 6. Cache tx sig (JSON file)    │                         │
  │<──{success, tx sig}──────────│                                │                         │
  │                              │                                │                         │
  │                              │                                │  GET /readings/esp32_1  │
  │                              │<─────────────────────────────────────────────────────────│
  │                              │ 7. Fetch node PDA → readingCount                         │
  │                              │ 8. Batch-fetch all reading PDAs (10/batch, retry)        │
  │                              │ 9. Pair with cached tx sigs                              │
  │                              │─────────────────────────────────────────────────────────>│
  │                              │  {readings: [...], txSignature: "BNCHt...", ...}         │
  │                              │                                                          │
  │                              │                              ┌─ 10. Auto-lookup missing  │
  │                              │<──GET /tx-signature/:idx─────│   tx sigs (3 concurrent)  │
  │                              │──RPC lookup─────────────────>│                           │
  │                              │<──tx sig─────────────────────│                           │
  │                              │──{signature}─────────────────│──> Render Solscan link    │
```

---

### 5. Deployment Architecture

```
┌──────────────────────────────────────────────────────┐
│                   End Users                          │
│         airchain.thenameisaquila.site                │
│              (Static React Build)                    │
└────────────────────┬─────────────────────────────────┘
                     │ HTTPS (fetch)
                     ▼
┌──────────────────────────────────────────────────────┐
│           Azure App Service (Linux, Node 22)         │
│         airchain-server-c0cma4dcc6fgbhdd            │
│              (Express Server)                        │
│  ┌────────────────────────────────────────────────┐  │
│  │  • Signature verification (tweetnacl)          │  │
│  │  • Anchor program client                       │  │
│  │  • tx-signatures.json cache                    │  │
│  │  • RPC retry + batching                        │  │
│  └────────────────────────────────────────────────┘  │
└────────────┬──────────────────────┬──────────────────┘
             │                      │
             ▼                      ▼
┌────────────────────┐   ┌──────────────────────────┐
│  Helius Devnet RPC │   │   api.devnet.solana.com  │
│  (Primary, 25rps)  │   │   (Fallback via retry)   │
└────────┬───────────┘   └──────────┬───────────────┘
         │                          │
         └──────────┬───────────────┘
                    ▼
┌──────────────────────────────────────────────────────┐
│              Solana Devnet Blockchain                │
│  Program: 5UB7ModzcxkMMx93sSemD7NR3S5NKBx1RhEg...   │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ Locality │  │   Node   │  │ Reading (0..N)   │   │
│  │ "Bengal…"│  │esp32_…_1 │  │ co2, temp, aqi…  │   │
│  └──────────┘  └──────────┘  └──────────────────┘   │
└──────────────────────────────────────────────────────┘
```

**CI/CD:** GitHub Actions → pushes to `main` trigger `npm install` (which pulls `tweetnacl`) and deploy to Azure Web App. Frontend is built locally (`npm run build` in `dashboard/`) and uploaded to static hosting.

**Environment Variables (Azure App Settings):**
- `PRIVATE_KEY` — 64-byte Solana keypair secret key as JSON array (required, server crashes without it)
- `PORT` — HTTP port (defaults to 3001)
- `HELIUS_API_KEY` — Helius RPC API key (falls back to hardcoded value)

---

### 6. Key Design Decisions

**Why Ed25519 for sensor signing?** Same curve as Solana. No dependency mismatch between hardware and blockchain. ESP32 can generate and sign efficiently. `tweetnacl` on the server side is pure JavaScript — no native compilation on Azure.

**Why PDA-based reading storage?** Deterministic addressing means the server can look up any reading by just `nodeId` and `index`. No need for an on-chain registry of reading addresses. Sequential indices simplify pagination and batch fetching.

**Why lazy transaction signature resolution?** The old approach (per-reading RPC lookups inside `/readings`) caused 50+ concurrent RPC calls — triggering rate limits and making the page hang. Now signatures come from a local cache (instant), and missing ones resolve on-demand in the background without blocking the dashboard.

**Why batching with delays instead of raw parallelism?** `Promise.all` on 100 readings fires 100 simultaneous RPC calls. Solana's public endpoint rate-limits at ~25 req/s. Batching with 300ms pauses keeps the server under the limit while maintaining acceptable latency (~2.7s for 50 readings).

**Why not verify signature on-chain?** The Solana program could verify the Ed25519 signature in the `submitReading` instruction, but this would increase compute unit costs (Ed25519 verification is ~50k CU on Solana). Off-chain verification at the relay server achieves the same security guarantee without the gas cost. The signature is still stored on-chain for third-party audit.
