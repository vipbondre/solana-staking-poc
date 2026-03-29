# Solana Staking App

A non-custodial web app for managing Solana investments — multi-protocol liquid staking, native validator staking, live portfolio holdings, and a full crypto market dashboard.

---

## Features

### Portfolio
- Connect your **Phantom wallet** and view SOL & mSOL balances in real time
- **Stake SOL** → receive mSOL via Marinade Finance
- **Withdraw mSOL** → instantly convert back to SOL (liquid unstake, small fee)
- Enter amounts in **SOL or USD** — toggle between them on the fly
- Live exchange rate estimates before you sign
- Transaction log with confirmation status and Solscan links

### Earn
- **Multi-protocol liquid staking** — compare and stake with Marinade, Jito, BlazeStake, and JPool side by side
- Live APY and TVL for each protocol sourced from DeFiLlama
- **Native staking** — stake directly on-chain with any validator, zero smart contract risk
- Searchable validator table with APY, commission, hit rate, and TVL
- SOL/USD toggle on all staking inputs
- View and manage your native stake accounts — unstake and withdraw in one click

### Holdings
- Full breakdown of every token in your wallet (SOL + all SPL tokens)
- **Portfolio 24h change** — weighted average across all holdings by USD value
- Per-asset: balance, price, USD value, portfolio %, 24h and 1M/1Y returns
- Best and worst 24h performer cards at a glance

### Market
- Live global stats: total market cap, 24h volume, BTC & ETH dominance
- **Top 15 cryptocurrencies** by market cap with 24h, 1M, 1Y returns
- Auto-refreshes every 5 minutes while you're on the tab

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
│  Builds unsigned transactions (Marinade, SPL pools,     │
│  native stake program)                                  │
│  Fetches APY/TVL/prices from DeFiLlama                  │
│  Fetches validator data from Stakewiz                   │
│  Fetches market data from CoinGecko                     │
│  Reads on-chain balances via Solana RPC                 │
│  Never holds private keys or signs anything             │
└───────────────┬─────────────────────────────────────────┘
                │
        ┌───────┴──────────────────┐
        │                          │
   Solana Mainnet        External APIs
   (RPC calls)          DeFiLlama · Stakewiz · CoinGecko
```

**Key design principle:** the backend is a *transaction builder only*. It constructs and serializes unsigned transactions, returns them as Base64, and the user signs via Phantom in the browser. The backend has zero access to funds.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript (no build step) |
| Wallet | Phantom browser extension via `window.solana` |
| Solana SDK | `@solana/web3.js` v1.95 (CDN) |
| Liquid staking | Marinade (`@marinade.finance/marinade-ts-sdk`) · Jito, BlazeStake, JPool (`@solana/spl-stake-pool`) |
| Native staking | Solana native stake program via `@solana/web3.js` |
| Backend | Node.js 18+ · Express · ES Modules |
| APY / TVL data | DeFiLlama yields API (free, no key) |
| Token prices | DeFiLlama coins API (free, no key) |
| Validator data | Stakewiz API (free, no key) |
| Market data | CoinGecko free API |
| Network | Solana Mainnet Beta |

---

## Getting Started

### Prerequisites
- **Node.js 18+**
- **Phantom wallet** browser extension — [phantom.app](https://phantom.app)
- A Solana mainnet wallet with some SOL

### 1. Clone the repo

```bash
git clone https://github.com/vipbondre/solana-staking-poc.git
cd solana-staking-poc
```

### 2. Start the backend

```bash
cd backend
npm install
node server.js
# Server running at http://localhost:4000
```

### 3. Serve the frontend

The frontend is static — no build step required:

```bash
npx http-server frontend/
# Open http://localhost:8080
```

Or open `frontend/index.html` directly in your browser.

### 4. Connect your wallet

Click **Connect Phantom Wallet** and approve the connection. Your SOL and token balances load automatically.

---

## API Reference

Base URL: `http://localhost:4000`

