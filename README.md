# Solana Staking App

A non-custodial web app for managing Solana investments — liquid staking via [Marinade Finance](https://marinade.finance), live portfolio holdings, and a full crypto market dashboard.

---

## Features

### Portfolio
- Connect your **Phantom wallet** and view SOL & mSOL balances in real time
- **Stake SOL** → receive mSOL, earn ~6–8% APY automatically
- **Withdraw mSOL** → instantly convert back to SOL (liquid unstake, small fee)
- Enter amounts in **SOL or USD** — toggle between them on the fly
- Live SOL ↔ mSOL exchange rate estimates before you sign
- Transaction log with confirmation status and Solscan links

### Holdings
- Full breakdown of every token in your wallet (SOL + all SPL tokens)
- **Portfolio 24h change** — weighted average across all holdings by USD value
- Per-asset: balance, price, USD value, portfolio %, 24h and 1M/1Y returns
- Best and worst 24h performer cards at a glance

### Market
- Live global stats: total market cap, 24h volume, BTC & ETH dominance
- **Top 15 cryptocurrencies** by market cap with 24h, 1W, 1M, 1Y returns
- Combined market cap of the top 15, with a CoinGecko link for full data
- Auto-refreshes every 5 minutes; serves stale cache on rate-limit

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        Browser                          │
│  frontend/index.html + script.js + styles.css           │
│                                                         │
│  1. User connects Phantom wallet                        │
│  2. Frontend calls backend to build unsigned tx         │
│  3. Phantom signs the tx (private key never leaves      │
│     the browser)                                        │
│  4. Phantom broadcasts signed tx to Solana              │
│  5. Frontend polls /confirmTx until finalized           │
└───────────────┬─────────────────────────────────────────┘
                │  REST API (localhost:4000)
┌───────────────▼─────────────────────────────────────────┐
│                    backend/server.js                    │
│                                                         │
│  Builds unsigned transactions using Marinade SDK        │
│  Fetches prices + market data from CoinGecko            │
│  Reads on-chain balances via Solana RPC                 │
│  Never holds private keys or signs anything             │
└───────────────┬─────────────────────────────────────────┘
                │
        ┌───────┴────────┐
        │                │
   Solana Mainnet   CoinGecko API
   (RPC calls)     (prices, market data)
```

**Key design principle:** the backend is a *transaction builder only*. It constructs and serializes unsigned transactions, returns them as Base64, and the user signs via Phantom in the browser. The backend has zero access to funds.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript (no build step) |
| Wallet | Phantom browser extension via `window.solana` |
| Solana SDK | `@solana/web3.js` v1.95 (CDN) |
| Staking protocol | Marinade Finance (`@marinade.finance/marinade-ts-sdk`) |
| Backend | Node.js 18+ · Express · ES Modules |
| Price data | CoinGecko free API |
| Network | Solana Mainnet Beta |

---

## Getting Started

### Prerequisites
- **Node.js 18+**
- **Phantom wallet** browser extension — [phantom.app](https://phantom.app)
- A Solana mainnet wallet with some SOL

### 1. Start the backend

```bash
cd backend
npm install
node server.js
# Server running at http://localhost:4000
```

### 2. Serve the frontend

The frontend is static — no build step required. Serve it with any static file server:

```bash
npx http-server frontend/
# Open http://localhost:8080
```

Or open `frontend/index.html` directly in your browser.

### 3. Connect your wallet

Click **Connect Phantom Wallet** and approve the connection. Your SOL and mSOL balances load automatically.

---

## API Reference

Base URL: `http://localhost:4000`

| Method | Endpoint | Body | Response |
|---|---|---|---|
| GET | `/health` | — | `{ ok, ts, rpc }` |
| GET | `/prices` | — | `{ sol, msol }` (USD) |
| GET | `/market` | — | Global stats + top 15 coins |
| POST | `/balance` | `{ wallet }` | `{ sol, lamports, usd }` |
| POST | `/investment` | `{ wallet }` | `{ msol, usd }` |
| POST | `/holdings` | `{ wallet }` | All token holdings with market data |
| POST | `/stake` | `{ wallet, amount }` | `{ transaction }` Base64 unsigned tx |
| POST | `/withdraw` | `{ wallet, amount }` | `{ transaction }` Base64 unsigned tx |
| POST | `/confirmTx` | `{ signature }` | Solana confirmation status |

### Server-side caching

| Data | TTL | Endpoint |
|---|---|---|
| SOL/mSOL prices | 60 seconds | `/prices` |
| Market data (top 15) | 5 minutes | `/market` |
| Per-token metadata | 1 hour | used by `/holdings` |

---

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP port for the backend |
| `RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |

For production, replace the public RPC with a dedicated endpoint (e.g. Helius, QuickNode) to avoid rate limits.

---

## Deployment Notes

- Update `API_BASE` in `frontend/script.js` from `localhost:4000` to your deployed backend URL
- The frontend can be hosted on any static host (Vercel, Netlify, Cloudflare Pages, S3, etc.)
- The backend is a standard Node.js Express app — deploy to Railway, Render, Fly.io, or any VPS
- CoinGecko free tier is rate-limited; consider upgrading to a paid plan or adding a longer cache TTL for high-traffic deployments

---

## How Staking Works

Marinade Finance is a liquid staking protocol on Solana. When you stake:

1. You deposit SOL → Marinade gives you **mSOL** (Marinade Staked SOL)
2. mSOL automatically appreciates in value relative to SOL as staking rewards accrue (~6–8% APY)
3. You can hold, trade, or use mSOL in DeFi at any time
4. To exit, use **liquid unstake** — convert mSOL back to SOL instantly for a small fee (~0.3%), or wait for the standard unstake delay (2–3 epochs, ~5 days) for no fee

---

## Project Structure

```
solana-staking-webapp/
├── backend/
│   ├── server.js        # Express API — tx builder, price/market/holdings endpoints
│   └── package.json
└── frontend/
    ├── index.html       # App shell, all screens
    ├── script.js        # All UI logic, wallet integration, API calls
    └── styles.css       # Design tokens, components, responsive layout
```
