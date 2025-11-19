// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { Transaction, Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Marinade, MarinadeConfig } from "@marinade.finance/marinade-ts-sdk";
import BN from "bn.js";


const app = express();
const PORT = 4000;
app.use(cors());
app.use(bodyParser.json());

// Solana connection
const connection = new Connection("https://api.mainnet-beta.solana.com");

// mSOL mint (mainnet)
const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");

// -------- API ENDPOINTS --------

// Get Marinade staking account balance
app.post("/balance", async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: "Wallet address required" });

    const balance = await connection.getBalance(new PublicKey(wallet));
    res.json({ balance: balance / LAMPORTS_PER_SOL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/stake", async (req, res) => {
  try {
    const { wallet, amount } = req.body;
    if (!wallet || !amount) {
      return res.status(400).json({ error: "Wallet and amount required" });
    }

    const userPublicKey = new PublicKey(wallet);

    const config = new MarinadeConfig({
      connection,
      publicKey: userPublicKey,
    });
    const marinade = new Marinade(config);

    // Amount in lamports
    const lamports = new BN(Math.floor(amount * LAMPORTS_PER_SOL));

    // ✅ Deposit only takes amount
    const { transaction } = await marinade.deposit(lamports);

    // Ensure transaction is valid
    transaction.feePayer = userPublicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const serialized = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    res.json({ transaction: Buffer.from(serialized).toString("base64") });
  } catch (err) {
    console.error("Stake error:", err);
    res.status(500).json({ error: err.message });
  }
});

// fetch mSOL balance (investment), staked SOL
app.post("/investment", async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: "Wallet required" });

    const owner = new PublicKey(wallet);

    // Get all mSOL token accounts for this wallet
    const tokenAccounts = await connection.getTokenAccountsByOwner(owner, { mint: MSOL_MINT });

    let total = 0;
    for (const ta of tokenAccounts.value) {
      const bal = await connection.getTokenAccountBalance(ta.pubkey);
      total += bal?.value?.uiAmount || 0;
    }

    return res.json({ staked: total });
  } catch (err) {
    console.error("Investment fetch error:", err);
    return res.status(500).json({ error: err.message });
  }
});


// Withdraw staked SOL
app.post("/withdraw", async (req, res) => {
  try {
    const { wallet, amount } = req.body;
    if (!wallet || !amount) {
      return res.status(400).json({ error: "Wallet address and amount are required" });
    }

    const walletPublicKey = new PublicKey(wallet);
    const msolAmountToUnstake = new BN(parseFloat(amount) * LAMPORTS_PER_SOL);

    console.log(`Preparing to liquid-unstake ${amount} mSOL for wallet ${wallet}`);

    // --- THIS IS THE FIX ---
    // 1. Create a new MarinadeConfig with the user's public key for each request
    const userConfig = new MarinadeConfig({
      connection: connection,
      publicKey: walletPublicKey, // Set the user's public key here
    });

    // 2. Create a new Marinade instance based on the user-specific config
    const userMarinade = new Marinade(userConfig);
    // --- END OF FIX ---

    // 3. Call liquidUnstake on the new instance. No need to pass the owner again.
    const { transaction } = await userMarinade.liquidUnstake(msolAmountToUnstake);

    // Set the fee payer and recent blockhash for the transaction
    transaction.feePayer = walletPublicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    // Serialize the transaction without signing it
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
    });

    // Convert to Base64 to safely send via JSON
    const transactionBase64 = serializedTransaction.toString("base64");

    res.status(200).json({ transaction: transactionBase64 });

  } catch (err) {
    console.error("Backend withdraw error:", err);
    const errorMessage = err instanceof Error ? err.message : "An unknown error occurred";
    res.status(500).json({ error: errorMessage });
  }
});

app.post("/confirmTx", async (req, res) => {
  try {
    const { signature } = req.body;
    if (!signature) return res.status(400).json({ error: "Signature required" });

    const status = await connection.getSignatureStatuses([signature]);
    res.json(status.value[0]);
  } catch (err) {
    console.error("ConfirmTx backend error:", err);
    res.status(500).json({ error: err.message });
  }
});


app.listen(4000, () => console.log("Backend running on http://localhost:4000"));
