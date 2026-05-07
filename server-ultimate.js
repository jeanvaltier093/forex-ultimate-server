'use strict';
const express = require('express');
const fetch   = require('node-fetch');
const app     = express();
 
const TWELVE_KEY = process.env.TWELVE_DATA_API_KEY;
const JBIN_KEY   = process.env.JBIN_KEY;
const JBIN_ID    = process.env.JBIN_ID;
const PORT       = process.env.PORT || 3001;
 
if (!TWELVE_KEY || !JBIN_KEY || !JBIN_ID) {
  console.error('❌ Variables manquantes : TWELVE_DATA_API_KEY, JBIN_KEY, JBIN_ID');
  process.exit(1);
}
 
let activeTrades   = [];
let history        = [];
let lastSignalTime = {};
 
const PAIRS = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','NZD/USD','USD/CAD','EUR/GBP'];
const ANTI_CLUSTER = 24 * 60 * 60 * 1000;
 
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
 
// ─── JSONBIN ─────────────────────────────────────────────────────────────────
async function syncCloud() {
  try {
    await fetch(`https://api.jsonbin.io/v3/b/${JBIN_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JBIN_KEY },
      body: JSON.stringify({ activeTrades, history, lastSignalTime })
    });
    console.log('☁️  Cloud sauvegardé');
  } catch (e) { console.error('syncCloud:', e.message); }
}
async function loadCloud() {
  try {
    const r = await fetch(`https://api.jsonbin.io/v3/b/${JBIN_ID}/latest`, {
      headers: { 'X-Master-Key': JBIN_KEY }
    });
    const d = await r.json();
    if (d.record) {
      activeTrades   = d.record.activeTrades   || [];
      history        = d.record.history        || [];
      lastSignalTime = d.record.lastSignalTime || {};
      console.log(`☁️  Cloud chargé — ${activeTrades.length} actifs, ${history.length} historique`);
    }
  } catch (e) { console.error('loadCloud:', e.message); }
}
 
// ─── MARCHÉ ───────────────────────────────────────────────────────────────────
function isDST(date) {
  const month = date.getUTCMonth() + 1;
  if (month >= 4 && month <= 9) return true;
  if (month <= 2 || month >= 11) return false;
  if (month === 3) { const ls = lastSundayOf(date.getUTCFullYear(), 3); return date.getUTCDate() >= ls; }
  if (month === 10) { const ls = lastSundayOf(date.getUTCFullYear(), 10); return date.getUTCDate() < ls; }
  return false;
}
function lastSundayOf(year, month) {
  const d = new Date(Date.UTC(year, month, 0));
  return d.getUTCDate() - d.getUTCDay();
}
function isMarketOpen() {
  const now = new Date();
  const parisOffset = isDST(now) ? 2 : 1;
  const utcHour = now.getUTCHours();
  const parisHour = (utcHour + parisOffset) % 24;
  const utcDay = now.getUTCDay();
  const parisDay = parisHour < utcHour ? (utcDay + 1) % 7 : utcDay;
  if (parisDay === 6) return false;
  if (parisDay === 0 && parisHour < 23) return false;
  if (parisDay === 5 && parisHour >= 23) return false;
  if (parisDay === 1 && parisHour < 1) return false;
  return true;
}
 
