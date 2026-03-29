# Multi-Protocol Staking — Research & Implementation Plan

> Discussion date: 2026-03-28
> Status: Research complete, awaiting layout decision before implementation

---

## Objective

Replace the single Marinade Finance integration with a full multi-protocol staking aggregator. Offer users:
- Side-by-side comparison of all major Solana liquid staking protocols
- Native (non-liquid) staking with validator selection
- Clear tradeoffs: APY, liquidity, risk, fees

Remove "Powered by Marinade" branding — position the app as a neutral aggregator.

---

## Liquid Staking Protocols

### Marinade Finance (mSOL) — Already Implemented

- **Token:** mSOL — `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So`
- **APY:** ~7–8%
- **TVL:** ~$2B
- **Unstake:** Instant via Jupiter (0.1–9% fee, typically ~0.3%), or delayed ~2 days (free)
- **SDK:** `@marinade.finance/marinade-ts-sdk` (npm) — already in project
- **APY API:** `https://validators-api.marinade.finance/` (Swagger-documented)
- **Program:** `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD`
- **State account:** `8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC`
- **Audits:** Kudelski Security, Ackee Blockchain, Neodyme. SOC 2 Type I & II.
- **Integration difficulty:** Medium (custom Anchor program, needs their SDK)

---

### Jito (JitoSOL) — Highest Priority Addition

- **Token:** JitoSOL — `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn`
- **APY:** ~7.2–7.8% (base ~5.9–6.6% + MEV boost ~20–30% on top)
- **TVL:** ~$2.9B (largest Solana LST by TVL)
- **Unstake:** Instant via reserve (`useReserve: true`), or delayed ~2 days
- **SDK:** `@solana/spl-stake-pool` (standard SPL — same package works for Jito, BlazeStake, JPool)
- **APY API:** `https://kobe.mainnet.jito.network/api/v1/` — no API key needed
  - `/validators` — validator data
  - `/jitosol_validators` — JitoSOL pool validators per epoch
  - `/staker_rewards` — MEV and staker rewards
- **Pool state address:** `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb`
- **SPL program:** `SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy`
- **Key differentiator:** MEV rewards passed directly to stakers — higher effective APY than most competitors
- **Audits:** Built on Solana Foundation's SPL stake pool program (audited 9 times by 5+ firms)
- **Integration difficulty:** Easy

---

### BlazeStake (bSOL)

- **Token:** bSOL — `bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1`
- **APY:** ~7.0%
- **TVL:** Smaller than Jito/Marinade (tracked on DeFiLlama)
- **Unstake:** Instant if reserve available, delayed ~2 days
- **SDK:** `@solana/spl-stake-pool` (same package as Jito)
- **APY API:** `https://stake-docs.solblaze.org/developers/other-apis`
- **Pool state address:** `stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi`
- **Key differentiator:** Supports Custom Liquid Staking — users direct their SOL to a specific validator while still receiving bSOL
- **Audits:** Uses Solana Foundation's audited SPL stake pool program
- **Integration difficulty:** Easy (same SDK as Jito, different pool address)

---

### JPool (JSOL)

- **Token:** JSOL
- **APY:** ~7–9%
- **TVL:** ~$179M
- **Unstake:** Instant if reserve available, delayed ~2 days
- **SDK:** `@solana/spl-stake-pool` (same package as Jito and BlazeStake)
- **APY API:** No dedicated public API — use DeFiLlama aggregator
- **Pool state address:** `CtMyWsrUtAwXWiGr9WjHT5fC3p3fgV8cyGpLTo2LJzG1`
- **Audits:** Uses Solana Foundation's audited SPL stake pool program
- **Integration difficulty:** Easy

---

### Sanctum (INF) — Skip for Now

