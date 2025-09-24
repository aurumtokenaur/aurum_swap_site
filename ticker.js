const SYMS = [
  "BNBUSDT","BTCUSDT","ETHUSDT","SOLUSDT","ADAUSDT","XRPUSDT",
  "DOGEUSDT","MATICUSDT","DOTUSDT","SHIBUSDT","LTCUSDT","AVAXUSDT",
  "TRXUSDT","LINKUSDT","UNIUSDT","ATOMUSDT","BCHUSDT","AAVEUSDT",
  "FILUSDT","NEARUSDT","EGLDUSDT","XLMUSDT","ETCUSDT","ICPUSDT"
];

const lane = document.getElementById("tickerLane");

// 🚀 placeholders iniciais para não demorar a aparecer
lane.innerHTML = SYMS.map(sym => {
  const s = sym.replace("USDT","");
  return `<span class="item">${s}: loading...</span>`;
}).join("") + lane.innerHTML;

async function fetchPrices(){
  try {
    const url = "https://api.binance.com/api/v3/ticker/24hr?symbols=" + encodeURIComponent(JSON.stringify(SYMS));
    const res = await fetch(url);
    const data = await res.json();
    const html = data.map(t=>{
      const sym=t.symbol.replace("USDT","");
      const price=parseFloat(t.lastPrice).toFixed(3);
      const chg=parseFloat(t.priceChangePercent);
      const cls=chg>0?"price-up":chg<0?"price-down":"price-stable";
      return `<span class="item ${cls}">${sym}: $${price} (${chg.toFixed(2)}%)</span>`;
    }).join("");
    lane.innerHTML = html + html;
  } catch(e){
    lane.innerHTML = "<span>Ticker error</span>";
  }
}

// já busca logo de cara
fetchPrices();
// continua atualizando a cada 30s
setInterval(fetchPrices, 60000);