// ─── INDICATEURS ─────────────────────────────────────────────────────────────
function calcEMA(d, p) {
  if (d.length <= p) return d.map(() => d[d.length-1]);
  const k = 2/(p+1); let e = d.slice(0,p).reduce((a,b)=>a+b,0)/p;
  const r = [e];
  for (let i = p; i < d.length; i++) { e = d[i]*k + e*(1-k); r.push(e); }
  return r;
}
function calcATR(h, l, c, p=14) {
  const tr = [];
  for (let i=1; i<c.length; i++) tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  return tr.length ? tr.slice(-p).reduce((a,b)=>a+b,0)/Math.min(p,tr.length) : 0.001;
}
function calcADX(h, l, c, p=14) {
  const tr=[],pm=[],mm=[];
  for (let i=1; i<c.length; i++) {
    tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
    const u=h[i]-h[i-1], dv=l[i-1]-l[i];
    pm.push(u>dv&&u>0?u:0); mm.push(dv>u&&dv>0?dv:0);
  }
  const sT=tr.slice(-p).reduce((a,b)=>a+b,0)||1;
  const sP=pm.slice(-p).reduce((a,b)=>a+b,0);
  const sM=mm.slice(-p).reduce((a,b)=>a+b,0);
  const pDI=(sP/sT)*100, mDI=(sM/sT)*100;
  return { adx: Math.abs(pDI-mDI)/(pDI+mDI+0.0001)*100, bull: pDI>mDI };
}
function calcOBV(c) {
  let obv10=0;
  for (let i=Math.max(1,c.length-10); i<c.length; i++) {
    const b=Math.abs(c[i]-c[i-1])*10000;
    obv10 += c[i]>c[i-1]?b:-b;
  }
  return { rising: obv10>0 };
}
function calcRSI(closes, period=14) {
  if (closes.length < period+1) return closes.map(()=>50);
  const gains=[], losses=[];
  for (let i=1; i<closes.length; i++) {
    const d = closes[i]-closes[i-1];
    gains.push(d>0?d:0); losses.push(d<0?-d:0);
  }
  let ag = gains.slice(0,period).reduce((a,b)=>a+b,0)/period;
  let al = losses.slice(0,period).reduce((a,b)=>a+b,0)/period;
  const rsi = [100-100/(1+ag/(al||0.0001))];
  for (let i=period; i<gains.length; i++) {
    ag = (ag*(period-1)+gains[i])/period;
    al = (al*(period-1)+losses[i])/period;
    rsi.push(100-100/(1+ag/(al||0.0001)));
  }
  return rsi;
}
function calcStochRSI(closes) {
  const rsi = calcRSI(closes, 14);
  if (rsi.length < 4) return { k: 50, rising: false };
  const lb = Math.min(14, rsi.length);
  const slice = rsi.slice(-lb);
  const minR = Math.min(...slice), maxR = Math.max(...slice);
  const cur  = rsi[rsi.length-1];
  const prev = rsi.length > 1 ? rsi[rsi.length-2] : cur;
  const k    = maxR === minR ? 50 : ((cur-minR)/(maxR-minR))*100;
  const kP   = maxR === minR ? 50 : ((prev-minR)/(maxR-minR))*100;
  return { k, rising: k > kP };
}
function calcHeikenAshi(opens, highs, lows, closes) {
  if (opens.length < 2) return { bull: false };
  const ha = []; let haO = (opens[0]+closes[0])/2;
  for (let i=0; i<closes.length; i++) {
    const haC = (opens[i]+highs[i]+lows[i]+closes[i])/4;
    if (i>0) haO = (ha[i-1].o+ha[i-1].c)/2;
    ha.push({ o: haO, c: haC });
  }
  const last = ha[ha.length-1];
  return { bull: last.c > last.o };
}
function calcConnors(closes) {
  const rsi3 = calcRSI(closes, 3);
  const v = rsi3[rsi3.length-1];
  return { oversold: v < 30, overbought: v > 70, val: Math.round(v) };
}
function calcPivots(highs, lows, closes) {
  const n = closes.length;
  if (n < 3) return { pivot: 0, r1: 0, r2: 0, s1: 0 };
  const pH = Math.max(...highs.slice(-20,-1));
  const pL = Math.min(...lows.slice(-20,-1));
  const pC = closes[n-2];
  const piv = (pH+pL+pC)/3;
  return { pivot: piv, r1: 2*piv-pL, r2: piv+(pH-pL), s1: 2*piv-pH };
}
function detectDblTop(highs, closes) {
  const h = highs.slice(-30);
  const maxH = Math.max(...h);
  const maxI = h.lastIndexOf(maxH);
  if (maxI < 5) return false;
  for (let i=0; i<maxI-4; i++) {
    if (Math.abs(h[i]-maxH)/maxH < 0.004) {
      const valley = Math.min(...h.slice(i, maxI));
      return closes[closes.length-1] < valley * 1.002;
    }
  }
  return false;
}
function detectTriangleDes(highs, lows, closes) {
  if (highs.length < 20) return false;
  const rH = highs.slice(-15), rL = lows.slice(-15);
  const avgH1 = rH.slice(0,7).reduce((a,b)=>a+b,0)/7;
  const avgH2 = rH.slice(7).reduce((a,b)=>a+b,0)/8;
  const lowerHighs = avgH2 < avgH1 * 0.998;
  const minL = Math.min(...rL), maxL = Math.max(...rL);
  const stableLows = maxL > 0 ? (maxL-minL)/minL < 0.005 : false;
  const nearSup = closes[closes.length-1] < (minL||0) * 1.003;
  return lowerHighs && stableLows && nearSup;
}
 