- **Token:** INF — multi-LST basket token (holds mSOL, JitoSOL, bSOL, and others)
- **APY:** ~7.1% + trading fees from LST swaps
- **TVL:** ~$300M (INF pool)
- **Unstake:** Instant via Infinity liquidity pool
- **SDK:** `igneous-labs/stakedex-sdk` (follows Jupiter interface — complex router model)
- **APY API:** `https://extra-api.sanctum.so/`
- **Key differentiator:** Earns both staking yield and swap fees; underpins 200+ validator LSTs
- **Integration difficulty:** Medium-Hard (custom router, not standard SPL pool)
- **Decision:** Skip for initial release, revisit later

---

### Lido — Not Relevant

Lido discontinued its native Solana staking product. What remains (wstETH on Solana) is bridged Ethereum liquid-staked ETH via Wormhole — an Ethereum DeFi asset, not a Solana staking product. Negligible volume. **Do not include.**

---

## Native (Non-Liquid) Staking

### How It Works

1. Create a **stake account** funded with SOL
2. Set staker and withdrawal authority to user's wallet (non-custodial)
3. Delegate to a chosen validator via their vote account address
4. Stake activates at the next epoch boundary (~2 days)
5. To exit: deactivate stake account, wait ~2 days, withdraw SOL

No token is issued. SOL is locked during staking. No smart contract beyond Solana's native stake program.

### Key Metrics

