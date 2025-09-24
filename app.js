/***************************************
  app.js - Aurum Presale (production-ready)
  - Connects wallet (with pending-request guard)
  - Validates contract address
  - Estimates tokens from BNB (Binance price)
  - Sends purchase tx with gas guard
  - Updates batch progress
  - Auto-reconnect on accountsChanged/chainChanged
****************************************/

/******** CONFIG ********/
const RAW_CONTRACT = "0xac958de36acfbb1dce325140973799475ed9493e"; // official contract address
// Minimal ABI (extend if your contract exposes more functions)
const ABI = [
  "function buyTokens() payable",
  "function paused() view returns (bool)",
  "function aurumToken() view returns (address)",
  "function rateTokensPerBNB() view returns (uint256)",
  "function tokensForSale() view returns (uint256)"
];
const TOKEN_PRICE_USD = 0.10; // UI-only estimate
const TARGET_CHAIN_ID = 56;   // BSC mainnet

/******* global state *******/
let provider = null;
let signer = null;
let contract = null;
let bnbUsd = null;
let isConnecting = false;
let isBuying = false;
window.initialBatch = null;

/******* DOM utilities *******/
const $ = (id) => document.getElementById(id);
function setStatus(msg, cls = "") {
  const el = $("status");
  if (!el) return;
  el.className = cls;
  el.innerHTML = msg;
}
function setBadge(id, txt) {
  const el = $(id);
  if (el) el.textContent = txt;
}
function setDisabled(btn, flag) {
  if (!btn) return;
  btn.disabled = !!flag;
}
function normalizeAddress(addr) {
  try { return ethers.utils.getAddress(addr); } catch { return null; }
}
const CONTRACT = normalizeAddress(RAW_CONTRACT);

/******* HARDEN BUTTON (reset old listeners to avoid duplicates) *******/
function hardenButton(btn, handler) {
  if (!btn) return null;
  try { btn.setAttribute("type", "button"); } catch {}
  const clone = btn.cloneNode(true);
  btn.parentNode.replaceChild(clone, btn);
  const el = clone;
  const safe = (e) => { e.preventDefault(); try { handler(e); } catch (err) { console.error(err); } };
  el.addEventListener("click", safe, { passive: true });
  el.addEventListener("touchend", (e) => { e.preventDefault(); safe(e); }, { passive: false });
  return el;
}

/********* UPDATE PROGRESS (batch progress bar) *********/
async function updateProgress() {
  if (!contract || !provider) return;
  try {
    let tokenAddr = null;
    try { tokenAddr = await contract.aurumToken(); } catch {}
    if (!tokenAddr) return;

    const tokenAbi = ["function balanceOf(address) view returns (uint256)"];
    const token = new ethers.Contract(tokenAddr, tokenAbi, provider);
    const balance = await token.balanceOf(CONTRACT);
    const balanceNum = parseInt(ethers.utils.formatUnits(balance, 18));
    if (!window.initialBatch) window.initialBatch = balanceNum;

    const sold = window.initialBatch - balanceNum;
    const percent = window.initialBatch > 0 ? (sold / window.initialBatch) * 100 : 0;

    const bar = $("progressBar");
    if (bar) bar.style.width = percent + "%";
    const txt = $("progressText");
    if (txt) txt.textContent = `${sold} / ${window.initialBatch} AUR sold in this batch (${percent.toFixed(1)}%)`;
  } catch (e) {
    console.error("updateProgress error:", e);
  }
}