| Method | Endpoint | Body | Response |
|---|---|---|---|
| GET | `/health` | — | `{ ok, ts, rpc }` |
| GET | `/staking-options` | — | All protocols with APY + TVL |
| GET | `/validators` | — | Top validators with APY, commission, hit rate, TVL |
| GET | `/market` | — | Global stats + top 15 coins |
| POST | `/balance` | `{ wallet }` | `{ sol, lamports, usd }` |
| POST | `/investment` | `{ wallet }` | `{ msol, usd }` |
| POST | `/holdings` | `{ wallet }` | All token holdings with prices and market data |
| POST | `/stake` | `{ wallet, amount }` | Marinade — Base64 unsigned tx |
| POST | `/stake/jito` | `{ wallet, amount }` | Jito — Base64 unsigned tx |
| POST | `/stake/blaze` | `{ wallet, amount }` | BlazeStake — Base64 unsigned tx |
| POST | `/stake/jpool` | `{ wallet, amount }` | JPool — Base64 unsigned tx |
| POST | `/stake/native` | `{ wallet, amount, voteAccount }` | Native — Base64 partially signed tx |
| POST | `/stake-accounts` | `{ wallet }` | All native stake accounts for wallet |
| POST | `/unstake/native` | `{ wallet, stakeAccount }` | Deactivate — Base64 unsigned tx |
| POST | `/withdraw/native` | `{ wallet, stakeAccount }` | Withdraw — Base64 unsigned tx |
| POST | `/withdraw` | `{ wallet, amount }` | Marinade liquid unstake — Base64 unsigned tx |
| POST | `/confirmTx` | `{ signature }` | Solana confirmation status |

### Server-side caching

| Data | TTL | Source |
|---|---|---|
| SOL/mSOL prices | 60 seconds | DeFiLlama coins API |
| Staking options (APY/TVL) | 10 minutes | DeFiLlama yields API |
| Validator list | 1 hour | Stakewiz API |
| Market data (top 15) | 5 minutes | CoinGecko API |
| Per-token metadata | 1 hour | CoinGecko API |

---

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP port for the backend |
| `RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |

For production, replace the public RPC with a dedicated endpoint (e.g. Helius, QuickNode) to avoid rate limits.

---

## Deployment

- Update `API_BASE` in `frontend/script.js` from `localhost:4000` to your deployed backend URL
- The frontend can be hosted on any static host (Vercel, Netlify, Cloudflare Pages, S3)
- The backend is a standard Node.js Express app — deploy to Railway, Render, Fly.io, or any VPS

---

## How Staking Works

### Liquid Staking
Deposit SOL into a protocol's stake pool and receive a liquid token in return. The token appreciates in value as staking rewards accrue. You can hold, trade, or use it in DeFi at any time.

| Protocol | Token | Highlight |
|---|---|---|
| Marinade Finance | mSOL | Diversified validator pool |
| Jito | JitoSOL | MEV rewards passed to stakers |
| BlazeStake | bSOL | Custom validator direction |
| JPool | JSOL | Community-focused |

To exit: liquid unstake instantly for a small fee (~0.3%), or delayed unstake (~2 days) for free.

### Native Staking
Stake SOL directly with a validator of your choice using Solana's native stake program — no third-party smart contract involved.

1. Select a validator from the table (filter by APY, commission, hit rate)
2. Enter amount and confirm — a stake account is created on-chain with your wallet as authority
3. Stake activates at the next epoch boundary (~2 days)
4. To exit: deactivate → wait ~2 days → withdraw SOL back to wallet

No liquid token is issued. SOL is locked during the staking period.

---

## Project Structure

```
solana-staking-webapp/
├── backend/
│   ├── server.js        # Express API — tx builder, price/market/holdings/staking endpoints
│   └── package.json
├── frontend/
│   ├── index.html       # App shell — Portfolio, Holdings, Earn, Market tabs
│   ├── script.js        # All UI logic, wallet integration, API calls
│   └── styles.css       # Design tokens, components, responsive layout
└── docs/
    └── staking-multiprotocol-research.md   # Protocol research and implementation notes
```