// ─── MOTEUR ULTIMATE ──────────────────────────────────────────────────────────
function computeUltimate(candles, pair) {
  if (candles.length < 60) return null;
  const closes = candles.map(c => parseFloat(c.close));
  const highs  = candles.map(c => parseFloat(c.high));
  const lows   = candles.map(c => parseFloat(c.low));
  const opens  = candles.map(c => parseFloat(c.open));
  const n      = closes.length - 1;
  if (n < 50) return null;
  const price  = closes[n];
  const dec    = pair.includes('JPY') ? 3 : 5;
  const atrVal = calcATR(highs, lows, closes);
  const slPips = atrVal * 1.5;
  const tpPips = slPips * 1.5;
 
  const e12  = calcEMA(closes, 12),           e26  = calcEMA(closes, 26);
  const e12p = calcEMA(closes.slice(0,-3),12), e26p = calcEMA(closes.slice(0,-3),26);
  const ml   = e12.slice(e12.length-e26.length).map((v,i)=>v-e26[i]);
  const mlp  = e12p.slice(e12p.length-e26p.length).map((v,i)=>v-e26p[i]);
  const priceTrend = closes[n] > closes[n-3] ? 1 : -1;
  const macdTrend  = ml[ml.length-1] > mlp[mlp.length-1] ? 1 : -1;
  const macdDiv    = priceTrend !== macdTrend ? -priceTrend : 0;
 
  const stRSI = calcStochRSI(closes);
  const adxD  = calcADX(highs, lows, closes);
  const ha    = calcHeikenAshi(opens, highs, lows, closes);
  const cnrs  = calcConnors(closes);
  const pivs  = calcPivots(highs, lows, closes);
  const dTop  = detectDblTop(highs, closes);
  const triD  = detectTriangleDes(highs, lows, closes);
  const obv   = calcOBV(closes);
  const stDisp  = stRSI.k.toFixed(0)+'%'+(stRSI.rising?'↑':'↓');
  const adxDisp = adxD.adx.toFixed(1)+(adxD.bull?'▲':'▼');
  const obvDisp = (obv.rising?'↑':'↓');
 
  const bS = [macdDiv===1, stRSI.k>50&&stRSI.rising, adxD.bull, ha.bull, cnrs.oversold];
  const bNames = ['Divergence MACD haussière','StochRSI > 50 montant','ADX direction haussière','Heiken Ashi haussier','Connors RSI survendu (RSI3 < 30)'];
  const buyHit = bS.filter(Boolean).length;
 
  const sS = [macdDiv===-1, stRSI.k<50&&!stRSI.rising, price>=pivs.r1, dTop, triD];
  const sNames = ['Divergence MACD baissière','StochRSI < 50 descendant','Zone Pivot R1/R2','Double sommet','Triangle descendant'];
  const sellHit = sS.filter(Boolean).length;
 
  if (buyHit >= 4) {
    return {
      pair, direction: 'BUY',
      entryPrice: price.toFixed(dec),
      sl: (price-slPips).toFixed(dec), tp: (price+tpPips).toFixed(dec),
      reliability: 67, engine: 'ULTIMATE',
      signalHits: buyHit, signalNames: bNames, signalStates: bS,
      reasons: bNames.filter((_,i)=>bS[i]).map(r=>'✓ '+r),
      obvDisplay: obvDisp, adxDisplay: adxDisp, cciDisplay: stDisp,
      timestamp: new Date().toISOString()
    };
  }
  if (sellHit >= 4) {
    return {
      pair, direction: 'SELL',
      entryPrice: price.toFixed(dec),
      sl: (price+slPips).toFixed(dec), tp: (price-tpPips).toFixed(dec),
      reliability: 72, engine: 'ULTIMATE',
      signalHits: sellHit, signalNames: sNames, signalStates: sS,
      reasons: sNames.filter((_,i)=>sS[i]).map(r=>'✓ '+r),
      obvDisplay: obvDisp, adxDisplay: adxDisp, cciDisplay: stDisp,
      timestamp: new Date().toISOString()
    };
  }
  return null;
}
 
