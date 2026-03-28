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

// ─── Tab Navigation ───────────────────────────────────────────────────────────

function showPortfolioView() {
  $('portfolioView').classList.remove('hidden');
  $('holdingsScreen').classList.add('hidden');
  $('marketScreen').classList.add('hidden');
  $('tabPortfolio').classList.add('active');
  $('tabHoldings').classList.remove('active');
  $('tabMarket').classList.remove('active');
  if (marketTimer) { clearInterval(marketTimer); marketTimer = null; }
}

function showHoldingsView() {
  $('portfolioView').classList.add('hidden');
  $('holdingsScreen').classList.remove('hidden');
  $('marketScreen').classList.add('hidden');
  $('tabPortfolio').classList.remove('active');
  $('tabHoldings').classList.add('active');
  $('tabMarket').classList.remove('active');
  if (marketTimer) { clearInterval(marketTimer); marketTimer = null; }

  if (!state.wallet) {
    $('holdingsTableBody').innerHTML =
      '<tr><td colspan="9" class="table-placeholder">Connect your wallet to view holdings.</td></tr>';
    ['hvTotalValue', 'hvAssetCount', 'hvBest', 'hvBestPct', 'hvWorst', 'hvWorstPct', 'hvLargest', 'hvLargestPct']
      .forEach(id => { $(id).textContent = '–'; });
    return;
  }

  if (!holdingsLoaded) loadHoldings();
}

function showMarketView() {
  $('portfolioView').classList.add('hidden');
  $('holdingsScreen').classList.add('hidden');
  $('marketScreen').classList.remove('hidden');
  $('tabPortfolio').classList.remove('active');
  $('tabHoldings').classList.remove('active');
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
  $('tabMarket').onclick       = showMarketView;
  $('refreshMarket').onclick   = loadMarket;
  $('refreshHoldings').onclick = loadHoldings;

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