- **APY:** ~6–7.5% (depends on chosen validator's commission)
- **Cooldown:** ~1 epoch (~2 days) to activate AND to deactivate
- **Minimum:** 0.01 SOL (stake account rent-exemption)
- **Smart contract risk:** Zero — uses Solana's native stake program, not a third-party contract

### Implementation

Pure `@solana/web3.js` — no additional SDK needed:

```javascript
// Create stake account
StakeProgram.createAccount({ fromPubkey, stakePubkey, authorized: { staker, withdrawer }, lamports })

// Delegate to validator
StakeProgram.delegate({ stakePubkey, authorizedPubkey, votePubkey })

// Unstake (two-step)
StakeProgram.deactivate({ stakePubkey, authorizedPubkey })
StakeProgram.withdraw({ stakePubkey, authorizedPubkey, toPubkey, lamports })
```

The `stakePubkey` is a fresh `Keypair.generate()` created server-side per transaction. The user's wallet controls it via the staker/withdrawer authority.

### Validator Selection

**Stakewiz API** (recommended — free, no API key required for basic use):
- `GET https://api.stakewiz.com/validators` — all validators with Wiz Score, commission, uptime, skip rate, APY estimate
- `GET https://api.stakewiz.com/validator/{VOTE_IDENTITY}` — single validator detail
- Docs: `https://docs.stakewiz.com/reference/api-reference/validators`

**Validators.app** (alternative — free tier with API token):
- `GET https://www.validators.app/api/v1/validators/mainnet.json`

**On-chain fallback:**
- `connection.getVoteAccounts()` — returns all current vote accounts directly from RPC, no external API needed

---

## APY Data Strategy

### Best Single Source: DeFiLlama Yields API

```
GET https://yields.llama.fi/pools
```

- **Free, no API key**
- Updated hourly
- Returns APY + TVL for all major Solana staking protocols
- Filter by `chain: "Solana"` and project name: `"marinade"`, `"jito-liquid-staking"`, `"blazestake"`, `"jpool"`
- **This one call covers all liquid staking protocols simultaneously**

### Per-Protocol APIs (for richer data)

| Protocol | Endpoint |
|---|---|
| Marinade | `https://validators-api.marinade.finance/` |
| Jito | `https://kobe.mainnet.jito.network/api/v1/` |
| Sanctum LSTs | `https://extra-api.sanctum.so/` |
| BlazeStake | `https://stake-docs.solblaze.org/developers/other-apis` |
| Native (per validator) | `https://api.stakewiz.com/validators` |

### On-Chain Exchange Rate (any SPL pool)

```javascript
const { stakePool } = await getStakePoolAccount(connection, poolAddress);
const rate = stakePool.totalLamports / stakePool.poolTokenSupply;
// Compare across epochs to derive APY
```

---

## Proposed Implementation Plan

### Backend

**1. New endpoint: `GET /staking-options`**
- Calls DeFiLlama yields API, filters for Solana staking protocols
- Returns unified array: `{ protocol, token, mint, apy, tvl, unstakeType, fee, poolAddress }`
- Cache: 10 minutes

**2. New endpoint: `GET /validators`**
- Calls Stakewiz API, returns top 50 validators sorted by Wiz Score
- Returns: `{ name, voteAccount, commission, apy, uptime, skipRate, wizScore }`
- Cache: 1 hour

**3. New stake/unstake endpoints**

| Endpoint | Protocol | SDK used |
|---|---|---|
| `POST /stake/jito` | Jito | `@solana/spl-stake-pool` |
| `POST /stake/blaze` | BlazeStake | `@solana/spl-stake-pool` |
| `POST /stake/jpool` | JPool | `@solana/spl-stake-pool` |
| `POST /stake/native` | Native | `@solana/web3.js` only |
| `POST /unstake/native` | Native | `@solana/web3.js` only |

Existing `/stake` and `/withdraw` (Marinade) remain unchanged.

**New npm dependency:** `@solana/spl-stake-pool` — covers Jito, BlazeStake, and JPool with one package.

### Frontend

**1. Remove "Powered by Marinade"** from header

**2. New "Earn" tab** with two sections:

**Liquid Staking section:**
- Comparison table/cards for Marinade, Jito, BlazeStake, JPool
- Columns: Protocol, Token, APY, TVL, Instant Unstake, Fee
- "Stake" button per protocol → opens amount input → builds tx → Phantom signs
- Highlight best APY

**Native Staking section:**
- Explain the tradeoff (locked 2 days, no token, no contract risk)
- Searchable validator table: name, commission, APY estimate, uptime
- Amount input + selected validator → builds stake tx → Phantom signs

**3. Portfolio tab** — no staking action cards (moved to Earn tab), keeps balances display

---

## Comparison Metrics for Users

| Metric | Why It Matters |
|---|---|
| APY (7-day, 30-day) | Primary yield comparison; rolling average smooths epoch volatility |
| TVL | Proxy for trust, liquidity depth, protocol maturity |
| Token received | Matters for DeFi composability (can you use mSOL/JitoSOL in other protocols?) |
| Unstake type | Instant vs. delayed is a major UX difference |
| Unstake fee | Liquid instant unstake costs 0.1–9%; native has no fee |
| Cooldown period | ~2 days for all delayed options |
| MEV sharing | Only Jito passes MEV to stakers |
| Smart contract risk | Custom program (Marinade, Sanctum) vs. Solana Foundation's audited SPL program |
| Audit count | Number of independent security audits |
| Validator diversity | Number of validators in the pool (decentralization) |

---

## Open Question (Pending Decision)

**Where should the staking comparison UI live?**

- **Option A — New "Earn" tab** (Portfolio / Holdings / Earn / Market): clean separation, dedicated space
- **Option B — Inside Portfolio tab**: "Compare protocols" section below existing stake/withdraw cards
- **Option C — New "Stake" tab**: Portfolio becomes read-only (balances only), Stake tab handles all actions

---

## Key Technical Notes

- Jito, BlazeStake, and JPool all use the same `@solana/spl-stake-pool` package — adding all three costs the same effort as adding one
- Native staking needs zero new dependencies — `@solana/web3.js` already imported
- Marinade SDK already in project — existing `/stake` and `/withdraw` endpoints stay as-is
- All transactions follow the same non-custodial pattern: backend builds unsigned tx → frontend sends to Phantom to sign → Phantom broadcasts
- `stakePubkey` for native staking is a fresh keypair per transaction; user's wallet holds staker + withdrawer authority