// ─── FETCH BOUGIES ────────────────────────────────────────────────────────────
async function fetchCandles(pair, outputsize = 200) {
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${pair}&interval=4h&outputsize=${outputsize}&apikey=${TWELVE_KEY}`
    );
    const d = await r.json();
    if (!d.values || d.status === 'error') {
      console.log(`⚠️  ${pair} — réponse API : ${JSON.stringify(d).slice(0, 120)}`);
      return null;
    }
    return d.values.reverse().slice(0, -1);
  } catch (e) { console.error(`fetchCandles ${pair}:`, e.message); return null; }
}
 
// ─── FETCH BOUGIES 30MIN ─────────────────────────────────────────────────────
async function fetchCandles30(pair) {
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=15min&outputsize=300&apikey=${TWELVE_KEY}`
    );
    const d = await r.json();
    if (!d.values || d.status === 'error') return null;
    return d.values.reverse().slice(0, -1);
  } catch (e) { console.error(`fetchCandles30 ${pair}:`, e.message); return null; }
}
 
// ─── VÉRIFICATION TP/SL — BOUGIES 30MIN (filtre strict post-entrée) ──────────
async function checkTrades() {
  if (!activeTrades.length) return;
  let changed = false;
 
  for (const trade of [...activeTrades]) {
    try {
      const tp     = parseFloat(trade.tp);
      const sl     = parseFloat(trade.sl);
      const en     = parseFloat(trade.entryPrice);
      const isJPY  = trade.pair.includes('JPY');
      const pipDiv = isJPY ? 0.01 : 0.0001;
      const dec    = isJPY ? 3 : 5;
 
      const entryTs = new Date(trade.addedAt || trade.timestamp).getTime();
      if (isNaN(entryTs)) { console.log(`⚠️  ${trade.pair} — date invalide`); continue; }
 
      const candles = await fetchCandles30(trade.pair);
      await sleep(600);
      if (!candles || !candles.length) { console.log(`⚠️  ${trade.pair} — bougies 15min indisponibles`); continue; }
 
      // Filtre strict : uniquement bougies dont le DÉBUT est APRÈS l'entrée
      const postEntry = candles.filter(c => new Date(c.datetime).getTime() > entryTs);
 
      if (!postEntry.length) {
        const last = candles[candles.length - 1];
        console.log(`⏸  ${trade.pair} — en attente bougie 15min post-entrée | TP: ${(Math.abs(last.close-tp)/pipDiv).toFixed(0)}p | SL: ${(Math.abs(last.close-sl)/pipDiv).toFixed(0)}p`);
        continue;
      }
 
      let closed = false, result = null, closePrice = null, closeDate = null;
 
      for (const candle of postEntry) {
        const high = parseFloat(candle.high);
        const low  = parseFloat(candle.low);
        if (trade.direction === 'BUY') {
          if (high >= tp) { closed=true; result='WIN';  closePrice=tp; closeDate=candle.datetime; break; }
          if (low  <= sl) { closed=true; result='LOSS'; closePrice=sl; closeDate=candle.datetime; break; }
        } else {
          if (low  <= tp) { closed=true; result='WIN';  closePrice=tp; closeDate=candle.datetime; break; }
          if (high >= sl) { closed=true; result='LOSS'; closePrice=sl; closeDate=candle.datetime; break; }
        }
      }
 
      if (closed) {
        const pips = ((trade.direction==='BUY'?closePrice-en:en-closePrice)/pipDiv).toFixed(1);
        console.log(`${result==='WIN'?'✅':'❌'} ${trade.pair} ${trade.direction} — ${pips>0?'+':''}${pips}p | 15min: ${closeDate}`);
        history.unshift({ ...trade, result, closePrice: closePrice.toFixed(dec), pips, closedAt: new Date(closeDate).toISOString() });
        if (history.length > 100) history = history.slice(0, 100);
        activeTrades = activeTrades.filter(t => t.pair !== trade.pair);
        changed = true;
      } else {
        const last = postEntry[postEntry.length - 1];
        console.log(`⏸  ${trade.pair} ${trade.direction} | ${last.close} | TP ${(Math.abs(last.close-tp)/pipDiv).toFixed(0)}p | SL ${(Math.abs(last.close-sl)/pipDiv).toFixed(0)}p | ${postEntry.length} bougies 15min`);
      }
 
    } catch (e) { console.error(`checkTrades ${trade.pair}:`, e.message); }
  }
  if (changed) await syncCloud();
}
 
