let walletAddress = null;
// Add this line at the top of your frontend javascript file
//const connection = new solanaWeb3.Connection("https://api.mainnet-beta.solana.com");

async function confirmTx(signature) {
  while (true) {
    const res = await fetch("http://localhost:4000/confirmTx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature })
    });

    const data = await res.json();
    if (data && (data.confirmationStatus === "confirmed" || data.err)) {
      return data;
    }
    await new Promise(r => setTimeout(r, 1000)); // poll every 1s
  }
}

async function connectWallet() {
  if (window.solana && window.solana.isPhantom) {
    try {
      const resp = await window.solana.connect();
      walletAddress = resp.publicKey.toString();
      document.getElementById("wallet").innerText = "Wallet: " + walletAddress;
      fetchBalance();
    } catch (err) {
      alert("Wallet connection failed: " + err.message);
    }
  } else {
    alert("Phantom wallet not found! Please install it.");
  }
}

async function fetchBalance() {
  if (!walletAddress) return;
  const res = await fetch("http://localhost:4000/balance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: walletAddress })
  });
  const data = await res.json();
  document.getElementById("balance").innerText = "Balance: " + data.balance + " SOL";
}

// Decode base64 → Uint8Array
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function stakeSOL() {
  const amount = document.getElementById("stakeAmount").value;
  if (!amount) return alert("Enter amount");

  const res = await fetch("http://localhost:4000/stake", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: walletAddress, amount })
  });

  const data = await res.json();
  if (!data.transaction) return alert("Error: " + JSON.stringify(data));

  console.log("Decoded base64 length:", data.transaction.length);

  const txBytes = base64ToUint8Array(data.transaction);
  const tx = solanaWeb3.Transaction.from(txBytes);

  try {
    const { signature } = await window.solana.signAndSendTransaction(tx);
    alert("✅ Transaction sent! Signature: " + signature);
  } catch (err) {
    console.error("Phantom error:", err);
    alert("❌ Transaction failed: " + err.message);
  }
}


async function fetchInvestment() {
  const res = await fetch("http://localhost:4000/investment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: walletAddress })
  });

  const data = await res.json();

  // Use the field returned by backend
  document.getElementById("investment").innerText =
    `Staked: ${data.staked} mSOL`;
}

// Withdraw function
async function withdrawSOL() {
  try {
    const amount = document.getElementById("withdrawAmount").value;
    if (!amount || parseFloat(amount) <= 0) {
      return alert("Please enter a valid amount to withdraw.");
    }

    console.log(`Requesting withdrawal of ${amount} mSOL...`);

    // 1. Call your backend to get the prepared transaction
    const res = await fetch("http://localhost:4000/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: walletAddress, amount: amount }),
    });

    const data = await res.json();
    if (!data.transaction) {
      return alert("Error from backend: " + (data.error || JSON.stringify(data)));
    }

    // 2. Decode the Base64 transaction string into a byte array
    const txBytes = Uint8Array.from(atob(data.transaction), c => c.charCodeAt(0));

    // 3. Deserialize the byte array into a Transaction object
    const tx = solanaWeb3.Transaction.from(txBytes);

    // 4. Use the connected wallet to sign and send the transaction
    // This will open a confirmation popup in the user's wallet (e.g., Phantom)
    const { signature } = await window.solana.signAndSendTransaction(tx);
    
    // 5. Confirm the transaction and provide feedback
    //await connection.confirmTransaction(signature, 'confirmed');
    await confirmTx(signature);
    
    alert(`✅ Withdraw successful! Transaction Signature: ${signature}`);
    console.log(`Withdrawal signature: ${signature}`);
    console.log(`View on Solscan: https://solscan.io/tx/${signature}`);

  } catch (err) {
    console.error("Frontend withdraw error:", err);
    alert("❌ Withdraw failed: " + err.message);
  }
}



// Event Listeners
document.getElementById("connectBtn").onclick = connectWallet;
document.getElementById("stakeBtn").onclick = stakeSOL;
document.getElementById("fetchInvestment").onclick = fetchInvestment;
document.getElementById("withdrawBtn").onclick = withdrawSOL;