/********* CONNECT WALLET (professional flow with pending guard) *********/
async function connectWallet() {
  const connectBtn = $("connectBtn");

  if (!window.ethereum) {
    setStatus("Install a compatible wallet (MetaMask/TrustWallet).", "err");
    return;
  }
  if (isConnecting) {
    // Already waiting for wallet approval
    setStatus("Please confirm the connection in your wallet…", "");
    return;
  }

  try {
    isConnecting = true;
    setDisabled(connectBtn, true);
    setStatus("Requesting connection… Confirm in your wallet.", "");

    provider = new ethers.providers.Web3Provider(window.ethereum, "any");

    // This triggers the wallet popup. If user doesn't respond, error -32002 can appear on repeated clicks.
    await provider.send("eth_requestAccounts", []);

    signer = provider.getSigner();
    const acct = await signer.getAddress();

    // Ensure correct network (attempt switch to BSC)
    let net = await provider.getNetwork();
    if (net.chainId !== TARGET_CHAIN_ID) {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x38" }], // hex(56)
        });
        provider = new ethers.providers.Web3Provider(window.ethereum, "any");
        signer = provider.getSigner();
        net = await provider.getNetwork();
      } catch (err) {
        console.warn("switch chain error:", err);
        setStatus("Please switch to BSC network (56) in your wallet.", "err");
        return;
      }
    }

    if (!CONTRACT) {
      setStatus("Invalid contract address (CONFIG).", "err");
      return;
    }
    contract = new ethers.Contract(CONTRACT, ABI, signer);

    const bal = await provider.getBalance(acct);
    setBadge("netBadge", `🌐 Network: ${net.name} (${net.chainId})`);
    setBadge("acctBadge", `👛 Account: ${acct.slice(0, 6)}...${acct.slice(-4)}`);
    setBadge("balBadge", `💰 Balance: ${ethers.utils.formatEther(bal)} BNB`);
    setStatus("Wallet connected ✅", "ok");

    const linkEl = $("contractLink");
    if (linkEl && CONTRACT) {
      linkEl.href = `https://bscscan.com/address/${CONTRACT}`;
      linkEl.target = "_blank";
      linkEl.rel = "noopener";
    }

    await updateProgress();

    // Clean and reattach listeners to avoid duplicates
    try {
      window.ethereum.removeAllListeners("accountsChanged");
      window.ethereum.removeAllListeners("chainChanged");
    } catch {}
    window.ethereum.on("accountsChanged", () => {
      setStatus("Account changed, reconnecting…", "");
      connectWallet();
    });
    window.ethereum.on("chainChanged", () => {
      setStatus("Network changed, reconnecting…", "");
      connectWallet();
    });
  } catch (e) {
    console.error("connectWallet:", e);
    const code = e?.code;
    const msg = e?.message || String(e);

    if (code === -32002) {
      // Pending request already open in wallet
      setStatus("Connection request already pending. Please open your wallet and approve it.", "err");
    } else if (code === 4001 || /user rejected/i.test(msg)) {
      setStatus("Connection rejected by user.", "err");
    } else {
      setStatus("Connection error: " + msg, "err");
    }
  } finally {
    isConnecting = false;
    setDisabled(connectBtn, false);
  }
}

/********* BUY TOKENS (with button guard) *********/
async function buyTokens() {
  const buyBtn = $("buyBtn");
  if (!contract || !signer) {
    setStatus("Connect your wallet first.", "err");
    return;
  }
  if (isBuying) return;

  try {
    // Optional pause guard
    if (typeof contract.paused === "function") {
      const paused = await contract.paused();
      if (paused) { setStatus("Purchases are currently paused in the contract.", "err"); return; }
    }
  } catch (e) { console.warn("paused check error:", e); }

  const bnbInput = $("bnbAmount");
  if (!bnbInput) { setStatus("BNB input field not found.", "err"); return; }
  const val = (bnbInput.value || "").trim();
  if (!/^\d+(\.\d+)?$/.test(val) || Number(val) <= 0) {
    setStatus("Enter a valid BNB amount (ex: 0.05).", "err");
    return;
  }

  try {
    isBuying = true;
    setDisabled(buyBtn, true);

    const valueWei = ethers.utils.parseEther(val);
    const userAddr = await signer.getAddress();
    const balance = await provider.getBalance(userAddr);
    if (balance.lt(valueWei)) { setStatus("Insufficient balance.", "err"); return; }

    let overrides = { value: valueWei };
    try {
      const est = await contract.estimateGas.buyTokens(overrides);
      overrides.gasLimit = est.mul(12).div(10); // +20% headroom
    } catch {}

    setStatus("⏳ Sending transaction… confirm in your wallet.", "");
    const tx = await contract.buyTokens(overrides);
    setStatus(`⏳ Tx sent: <a href="https://bscscan.com/tx/${tx.hash}" target="_blank">${tx.hash}</a>`, "");
    const receipt = await tx.wait();
    if (receipt && receipt.status === 1) {
      setStatus(`✅ Purchase confirmed: <a href="https://bscscan.com/tx/${receipt.transactionHash}" target="_blank">${receipt.transactionHash}</a>`, "ok");
      const bal = await provider.getBalance(userAddr);
      setBadge("balBadge", `💰 Balance: ${ethers.utils.formatEther(bal)} BNB`);
      await updateProgress();
    } else {
      setStatus("Transaction finished but not confirmed (status != 1).", "err");
    }
  } catch (e) {
    console.error("buyTokens error:", e);
    const code = e?.code;
    const msg = e?.data?.message || e?.reason || e?.message || String(e);
    if (code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(msg)) {
      setStatus("Insufficient balance to cover value + gas.", "err");
    } else if (/user rejected/i.test(msg) || code === 4001) {
      setStatus("Transaction rejected by user.", "err");
    } else {
      setStatus("Purchase error: " + msg, "err");
    }
  } finally {
    isBuying = false;
    setDisabled(buyBtn, false);
  }
}