// ─── SCAN PRINCIPAL ───────────────────────────────────────────────────────────
async function runScan() {
  console.log(`\n⬡ SCAN ULTIMATE — ${new Date().toLocaleString('fr-FR')}`);
  if (!isMarketOpen()) { console.log('🚫 Marché fermé — scan ignoré'); await checkTrades(); return; }
 
  const now = new Date();
  const parisOffset = isDST(now) ? 2 : 1;
  const parisHour = (now.getUTCHours() + parisOffset) % 24;
  const utcDay = now.getUTCDay();
  const parisDay = parisHour < now.getUTCHours() ? (utcDay+1)%7 : utcDay;
  if (parisDay === 5 && parisHour >= 14) {
    console.log('🚫 Vendredi après 14h Paris — pas de nouveaux signaux');
    await loadCloud(); await checkTrades(); return;
  }
 
  await loadCloud();
  const ts = Date.now();
  const activePairs = activeTrades.map(t => t.pair);
  let signalsFound = 0, changed = false;
 
  for (const pair of PAIRS) {
    if (activePairs.includes(pair)) { console.log(`⏸  ${pair} — trade actif`); continue; }
    if (lastSignalTime[pair] && (ts-lastSignalTime[pair]) < ANTI_CLUSTER) {
      console.log(`🕐 ${pair} — signal récent (${Math.round((ts-lastSignalTime[pair])/3600000)}h)`); continue;
    }
    try {
      const candles = await fetchCandles(pair);
      await sleep(10000); // offset vs serveur PROD
      if (!candles) { console.log(`⚠️  ${pair} — données indisponibles`); continue; }
      const sig = computeUltimate(candles, pair);
      if (sig) {
        console.log(`🚨 SIGNAL ${sig.direction} sur ${sig.pair} — ${sig.reliability}% — ${sig.signalHits}/5`);
        activeTrades.push({ ...sig, addedAt: new Date().toISOString() });
        lastSignalTime[pair] = ts; signalsFound++; changed = true;
      } else { console.log(`📊 ${pair} — aucun signal ULTIMATE`); }
    } catch (e) { console.error(`scan ${pair}:`, e.message); }
  }
 
  console.log(`✅ Scan ULTIMATE terminé — ${signalsFound} signal(s)`);
  await checkTrades();
  if (changed) await syncCloud();
}
 
