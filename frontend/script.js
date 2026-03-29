'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────

const API_BASE  = 'http://localhost:4000';
const SOLSCAN   = 'https://solscan.io/tx';
const POLL_INTERVAL_MS  = 1_500;
const POLL_TIMEOUT_MS   = 90_000;   // give up confirming after 90s
const SOL_FEE_RESERVE   = 0.01;     // keep for transaction fees on Max

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  wallet:       null,   // connected wallet address (string)
  solBalance:   null,   // { sol, usd, lamports }
  msolBalance:  null,   // { msol, usd }
  prices:       null,   // { sol, msol }
  txHistory:    [],     // { id, type, amount, token, signature, status, ts }
  stakeMode:    'sol',  // 'sol' | 'usd'
  withdrawMode: 'msol', // 'msol' | 'usd'
};

// ─── Utilities ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function truncate(addr, chars = 4) {
  return addr ? `${addr.slice(0, chars + 2)}…${addr.slice(-chars)}` : '–';
}

// Shorter address on narrow screens (< 480px)
function truncateAdaptive(addr) {
  const chars = window.innerWidth < 480 ? 4 : 6;
  return truncate(addr, chars);
}

function fmt(n, decimals = 4) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

function fmtUsd(n) {
  if (!n && n !== 0) return '–';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

function setLoading(btn, loading, originalLabel) {
  btn.disabled = loading;
  if (loading) {
    btn.dataset.label = btn.textContent;
    btn.innerHTML = `<span class="spinner"></span> ${originalLabel}`;
  } else {
    btn.textContent = btn.dataset.label || originalLabel;
  }
}

// ─── API Client ───────────────────────────────────────────────────────────────

const api = {
  async _req(method, path, body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(`${API_BASE}${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.detail || `HTTP ${res.status}`);
    return data;
  },
  get:  (path)       => api._req('GET',  path),
  post: (path, body) => api._req('POST', path, body),
};

// ─── Toast Notifications ──────────────────────────────────────────────────────

function toast(message, type = 'info', duration = 5000) {
  const container = $('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-body">${message}</span><button class="toast-close" aria-label="Close">✕</button>`;

  const close = () => {
    el.classList.add('hiding');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };

  el.querySelector('.toast-close').onclick = close;
  container.appendChild(el);

  if (duration > 0) setTimeout(close, duration);
}

// ─── Theme ────────────────────────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem('theme') || 'light';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('themeIcon').textContent = theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

async function connectWallet() {
  if (!window.solana?.isPhantom) {
    $('phantomMissing').classList.remove('hidden');
    return;
  }

  const btn = $('connectBtn');
  setLoading(btn, true, 'Connecting…');

  try {
    const resp = await window.solana.connect();
    state.wallet = resp.publicKey.toString();
    showDashboard();
    await refreshAll();
  } catch (err) {
    console.error('[wallet] connect failed', err);
    toast(`Connection failed: ${err.message}`, 'error');
  } finally {
    setLoading(btn, false, 'Connect Phantom Wallet');
  }
}

function disconnectWallet() {
  if (window.solana?.disconnect) window.solana.disconnect();
  state.wallet      = null;
  state.solBalance  = null;
  state.msolBalance = null;
  state.txHistory   = [];
  holdingsLoaded    = false;
  earnLoaded        = false;
  selectedProtocol  = null;
  selectedValidator = null;
  earnStakeMode     = 'sol';
  nativeStakeMode   = 'sol';
  nativeSectionOpen = false;
  showConnectScreen();
  toast('Wallet disconnected', 'info');
}

// ─── UI Screens ───────────────────────────────────────────────────────────────

function showDashboard() {
  $('connectScreen').classList.add('hidden');
  $('dashboardScreen').classList.remove('hidden');
  $('walletAddress').textContent = truncateAdaptive(state.wallet);
  $('walletAddress').title       = state.wallet; // full address on hover/long-press
}

function showConnectScreen() {
  $('dashboardScreen').classList.add('hidden');
  $('connectScreen').classList.remove('hidden');
}

// ─── Balance Display ──────────────────────────────────────────────────────────

function displaySolBalance(data) {
  state.solBalance = data;
  $('solAmount').textContent = data ? `${fmt(data.sol, 4)} SOL` : '–';
  $('solUsd').textContent    = data ? fmtUsd(data.usd)         : '–';
  updateEstimates();
}

function displayMsolBalance(data) {
  state.msolBalance = data;
  $('msolAmount').textContent = data ? `${fmt(data.msol, 4)} mSOL` : '–';
  $('msolUsd').textContent    = data ? fmtUsd(data.usd)            : '–';
  updateEstimates();
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

async function refreshSol() {
  const btn = $('refreshSol');
  btn.disabled = true;
  try {
    const data = await api.post('/balance', { wallet: state.wallet });
    displaySolBalance(data);
  } catch (err) {
    console.error('[balance] SOL fetch failed', err);
    toast(`SOL balance error: ${err.message}`, 'warning');
  } finally {
    btn.disabled = false;
  }
}

async function refreshMsol() {
  const btn = $('refreshMsol');
  btn.disabled = true;
  try {
    const data = await api.post('/investment', { wallet: state.wallet });
    displayMsolBalance(data);
  } catch (err) {
    console.error('[balance] mSOL fetch failed', err);
    toast(`mSOL balance error: ${err.message}`, 'warning');
  } finally {
    btn.disabled = false;
  }
}

async function refreshPrices() {
  try {
    state.prices = await api.get('/prices');
    updateEstimates();
  } catch (err) {
    console.error('[prices] fetch failed', err);
  }
}

async function refreshAll() {
  await Promise.allSettled([refreshPrices(), refreshSol(), refreshMsol()]);
}

// ─── Currency Mode ────────────────────────────────────────────────────────────

function setStakeMode(mode) {
  state.stakeMode = mode;
  $('stakeSuffix').textContent = mode === 'usd' ? 'USD' : 'SOL';
  document.querySelectorAll('#stakeToggle .toggle-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  $('stakeAmount').value = '';
  updateEstimates();
}

function setWithdrawMode(mode) {
  state.withdrawMode = mode;
  $('withdrawSuffix').textContent = mode === 'usd' ? 'USD' : 'mSOL';
  document.querySelectorAll('#withdrawToggle .toggle-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  $('withdrawAmount').value = '';
  updateEstimates();
}

// ─── Estimates ────────────────────────────────────────────────────────────────

function updateEstimates() {
  const stakeInput    = parseFloat($('stakeAmount').value);
  const withdrawInput = parseFloat($('withdrawAmount').value);
  const p = state.prices;

  if (p?.sol && p?.msol) {
    const rate = p.sol / p.msol;  // mSOL per SOL

    // Stake estimate
    if (!isNaN(stakeInput) && stakeInput > 0) {
      if (state.stakeMode === 'usd') {
        const solEquiv  = stakeInput / p.sol;
        const msolEquiv = solEquiv * rate;
        $('stakeEstimate').textContent =
          `${fmtUsd(stakeInput)} → ≈ ${fmt(solEquiv, 4)} SOL → ${fmt(msolEquiv, 4)} mSOL`;
      } else {
        const msolEquiv = stakeInput * rate;
        $('stakeEstimate').textContent =
          `≈ ${fmt(msolEquiv, 4)} mSOL  (≈ ${fmtUsd(stakeInput * p.sol)})`;
      }
    } else {
      $('stakeEstimate').textContent = `Rate: 1 SOL ≈ ${fmt(rate, 4)} mSOL`;
    }

    // Withdraw estimate
    if (!isNaN(withdrawInput) && withdrawInput > 0) {
      if (state.withdrawMode === 'usd') {
        const msolEquiv = withdrawInput / p.msol;
        const solEquiv  = msolEquiv / rate;
        $('withdrawEstimate').textContent =
          `${fmtUsd(withdrawInput)} → ≈ ${fmt(msolEquiv, 4)} mSOL → ${fmt(solEquiv, 4)} SOL`;
      } else {
        const solEquiv = withdrawInput / rate;
        $('withdrawEstimate').textContent =
          `≈ ${fmt(solEquiv, 4)} SOL  (≈ ${fmtUsd(withdrawInput * p.msol)})`;
      }
    } else {
      $('withdrawEstimate').textContent = `Rate: 1 mSOL ≈ ${fmt(1/rate, 4)} SOL`;
    }
  } else {
    $('stakeEstimate').textContent    = '≈ – mSOL (price unavailable)';
    $('withdrawEstimate').textContent = '≈ – SOL (price unavailable)';
  }
}

// ─── Max buttons ─────────────────────────────────────────────────────────────

function setMaxStake() {
  if (!state.solBalance) return;
  const maxSol = Math.max(0, state.solBalance.sol - SOL_FEE_RESERVE);
  if (state.stakeMode === 'usd') {
    const maxUsd = maxSol * (state.prices?.sol ?? 0);
    $('stakeAmount').value = maxUsd > 0 ? fmt(maxUsd, 2).replace(/,/g, '') : '';
  } else {
    $('stakeAmount').value = maxSol > 0 ? fmt(maxSol, 6).replace(/,/g, '') : '';
  }
  updateEstimates();
}

function setMaxWithdraw() {
  if (!state.msolBalance) return;
  if (state.withdrawMode === 'usd') {
    const maxUsd = state.msolBalance.msol * (state.prices?.msol ?? 0);
    $('withdrawAmount').value = fmt(maxUsd, 2).replace(/,/g, '');
  } else {
    $('withdrawAmount').value = fmt(state.msolBalance.msol, 6).replace(/,/g, '');
  }
  updateEstimates();
}

// ─── Copy Address ─────────────────────────────────────────────────────────────

async function copyAddress() {
  if (!state.wallet) return;
  try {
    await navigator.clipboard.writeText(state.wallet);
    toast('Address copied to clipboard', 'success', 2000);
  } catch {
    toast('Copy failed — please copy manually', 'warning');
  }
}

// ─── Transaction Log ──────────────────────────────────────────────────────────

function addTx(entry) {
  state.txHistory.unshift(entry);
  renderTxLog();
}

function updateTx(signature, patch) {
  const tx = state.txHistory.find(t => t.signature === signature);
  if (tx) Object.assign(tx, patch);
  renderTxLog();
}

function renderTxLog() {
  const list = $('txList');
  if (state.txHistory.length === 0) {
    list.innerHTML = '<p class="tx-empty">No transactions this session.</p>';
    return;
  }

  list.innerHTML = state.txHistory.map(tx => {
    const isStake = tx.type === 'stake';
    const icon    = isStake ? '↑' : '↓';
    const label   = `${isStake ? 'Staked' : 'Withdrew'} ${tx.label ?? `${fmt(tx.amount, 4)} ${tx.token}`}`;
    const sig     = tx.signature || '';
    const shortSig = sig ? `${sig.slice(0, 8)}…${sig.slice(-6)}` : 'pending';
    const link    = sig
      ? `<a href="${SOLSCAN}/${sig}" target="_blank" rel="noopener" title="${sig}">${shortSig}</a>`
      : shortSig;

    return `
      <div class="tx-item">
        <div class="tx-icon ${tx.type}">${icon}</div>
        <div class="tx-body">
          <div class="tx-main">
            <span>${label}</span>
            <span class="tx-status ${tx.status}">${tx.status}</span>
          </div>
          <div class="tx-sig">${link}</div>
          <div class="tx-time">${timeAgo(tx.ts)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function clearTxLog() {
  state.txHistory = [];
  renderTxLog();
}

// ─── Confirmation Polling ─────────────────────────────────────────────────────

async function pollConfirmation(signature) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const status = await api.post('/confirmTx', { signature });
      if (!status) continue;

      if (status.err) {
        updateTx(signature, { status: 'failed' });
        return { ok: false, err: status.err };
      }

      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        updateTx(signature, { status: 'confirmed' });
        return { ok: true };
      }
    } catch (err) {
      console.warn('[confirmTx] polling error', err.message);
    }
  }

  // Timed out — not necessarily failed, just unconfirmed
  updateTx(signature, { status: 'pending' });
  return { ok: false, err: 'Timed out — check Solscan for final status' };
}

// ─── Stake SOL ───────────────────────────────────────────────────────────────

async function stakeSOL() {
  const amountStr = $('stakeAmount').value.trim();
  const amount    = parseFloat(amountStr);

  if (!amountStr || isNaN(amount) || amount <= 0) {
    toast(`Enter a valid ${state.stakeMode === 'usd' ? 'USD' : 'SOL'} amount`, 'warning');
    return;
  }
  if (!state.wallet) { toast('Wallet not connected', 'error'); return; }

  // Convert USD → SOL if in dollar mode
  let solAmount;
  if (state.stakeMode === 'usd') {
    if (!state.prices?.sol) { toast('SOL price unavailable — switch to SOL mode', 'warning'); return; }
    solAmount = amount / state.prices.sol;
  } else {
    solAmount = amount;
  }

  const btn = $('stakeBtn');
  setLoading(btn, true, 'Staking…');

  let signature = null;
  try {
    toast('Building stake transaction…', 'info', 3000);
    const { transaction: txBase64 } = await api.post('/stake', { wallet: state.wallet, amount: solAmount });

    const txBytes = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));
    const tx      = solanaWeb3.Transaction.from(txBytes);

    toast('Awaiting wallet approval…', 'info', 10000);
    const result = await window.solana.signAndSendTransaction(tx);
    signature    = result.signature;

    // Log shows what user actually typed (with their chosen currency label)
    const logLabel = state.stakeMode === 'usd'
      ? `${fmtUsd(amount)} (${fmt(solAmount, 4)} SOL)`
      : `${fmt(solAmount, 4)} SOL`;
    addTx({ type: 'stake', amount: solAmount, token: 'SOL', label: logLabel, signature, status: 'pending', ts: Date.now() });
    $('stakeAmount').value = '';
    toast('Transaction sent — waiting for confirmation…', 'info', 8000);

    const { ok, err } = await pollConfirmation(signature);
    if (ok) {
      toast(`Staked ${fmt(solAmount, 4)} SOL ✓`, 'success');
      await refreshAll();
    } else {
      toast(`Confirmation issue: ${err}. <a href="${SOLSCAN}/${signature}" target="_blank">View on Solscan</a>`, 'warning', 10000);
    }

  } catch (err) {
    console.error('[stake]', err);
    if (signature) updateTx(signature, { status: 'failed' });
    toast(`Stake failed: ${err.message}`, 'error');
  } finally {
    setLoading(btn, false, 'Stake SOL');
  }
}

// ─── Withdraw mSOL ───────────────────────────────────────────────────────────

async function withdrawMSOL() {
  const amountStr = $('withdrawAmount').value.trim();
  const amount    = parseFloat(amountStr);

  if (!amountStr || isNaN(amount) || amount <= 0) {
    toast(`Enter a valid ${state.withdrawMode === 'usd' ? 'USD' : 'mSOL'} amount`, 'warning');
    return;
  }
  if (!state.wallet) { toast('Wallet not connected', 'error'); return; }

  // Convert USD → mSOL if in dollar mode
  let msolAmount;
  if (state.withdrawMode === 'usd') {
    if (!state.prices?.msol) { toast('mSOL price unavailable — switch to mSOL mode', 'warning'); return; }
    msolAmount = amount / state.prices.msol;
  } else {
    msolAmount = amount;
  }

  const btn = $('withdrawBtn');
  setLoading(btn, true, 'Withdrawing…');

  let signature = null;
  try {
    toast('Building withdraw transaction…', 'info', 3000);
    const { transaction: txBase64 } = await api.post('/withdraw', { wallet: state.wallet, amount: msolAmount });

    const txBytes = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));
    const tx      = solanaWeb3.Transaction.from(txBytes);

    toast('Awaiting wallet approval…', 'info', 10000);
    const result = await window.solana.signAndSendTransaction(tx);
    signature    = result.signature;

    const logLabel = state.withdrawMode === 'usd'
      ? `${fmtUsd(amount)} (${fmt(msolAmount, 4)} mSOL)`
      : `${fmt(msolAmount, 4)} mSOL`;
    addTx({ type: 'withdraw', amount: msolAmount, token: 'mSOL', label: logLabel, signature, status: 'pending', ts: Date.now() });
    $('withdrawAmount').value = '';
    toast('Transaction sent — waiting for confirmation…', 'info', 8000);

    const { ok, err } = await pollConfirmation(signature);
    if (ok) {
      toast(`Withdrawn ${fmt(msolAmount, 4)} mSOL → SOL ✓`, 'success');
      await refreshAll();
    } else {
      toast(`Confirmation issue: ${err}. <a href="${SOLSCAN}/${signature}" target="_blank">View on Solscan</a>`, 'warning', 10000);
    }

  } catch (err) {
    console.error('[withdraw]', err);
    if (signature) updateTx(signature, { status: 'failed' });
    toast(`Withdraw failed: ${err.message}`, 'error');
  } finally {
    setLoading(btn, false, 'Withdraw mSOL');
  }
}

// ─── Market Formatting Helpers ────────────────────────────────────────────────

function fmtCap(n) {
  if (!n && n !== 0) return '–';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString('en-US')}`;
}

function fmtCoinPrice(n) {
  if (n == null) return '–';
  if (n >= 10000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 1)     return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 0.01)  return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return `<span class="pct-na">–</span>`;
  const cls   = n >= 0 ? 'pct-pos' : 'pct-neg';
  const arrow = n >= 0 ? '▲' : '▼';
  return `<span class="${cls}">${arrow} ${Math.abs(n).toFixed(2)}%</span>`;
}

// ─── Market State ─────────────────────────────────────────────────────────────

let marketLoaded   = false;
let marketTimer    = null;

// ─── Holdings State ───────────────────────────────────────────────────────────

let holdingsLoaded = false;

// ─── Earn State ───────────────────────────────────────────────────────────────

let earnLoaded         = false;
let earnProtocols      = [];
let earnValidators     = [];
let earnValidatorsAll  = [];   // unfiltered, for search
let selectedProtocol   = null; // protocol id string
let selectedValidator  = null; // validator object
let earnStakeMode      = 'sol'; // 'sol' | 'usd'
let nativeStakeMode    = 'sol'; // 'sol' | 'usd'
let nativeSectionOpen  = false;

// ─── Market Rendering ─────────────────────────────────────────────────────────

function renderMarketOverview(g) {
  $('ovTotalCap').textContent    = fmtCap(g.total_market_cap?.usd);
  $('ovCapChange').innerHTML     = g.market_cap_change_percentage_24h_usd != null
                                     ? fmtPct(g.market_cap_change_percentage_24h_usd)
                                     : '–';
  $('ovVolume').textContent      = fmtCap(g.total_volume?.usd);
  $('ovBtcDom').textContent      = g.market_cap_percentage?.btc
                                     ? `${g.market_cap_percentage.btc.toFixed(1)}%` : '–';
  $('ovEthDom').textContent      = g.market_cap_percentage?.eth
                                     ? `${g.market_cap_percentage.eth.toFixed(1)}%` : '–';
  $('ovActiveCoins').textContent = g.active_cryptocurrencies
                                     ? g.active_cryptocurrencies.toLocaleString('en-US') : '–';
}

function renderMarketTable(coins) {
  const tbody = $('marketTableBody');
  if (!coins?.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-placeholder">No data available.</td></tr>';
    $('top15Sum').textContent = '';
    return;
  }

  const totalCap = coins.reduce((sum, c) => sum + (c.market_cap ?? 0), 0);
  $('top15Sum').textContent = `Combined: ${fmtCap(totalCap)}`;

  tbody.innerHTML = coins.map((c, i) => `
    <tr>
      <td class="col-rank">${c.market_cap_rank ?? i + 1}</td>
      <td>
        <div class="coin-info">
          <img class="coin-logo" src="${c.image}" alt="${c.symbol}" width="26" height="26" loading="lazy" />
          <div>
            <div class="coin-name">${c.name}</div>
            <div class="coin-symbol">${c.symbol.toUpperCase()}</div>
          </div>
        </div>
      </td>
      <td class="col-num">${fmtCoinPrice(c.current_price)}</td>
      <td class="col-num">${fmtCap(c.market_cap)}</td>
      <td class="col-num">${fmtCap(c.total_volume)}</td>
      <td class="col-num">${fmtPct(c.price_change_percentage_24h_in_currency)}</td>
      <td class="col-num">${fmtPct(c.price_change_percentage_7d_in_currency)}</td>
      <td class="col-num">${fmtPct(c.price_change_percentage_30d_in_currency)}</td>
      <td class="col-num">${fmtPct(c.price_change_percentage_1y_in_currency)}</td>
    </tr>
  `).join('');
}

// ─── Market Data Fetching ─────────────────────────────────────────────────────

async function loadMarket() {
  const btn = $('refreshMarket');
  if (btn) btn.disabled = true;

  try {
    const data = await api.get('/market');

    renderMarketOverview(data.global);
    renderMarketTable(data.coins);

    const updatedMs = data.cachedAt || Date.now();
    $('marketUpdated').textContent =
      `Updated ${timeAgo(updatedMs)}${data.stale ? ' · stale' : ''}`;

    marketLoaded = true;
  } catch (err) {
    console.error('[market] fetch failed', err);
    const tbody = $('marketTableBody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="9" class="table-placeholder">
        Failed to load market data — ${err.message}
      </td></tr>`;
    }
    toast(`Market data unavailable: ${err.message}`, 'warning');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─── Holdings Rendering ───────────────────────────────────────────────────────

function renderHoldingsOverview(holdings, totalValue) {
  $('hvTotalValue').textContent = fmtUsd(totalValue);
  $('hvAssetCount').textContent = `${holdings.length} asset${holdings.length !== 1 ? 's' : ''}`;

  // Weighted-average 24h change across all holdings with price data
  const with24h = holdings.filter(h => h.change24h != null && h.value > 0);
  if (with24h.length > 0) {
    const valueWithChange = with24h.reduce((s, h) => s + h.value, 0);
    const portfolio24h    = with24h.reduce((s, h) => s + h.change24h * h.value, 0) / valueWithChange;
    $('hvPortfolio24h').innerHTML    = fmtPct(portfolio24h);
    $('hvPortfolio24hSub').textContent = `across ${with24h.length} of ${holdings.length} assets`;

    const best  = with24h.reduce((a, b) => a.change24h > b.change24h ? a : b);
    const worst = with24h.reduce((a, b) => a.change24h < b.change24h ? a : b);
    $('hvBest').textContent   = best.symbol;
    $('hvBestPct').innerHTML  = fmtPct(best.change24h);
    $('hvWorst').textContent  = worst.symbol;
    $('hvWorstPct').innerHTML = fmtPct(worst.change24h);
  } else {
    ['hvPortfolio24h', 'hvBest', 'hvBestPct', 'hvWorst', 'hvWorstPct'].forEach(id => { $(id).textContent = '–'; });
  }

  if (holdings.length > 0) {
    const largest = holdings[0]; // already sorted by value desc
    $('hvLargest').textContent    = largest.symbol;
    $('hvLargestPct').textContent = `${fmt(largest.portfolioPct, 1)}% of portfolio`;
  }
}

function renderHoldingsTable(holdings) {
  const tbody = $('holdingsTableBody');
  if (!holdings?.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-placeholder">No holdings found.</td></tr>';
    return;
  }

  tbody.innerHTML = holdings.map((h, i) => {
    const logoHtml = h.image
      ? `<img class="coin-logo" src="${escapeHtml(h.image)}" alt="${escapeHtml(h.symbol)}" width="26" height="26" loading="lazy" />`
      : `<div class="coin-logo coin-logo-placeholder"></div>`;

    const balanceFmt = h.balance < 1 ? fmt(h.balance, 6) : fmt(h.balance, 4);
    const barWidth   = Math.min(h.portfolioPct, 100).toFixed(1);

    return `
      <tr>
        <td class="col-rank">${i + 1}</td>
        <td>
          <div class="coin-info">
            ${logoHtml}
            <div>
              <div class="coin-name">${escapeHtml(h.name)}</div>
              <div class="coin-symbol">${escapeHtml(h.symbol)}</div>
            </div>
          </div>
        </td>
        <td class="col-num">${balanceFmt}</td>
        <td class="col-num">${h.price > 0 ? fmtCoinPrice(h.price) : '–'}</td>
        <td class="col-num">${h.value > 0 ? fmtUsd(h.value) : '–'}</td>
        <td class="col-num">
          <div class="portfolio-bar-wrap">
            <div class="portfolio-bar-track">
              <div class="portfolio-bar-fill" style="width:${barWidth}%"></div>
            </div>
            <span class="portfolio-pct-label">${fmt(h.portfolioPct, 1)}%</span>
          </div>
        </td>
        <td class="col-num">${fmtPct(h.change24h)}</td>
        <td class="col-num">${fmtPct(h.change30d)}</td>
        <td class="col-num">${fmtPct(h.change1y)}</td>
      </tr>
    `;
  }).join('');
}

async function loadHoldings() {
  if (!state.wallet) {
    toast('Connect your wallet first', 'warning');
    return;
  }

  const btn   = $('refreshHoldings');
  const tbody = $('holdingsTableBody');
  if (btn)   btn.disabled = true;
  if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="table-placeholder">
    <span class="spinner"></span> Loading holdings…
  </td></tr>`;

  try {
    const data = await api.post('/holdings', { wallet: state.wallet });
    renderHoldingsOverview(data.holdings, data.totalValue);
    renderHoldingsTable(data.holdings);
    $('holdingsUpdated').textContent = `Updated just now`;
    holdingsLoaded = true;
  } catch (err) {
    console.error('[holdings] fetch failed', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="table-placeholder">
      Failed to load holdings — ${escapeHtml(err.message)}
    </td></tr>`;
    toast(`Holdings unavailable: ${err.message}`, 'warning');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─── Earn: Currency Modes ─────────────────────────────────────────────────────

function setEarnStakeMode(mode) {
  earnStakeMode = mode;
  $('earnStakeSuffix').textContent = mode === 'usd' ? 'USD' : 'SOL';
  document.querySelectorAll('#earnStakeToggle .toggle-opt').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.mode === mode)
  );
  $('earnStakeAmount').value = '';
  updateEarnEstimate();
}

function setNativeStakeMode(mode) {
  nativeStakeMode = mode;
  $('nativeStakeSuffix').textContent = mode === 'usd' ? 'USD' : 'SOL';
  document.querySelectorAll('#nativeStakeToggle .toggle-opt').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.mode === mode)
  );
  $('nativeStakeAmount').value = '';
  updateNativeEstimate();
}

// ─── Earn: Native Section Collapse ───────────────────────────────────────────

function toggleNativeSection() {
  nativeSectionOpen = !nativeSectionOpen;
  $('nativeSectionContent').classList.toggle('hidden', !nativeSectionOpen);
  $('nativeCollapseArrow').classList.toggle('open', nativeSectionOpen);
  if (nativeSectionOpen && earnLoaded && state.wallet) loadStakeAccounts();
}

// ─── Earn: Protocol Cards ─────────────────────────────────────────────────────

function renderProtocolCards(protocols) {
  const grid = $('protocolGrid');
  if (!protocols?.length) {
    grid.innerHTML = '<div class="table-placeholder" style="grid-column:1/-1">No protocol data available.</div>';
    return;
  }

  // Find highest APY for "Best APY" badge
  const maxApy = Math.max(...protocols.filter(p => p.apy != null).map(p => p.apy));

  grid.innerHTML = protocols.map(p => {
    const isBest    = p.apy != null && p.apy === maxApy;
    const isSelected = selectedProtocol === p.id;

    const logoHtml = p.logo
      ? `<img class="protocol-logo" src="${escapeHtml(p.logo)}" alt="${escapeHtml(p.name)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'protocol-logo-placeholder',textContent:'${p.token[0]}'}))" />`
      : `<div class="protocol-logo-placeholder">${p.token[0]}</div>`;

    const apyDisplay = p.apy != null ? `${p.apy.toFixed(2)}%` : '–';
    const tvlDisplay = p.tvl  != null ? fmtCap(p.tvl)          : '–';

    const badges = [];
    if (p.unstakeType === 'instant') badges.push(`<span class="proto-badge proto-badge-green">⚡ Instant unstake</span>`);
    if (p.mev)                       badges.push(`<span class="proto-badge proto-badge-orange">💸 MEV rewards</span>`);
    if (p.contractRisk === 'spl')    badges.push(`<span class="proto-badge proto-badge-neutral">🛡️ SPL program · ${p.audits} audits</span>`);
    if (p.contractRisk === 'custom') badges.push(`<span class="proto-badge proto-badge-neutral">🔐 ${p.audits} security audits</span>`);

    return `
      <div class="protocol-card${isSelected ? ' selected' : ''}" data-id="${p.id}" onclick="selectProtocol('${p.id}')">
        <div class="protocol-card-top">
          <div class="protocol-identity">
            ${logoHtml}
            <div>
              <div class="protocol-name">${escapeHtml(p.name)}</div>
              <div class="protocol-token">${escapeHtml(p.token)}</div>
            </div>
          </div>
          ${isBest ? '<span class="best-badge">Best APY</span>' : ''}
        </div>
        <div class="protocol-apy-block">
          <div class="protocol-apy-value">${apyDisplay}</div>
          <div class="protocol-apy-label">APY · TVL ${tvlDisplay}</div>
        </div>
        <div class="protocol-features">${badges.join('')}</div>
        <p style="font-size:12px;color:var(--text-muted);line-height:1.4;margin:0">${escapeHtml(p.description)}</p>
        <button class="btn-primary protocol-stake-btn" onclick="event.stopPropagation();selectProtocol('${p.id}')">
          Stake SOL → ${escapeHtml(p.token)}
        </button>
      </div>
    `;
  }).join('');
}

function selectProtocol(id) {
  selectedProtocol = id;
  const p = earnProtocols.find(x => x.id === id);
  if (!p) return;

  // Update card highlight
  document.querySelectorAll('.protocol-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.id === id);
  });

  // Show stake panel
  $('stakePanelName').textContent  = p.name;
  $('stakePanelToken').textContent = p.token;
  $('earnStakeAmount').value       = '';
  updateEarnEstimate();
  $('liquidStakePanel').classList.remove('hidden');
  $('earnStakeAmount').focus();
}

function clearProtocolSelection() {
  selectedProtocol = null;
  document.querySelectorAll('.protocol-card').forEach(c => c.classList.remove('selected'));
  $('liquidStakePanel').classList.add('hidden');
  $('earnStakeAmount').value = '';
}

function updateEarnEstimate() {
  const amount = parseFloat($('earnStakeAmount').value);
  if (!isNaN(amount) && amount > 0 && state.prices?.sol) {
    if (earnStakeMode === 'usd') {
      const sol = amount / state.prices.sol;
      $('earnStakeEstimate').textContent = `${fmtUsd(amount)} → ≈ ${fmt(sol, 4)} SOL`;
    } else {
      $('earnStakeEstimate').textContent = `≈ ${fmtUsd(amount * state.prices.sol)}`;
    }
  } else {
    $('earnStakeEstimate').textContent = '≈ –';
  }
}

async function stakeWithProtocol() {
  if (!selectedProtocol) return;
  if (!state.wallet) { toast('Connect your wallet first', 'error'); return; }

  const amountStr = $('earnStakeAmount').value.trim();
  const amount    = parseFloat(amountStr);
  if (!amountStr || isNaN(amount) || amount <= 0) {
    toast(`Enter a valid ${earnStakeMode === 'usd' ? 'USD' : 'SOL'} amount`, 'warning'); return;
  }

  let solAmount;
  if (earnStakeMode === 'usd') {
    if (!state.prices?.sol) { toast('SOL price unavailable — switch to SOL mode', 'warning'); return; }
    solAmount = amount / state.prices.sol;
  } else {
    solAmount = amount;
  }

  const p = earnProtocols.find(x => x.id === selectedProtocol);
  if (!p) return;

  const btn = $('earnStakeBtn');
  setLoading(btn, true, 'Staking…');

  let signature = null;
  try {
    toast(`Building ${p.name} stake transaction…`, 'info', 3000);
    const endpoint = selectedProtocol === 'marinade' ? '/stake' : `/stake/${selectedProtocol}`;
    const { transaction: txBase64 } = await api.post(endpoint, { wallet: state.wallet, amount: solAmount });

    const txBytes = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));
    const tx      = solanaWeb3.Transaction.from(txBytes);

    toast('Awaiting wallet approval…', 'info', 10000);
    const result = await window.solana.signAndSendTransaction(tx);
    signature    = result.signature;

    const logLabel = earnStakeMode === 'usd'
      ? `${fmtUsd(amount)} (${fmt(solAmount, 4)} SOL) → ${p.token}`
      : `${fmt(solAmount, 4)} SOL → ${p.token}`;
    addTx({ type: 'stake', amount: solAmount, token: 'SOL', label: logLabel, signature, status: 'pending', ts: Date.now() });
    $('earnStakeAmount').value = '';
    toast(`Transaction sent — waiting for confirmation…`, 'info', 8000);

    const { ok, err } = await pollConfirmation(signature);
    if (ok) {
      toast(`Staked ${fmt(solAmount, 4)} SOL → ${p.token} ✓`, 'success');
      await refreshAll();
      holdingsLoaded = false; // refresh holdings next time
    } else {
      toast(`Confirmation issue: ${err}. <a href="${SOLSCAN}/${signature}" target="_blank">View on Solscan</a>`, 'warning', 10000);
    }
  } catch (err) {
    console.error('[earn/stake]', err);
    if (signature) updateTx(signature, { status: 'failed' });
    toast(`Stake failed: ${err.message}`, 'error');
  } finally {
    setLoading(btn, false, `Stake SOL → ${p?.token ?? ''}`);
  }
}

// ─── Earn: Validators ─────────────────────────────────────────────────────────

function renderValidatorTable(validators) {
  const tbody = $('validatorTableBody');
  if (!validators?.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-placeholder">No validators found.</td></tr>';
    return;
  }

  tbody.innerHTML = validators.map((v, i) => {
    const logoHtml = v.avatarUrl
      ? `<img class="validator-avatar" src="${escapeHtml(v.avatarUrl)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
      : '';

    const apyDisplay  = v.apy      != null ? `${v.apy.toFixed(2)}%`    : '–';
    const commDisplay = v.commission != null ? `${v.commission}%`       : '–';
    const skipDisplay = v.skipRate  != null ? `${(100 - v.skipRate).toFixed(2)}%` : '–';
    const tvlDisplay  = v.activeSol != null && state.prices?.sol
      ? fmtCap(v.activeSol * state.prices.sol)
      : (v.activeSol != null ? `${fmt(v.activeSol, 0)} SOL` : '–');

    const isSelected = selectedValidator?.voteAccount === v.voteAccount;

    return `
      <tr class="${isSelected ? 'validator-row-selected' : ''}">
        <td>
          <div class="validator-name-cell">
            ${logoHtml}
            <span class="validator-name-text">${escapeHtml(v.name)}</span>
          </div>
        </td>
        <td class="col-num">${apyDisplay}</td>
        <td class="col-num">${commDisplay}</td>
        <td class="col-num">${skipDisplay}</td>
        <td class="col-num">${tvlDisplay}</td>
        <td class="col-num">
          <button class="btn-ghost btn-sm" onclick="selectValidator(${i})">
            ${isSelected ? '✓ Selected' : 'Select'}
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function filterValidators() {
  const q = $('validatorSearch').value.toLowerCase().trim();
  earnValidators = q
    ? earnValidatorsAll.filter(v => v.name.toLowerCase().includes(q))
    : earnValidatorsAll;
  renderValidatorTable(earnValidators);
}

function selectValidator(idx) {
  selectedValidator = earnValidators[idx];
  const v = selectedValidator;

  $('selectedValidatorName').textContent = v.name;
  $('selectedValidatorMeta').textContent =
    `${v.commission != null ? v.commission + '% commission' : ''} ${v.apy != null ? '· ~' + v.apy.toFixed(2) + '% APY' : ''}`.trim();

  $('nativeStakeAmount').value = '';
  updateNativeEstimate();
  $('nativeStakeForm').classList.remove('hidden');
  $('nativeStakeAmount').focus();

  renderValidatorTable(earnValidators); // re-render to show ✓
}

function clearValidatorSelection() {
  selectedValidator = null;
  $('nativeStakeForm').classList.add('hidden');
  $('nativeStakeAmount').value = '';
  renderValidatorTable(earnValidators);
}

function updateNativeEstimate() {
  const amount = parseFloat($('nativeStakeAmount').value);
  if (!isNaN(amount) && amount > 0 && state.prices?.sol) {
    if (nativeStakeMode === 'usd') {
      const sol = amount / state.prices.sol;
      $('nativeStakeEstimate').textContent = `${fmtUsd(amount)} → ≈ ${fmt(sol, 4)} SOL`;
    } else {
      $('nativeStakeEstimate').textContent = `≈ ${fmtUsd(amount * state.prices.sol)}`;
    }
  } else {
    $('nativeStakeEstimate').textContent = '≈ –';
  }
}

async function stakeNative() {
  if (!selectedValidator) { toast('Select a validator first', 'warning'); return; }
  if (!state.wallet)      { toast('Connect your wallet first', 'error');  return; }

  const amountStr = $('nativeStakeAmount').value.trim();
  const amount    = parseFloat(amountStr);
  if (!amountStr || isNaN(amount) || amount <= 0) {
    toast(`Enter a valid ${nativeStakeMode === 'usd' ? 'USD' : 'SOL'} amount`, 'warning'); return;
  }

  let solAmount;
  if (nativeStakeMode === 'usd') {
    if (!state.prices?.sol) { toast('SOL price unavailable — switch to SOL mode', 'warning'); return; }
    solAmount = amount / state.prices.sol;
  } else {
    solAmount = amount;
  }

  const btn = $('nativeStakeBtn');
  setLoading(btn, true, 'Staking…');

  let signature = null;
  try {
    toast('Building native stake transaction…', 'info', 3000);
    const { transaction: txBase64, stakeAccount } = await api.post('/stake/native', {
      wallet:      state.wallet,
      amount:      solAmount,
      voteAccount: selectedValidator.voteAccount,
    });

    const txBytes = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));
    const tx      = solanaWeb3.Transaction.from(txBytes);

    toast('Awaiting wallet approval…', 'info', 10000);
    const result = await window.solana.signAndSendTransaction(tx);
    signature    = result.signature;

    const logLabel = nativeStakeMode === 'usd'
      ? `${fmtUsd(amount)} (${fmt(solAmount, 4)} SOL) → ${selectedValidator.name} (native)`
      : `${fmt(solAmount, 4)} SOL → ${selectedValidator.name} (native)`;
    addTx({ type: 'stake', amount: solAmount, token: 'SOL', label: logLabel, signature, status: 'pending', ts: Date.now() });
    $('nativeStakeAmount').value = '';
    toast('Transaction sent — confirming…', 'info', 8000);

    const { ok, err } = await pollConfirmation(signature);
    if (ok) {
      toast(`Staked ${fmt(solAmount, 4)} SOL with ${selectedValidator.name} ✓`, 'success');
      await refreshAll();
      // Refresh stake accounts list
      if (state.wallet) loadStakeAccounts();
    } else {
      toast(`Confirmation issue: ${err}. <a href="${SOLSCAN}/${signature}" target="_blank">View on Solscan</a>`, 'warning', 10000);
    }
  } catch (err) {
    console.error('[earn/native]', err);
    if (signature) updateTx(signature, { status: 'failed' });
    toast(`Native stake failed: ${err.message}`, 'error');
  } finally {
    setLoading(btn, false, 'Stake with Validator');
  }
}

// ─── Earn: Stake Accounts ─────────────────────────────────────────────────────

function setNativeTvlBadge(text) {
  const el = $('nativeTotalLocked');
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? '' : 'none';
}

async function loadStakeAccounts() {
  if (!state.wallet) {
    setNativeTvlBadge('');
    return;
  }

  // Show a loading indicator in the badge immediately
  setNativeTvlBadge('Loading…');

  const section = $('nativeAccountsSection');
  const list    = $('nativeAccountsList');

  try {
    const accounts = await api.post('/stake-accounts', { wallet: state.wallet });

    const totalLocked = accounts.reduce((s, a) => s + (a.balance ?? 0), 0);
    if (totalLocked > 0) {
      const usd = state.prices?.sol ? ` · ${fmtUsd(totalLocked * state.prices.sol)}` : '';
      setNativeTvlBadge(`${fmt(totalLocked, 4)} SOL locked${usd}`);
    } else {
      setNativeTvlBadge('0 SOL locked');
    }

    if (!accounts.length) {
      section.classList.add('hidden');
      return;
    }
    list.innerHTML = '';
    section.classList.remove('hidden');
    renderStakeAccounts(accounts);
  } catch (err) {
    console.error('[stake-accounts]', err);
    setNativeTvlBadge('–');
    section.classList.add('hidden');
  }
}

function renderStakeAccounts(accounts) {
  const list = $('nativeAccountsList');

  list.innerHTML = accounts.map(a => {
    const short     = `${a.address.slice(0, 8)}…${a.address.slice(-6)}`;
    const stateInfo = {
      delegated:    { label: 'Active',        cls: 'stake-state-delegated'    },
      deactivating: { label: 'Deactivating',  cls: 'stake-state-deactivating' },
      inactive:     { label: 'Ready to claim',cls: 'stake-state-inactive'     },
    }[a.state] ?? { label: a.state, cls: 'stake-state-inactive' };

    const actions = [];
    if (a.state === 'delegated') {
      actions.push(`<button class="btn-ghost btn-sm" onclick="unstakeNative('${a.address}')">Unstake</button>`);
    }
    if (a.state === 'inactive') {
      actions.push(`<button class="btn-primary btn-sm" onclick="withdrawNative('${a.address}')">Withdraw SOL</button>`);
    }

    const validatorShort = a.validator ? `${a.validator.slice(0, 8)}…` : '–';

    return `
      <div class="stake-account-item">
        <div class="stake-account-info">
          <div class="stake-account-detail">
            ${fmt(a.balance, 4)} SOL
            <span class="stake-state-badge ${stateInfo.cls}">${stateInfo.label}</span>
          </div>
          <div class="stake-account-addr">${short} · validator: ${validatorShort}</div>
        </div>
        <div class="stake-account-actions">${actions.join('')}</div>
      </div>
    `;
  }).join('');
}

async function unstakeNative(stakeAccount) {
  if (!state.wallet) return;
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '…';

  let signature = null;
  try {
    toast('Building unstake transaction…', 'info', 3000);
    const { transaction: txBase64 } = await api.post('/unstake/native', { wallet: state.wallet, stakeAccount });

    const txBytes = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));
    const tx      = solanaWeb3.Transaction.from(txBytes);

    toast('Awaiting wallet approval…', 'info', 10000);
    const result = await window.solana.signAndSendTransaction(tx);
    signature    = result.signature;

    addTx({ type: 'withdraw', amount: 0, token: 'SOL', label: 'Deactivate stake account', signature, status: 'pending', ts: Date.now() });
    const { ok, err } = await pollConfirmation(signature);
    if (ok) {
      toast('Stake deactivated — SOL available to withdraw in ~2 days ✓', 'success', 8000);
      loadStakeAccounts();
    } else {
      toast(`Issue: ${err}`, 'warning', 8000);
    }
  } catch (err) {
    console.error('[unstake/native]', err);
    toast(`Unstake failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unstake';
  }
}

async function withdrawNative(stakeAccount) {
  if (!state.wallet) return;
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '…';

  let signature = null;
  try {
    toast('Building withdraw transaction…', 'info', 3000);
    const { transaction: txBase64 } = await api.post('/withdraw/native', { wallet: state.wallet, stakeAccount });

    const txBytes = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));
    const tx      = solanaWeb3.Transaction.from(txBytes);

    toast('Awaiting wallet approval…', 'info', 10000);
    const result = await window.solana.signAndSendTransaction(tx);
    signature    = result.signature;

    addTx({ type: 'withdraw', amount: 0, token: 'SOL', label: 'Withdraw native stake', signature, status: 'pending', ts: Date.now() });
    const { ok, err } = await pollConfirmation(signature);
    if (ok) {
      toast('SOL withdrawn successfully ✓', 'success');
      await refreshAll();
      loadStakeAccounts();
    } else {
      toast(`Issue: ${err}`, 'warning', 8000);
    }
  } catch (err) {
    console.error('[withdraw/native]', err);
    toast(`Withdraw failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Withdraw SOL';
  }
}

// ─── Earn: Data Loading ───────────────────────────────────────────────────────

async function loadEarnData() {
  const btn = $('refreshEarn');
  if (btn) btn.disabled = true;

  try {
    const [optionsData, validatorsData] = await Promise.allSettled([
      api.get('/staking-options'),
      api.get('/validators'),
    ]);

    // Protocols
    if (optionsData.status === 'fulfilled') {
      earnProtocols = optionsData.value.protocols ?? [];
      renderProtocolCards(earnProtocols);
      const updatedMs = optionsData.value.cachedAt || Date.now();
      $('earnUpdated').textContent = `Updated ${timeAgo(updatedMs)}${optionsData.value.stale ? ' · stale' : ''}`;
    } else {
      $('protocolGrid').innerHTML = `<div class="table-placeholder" style="grid-column:1/-1">Failed to load protocols — ${escapeHtml(optionsData.reason?.message ?? '')}</div>`;
    }

    // Validators
    if (validatorsData.status === 'fulfilled') {
      earnValidatorsAll = validatorsData.value ?? [];
      earnValidators    = earnValidatorsAll;
      renderValidatorTable(earnValidators);
    } else {
      $('validatorTableBody').innerHTML = `<tr><td colspan="6" class="table-placeholder">Failed to load validators — ${escapeHtml(validatorsData.reason?.message ?? '')}</td></tr>`;
    }

    earnLoaded = true;
  } finally {
    if (btn) btn.disabled = false;
  }

  // Load stake accounts if wallet is connected
  if (state.wallet) loadStakeAccounts();
}

// ─── Tab Navigation ───────────────────────────────────────────────────────────

function hideAllScreens() {
  $('portfolioView').classList.add('hidden');
  $('holdingsScreen').classList.add('hidden');
  $('earnScreen').classList.add('hidden');
  $('marketScreen').classList.add('hidden');
  ['tabPortfolio','tabHoldings','tabEarn','tabMarket'].forEach(id => $(id).classList.remove('active'));
  if (marketTimer) { clearInterval(marketTimer); marketTimer = null; }
}

function showPortfolioView() {
  hideAllScreens();
  $('portfolioView').classList.remove('hidden');
  $('tabPortfolio').classList.add('active');
}

function showHoldingsView() {
  hideAllScreens();
  $('holdingsScreen').classList.remove('hidden');
  $('tabHoldings').classList.add('active');

  if (!state.wallet) {
    $('holdingsTableBody').innerHTML =
      '<tr><td colspan="9" class="table-placeholder">Connect your wallet to view holdings.</td></tr>';
    ['hvTotalValue','hvAssetCount','hvPortfolio24h','hvPortfolio24hSub','hvBest','hvBestPct','hvWorst','hvWorstPct','hvLargest','hvLargestPct']
      .forEach(id => { $(id).textContent = '–'; });
    return;
  }

  if (!holdingsLoaded) loadHoldings();
}

function showEarnView() {
  hideAllScreens();
  $('earnScreen').classList.remove('hidden');
  $('tabEarn').classList.add('active');

  if (!earnLoaded) loadEarnData();
  else if (state.wallet) loadStakeAccounts(); // refresh accounts on revisit
}

function showMarketView() {
  hideAllScreens();
  $('marketScreen').classList.remove('hidden');
  $('tabMarket').classList.add('active');
  if (!marketLoaded) loadMarket();
  if (!marketTimer) marketTimer = setInterval(loadMarket, 5 * 60_000);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  initTheme();

  // Theme toggle
  $('themeToggle').onclick = toggleTheme;

  // Wallet
  $('connectBtn').onclick    = connectWallet;
  $('disconnectBtn').onclick = disconnectWallet;
  $('copyBtn').onclick       = copyAddress;

  // Refresh
  $('refreshSol').onclick  = refreshSol;
  $('refreshMsol').onclick = refreshMsol;

  // Max
  $('maxStake').onclick    = setMaxStake;
  $('maxWithdraw').onclick = setMaxWithdraw;

  // Tab navigation
  $('tabPortfolio').onclick    = showPortfolioView;
  $('tabHoldings').onclick     = showHoldingsView;
  $('tabEarn').onclick         = showEarnView;
  $('tabMarket').onclick       = showMarketView;
  $('refreshMarket').onclick   = loadMarket;
  $('refreshHoldings').onclick = loadHoldings;
  $('refreshEarn').onclick     = loadEarnData;

  // Earn — currency toggles
  document.querySelectorAll('#earnStakeToggle .toggle-opt').forEach(btn =>
    btn.addEventListener('click', () => setEarnStakeMode(btn.dataset.mode))
  );
  document.querySelectorAll('#nativeStakeToggle .toggle-opt').forEach(btn =>
    btn.addEventListener('click', () => setNativeStakeMode(btn.dataset.mode))
  );

  // Earn — liquid staking
  $('clearProtocol').onclick   = clearProtocolSelection;
  $('earnStakeBtn').onclick    = stakeWithProtocol;
  $('earnMaxStake').onclick    = () => {
    if (!state.solBalance) return;
    const maxSol = Math.max(0, state.solBalance.sol - SOL_FEE_RESERVE);
    if (earnStakeMode === 'usd') {
      const maxUsd = maxSol * (state.prices?.sol ?? 0);
      $('earnStakeAmount').value = maxUsd > 0 ? fmt(maxUsd, 2).replace(/,/g, '') : '';
    } else {
      $('earnStakeAmount').value = maxSol > 0 ? fmt(maxSol, 6).replace(/,/g, '') : '';
    }
    updateEarnEstimate();
  };
  $('earnStakeAmount').addEventListener('input', updateEarnEstimate);

  // Earn — native staking
  $('clearValidator').onclick       = clearValidatorSelection;
  $('nativeStakeBtn').onclick       = stakeNative;
  $('refreshStakeAccounts').onclick = loadStakeAccounts;
  $('maxNativeStake').onclick       = () => {
    if (!state.solBalance) return;
    const maxSol = Math.max(0, state.solBalance.sol - SOL_FEE_RESERVE);
    if (nativeStakeMode === 'usd') {
      const maxUsd = maxSol * (state.prices?.sol ?? 0);
      $('nativeStakeAmount').value = maxUsd > 0 ? fmt(maxUsd, 2).replace(/,/g, '') : '';
    } else {
      $('nativeStakeAmount').value = maxSol > 0 ? fmt(maxSol, 6).replace(/,/g, '') : '';
    }
    updateNativeEstimate();
  };
  $('nativeStakeAmount').addEventListener('input', updateNativeEstimate);
  $('validatorSearch').addEventListener('input', filterValidators);

  // Currency toggles
  document.querySelectorAll('#stakeToggle .toggle-opt').forEach(btn => {
    btn.onclick = () => setStakeMode(btn.dataset.mode);
  });
  document.querySelectorAll('#withdrawToggle .toggle-opt').forEach(btn => {
    btn.onclick = () => setWithdrawMode(btn.dataset.mode);
  });

  // Actions
  $('stakeBtn').onclick    = stakeSOL;
  $('withdrawBtn').onclick = withdrawMSOL;

  // Tx log
  $('clearTx').onclick = clearTxLog;

  // Live estimate updates
  $('stakeAmount').addEventListener('input', updateEstimates);
  $('withdrawAmount').addEventListener('input', updateEstimates);

  // Auto-reconnect if Phantom is already authorised
  if (window.solana?.isPhantom && window.solana.isConnected) {
    state.wallet = window.solana.publicKey?.toString();
    if (state.wallet) {
      showDashboard();
      refreshAll();
    }
  }

  // Re-truncate address on orientation change / resize
  window.addEventListener('resize', () => {
    if (state.wallet) {
      $('walletAddress').textContent = truncateAdaptive(state.wallet);
    }
  }, { passive: true });

  // Listen for Phantom account changes
  window.solana?.on?.('accountChanged', (pubkey) => {
    if (pubkey) {
      state.wallet = pubkey.toString();
      showDashboard();
      refreshAll();
      toast('Wallet account changed', 'info');
    } else {
      disconnectWallet();
    }
  });
}

// Wait for DOM + solana web3 CDN script
document.addEventListener('DOMContentLoaded', init);