/********* VALIDATION & ESTIMATE UI *********/
function setupValidationAndEstimate() {
  const validateBtn = $("validateBtn");
  if (validateBtn) {
    validateBtn.addEventListener("click", () => {
      const input = ($("tokenAddr")?.value || "").trim();
      try {
        const norm = ethers.utils.getAddress(input);
        if (norm.toLowerCase() === CONTRACT.toLowerCase()) {
          $("tokenStatus").textContent = "✅ Valid contract! You can purchase safely.";
          $("tokenStatus").className = "ok";
          $("buyBtn").disabled = false;
        } else {
          $("tokenStatus").textContent = "❌ Address does not match the official contract!";
          $("tokenStatus").className = "err";
          $("buyBtn").disabled = true;
        }
      } catch {
        $("tokenStatus").textContent = "❌ Invalid address.";
        $("tokenStatus").className = "err";
        $("buyBtn").disabled = true;
      }
    });
  }

  const bnbIn = $("bnbAmount"), pi = $("priceInfo");
  if (bnbIn && pi) {
    bnbIn.addEventListener("input", async () => {
      const v = (bnbIn.value || "").trim();
      if (!v || isNaN(v) || Number(v) <= 0) { pi.textContent = "Estimated amount: —"; return; }
      try {
        if (!bnbUsd) {
          const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT");
          const j = await res.json(); bnbUsd = parseFloat(j.price);
        }
        const usd = Number(v) * bnbUsd;
        const tokens = usd / TOKEN_PRICE_USD;
        pi.textContent = `With ${v} BNB (~$${usd.toFixed(2)}), you will receive approx. ${tokens.toFixed(2)} AUR`;
      } catch (e) {
        console.warn("estimate error:", e);
        pi.textContent = "Estimated amount: —";
      }
    });
  }
}

/********* WIRE UI (buttons) *********/
function wireButtons() {
  let connectBtn = $("connectBtn");
  let buyBtn = $("buyBtn");

  if (!connectBtn) {
    connectBtn = Array.from(document.querySelectorAll("button")).find(b => /(connect)/i.test(b.innerText));
  }
  if (!buyBtn) {
    buyBtn = Array.from(document.querySelectorAll("button")).find(b => /(buy|purchase)/i.test(b.innerText));
  }

  if (!connectBtn) console.warn("connect button not found");
  if (!buyBtn) console.warn("buy button not found");

  if (connectBtn) hardenButton(connectBtn, connectWallet);
  if (buyBtn) hardenButton(buyBtn, buyTokens);

  setupValidationAndEstimate();

  // Optional: auto-connect if the wallet already granted permissions
  document.addEventListener("DOMContentLoaded", async () => {
    if (window.ethereum && window.ethereum.selectedAddress) {
      connectWallet();
    }
  });
}

/********* start *********/
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireButtons);
} else {
  wireButtons();
}

// Periodically refresh progress (does not touch wallet state)
setInterval(() => { if (contract) updateProgress(); }, 30000);