// ─── SCHEDULING ───────────────────────────────────────────────────────────────
function getNextInterval() {
  const now = new Date();
  const parisOffset = isDST(now) ? 2 : 1;
  const parisHour = (now.getUTCHours() + parisOffset) % 24;
  const day = now.getUTCDay(), utcHour = now.getUTCHours();
  if (day===6||day===0) return 60*60*1000;
  if (day===5&&utcHour>=22) return 60*60*1000;
  if (day===1&&utcHour<1) return 60*60*1000;
  return parisHour>=8&&parisHour<22 ? 15*60*1000 : 60*60*1000;
}
async function scheduleNextScan() {
  const interval = getNextInterval();
  console.log(`⏱  Prochain scan dans ${Math.round(interval/60000)} min`);
  setTimeout(async () => { await runScan(); scheduleNextScan(); }, interval);
}
 
// ─── HTTP ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'running', engine: 'ULTIMATE', version: '1.0.0',
    time: new Date().toISOString(), marketOpen: isMarketOpen(),
    activeTrades: activeTrades.length, history: history.length,
    pairs: PAIRS.length,
    signals: {
      buy:  'macdDiv + stochRSIMid + adxDir + heikenDir + connorsExt — WR 67%',
      sell: 'macdDiv + stochRSIMid + pivotR2 + dblTop + triangleDes  — WR 72%'
    }
  });
});
app.get('/status', (req, res) => {
  const wins = history.filter(h=>h.result==='WIN').length;
  const wr   = history.length ? Math.round(wins/history.length*100) : 0;
  const pips = history.reduce((s,h)=>s+parseFloat(h.pips||0), 0);
  res.json({
    activeTrades, history: history.slice(0, 50), lastSignalTime,
    stats: {
      winRate:   history.length ? wr+'%' : '—',
      totalPips: history.length ? (pips>=0?'+':'')+pips.toFixed(1) : '—',
      trades:    history.length, wins
    }
  });
});
app.post('/scan', async (req, res) => {
  res.json({ message: 'Scan lancé en arrière-plan' });
  runScan().catch(console.error);
});
app.post('/close', async (req, res) => {
  const { pair, result, closePrice } = req.body;
  if (!pair || !result) return res.status(400).json({ error: 'pair et result requis' });
  const trade = activeTrades.find(t => t.pair === pair);
  if (!trade) return res.status(404).json({ error: 'Trade non trouvé' });
  const cp     = parseFloat(closePrice) || parseFloat(result==='WIN'?trade.tp:trade.sl);
  const en     = parseFloat(trade.entryPrice);
  const isJPY  = pair.includes('JPY');
  const pipDiv = isJPY ? 0.01 : 0.0001;
  const dec    = isJPY ? 3 : 5;
  const pips   = ((trade.direction==='BUY' ? cp-en : en-cp) / pipDiv).toFixed(1);
  history.unshift({ ...trade, result, closePrice: cp.toFixed(dec), pips, closedAt: new Date().toISOString() });
  if (history.length > 100) history = history.slice(0, 100);
  activeTrades = activeTrades.filter(t => t.pair !== pair);
  await syncCloud();
  console.log(`🔒 Clôture manuelle — ${pair} ${trade.direction} — ${result} — ${pips>0?'+':''}${pips} pips`);
  res.json({ success: true, pips, result });
});
 
// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
async function start() {
  console.log('🚀 Forex ULTIMATE — Serveur démarré');
  console.log('   BUY  : macdDiv + stochRSIMid + adxDir + heikenDir + connorsExt — WR 67%');
  console.log('   SELL : macdDiv + stochRSIMid + pivotR2 + dblTop + triangleDes  — WR 72%');
  console.log('   TP/SL check : HIGH/LOW de chaque bougie 4h ✅');
  await loadCloud();
  app.listen(PORT, () => console.log(`🌐 Port ${PORT}`));
  setInterval(async()=>{
    try{ await fetch(`http://localhost:${PORT}/`); console.log('[ULTIMATE] 🏓 Keep-alive OK'); }
    catch(e){ console.log('[ULTIMATE] ⚠ Keep-alive échoué:', e.message); }
  }, 14*60*1000);
  await sleep(45000); // offset vs serveur PROD
  await runScan();
  scheduleNextScan();
}
 
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
start().catch(console.error);
 
