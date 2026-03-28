// server.js — Solana Staking Backend
// Node 18+ required (uses native fetch for price data)

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
import { Marinade, MarinadeConfig } from "@marinade.finance/marinade-ts-sdk";

// ─── Token Detail Cache ────────────────────────────────────────────────────────

const TOKEN_DETAIL_TTL_MS = 60 * 60_000; // 1 hour — CoinGecko free tier
const tokenDetailCache    = new Map();    // mint → { data, updatedAt }

async function getTokenDetail(mint) {
  const cached = tokenDetailCache.get(mint);
  if (cached && Date.now() - cached.updatedAt < TOKEN_DETAIL_TTL_MS) return cached.data;

  const res = await fetch(
    `https://api.coingecko.com/api/v3/coins/solana/contract/${mint}` +
    `?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!res.ok) throw new Error(`CoinGecko token detail HTTP ${res.status}`);
  const json = await res.json();

  const data = {
    name:      json.name,
    symbol:    json.symbol?.toUpperCase(),
    image:     json.image?.small ?? json.image?.thumb ?? null,
    change7d:  json.market_data?.price_change_percentage_7d  ?? null,
    change30d: json.market_data?.price_change_percentage_30d ?? null,
    change1y:  json.market_data?.price_change_percentage_1y  ?? null,
    marketCap: json.market_data?.market_cap?.usd             ?? null,
  };

  tokenDetailCache.set(mint, { data, updatedAt: Date.now() });
  log("DEBUG", "Token detail cached", { mint, symbol: data.symbol });
  return data;
}
import BN from "bn.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT    = process.env.PORT    || 4000;
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");
const MIN_STAKE_SOL = 0.001;

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(level, message, data = null) {
  const entry = { ts: new Date().toISOString(), level, message };
  if (data) entry.data = data;
  console.log(JSON.stringify(entry));
}

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Request logger middleware
app.use((req, _res, next) => {
  log("DEBUG", `${req.method} ${req.path}`, req.body && Object.keys(req.body).length ? req.body : null);
  next();
});

// Response timer middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () =>
    log("INFO", `${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`)
  );
  next();
});

// ─── Solana Connection ────────────────────────────────────────────────────────

const connection = new Connection(RPC_URL, "confirmed");
log("INFO", "Solana connection initialised", { rpc: RPC_URL });

// ─── Price Cache ──────────────────────────────────────────────────────────────

const PRICE_TTL_MS = 60_000;
let priceCache = { sol: 0, msol: 0, updatedAt: 0 };

async function getPrices() {
  if (Date.now() - priceCache.updatedAt < PRICE_TTL_MS) return priceCache;

  try {
    const res  = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana,msol&vs_currencies=usd",
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    priceCache = {
      sol:       data.solana?.usd ?? 0,
      msol:      data.msol?.usd   ?? 0,
      updatedAt: Date.now(),
    };
    log("DEBUG", "Prices refreshed", priceCache);
  } catch (err) {
    log("WARN", "Price fetch failed — using cached values", { error: err.message });
  }

  return priceCache;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parsePublicKey(wallet) {
  try { return new PublicKey(wallet); } catch { return null; }
}

function fail(res, status, message, detail = null) {
  const body = { error: message };
  if (detail) body.detail = detail;
  log("WARN", message, detail ? { detail } : null);
  return res.status(status).json(body);
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), rpc: RPC_URL });
});

// Token prices (USD)
app.get("/prices", async (_req, res) => {
  try {
    res.json(await getPrices());
  } catch (e) {
    fail(res, 500, "Failed to fetch prices", e.message);
  }
});

// Native SOL balance
app.post("/balance", async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return fail(res, 400, "wallet is required");

  const pubkey = parsePublicKey(wallet);
  if (!pubkey) return fail(res, 400, "Invalid wallet address");

  try {
    const [lamports, prices] = await Promise.all([
      connection.getBalance(pubkey),
      getPrices(),
    ]);
    const sol = lamports / LAMPORTS_PER_SOL;
    res.json({ sol, lamports, usd: +(sol * prices.sol).toFixed(2) });
  } catch (e) {
    fail(res, 500, "Failed to fetch balance", e.message);
  }
});

// mSOL balance (liquid staking position)
app.post("/investment", async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return fail(res, 400, "wallet is required");

  const pubkey = parsePublicKey(wallet);
  if (!pubkey) return fail(res, 400, "Invalid wallet address");

  try {
    const [accounts, prices] = await Promise.all([
      connection.getTokenAccountsByOwner(pubkey, { mint: MSOL_MINT }),
      getPrices(),
    ]);

    let msol = 0;
    for (const { pubkey: ta } of accounts.value) {
      const bal = await connection.getTokenAccountBalance(ta);
      msol += bal?.value?.uiAmount ?? 0;
    }

    res.json({ msol, usd: +(msol * prices.msol).toFixed(2) });
  } catch (e) {
    fail(res, 500, "Failed to fetch mSOL balance", e.message);
  }
});

// Build stake transaction (SOL → mSOL via Marinade deposit)
app.post("/stake", async (req, res) => {
  const { wallet, amount } = req.body;
  if (!wallet || amount == null) return fail(res, 400, "wallet and amount are required");

  const pubkey = parsePublicKey(wallet);
  if (!pubkey) return fail(res, 400, "Invalid wallet address");

  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0)  return fail(res, 400, "amount must be a positive number");
  if (amountNum < MIN_STAKE_SOL)            return fail(res, 400, `Minimum stake is ${MIN_STAKE_SOL} SOL`);

  try {
    const config   = new MarinadeConfig({ connection, publicKey: pubkey });
    const marinade = new Marinade(config);
    const lamports = new BN(Math.floor(amountNum * LAMPORTS_PER_SOL));

    const { transaction } = await marinade.deposit(lamports);
    transaction.feePayer        = pubkey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
    log("INFO", "Stake tx built", { wallet, sol: amountNum });
    res.json({ transaction: Buffer.from(serialized).toString("base64") });
  } catch (e) {
    fail(res, 500, "Failed to build stake transaction", e.message);
  }
});

// Build withdraw transaction (mSOL → SOL via Marinade liquidUnstake)
app.post("/withdraw", async (req, res) => {
  const { wallet, amount } = req.body;
  if (!wallet || amount == null) return fail(res, 400, "wallet and amount are required");

  const pubkey = parsePublicKey(wallet);
  if (!pubkey) return fail(res, 400, "Invalid wallet address");

  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) return fail(res, 400, "amount must be a positive number");

  try {
    const config   = new MarinadeConfig({ connection, publicKey: pubkey });
    const marinade = new Marinade(config);
    const msolAmt  = new BN(Math.floor(amountNum * LAMPORTS_PER_SOL));

    const { transaction } = await marinade.liquidUnstake(msolAmt);
    transaction.feePayer        = pubkey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const serialized = transaction.serialize({ requireAllSignatures: false });
    log("INFO", "Withdraw tx built", { wallet, msol: amountNum });
    res.json({ transaction: Buffer.from(serialized).toString("base64") });
  } catch (e) {
    fail(res, 500, "Failed to build withdraw transaction", e.message);
  }
});

// ─── Market Data Cache ────────────────────────────────────────────────────────

const MARKET_TTL_MS = 5 * 60_000; // 5 minutes — CoinGecko free tier is rate-limited
let marketCache = { data: null, updatedAt: 0 };

async function getMarketData() {
  if (marketCache.data && Date.now() - marketCache.updatedAt < MARKET_TTL_MS) {
    return { ...marketCache.data, cachedAt: marketCache.updatedAt, stale: false };
  }

  const [globalRes, coinsRes] = await Promise.all([
    fetch("https://api.coingecko.com/api/v3/global",
      { signal: AbortSignal.timeout(10_000) }),
    fetch(
      "https://api.coingecko.com/api/v3/coins/markets" +
      "?vs_currency=usd&order=market_cap_desc&per_page=15&page=1" +
      "&sparkline=false&price_change_percentage=24h,7d,30d,1y",
      { signal: AbortSignal.timeout(10_000) }
    ),
  ]);

  if (!globalRes.ok) throw new Error(`CoinGecko global: HTTP ${globalRes.status}`);
  if (!coinsRes.ok)  throw new Error(`CoinGecko coins: HTTP ${coinsRes.status}`);

  const [globalJson, coinsJson] = await Promise.all([globalRes.json(), coinsRes.json()]);

  marketCache = {
    data:      { global: globalJson.data, coins: coinsJson },
    updatedAt: Date.now(),
  };

  log("DEBUG", "Market data refreshed", { coins: coinsJson.length });
  return { ...marketCache.data, cachedAt: marketCache.updatedAt, stale: false };
}

// Global market overview + top 15 coins
app.get("/market", async (_req, res) => {
  try {
    res.json(await getMarketData());
  } catch (e) {
    // Serve stale cache rather than failing hard
    if (marketCache.data) {
      log("WARN", "Serving stale market cache", { error: e.message });
      return res.json({ ...marketCache.data, cachedAt: marketCache.updatedAt, stale: true });
    }
    fail(res, 503, "Market data unavailable", e.message);
  }
});

// Transaction confirmation status (poll-friendly)
app.post("/confirmTx", async (req, res) => {
  const { signature } = req.body;
  if (!signature)                                      return fail(res, 400, "signature is required");
  if (typeof signature !== "string" || signature.length < 44) return fail(res, 400, "Invalid signature format");

  try {
    const statuses = await connection.getSignatureStatuses([signature]);
    res.json(statuses.value[0] ?? { confirmationStatus: null });
  } catch (e) {
    fail(res, 500, "Failed to get transaction status", e.message);
  }
});

// Wallet holdings: native SOL + all SPL tokens with prices and market data
app.post("/holdings", async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return fail(res, 400, "wallet is required");

  const pubkey = parsePublicKey(wallet);
  if (!pubkey) return fail(res, 400, "Invalid wallet address");

  try {
    const [lamports, prices, tokenAccountsResult] = await Promise.all([
      connection.getBalance(pubkey),
      getPrices(),
      connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
    ]);

    const solBalance = lamports / LAMPORTS_PER_SOL;

    // Collect non-zero SPL token accounts
    const tokens = [];
    for (const { account } of tokenAccountsResult.value) {
      const info = account.data.parsed?.info;
      if (!info) continue;
      const uiAmount = info.tokenAmount?.uiAmount ?? 0;
      if (uiAmount <= 0) continue;
      tokens.push({ mint: info.mint, balance: uiAmount });
    }

    // Batch-fetch USD prices + 24h change for all SPL tokens
    let tokenPrices = {};
    if (tokens.length > 0) {
      const mints = tokens.map(t => t.mint).join(",");
      try {
        const priceRes = await fetch(
          `https://api.coingecko.com/api/v3/simple/token_price/solana` +
          `?contract_addresses=${mints}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`,
          { signal: AbortSignal.timeout(10_000) }
        );
        if (priceRes.ok) tokenPrices = await priceRes.json();
      } catch (err) {
        log("WARN", "Token price batch fetch failed", { error: err.message });
      }
    }

    // Fetch token metadata + 7d/30d/1y changes (best-effort, individually cached 1h)
    const detailResults = await Promise.allSettled(
      tokens.map(t => getTokenDetail(t.mint))
    );

    // Pull SOL change data from market cache if available
    let solChanges = { change24h: null, change7d: null, change30d: null, change1y: null };
    if (marketCache.data?.coins) {
      const solCoin = marketCache.data.coins.find(c => c.id === "solana");
      if (solCoin) {
        solChanges = {
          change24h: solCoin.price_change_percentage_24h_in_currency ?? null,
          change7d:  solCoin.price_change_percentage_7d_in_currency  ?? null,
          change30d: solCoin.price_change_percentage_30d_in_currency ?? null,
          change1y:  solCoin.price_change_percentage_1y_in_currency  ?? null,
        };
      }
    }

    const holdings = [];

    // Native SOL holding
    holdings.push({
      type:      "native",
      symbol:    "SOL",
      name:      "Solana",
      image:     "https://assets.coingecko.com/coins/images/4128/small/solana.png",
      balance:   solBalance,
      price:     prices.sol ?? 0,
      value:     solBalance * (prices.sol ?? 0),
      ...solChanges,
      marketCap: null,
    });

    // SPL token holdings
    tokens.forEach((t, i) => {
      const priceData = tokenPrices[t.mint] ?? {};
      const detail    = detailResults[i].status === "fulfilled" ? detailResults[i].value : null;
      const price     = priceData.usd ?? 0;
      holdings.push({
        type:      "spl",
        mint:      t.mint,
        symbol:    detail?.symbol ?? (t.mint.slice(0, 6) + "…"),
        name:      detail?.name   ?? "Unknown Token",
        image:     detail?.image  ?? null,
        balance:   t.balance,
        price,
        value:     t.balance * price,
        change24h: priceData.usd_24h_change ?? null,
        change7d:  detail?.change7d          ?? null,
        change30d: detail?.change30d         ?? null,
        change1y:  detail?.change1y          ?? null,
        marketCap: priceData.usd_market_cap ?? detail?.marketCap ?? null,
      });
    });

    // Sort by value descending
    holdings.sort((a, b) => b.value - a.value);

    const totalValue = holdings.reduce((s, h) => s + h.value, 0);
    holdings.forEach(h => {
      h.portfolioPct = totalValue > 0 ? (h.value / totalValue) * 100 : 0;
    });

    log("INFO", "Holdings fetched", { wallet, count: holdings.length, totalValue: totalValue.toFixed(2) });
    res.json({ holdings, totalValue, count: holdings.length });
  } catch (e) {
    fail(res, 500, "Failed to fetch holdings", e.message);
  }
});

// ─── Error Handlers ───────────────────────────────────────────────────────────

app.use((req, res) => fail(res, 404, `${req.method} ${req.path} not found`));

// eslint-disable-next-line no-unused-vars
app.use((e, _req, res, _next) => {
  log("ERROR", "Unhandled exception", { message: e.message, stack: e.stack });
  fail(res, 500, "Internal server error");
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log("INFO", `Server listening`, { url: `http://localhost:${PORT}` });
});
