import { DurableObject } from "cloudflare:workers";
// 賺大錢發發發：Cloudflare 上的即時報價。
// /api/idx 大盤台美股、/api/quote 首頁自選股、/api/detail 自選股詳細頁、/api/stk 股票報酬比較與回測、/api/nav 淨值查詢、/api/mkt 大盤高低指標；其他網址交給靜態檔案。
// 報價類每 60 秒最多真的去抓一次（大盤高低指標 30 分鐘），期間大家共用同一份結果。
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const US = [["^GSPC", "標普500"], ["^SOX", "費城半導體"], ["^DJI", "道瓊工業指數"], ["^IXIC", "那斯達克"]];
// 日韓（Luna 2026-10-23）：時間用台灣時間；as: 1 讓網頁放在「日韓」分頁
const ASIA = [["^N225", "日經指數"], ["^KS11", "韓國指數"]];
// 匯率（Luna 2026-10-23）：1 美元、100 日圓、1000 韓元換多少台幣，放在全球大盤「匯率」分頁
// Yahoo 的日圓、韓元兌台幣報價只到小數 4 位（韓元 0.0246 太粗），改用美元兌台幣 ÷ 美元兌日圓／韓元算
const FX = [["TWD=X", "美元", 1, null], ["JPYTWD=X", "日圓", 100, "JPY=X"], ["KRWTWD=X", "韓元", 1000, "KRW=X"]];
// 黃金、白銀（Luna 2026-10-24）：國際期貨價（Yahoo，每盎司美元）放在「匯率」分頁；買入／賣出用 Swissquote 的國際現貨報價
const METAL = [["GC=F", "黃金", "XAU"], ["SI=F", "白銀", "XAG"]];
// 虛擬幣（Luna 2026-10-24）：幣安（Binance 公開行情 data-api.binance.vision）的 BTC/USDT、ETH/USDT，抓不到改用 OKX；日 K 以台灣時間換日
const CRYPTO = [["BTC-USDT", "比特幣", "BTC-USD"], ["ETH-USDT", "以太幣", "ETH-USD"], ["SOL-USDT", "索拉納", "SOL-USD"], ["BNB-USDT", "幣安幣", "BNB-USD"]]; // SOL、BNB：Luna 2026-10-25
// 穩定幣（Luna 2026-10-24）：USDT、USDC 對台幣，用台灣交易所 MAX（max-api.maicoin.com 公開行情）
const STABLE = [["USDT-TWD", "USDT"], ["USDC-TWD", "USDC"]];
const ixSym = k => (CRYPTO.find(c => c[0] === k) || [0, 0, k])[2];
const IXKEY = /^(twii|otc|txfn|txf|2330|\^?[A-Z0-9]{2,6}|[A-Z]{3,6}=X|[A-Z]{2}=F|(BTC|ETH|SOL|BNB)-USDT|(USDT|USDC)-TWD)$/;
const fxScale = s => (FX.find(f => f[0] === s) || [0, 0, 1])[2];
const ixTz = s => /=X$/.test(s) ? "Asia/Taipei" : /-USD$/.test(s) ? "UTC" : s === "^N225" ? "Asia/Tokyo" : s === "^KS11" ? "Asia/Seoul" : /^\^TWII$|\.TW$/.test(s) ? "Asia/Taipei" : "America/New_York";
const PICKS = [["TSM", "台積電ADR"], ["TSMX", "台積電ADR 2倍"]];
const CACHE_SEC = 60;

const r2 = x => Math.round(x * 100) / 100;
// 日期格式器建一次重複用：每次都 new 一個很耗 CPU（Cloudflare 免費版每次只給很少的 CPU 時間，超過就會失敗）
const fmts = {};
const fmt = (kind, tz, opt) => fmts[kind + tz] || (fmts[kind + tz] = new Intl.DateTimeFormat(kind === "hm" ? "en-GB" : "en-CA", { timeZone: tz, ...opt }));
const hm = (t, tz) => fmt("hm", tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t * 1000));
const ymdI = (t, tz) => fmt("ymd", tz, { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t * 1000));
const dayStr = {};
const ymdOff = (t, h) => { const n = Math.floor((t + h * 3600) / 86400); return dayStr[n] || (dayStr[n] = new Date(n * 864e5).toISOString().slice(0, 10)); };
// 台灣固定 +8；紐約夏令／冬令兩種時差算出同一天就直接用（日線都在白天），不同才用 Intl
const ymd = (t, tz) => tz === "Asia/Taipei" ? ymdOff(t, 8) : tz === "Asia/Tokyo" || tz === "Asia/Seoul" ? ymdOff(t, 9) : tz === "America/New_York" && ymdOff(t, -4) === ymdOff(t, -5) ? ymdOff(t, -4) : ymdI(t, tz);

async function get(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r;
}

// 加權、櫃買、2330：Yahoo 奇摩股市報價頁內嵌的 1 分鐘走勢
async function yahooTw(sym, name) {
  const h = await (await get("https://tw.stock.yahoo.com/quote/" + sym.replace("^", "%5E"))).text();
  const i = h.indexOf('"timestamp":[');
  const tail = h.slice(i);
  const ts = JSON.parse(tail.match(/"timestamp":(\[[^\]]*\])/)[1]);
  const cl = JSON.parse(tail.match(/"close":(\[[^\]]*\])/)[1]);
  const prev = parseFloat(h.slice(Math.max(0, i - 3000), i + 20000).match(/"chartPreviousClose":\s*([\d.]+)/)[1]);
  const pts = ts.map((t, k) => [t, cl[k]]).filter(p => p[1] != null).map(([t, c]) => [hm(t, "Asia/Taipei"), r2(c)]);
  return { name, date: ymd(ts[ts.length - 1], "Asia/Taipei"), prev, pts };
}

// 台指期：先用奇摩股市「台指期近一」的 1 分鐘走勢（期交所的網站常擋 Cloudflare）。一次抓回來的是一個交易日：前一晚 15:00 起的夜盤＋當天日盤
// 夜指期日 K（Luna 2026-11-06）：FinMind 盤後（after_market）的日期是「交易日」＝夜盤結束那天，
// 改標成夜盤開始那天（前一個日盤日），和網頁上夜指期的日期一致；同一天取成交量最大的合約
function txNightBars(data) {
  const pos = new Set(), best = {};
  for (const x of data || []) {
    if (!/^\d{6}$/.test(x.contract_date) || !(x.close > 0)) continue;
    if (x.trading_session === "position") { pos.add(x.date); continue; }
    if (x.trading_session !== "after_market") continue;
    const b = best[x.date]; if (!b || x.volume > b.volume) best[x.date] = x;
  }
  const pd = [...pos].sort(), out = []; let i = 0;
  for (const d of Object.keys(best).sort()) {
    while (i < pd.length && pd[i] < d) i++;
    if (!i) continue;
    const x = best[d]; out.push([pd[i - 1], x.open, x.max, x.min, x.close, x.volume]);
  }
  return out;
}
async function wtx() {
  const a = await (await get("https://tw.stock.yahoo.com/_td-stock/api/resource/FinanceChartService.ApacLibraCharts;symbols=%5B%22WTX%26%22%5D;type=tick?lang=zh-Hant-TW&region=TW")).json();
  const c = a[0].chart, ts = c.timestamp || [], cl = c.indicators.quote[0].close || [];
  const tw = t => new Date((t + 8 * 3600) * 1000).toISOString(); // 台灣固定 +8，直接算比 Intl 省 CPU
  const rows = ts.map((t, k) => { const x = tw(t); return [x.slice(0, 10), x.slice(11, 16), cl[k]]; }).filter(p => p[2] != null);
  return { rows, prev: c.meta.chartPreviousClose ?? c.meta.previousClose };
}
// 日盤（08:45–13:45）；晚上夜盤開始後抓不到當天日盤，就交給網頁沿用每天排程存下的那份
function txfDay(w) {
  const ds = w.rows.filter(p => p[1] >= "08:45" && p[1] <= "13:45");
  const day = ds.length ? ds[ds.length - 1][0] : "";
  const pts = ds.filter(p => p[0] === day).map(p => [p[1], r2(p[2])]);
  if (!pts.length) throw new Error("no txf");
  return { name: "台指期（近月）", date: day, prev: w.prev, pts };
}
// 夜指期：同一個合約的夜盤（15:00–隔天 05:00），漲跌和前一個日盤收盤比；白天看到的是昨晚那一段
function txfNight(w) {
  const ns = w.rows.filter(p => p[1] >= "15:00" || p[1] <= "05:00");
  const pts = ns.map(p => [p[1], r2(p[2])]);
  if (!pts.length) throw new Error("no night");
  const f = ns[0], start = f[1] >= "15:00" ? f[0] : new Date(Date.parse(f[0]) - 864e5).toISOString().slice(0, 10);
  return { name: "夜指期（台指期夜盤）", date: start, prev: w.prev, pts };
}
const txfYahoo = async () => txfDay(await wtx());
const txfAny = () => txfYahoo().catch(() => txf());

async function taifex(path, body) {
  const r = await get("https://mis.taifex.com.tw/futures/api/" + path, {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  });
  return (await r.json()).RtData;
}

// 台指期：期交所近月合約日盤 1 分鐘走勢
async function txf() {
  const q = (await taifex("getQuoteList", { MarketType: "0", SymbolType: "F", KindID: "1", CID: "TXF", ExpireMonth: "",
    RowSize: "全部", PageNo: "", SortColumn: "", AscDesc: "A" })).QuoteList;
  const near = q.find(x => x.SymbolID.endsWith("-F")); // 第一個 -F 是近月合約（-S 是現貨）
  const d = await taifex("getChartData1M", { SymbolID: near.SymbolID });
  const pts = d.Ticks.map(t => [`${t[0].slice(0, 2)}:${t[0].slice(2, 4)}`, r2(parseFloat(t[4]))]);
  const day = near.CDate;
  return { name: `台指期（近月 ${near.DispEName.slice(2)}）`, date: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`,
    prev: parseFloat(near.CRefPrice), pts };
}

// 美股指數、TSM、TSMX、匯率：Yahoo spark 5 分鐘走勢（美東時間）
async function fxSpark() {
  const u = "https://query1.finance.yahoo.com/v8/finance/spark?symbols=TWD%3DX,JPY%3DX,KRW%3DX&range=";
  const [r, dd] = await Promise.all([get(u + "1d&interval=5m").then(x => x.json()), get(u + "5d&interval=1d").then(x => x.json()).catch(() => ({}))]);
  // 昨收用日線前一天的收盤（1 天走勢的 chartPreviousClose 只是今天早上 7 點的價格），和 K 線一致
  const today = ymd(Date.now() / 1000, "Asia/Taipei");
  const pc = s => { const v = dd[s]; if (!v) return null; let p = null; (v.timestamp || []).forEach((t, i) => { if (v.close[i] != null && ymd(t, "Asia/Taipei") < today) p = v.close[i]; }); return p; };
  const usd = r["TWD=X"], at = new Map((usd.timestamp || []).map((t, i) => [t, usd.close[i]]));
  return FX.map(([s, name, n, via]) => {
    const v = via ? r[via] : usd, ts = v.timestamp || [];
    const rate = (a, b) => a != null && b ? (via ? a / b : a) * n : null;
    let lastU = null;
    const pts = ts.map((t, k) => { const u = at.get(t); if (u != null) lastU = u; return [t, rate(u ?? lastU, v.close[k])]; })
      .filter(p => p[1] != null).map(([t, c]) => [hm(t, "Asia/Taipei"), Math.round(c * 1000) / 1000]);
    const prev = rate(pc("TWD=X") ?? usd.chartPreviousClose ?? usd.previousClose, via ? pc(via) ?? v.chartPreviousClose ?? v.previousClose : 1);
    return { key: s, name, fx: 1, date: ts.length ? ymd(ts[ts.length - 1], "Asia/Taipei") : "", prev: Math.round(prev * 1000) / 1000, pts };
  });
}
async function metals() {
  const u = "https://query1.finance.yahoo.com/v8/finance/spark?symbols=GC%3DF,SI%3DF&range=";
  const sq = s => get(`https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${s}/USD`).then(x => x.json()).then(j => {
    const p = j[0].spreadProfilePrices[0]; return [p.bid, p.ask];
  }).catch(() => null);
  // 昨收用 1 天走勢的 chartPreviousClose（期貨是前一個交易日的收盤，週末也對）
  const [r, ...ba] = await Promise.all([get(u + "1d&interval=5m").then(x => x.json()), ...METAL.map(m => sq(m[2]))]);
  return METAL.map(([s, name], i) => {
    const v = r[s] || {}, ts = v.timestamp || [], cl = v.close || [], prev = null;
    const ok = ts.map((t, k) => [t, cl[k]]).filter(p => p[1] != null), pts = ok.map(([t, c]) => [hm(t, "Asia/Taipei"), r2(c)]);
    // 日期和 K 線同樣用美東日期（最後一筆有價格的時間）
    return { key: s, name, fx: 1, mt: 1, date: ok.length ? ymd(ok[ok.length - 1][0], "America/New_York") : "", prev: prev ?? v.chartPreviousClose ?? v.previousClose, pts, ...(ba[i] ? { ba: ba[i] } : {}) };
  });
}
// 虛擬幣：今天（台灣時間 0 點起）的 5 分 K；昨收用台灣時間 0 點的開盤價
const bnSym = s => s.replace("-", "");
async function crypto() {
  return Promise.all(CRYPTO.map(async ([s, name]) => {
    let rows;
    try {
      const j = await (await get(`https://data-api.binance.vision/api/v3/klines?symbol=${bnSym(s)}&interval=5m&limit=300`)).json();
      rows = j.map(x => [x[0] / 1000, +x[1], +x[4]]);
    } catch (_) {
      const j = await (await get(`https://www.okx.com/api/v5/market/candles?instId=${s}&bar=5m&limit=300`)).json();
      rows = (j.data || []).map(x => [+x[0] / 1000, +x[1], +x[4]]).sort((a, b) => a[0] - b[0]);
    }
    const day = rows.length ? ymd(rows[rows.length - 1][0], "Asia/Taipei") : "", today = rows.filter(x => ymd(x[0], "Asia/Taipei") === day);
    return { key: s, name, cr: 1, date: day, prev: today.length ? today[0][1] : null, pts: today.map(x => [hm(x[0], "Asia/Taipei"), r2(x[2])]) };
  }));
}
const maxK = (key, period, limit) => get(`https://max-api.maicoin.com/api/v2/k?market=${key.replace("-", "").toLowerCase()}&period=${period}&limit=${limit}`).then(r => r.json());
async function stable() {
  return Promise.all(STABLE.map(async ([s, name]) => {
    const rows = (await maxK(s, 5, 300)).map(x => [x[0], +x[1], +x[4]]);
    const day = rows.length ? ymd(rows[rows.length - 1][0], "Asia/Taipei") : "", today = rows.filter(x => ymd(x[0], "Asia/Taipei") === day);
    return { key: s, name, cr: 1, tw: 1, date: day, prev: today.length ? today[0][1] : null, pts: today.map(x => [hm(x[0], "Asia/Taipei"), +x[2].toFixed(3)]) };
  }));
}
// MAX 日 K（最近 1000 天）：[日期, 開, 高, 低, 收, 量]
async function maxDaily(key) {
  return (await maxK(key, 1440, 1000)).map(x => [ymd(x[0], "Asia/Taipei"), +x[1], +x[2], +x[3], +x[4], Math.round(+x[5])]);
}
async function spark(list, asia) {
  const q = "/v8/finance/spark?range=1d&interval=5m&symbols=" + list.map(([s]) => encodeURIComponent(s)).join(",");
  // Yahoo 偶爾擋 Cloudflare（429）：query1 不行換 query2
  let r;
  for (const host of ["query1", "query2"]) { try { r = await (await get(`https://${host}.finance.yahoo.com${q}`)).json(); break; } catch (e) { if (host === "query2") throw e; } }
  return list.map(([s, name]) => {
    const v = r[s] || {}, ts = v.timestamp || [], cl = v.close || [];
    const tz = asia ? "Asia/Taipei" : "America/New_York";
    const pts = ts.map((t, k) => [t, cl[k]]).filter(p => p[1] != null).map(([t, c]) => [hm(t, tz), r2(c)]);
    return { key: s, name, ...(asia ? { as: 1 } : { us: 1 }), date: ts.length ? ymd(ts[ts.length - 1], ixTz(s)) : "",
      prev: v.chartPreviousClose ?? v.previousClose, pts };
  });
}

async function build() {
  const jobs = {
    twii: yahooTw("^TWII", "加權指數"), otc: yahooTw("^TWOII", "櫃買指數"),
    us: spark([...US, ...PICKS]), asia: spark(ASIA, true), tw2330: yahooTw("2330.TW", "台積電"), fx: fxSpark(), mt: metals(), cr: crypto(), st: stable(),
  };
  const w = wtx();
  jobs.txf = w.then(txfDay).catch(() => txf());
  jobs.txfn = w.then(txfNight); // Luna：台股加夜指期，放在台指期下面
  const got = Object.fromEntries(await Promise.all(Object.entries(jobs).map(([k, p]) => p.then(v => [k, v], () => [k, null]))));
  // 某一組抓不到時，用這一組上一次抓到的（存 2 天），不要整組消失讓網頁退回內建的舊價格（Luna 2026-10-26：重新整理後價格變上一次的）
  const keep = caches.default;
  await Promise.all(Object.keys(got).map(async k => {
    const key = new Request(`https://idx.keep/${k}`), has = x => x && x.pts && x.pts.length && x.prev;
    let v = got[k];
    const full = v && (Array.isArray(v) ? v.every(has) : has(v));
    if (!full) { // 整組失敗，或其中幾檔是空的：用上一次存的補
      const old = await keep.match(key).then(r => r && r.json()).catch(() => null);
      if (old) v = Array.isArray(old) ? (Array.isArray(v) ? old.map(o => { const n = v.find(x => x.key === o.key); return has(n) ? n : o; }) : old) : (has(v) ? v : old);
      got[k] = v;
    }
    if (v && (Array.isArray(v) ? v.some(has) : has(v))) await keep.put(key, new Response(JSON.stringify(v), { headers: { "Cache-Control": "max-age=172800" } })).catch(() => {});
  }));
  const items = [];
  for (const k of ["twii", "txf", "txfn", "otc"]) if (got[k]) items.push({ key: k, ...got[k] });
  if (got.tw2330) items.push({ key: "2330", pick: 1, ...got.tw2330 }); // Luna：大盤台股最下面放台積電
  if (got.us) items.push(...got.us.map(x => PICKS.some(p => p[0] === x.key) ? { ...x, pick: 1 } : x));
  if (got.asia) items.push(...got.asia);
  if (got.fx) items.push(...got.fx);
  if (got.mt) items.push(...got.mt);
  if (got.cr) items.push(...got.cr);
  if (got.st) items.push(...got.st);
  const now = new Date(Date.now() + 8 * 3600e3).toISOString();
  const data = { updated: `${now.slice(0, 10)} ${now.slice(11, 16)}`, live: 1, items: items.filter(x => x.pts.length && x.prev) };
  const tsm = got.us && got.us.find(x => x.key === "TSM"), tw = got.tw2330, fx = got.fx && got.fx.find(x => x.key === "TWD=X");
  if (tsm && tsm.pts.length && tw && tw.pts.length && fx && fx.pts.length)
    data.adr = { adr: tsm.pts.at(-1)[1], adrDate: tsm.date, tw: tw.pts.at(-1)[1], twDate: tw.date, fx: Math.round(fx.pts.at(-1)[1] * 1000) / 1000 };
  return data;
}

// ───── 股票報酬比較、回測：選到的那幾檔，抓 Yahoo 5 年日線（含息調整）和當日 5 分 K ─────
const rp = x => x == null ? null : Math.round(x * (x < 10 ? 1e4 : x < 100 ? 1e3 : 100)) / (x < 10 ? 1e4 : x < 100 ? 1e3 : 100);
const freqLabel = n => n === 0 ? "無配息" : n >= 10 ? "月配" : n >= 3 ? "季配" : n === 2 ? "半年配" : "年配";
function weeklyKd(ts, hi, lo, cl, n = 9) { // 台股慣用 9 週 KD，和 update_stock_data.py 相同
  const weeks = new Map();
  ts.forEach((t, i) => {
    if (hi[i] == null || lo[i] == null || cl[i] == null) return;
    const d = new Date((t + 8 * 3600) * 1000), day = (d.getUTCDay() + 6) % 7;
    const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
    const w = weeks.get(mon);
    if (!w) weeks.set(mon, [hi[i], lo[i], cl[i]]); else { w[0] = Math.max(w[0], hi[i]); w[1] = Math.min(w[1], lo[i]); w[2] = cl[i]; }
  });
  const bars = [...weeks.keys()].sort().map(k => weeks.get(k));
  if (!bars.length) return [null, null];
  let k = 50, dv = 50;
  bars.forEach((b, i) => {
    const win = bars.slice(Math.max(0, i - n + 1), i + 1), H = Math.max(...win.map(x => x[0])), L = Math.min(...win.map(x => x[1]));
    const rsv = H === L ? 50 : (b[2] - L) / (H - L) * 100;
    k = k * 2 / 3 + rsv / 3; dv = dv * 2 / 3 + k / 3;
  });
  return [Math.round(k * 10) / 10, Math.round(dv * 10) / 10];
}
// Yahoo 偶爾會擋（429）或逾時：換另一台主機再試，最多 3 次
// 歷史跌幅（Luna 2026-11-06）：加權指數 10 年日 K。跌 20% 以上＝從最高點算到再創新高；跌 10% 以上＝反彈 10% 才算一段結束（近 5 年）
function ddCalc(r){
  const q=r.indicators.quote[0],ts=r.timestamp||[],K=[];
  ts.forEach((t,i)=>{const h=q.high[i],l=q.low[i],c=q.close[i];if(h==null||l==null||c==null)return;K.push([new Date((t+8*3600)*1000).toISOString().slice(0,10),h,l,c])});
  const n=K.length,r0=v=>Math.round(v*100)/100;
  // 跌 20% 以上：從最高點算，直到創新高才算結束
  const big=[];let pk=0,lo=-1;
  for(let i=1;i<n;i++){
    if(K[i][1]>K[pk][1]){if(lo>=0&&K[lo][2]/K[pk][1]<=0.8)big.push([pk,lo,i]);pk=i;lo=-1;continue}
    if(lo<0||K[i][2]<K[lo][2])lo=i}
  if(lo>=0&&K[lo][2]/K[pk][1]<=0.8)big.push([pk,lo,-1]);
  // 跌 10% 以上：10% 轉折（反彈 10% 才算一段結束）
  const sm=[];let dir=-1,ext=0,hiI=0;
  for(let i=1;i<n;i++){if(dir<0){if(K[i][1]>K[ext][1])ext=i;else if(K[i][2]<=K[ext][1]*0.9){hiI=ext;dir=1;ext=i}}else{if(K[i][2]<K[ext][2])ext=i;else if(K[i][1]>=K[ext][2]*1.1){sm.push([hiI,ext]);dir=-1;ext=i}}}
  const cur=dir>0?[hiI,ext]:null;
  const back=(p,from)=>{for(let j=from+1;j<n;j++)if(K[j][1]>K[p][1])return K[j][0];return null};
  const row=([p,l])=>({hd:K[p][0],h:r0(K[p][1]),ld:K[l][0],l:r0(K[l][2]),pct:r0((K[l][2]/K[p][1]-1)*100),back:back(p,l)});
  const last=K[n-1];
  return {big:big.map(row),small:sm.map(row).filter(x=>x.hd>=K[n-1][0].replace(/^\d{4}/,y=>y-5)),cur:cur?{...row(cur),last:r0(last[3]),date:last[0]}:null,from:K[0][0]};
}
async function ddHist() {
  for (const host of ["query1", "query2"]) {
    try {
      const j = await (await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/%5ETWII?range=10y&interval=1d`, { headers: { "User-Agent": UA } })).json();
      const r = j.chart && j.chart.result && j.chart.result[0]; if (r && (r.timestamp || []).length > 1000) return ddCalc(r);
    } catch (_) {}
  }
  throw new Error("no data");
}
async function chart(sym) {
  for (const host of ["query1", "query2", "query1"]) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1d&events=div`, { headers: { "User-Agent": UA } });
      if (!r.ok) continue;
      const j = await r.json(), res = j.chart && j.chart.result && j.chart.result[0];
      if (res) return res;
    } catch (_) {}
  }
  return null;
}
async function stockOne(code, us) {
  let sym = us ? code : code + ".TW", d = await chart(sym);
  if (!us && (!d || !(d.timestamp || []).length)) { sym = code + ".TWO"; d = await chart(sym); }
  if (!d || !(d.timestamp || []).length) return null;
  const q = d.indicators.quote[0], ts = d.timestamp, adj = d.indicators.adjclose[0].adjclose;
  const closes = ts.map((t, i) => [t, q.close[i]]).filter(x => x[1] != null);
  if (closes.length < 2) return null;
  const [lastT, lastC] = closes.at(-1);
  const divs = Object.values((d.events || {}).dividends || {}).filter(v => v.date > lastT - 365 * 86400);
  const [k, dv] = weeklyKd(ts, q.high, q.low, q.close);
  const tz = us ? "America/New_York" : "Asia/Taipei";
  const tt = d.meta.regularMarketTime || lastT;
  const daily = [];
  ts.forEach((t, i) => { if (adj[i] != null) daily.push([ymd(t, "Asia/Taipei"), rp(adj[i])]); });
  return { sym, prevClose: rp(closes.at(-2)[1]), last: rp(lastC), yield: Math.round(divs.reduce((a, v) => a + v.amount, 0) / lastC * 1e4) / 100,
    freq: freqLabel(divs.length), k, d: dv, tradeDate: `${ymd(tt, tz)} ${hm(tt, tz)}`, daily };
}
async function stocks(list) { // list: [[code, us]]
  const got = await Promise.all(list.map(([c, us]) => stockOne(c, us).catch(() => null)));
  const ok = list.map(([c], i) => [c, got[i]]).filter(x => x[1]);
  if (ok.length) try {
    const sp = await (await get("https://query1.finance.yahoo.com/v8/finance/spark?range=1d&interval=5m&symbols=" + ok.map(([, v]) => encodeURIComponent(v.sym)).join(","))).json();
    ok.forEach(([c, v]) => {
      const r = sp[v.sym] || {}, ts = r.timestamp || [], cl = r.close || [], tz = v.sym.includes(".") ? "Asia/Taipei" : "America/New_York";
      v.intraday = ts.map((t, i) => [t, cl[i]]).filter(x => x[1] != null).map(([t, c]) => [hm(t, tz), rp(c)]);
      v.dayPrev = rp(r.chartPreviousClose ?? r.previousClose ?? v.prevClose);
    });
  } catch (_) {}
  // Yahoo Finance 台股日線偶爾缺最近一天（0050 曾停在前一天），用奇摩股市即時價補上（和自選股同一個來源）
  const twc = ok.filter(([, v]) => /\.TWO?$/.test(v.sym)).map(([c]) => c);
  if (twc.length) try {
    const lv = await twLive(twc);
    ok.forEach(([c, v]) => {
      const x = lv[c], dl = v.daily, lb = dl.at(-1); if (!x || !lb || x.date < lb[0]) return;
      const ratio = lb[1] / v.last; // 還原價 ÷ 收盤價
      if (x.date > lb[0]) { dl.push([x.date, rp(x.last * ratio)]); v.prevClose = rp(x.prev); }
      else dl[dl.length - 1] = [lb[0], rp(x.last * ratio)];
      v.last = rp(x.last); v.dayPrev = rp(x.prev); v.tradeDate = x.date + " 13:30";
    });
  } catch (_) {}
  return Object.fromEntries(ok);
}

// ───── 除權息行事曆（Luna 2026-10-23）：證交所、櫃買中心的除權息預告表＋這個月已除權息的結果，網頁再挑自選股 ─────
// 回傳 items: [代號, 名稱, 日期, "息"/"權"/"權息", 每股現金股利（還沒公告是 null）]
async function divCal() {
  const now = new Date(Date.now() + 8 * 3600e3), y = now.getUTCFullYear(), m = now.getUTCMonth();
  const d8 = dt => dt.toISOString().slice(0, 10).replace(/-/g, "");
  const roc = t => { const a = String(t).match(/(\d{2,3})\D*(\d{2})\D*(\d{2})/); return a ? `${+a[1] + 1911}-${a[2]}-${a[3]}` : null; };
  const num = v => { const x = parseFloat(String(v).replace(/,/g, "")); return isFinite(x) ? x : null; };
  const kind = t => /權息/.test(t) ? "權息" : /權/.test(t) ? "權" : "息";
  const tw = u => get(u).then(r => r.json()).then(j => j.data || []);
  const tp = u => get(u, { headers: { Accept: "application/json" } }).then(r => r.json());
  const from = d8(new Date(Date.UTC(y, m, 1))), to = d8(now);
  const src = await Promise.all([
    tw("https://www.twse.com.tw/rwd/zh/exRight/TWT48U?response=json").then(a => a.map(r => [r[1], r[2], roc(r[0]), kind(r[3]), /待公告/.test(r[7]) ? null : num(r[7])])),
    tw(`https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json&startDate=${from}&endDate=${to}`).then(a => a.map(r => [r[1], r[2], roc(r[0]), kind(r[6]), /息/.test(r[6]) && !/權/.test(r[6]) ? num(r[5]) : null])),
    tp("https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost").then(a => a.map(r => [r.SecuritiesCompanyCode, r.CompanyName, roc(r.ExRrightsExDividendDate), kind(r.ExRrightsExDividend), num(r.CashDividend) || null])),
    tp("https://www.tpex.org.tw/openapi/v1/tpex_exright_daily").then(a => a.map(r => [r.SecuritiesCompanyCode, r.CompanyName, roc(r.Date), kind(r.ExRightsDiviend), num(r.CashDividend) || null])),
  ].map(p => p.catch(() => null)));
  if (!src[0] && !src[1]) throw new Error("twse failed");
  const by = new Map();
  for (const a of src) for (const r of a || []) {
    if (!r[0] || !r[2]) continue;
    const k = r[0] + r[2], o = by.get(k);
    if (!o || (o[4] == null && r[4] != null)) by.set(k, [String(r[0]).trim(), String(r[1]).replace(/\*$/, "").trim(), r[2], r[3], r[4]]);
  }
  const t = now.toISOString();
  return { updated: `${t.slice(0, 10)} ${t.slice(11, 16)}`, items: [...by.values()].sort((a, b) => a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0), ...(!src[0] || !src[1] ? { __partial: 1 } : {}) }; // 上櫃常擋 Cloudflare：只缺上櫃不算不完整，免得一直用舊備份（Luna 2026-11-10 看不到 11 月 00878）
}

// ───── 淨值查詢：證交所 ETF 盤中預估淨值（格式同 nav_table）─────
const num = x => { const v = parseFloat(String(x ?? "").replace(/,/g, "")); return isNaN(v) ? null : v; };
async function navTable() {
  const raw = await (await get("https://mis.twse.com.tw/stock/data/all_etf.txt", { headers: { Referer: "https://mis.twse.com.tw/stock/etf_nav.jsp?ex=tse" } })).json();
  const out = {};
  for (const g of raw.a1 || []) for (const m of g.msgArray || []) {
    const e = num(m.e), f = num(m.f);
    if (!f) continue;
    const i = String(m.i || ""), j = String(m.j || "");
    out[m.a] = [String(m.b || "").trim(), e, f, num(m.g), num(m.h), num(m.c), num(m.d), i.length === 8 ? `${i.slice(0, 4)}/${i.slice(4, 6)}/${i.slice(6)} ${j.slice(0, 5)}` : ""];
  }
  if (!Object.keys(out).length) throw new Error("all_etf empty");
  return out;
}

// ───── 大盤高低指標：三大法人、恐慌指數、散戶多空比、景氣燈號、M1B（融資維持率和本益比要整個市場的資料，太大，沿用上傳時的資料）─────
const twDay = (back = 0) => new Date(Date.now() + 8 * 3600e3 - back * 86400e3).toISOString().slice(0, 10);
async function inst() {
  for (let b = 0; b < 7; b++) {
    const day = twDay(b); if ([0, 6].includes(new Date(day).getUTCDay())) continue;
    const j = await (await get(`https://www.twse.com.tw/rwd/zh/fund/BFI82U?response=json&type=day&dayDate=${day.replace(/-/g, "")}`)).json();
    if (j.stat !== "OK") continue;
    const v = Object.fromEntries(j.data.map(r => [r[0], num(r[3]) || 0])), yi = x => Math.round(x / 1e6) / 100;
    return [[day, yi((v["外資及陸資(不含外資自營商)"] || 0) + (v["外資自營商"] || 0)), yi(v["投信"] || 0), yi((v["自營商(自行買賣)"] || 0) + (v["自營商(避險)"] || 0))]];
  }
  return null;
}
async function vixNow() {
  for (let b = 0; b < 2; b++) {
    const d = new Date(Date.now() + 8 * 3600e3); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - b);
    const r = await fetch(`https://www.taifex.com.tw/file/taifex/Dailydownload/vix/log2data/${d.toISOString().slice(0, 7).replace("-", "")}new.txt`, { headers: { "User-Agent": UA } });
    if (!r.ok) continue;
    const rows = new TextDecoder("latin1").decode(await r.arrayBuffer()).split(/\r?\n/).map(l => l.trim().split(/\s+/)).filter(p => p.length >= 3 && /^\d{8}$/.test(p[0]) && num(p[2]) != null);
    if (rows.length) { const p = rows.at(-1); return [[`${p[0].slice(0, 4)}-${p[0].slice(4, 6)}-${p[0].slice(6)}`, num(p[2])]]; }
  }
  return null;
}
async function taifexCsv(url, form) {
  const r = await get(url, { method: "POST", body: new URLSearchParams(form), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return new TextDecoder("latin1").decode(await r.arrayBuffer()).split(/\r?\n/).filter(l => /^\d{4}\/\d\d\/\d\d,/.test(l)).map(l => l.split(","));
}
async function retail() { // 小台散戶多空比 = -(三大法人小台未平倉淨額) ÷ 小台全市場未平倉量（一般時段）
  // 結束日超過期交所已有資料的日期會回錯誤頁，所以從今天往前試
  for (let back = 0; back < 4; back++) {
    const r = await retailRange(twDay(back + 10).replace(/-/g, "/"), twDay(back).replace(/-/g, "/")).catch(() => null);
    if (r) return r;
  }
  return null;
}
async function retailRange(a, b) {
  const [mxf, mtx] = await Promise.all([
    taifexCsv("https://www.taifex.com.tw/cht/3/futContractsDateDown", { queryStartDate: a, queryEndDate: b, commodityId: "MXF" }),
    taifexCsv("https://www.taifex.com.tw/cht/3/futDataDown", { down_type: "1", commodity_id: "MTX", queryStartDate: a, queryEndDate: b }),
  ]);
  const net = {}, oi = {};
  mxf.forEach(r => { net[r[0]] = (net[r[0]] || 0) + parseInt(r[13]); });
  mtx.forEach(r => { const v = num(r[11]); if (v != null) oi[r[0]] = (oi[r[0]] || 0) + v; }); // 盤後時段的未沖銷是「-」，會被略過
  const days = Object.keys(net).filter(d => oi[d]).sort();
  if (!days.length) return null;
  const d = days.at(-1);
  return [[d.replace(/\//g, "-"), Math.round(-net[d] / oi[d] * 1e4) / 100]];
}
async function unzipFile(buf, want) { // 只解出檔名符合 want 的那一個檔
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let e = u8.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  let p = dv.getUint32(e + 16, true);
  const n = dv.getUint16(e + 10, true);
  for (let i = 0; i < n; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true),
      xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.slice(p + 46, p + 46 + nl));
    if (want(name)) {
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true), data = u8.slice(start, start + csize);
      if (method === 0) return new TextDecoder().decode(data);
      const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
      return new TextDecoder().decode(out);
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error("file not in zip");
}
function csvRows(t) { return t.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).map(l => l.split(",").map(x => x.replace(/^"|"$/g, ""))); }
async function ndc() {
  const meta = (await (await get("https://data.gov.tw/api/v2/rest/dataset/6099")).json()).result.distribution;
  const url = meta.find(x => x.resourceFormat === "ZIP").resourceDownloadUrl;
  const txt = await unzipFile(await (await get(url)).arrayBuffer(), n => n.includes("景氣指標與燈號") && !n.includes("schema"));
  const [head, ...rows] = csvRows(txt), iD = head.indexOf("Date"), iS = head.indexOf("景氣對策信號綜合分數"), iL = head.indexOf("景氣對策信號");
  return rows.filter(r => num(r[iS]) != null).map(r => [`${r[iD].slice(0, 4)}-${r[iD].slice(4, 6)}`, Math.trunc(num(r[iS])), (r[iL] || "").trim()]).slice(-13);
}
async function m1b() {
  const [head, ...rows] = csvRows(await (await get("https://www.cbc.gov.tw/public/data/OpenData/%E7%B6%93%E7%A0%94%E8%99%95/EF01M01.csv")).text());
  const i1 = head.indexOf("貨幣總計數-M1B-日平均-年增率"), i2 = head.indexOf("貨幣總計數-M2-日平均-年增率");
  return rows.filter(r => num(r[i1]) != null && num(r[i2]) != null).map(r => {
    const [y, m] = r[0].split("M"); return [`${y}-${m.padStart(2, "0")}`, Math.round(num(r[i1]) * 100) / 100, Math.round(num(r[i2]) * 100) / 100];
  }).slice(-13);
}
async function market() {
  const jobs = { inst: inst(), vix: vixNow(), retail: retail(), ndc: ndc(), m1b: m1b() };
  const out = { updated: `${twDay(0)} ${new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16)}` };
  await Promise.all(Object.entries(jobs).map(([k, p]) => p.then(v => { if (v && v.length) out[k] = v; }, () => {})));
  return out;
}

// ───── 首頁自選股：當日 5 分 K 和昨收（台股先試 .TW，沒有再試 .TWO）─────
async function sparkMap(syms) {
  const out = {};
  for (let i = 0; i < syms.length; i += 20) {
    const r = await (await get("https://query1.finance.yahoo.com/v8/finance/spark?range=1d&interval=5m&symbols=" + syms.slice(i, i + 20).map(encodeURIComponent).join(","))).json();
    Object.assign(out, r);
  }
  return out;
}
// 台股即時報價：Yahoo 奇摩股市（沒有延遲；Yahoo Finance 的台股會晚 20 分鐘）
// 回傳 { 代號: { prev, last, o, h, l, v, date } }，上市找不到再用上櫃
async function twLive(codes) {
  const out = {};
  const ask = async suf => {
    const need = codes.filter(c => !out[c]); if (!need.length) return;
    for (let i = 0; i < need.length; i += 30) {
      const syms = need.slice(i, i + 30).map(c => c + suf).join(",");
      try {
        const a = await (await get(`https://tw.stock.yahoo.com/_td-stock/api/resource/StockServices.stockList;fields=avgPrice;symbols=${encodeURIComponent(syms)}?lang=zh-Hant-TW&region=TW`)).json();
        for (const x of a || []) {
          const c = String(x.symbol || "").replace(/\.TWO?$/, ""), n = v => v && v.raw != null && v.raw !== "" ? +v.raw : null;
          const last = n(x.price), prev = n(x.regularMarketPreviousClose);
          if (last == null || !prev || !x.regularMarketTime) continue;
          out[c] = { prev, last, o: n(x.regularMarketOpen), h: n(x.regularMarketDayHigh), l: n(x.regularMarketDayLow), v: +x.volume || 0,
            date: ymd(Date.parse(x.regularMarketTime) / 1000, "Asia/Taipei") };
        }
      } catch (_) {}
    }
  };
  await ask(".TW"); await ask(".TWO");
  return out;
}

// 定期定額（Luna 2026-10-24）：最近 3 個月每天的收盤價（沒有還原），網頁用扣款日（遇假日用下一個交易日）的收盤價算買幾股
// 自選股「回測」（Luna 2026-10-25）：5 年含息還原日線 OHLC，給頁面自己算 1～3 年的存股／價差回測
async function btBars(code, us) {
  for (const sym of us ? [code] : [code + ".TW", code + ".TWO"]) {
    const d = await chart(sym);
    if (!d || !(d.timestamp || []).length) continue;
    const q = d.indicators.quote[0], adj = (d.indicators.adjclose || [{}])[0].adjclose || q.close, out = { d: [], o: [], h: [], l: [], c: [] };
    d.timestamp.forEach((t, i) => {
      const c = q.close[i], a = adj[i];
      if (c == null || a == null || q.open[i] == null || q.high[i] == null || q.low[i] == null || (!us && !(q.volume[i] > 0))) return;
      const f = a / c;
      out.d.push(ymdOff(t, us ? -4 : 8)); out.o.push(rp(q.open[i] * f)); out.h.push(rp(q.high[i] * f)); out.l.push(rp(q.low[i] * f)); out.c.push(rp(a));
    });
    if (out.d.length > 60) return out;
  }
  return null;
}
async function closes(code, us) {
  const tz = us ? "America/New_York" : "Asia/Taipei";
  let out = null;
  for (const sym of us ? [code] : [code + ".TW", code + ".TWO"]) {
    for (const host of ["query1", "query2"]) {
      try {
        const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3mo&interval=1d`, { headers: { "User-Agent": UA } });
        if (!r.ok) continue;
        const res = (await r.json()).chart?.result?.[0];
        if (res && (res.timestamp || []).length) {
          const q = res.indicators.quote[0];
          // 台股放假日 Yahoo 偶爾也有一根（成交量 0），不算交易日
          out = res.timestamp.map((t, i) => [ymd(t, tz), q.close[i] == null || (!us && !q.volume[i]) ? null : rp(q.close[i])]).filter(x => x[1] != null);
        }
        break;
      } catch (_) {}
    }
    if (out) break;
  }
  if (!us) { // Yahoo 台股日線有時少最近幾天，用台股即時報價補今天
    const lv = (await twLive([code]).catch(() => ({})))[code];
    if (lv && lv.date) { out = (out || []).filter(x => x[0] !== lv.date); out.push([lv.date, lv.last]); out.sort((a, b) => a[0] < b[0] ? -1 : 1); }
  }
  if (!out || !out.length) throw new Error("no data");
  return { d: out };
}

async function quotes(tw, us) {
  const one = (v, tz) => {
    const ts = v.timestamp || [], cl = v.close || [];
    const pts = ts.map((t, k) => [t, cl[k]]).filter(x => x[1] != null);
    if (!pts.length) return null;
    return { prev: rp(v.chartPreviousClose ?? v.previousClose), last: rp(pts.at(-1)[1]), date: ymd(pts.at(-1)[0], tz),
      pts: pts.map(([t, c]) => [hm(t, tz), rp(c)]) };
  };
  const out = {};
  const liveP = twLive(tw);
  let r = await sparkMap([...tw.map(c => c + ".TW"), ...us]);
  tw.forEach(c => { const x = r[c + ".TW"] && one(r[c + ".TW"], "Asia/Taipei"); if (x) out[c] = x; });
  us.forEach(c => { const x = r[c] && one(r[c], "America/New_York"); if (x) out[c] = { ...x, us: 1 }; });
  const live = await liveP;
  const miss = tw.filter(c => !out[c] && !live[c]);
  if (miss.length) {
    r = await sparkMap(miss.map(c => c + ".TWO")).catch(() => ({})); // 開盤前 20 分鐘 Yahoo 還沒有今天的走勢，不能讓整份報價失敗
    miss.forEach(c => { const x = r[c + ".TWO"] && one(r[c + ".TWO"], "Asia/Taipei"); if (x) out[c] = x; });
  }
  // 台股價格用即時的那一份蓋過去（附上開高低量，詳細頁的今天 K 棒用得到）
  for (const [c, x] of Object.entries(live)) out[c] = { pts: [], ...(out[c] || {}), ...x };
  return out;
}

// ───── 自選股詳細頁：一檔的 K 線、配息、EPS、本益比、河流圖 ─────
// 台股 EPS 用 FinMind 季報（抓不到改用 Yahoo 近幾季）；美股用 Yahoo 年報 EPS 加最近的近四季 EPS
// usd=true：美股 ADR（例如 TSM）的財報是台幣，換成美元，股價 ÷ EPS 才對得上（Luna 2026-10-23：TSM 本益比怪怪的）
async function yahooSeries(sym, types, usd = false) {
  const j = await (await get(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?type=${types}&period1=1400000000&period2=${Math.floor(Date.now() / 1000) + 86400}`)).json();
  const out = {}, fx = {};
  for (const r of j.timeseries.result || []) {
    const k = r.meta.type[0], pts = (r[k] || []).filter(Boolean);
    if (usd) for (const c of new Set(pts.map(v => v.currencyCode).filter(c => c && c !== "USD"))) if (!fx[c]) fx[c] = await fxMonthly(c);
    out[k] = pts.map(v => { const c = v.currencyCode, m = usd && c && c !== "USD" ? fx[c] : null;
      return [v.asOfDate, m ? v.reportedValue.raw / fxAt(m, v.asOfDate) : v.reportedValue.raw]; }).filter(x => isFinite(x[1]));
  }
  return out;
}
// 每月匯率（1 美元換多少外幣），給財報換算用
async function fxMonthly(cur) {
  const d = await chart(`${cur}=X`).catch(() => null), m = {};
  if (d) d.timestamp.forEach((t, i) => { const v = d.indicators.quote[0].close[i]; if (v) m[ymd(t, "Asia/Taipei").slice(0, 7)] = v; });
  return m;
}
function fxAt(m, date) { const ks = Object.keys(m).sort(); let v = NaN; for (const k of ks) { if (k <= date.slice(0, 7)) v = m[k]; else break; } return isFinite(v) ? v : (ks.length ? m[ks[0]] : NaN); }
async function twEps(code) {
  try {
    const j = await (await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements&data_id=${code}&start_date=${new Date().getUTCFullYear() - 7}-01-01`)).json();
    const q = (j.data || []).filter(x => x.type === "EPS").map(x => [x.date, x.value]).sort();
    if (q.length >= 4) return q;
  } catch (_) {}
  return null;
}
// 法人（分析師）預估 EPS：Yahoo Finance 分析頁裡的「今年／明年」平均預估
// 台股先用鉅亨網（FactSet 法人共識，涵蓋比較多檔），抓不到再用 Yahoo
async function twEstimates(code) {
  try {
    const j = await (await get(`https://marketinfo.api.cnyes.com/mi/api/v1/financialIndicator/estimateProfit/TWS:${code}:STOCK?type=eps`)).json();
    const by = Object.fromEntries((j.data || []).filter(x => x.feMean != null).map(x => [x.financialYear, x]));
    const y = new Date(Date.now() + 8 * 3600e3).getUTCFullYear(), out = {};
    for (const [k, yr] of [["y0", y], ["y1", y + 1]]) {
      const e = by[yr]; if (!e) continue;
      out[k] = { end: `${yr}-12-31`, avg: rp(e.feMean), low: rp(e.feLow), high: rp(e.feHigh), n: e.numEst, prev: by[yr - 1] ? rp(by[yr - 1].feMean) : null };
    }
    return out.y0 || out.y1 ? out : null;
  } catch (_) { return undefined; } // 抓失敗（不是沒資料）回 undefined，讓 valuation 不要快取
}
// 法人預估 EPS 抓到一次就保留一季（Luna 2026-10-23）：有新資料才換；這次沒抓到就用保留的
async function estimates(sym) {
  const key = new Request(`https://est.cache/${encodeURIComponent(sym.replace(/\.TWO$/, ".TW"))}`), cache = caches.default;
  const now = await estimatesLive(sym);
  if (now && (now.y0 || now.y1)) { await cache.put(key, new Response(JSON.stringify(now), { headers: { "Cache-Control": "public, max-age=7776000" } })).catch(() => {}); return now; }
  const kept = await cache.match(key).then(r => r && r.json()).catch(() => null);
  return kept || now;
}
async function estimatesLive(sym) {
  const tw = sym.match(/^(\w+)\.TWO?$/);
  let failed = false;
  if (tw) { const c = await twEstimates(tw[1]); if (c) return c; failed = c === undefined; }
  const y = await yahooEstimates(sym);
  return y || (failed ? undefined : null);
}
async function yahooEstimates(sym) {
  try {
    // 頁面約 1MB：只取 earningsTrend 附近一小段再處理，省 CPU
    // 邊讀邊找，找到 earningsTrend 後再多讀 4 萬字就停，不用整頁解碼
    const rd = (await get(`https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/analysis/`)).body.getReader(), dec = new TextDecoder();
    let raw = "", at = -1;
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      raw += dec.decode(value, { stream: true });
      if (at < 0) { at = raw.indexOf("earningsTrend"); if (at < 0) raw = raw.slice(-20); else { raw = raw.slice(at); at = 0; } }
      if (at >= 0 && raw.length > 40000) { rd.cancel().catch(() => {}); break; }
    }
    if (at < 0) return null;
    const h = raw.slice(0, 40000).replace(/\\"/g, '"');
    const out = {};
    for (const [k, per] of [["y0", "0y"], ["y1", "+1y"]]) {
      const i = h.indexOf(`"period":"${per}","endDate":"`); if (i < 0) continue;
      const end = h.slice(i + per.length + 23, i + per.length + 33);
      const a = h.indexOf('"earningsEstimate":{', i), b = h.indexOf('"revenueEstimate"', a);
      if (a < 0 || a - i > 400) continue;
      const seg = h.slice(a, b > a ? b : a + 600), num = f => { const m = seg.match(new RegExp(`"${f}":\\{"raw":(-?[\\d.]+)`)); return m ? +m[1] : null; };
      const avg = num("avg"); if (avg == null) continue;
      out[k] = { end, avg: rp(avg), low: rp(num("low")), high: rp(num("high")), n: num("numberOfAnalysts"), prev: rp(num("yearAgoEps")) };
    }
    return out.y0 || out.y1 ? out : null;
  } catch (_) { return null; }
}
// 近 5 年本益比平均：每個月收盤 ÷ 當時近四季 EPS；平均 ±1 個標準差當「便宜／昂貴」的分界
function pe5Band(monthly, ttmSeries) {
  const p5 = monthly.slice(-60).map(([dt, c]) => { const e = [...ttmSeries].reverse().find(x => x[0] <= dt); return e && e[1] > 0 ? c / e[1] : null; }).filter(v => v != null && v < 300);
  if (p5.length < 12) return null;
  const avg = p5.reduce((a, b) => a + b, 0) / p5.length, sd = Math.sqrt(p5.reduce((a, b) => a + (b - avg) ** 2, 0) / p5.length);
  return { avg: Math.round(avg * 10) / 10, lo: Math.round(Math.max(avg - sd, avg * 0.5) * 10) / 10, hi: Math.round((avg + sd) * 10) / 10, months: p5.length };
}
// 股淨比：bps＝推算的每股淨值（網頁用即時股價 ÷ bps 算現在的股淨比）；台股另有近 5 年平均 ±1 個標準差
async function pbBand(code, us, sym, bars, price) {
  try {
    const closeAt = Object.fromEntries(bars.map(b => [b[0], b[4]]));
    let pts = [];
    if (!us) {
      const j = await (await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPER&data_id=${code}&start_date=${new Date().getUTCFullYear() - 5}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}-01`)).json();
      pts = (j.data || []).filter(x => x.PBR > 0).map(x => [x.date, x.PBR]);
    } else {
      const y = await yahooSeries(sym, "trailingPbRatio").catch(() => ({}));
      pts = (y.trailingPbRatio || []).filter(x => x[1] > 0);
    }
    if (!pts.length) return null;
    const [ld, lv] = pts[pts.length - 1], dates = Object.keys(closeAt).filter(d => d <= ld).sort(), c0 = dates.length ? closeAt[dates[dates.length - 1]] : null;
    const cur = c0 ? price / (c0 / lv) : lv, r2 = v => Math.round(v * 100) / 100;
    const pb = { cur: r2(cur), asOf: ld, bps: c0 ? c0 / lv : null };
    const mon = {}; pts.forEach(([d, v]) => { mon[d.slice(0, 7)] = v; });
    const m = Object.entries(mon).slice(-60);
    if (m.length >= 24) {
      const v = m.map(x => x[1]), avg = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - avg) ** 2, 0) / v.length);
      Object.assign(pb, { avg: r2(avg), lo: r2(Math.max(avg - sd, avg * 0.5)), hi: r2(avg + sd), months: m.map(x => x[0]), hist: m.map(x => r2(x[1])) });
    }
    return pb;
  } catch (_) { return null; }
}
// 自選股清單的便宜／合理／昂貴：今年法人預估 EPS ＋ 近 5 年本益比區間（網頁再用即時股價 ÷ EPS 比對）。ETF 沒有，回空的
async function valuation(code, us) {
  if (!us && /^00/.test(code)) return {};
  let sym = us ? code : code + ".TW", d = await chart(sym);
  if (!us && (!d || !(d.timestamp || []).length)) { sym = code + ".TWO"; d = await chart(sym); }
  if (!d || !(d.timestamp || []).length || d.meta.instrumentType === "ETF") return {};
  // 月收盤和詳細頁同一套算法，兩邊的便宜／昂貴才會一致
  const tz = us ? "America/New_York" : "Asia/Taipei", q = d.indicators.quote[0], month = {};
  const bars = d.timestamp.map((t, i) => [ymd(t, tz), q.open[i], q.high[i], q.low[i], rp(q.close[i])]).filter(b => b.slice(1, 5).every(v => v != null));
  bars.forEach(b => { month[b[0].slice(0, 7)] = [b[0], b[4]]; });
  const monthly = Object.values(month);
  const [est, pb, ttm] = await Promise.all([estimates(sym), pbBand(code, us, sym, bars, bars[bars.length - 1][4]), (async () => {
    const sumLast4 = qs => qs.map((x, i) => i < 3 ? null : [x[0], qs.slice(i - 3, i + 1).reduce((a, y) => a + y[1], 0)]).filter(Boolean);
    if (!us) {
      let qs = await twEps(code);
      if (!qs) { const y = await yahooSeries(sym, "quarterlyDilutedEPS").catch(() => ({})); qs = y.quarterlyDilutedEPS || []; }
      return sumLast4(qs);
    }
    const y = await yahooSeries(sym, "annualDilutedEPS,trailingDilutedEPS", true).catch(() => ({}));
    const r = ([dt, v]) => [dt, Math.round(v * 100) / 100], ann = (y.annualDilutedEPS || []).map(r), last = ann.length ? ann[ann.length - 1][0] : "";
    return [...ann, ...(y.trailingDilutedEPS || []).filter(x => x[0] > last).map(r)];
  })()]);
  // EPS 或股淨比的資料來源一時抓不到（FinMind 偶爾限流）：丟錯，不要把缺資料的結果快取 6 小時；cached() 會先給上次成功的備份
  const b5 = pe5Band(monthly, ttm), e = est && est.y0, out = {};
  // 資料來源一時抓不到（法人預估、EPS、股淨比）：標記 __partial，cached() 先給上次完整的備份，沒有才給現有的、只存 5 分鐘
  if (!ttm.length || (!us && !pb) || est === undefined) out.__partial = 1;
  if (b5 && e && e.avg > 0) Object.assign(out, { eps: e.avg, ...b5 });
  if (b5 && est && est.y1 && est.y1.avg > 0) Object.assign(out, { eps1: est.y1.avg, ...b5 }); // 明年本益比（Luna：分今年、明年）
  // 獲利不穩定（景氣循環股）：近 5 年近四季 EPS 曾經 ≤0，或從高點打對折（Luna：一下賺一下賠、或獲利打對折才算；聯發科掉 46% 算穩定成長，看本益比） → 網頁改看股淨比（Luna 2026-10-23）
  const t5 = ttm.slice(-20).map(x => x[1]);
  if (t5.length >= 8) { let pk = -Infinity, dd = 0; for (const v of t5) { pk = Math.max(pk, v); if (pk > 0) dd = Math.max(dd, 1 - v / pk); } out.cyc = Math.min(...t5) <= 0 || dd >= 0.5 ? 1 : 0; }
  if (pb && pb.bps && pb.avg) out.pb = { bps: Math.round(pb.bps * 1000) / 1000, avg: pb.avg, lo: pb.lo, hi: pb.hi };
  return keepVal(code, us, out);
}
// 本益比／股淨比區間（便宜價、合理價）和預估 EPS 抓到就保留一季（Luna 2026-10-23）：新的有就換、缺的用保留的補
const valKey = (code, us) => new Request(`https://val.cache/${us ? "us" : "tw"}/${encodeURIComponent(code)}`);
async function keptVal(code, us) { return caches.default.match(valKey(code, us)).then(r => r && r.json()).catch(() => null); }
async function keepVal(code, us, out) {
  const kept = await keptVal(code, us) || {}, m = { ...out };
  if (!(m.avg > 0) && kept.avg > 0) Object.assign(m, { avg: kept.avg, lo: kept.lo, hi: kept.hi, months: kept.months });
  for (const k of ["eps", "eps1"]) if (!(m[k] > 0) && kept[k] > 0) m[k] = kept[k];
  if (!m.pb && kept.pb) m.pb = kept.pb;
  if (m.cyc == null && kept.cyc) m.cyc = kept.cyc;
  delete m.__partial;
  const full = (m.eps > 0 || m.eps1 > 0) && m.avg > 0 && (us || m.pb);
  if (!full && out.__partial) m.__partial = 1;
  const save = { ...m }; delete save.__partial;
  if (save.avg > 0 || save.pb) await caches.default.put(valKey(code, us), new Response(JSON.stringify(save), { headers: { "Cache-Control": "public, max-age=7776000" } })).catch(() => {});
  return m;
}
async function detail(code, us) {
  let sym = us ? code : code + ".TW", d = await chart(sym);
  if (!us && (!d || !(d.timestamp || []).length)) { sym = code + ".TWO"; d = await chart(sym); }
  if (!d || !(d.timestamp || []).length) throw new Error("no data");
  const etf = d.meta.instrumentType === "ETF" || /^00/.test(code);
  const estP = etf ? Promise.resolve(null) : estimates(sym); // ETF 沒有分析師預估，不用抓（分析頁很大）
  const tz = us ? "America/New_York" : "Asia/Taipei", q = d.indicators.quote[0], ts = d.timestamp;
  const adj = d.indicators.adjclose[0].adjclose;
  const bars = ts.map((t, i) => [ymd(t, tz), rp(q.open[i]), rp(q.high[i]), rp(q.low[i]), rp(q.close[i]), q.volume[i] || 0]).filter(b => b.slice(1, 5).every(v => v != null));
  // 還原 K 線：開高低收都乘上「還原收盤 ÷ 收盤」（除權息、分割都還原）
  const fixed = ts.map((t, i) => { const c = q.close[i], a = adj[i]; if ([q.open[i], q.high[i], q.low[i], c, a].some(v => v == null) || !c) return null; const f = a / c;
    if (!us && !(q.volume[i] > 0) && q.high[i] === q.low[i]) return null; // 台股休市日的假 K 棒（量 0、高低一樣）
    return [ymd(t, tz), rp(q.open[i] * f), rp(q.high[i] * f), rp(q.low[i] * f), rp(a), q.volume[i] || 0]; }).filter(Boolean);
  let divs = Object.values((d.events || {}).dividends || {}).sort((a, b) => a.date - b.date).map(v => [ymd(v.date, tz), rp(v.amount), ""]);
  // 發放日：台股用 FinMind 股利政策（除息日、發放日、金額）；美股用 Nasdaq 的配息紀錄對上除息日
  try {
    if (!us) {
      const j = await (await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockDividend&data_id=${code}&start_date=${new Date().getUTCFullYear() - 6}-01-01`)).json();
      const fm = (j.data || []).filter(x => x.CashExDividendTradingDate && (x.CashEarningsDistribution + x.CashStatutorySurplus) > 0)
        .map(x => [x.CashExDividendTradingDate, rp(x.CashEarningsDistribution + x.CashStatutorySurplus), x.CashDividendPaymentDate || ""]).sort();
      if (fm.length) divs = fm;
    } else {
      const j = await (await get(`https://api.nasdaq.com/api/quote/${code}/dividends?assetclass=stocks`, { headers: { Accept: "application/json" } })).json();
      const iso = s => s && s.includes("/") ? `${s.slice(6)}-${s.slice(0, 2)}-${s.slice(3, 5)}` : "";
      const pay = Object.fromEntries((((j.data || {}).dividends || {}).rows || []).map(r => [iso(r.exOrEffDate), iso(r.paymentDate)]));
      divs = divs.map(([dt, a]) => [dt, a, pay[dt] || ""]);
    }
  } catch (_) {}
  // 日線有時還沒有今天那根：用今天的 5 分 K 補上（開盤取第一根，高低量用報價資料）
  try {
    const td = (await (await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`)).json()).chart.result[0];
    const m = td.meta, day = ymd(m.regularMarketTime, tz), o = (td.indicators.quote[0].open || []).find(v => v != null);
    if (fixed.length && day > fixed[fixed.length - 1][0] && o != null && m.regularMarketPrice)
      fixed.push([day, rp(o), rp(m.regularMarketDayHigh), rp(m.regularMarketDayLow), rp(m.regularMarketPrice), m.regularMarketVolume || 0]);
  } catch (_) {}
  // 台股：Yahoo 日線偶爾缺最近幾天（整天都是空的），用 FinMind 日資料補，今天再用即時報價補
  if (!us && fixed.length) {
    try {
      const from = fixed[fixed.length - 1][0];
      const j = await (await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${code}&start_date=${from}`)).json();
      for (const x of (j.data || []).sort((a, b) => a.date < b.date ? -1 : 1))
        if (x.date > fixed[fixed.length - 1][0] && x.close > 0) fixed.push([x.date, x.open, x.max, x.min, x.close, x.Trading_Volume || 0]);
    } catch (_) {}
    try {
      const lv = (await twLive([code]))[code];
      if (lv && lv.o != null && lv.date >= fixed[fixed.length - 1][0]) {
        const bar = [lv.date, lv.o, lv.h ?? lv.last, lv.l ?? lv.last, lv.last, lv.v];
        if (lv.date === fixed[fixed.length - 1][0]) fixed[fixed.length - 1] = bar; else fixed.push(bar);
      }
    } catch (_) {}
  }
  const out = { sym, cur: d.meta.currency, kline: fixed, divs, eps: null, epsKind: null, ttm: null };
  // 月收盤（河流圖用）
  const month = {};
  bars.forEach(b => { month[b[0].slice(0, 7)] = [b[0], b[4]]; });
  const monthly = Object.values(month);
  // 近四季 EPS 序列 [[生效日, ttm]]
  let ttmSeries = [];
  const sumLast4 = qs => qs.map((x, i) => i < 3 ? null : [x[0], Math.round(qs.slice(i - 3, i + 1).reduce((a, y) => a + y[1], 0) * 100) / 100]).filter(Boolean);
  if (!us) {
    let qs = await twEps(code);
    if (!qs) { const y = await yahooSeries(sym, "quarterlyDilutedEPS").catch(() => ({})); qs = y.quarterlyDilutedEPS || []; }
    out.eps = qs.slice(-12); out.epsKind = "季"; out.epsQ = qs.slice(-20);
    ttmSeries = sumLast4(qs);
  } else {
    const y = await yahooSeries(sym, "annualDilutedEPS,trailingDilutedEPS,quarterlyDilutedEPS", true).catch(() => ({}));
    const ann = (y.annualDilutedEPS || []).map(([dt, v]) => [dt, Math.round(v * 100) / 100]);
    const last = ann.length ? ann[ann.length - 1][0] : "";
    const tr = (y.trailingDilutedEPS || []).filter(x => x[0] > last).map(([dt, v]) => [dt, Math.round(v * 100) / 100]);
    out.eps = ann; out.epsKind = "年"; out.epsQ = (y.quarterlyDilutedEPS || []).map(([dt, v]) => [dt, Math.round(v * 100) / 100]);
    ttmSeries = [...ann, ...tr];
  }
  // 今年／明年本益比 = 現在股價 ÷ 法人預估 EPS
  const est = await estP, price = (fixed.length && bars.length && fixed[fixed.length - 1][0] > bars[bars.length - 1][0]) ? fixed[fixed.length - 1][4] : bars[bars.length - 1][4];
  if (est) { for (const k of ["y0", "y1"]) if (est[k]) est[k].pe = est[k].avg > 0 ? Math.round(price / est[k].avg * 10) / 10 : null; est.price = price; out.est = est;
    // 台股「去年 EPS」用實際四季加總
    const ly = String(new Date(Date.now() + 8 * 3600e3).getUTCFullYear() - 1), lq = !us && (out.epsQ || []).filter(q => q[0].startsWith(ly));
    if (est.y0 && lq && lq.length === 4) est.y0.prev = Math.round(lq.reduce((a, q) => a + q[1], 0) * 100) / 100; }
  // 法人預估或 EPS 一時抓不到：標記 __partial，cached() 不會把缺資料的結果存 1 小時（Luna：很多檔點進去沒有便宜／合理區間）
  if (!etf && (est === undefined || !ttmSeries.length)) out.__partial = 1;
  if (ttmSeries.length) {
    out.ttm = ttmSeries[ttmSeries.length - 1][1];
    const last = bars[bars.length - 1][4];
    out.pe = out.ttm > 0 ? Math.round(last / out.ttm * 10) / 10 : null;
    // 河流圖（近 3 年）：每個月用當時最新的近四季 EPS，倍數取這段期間本益比的 10%～90%
    // 近 5 年本益比平均：每個月收盤 ÷ 當時近四季 EPS；平均 ±1 個標準差當「便宜／昂貴」的分界
    const b5 = pe5Band(monthly, ttmSeries); if (b5) out.pe5 = b5;
    else { const k = await keptVal(code, us); if (k && k.avg > 0) out.pe5 = { avg: k.avg, lo: k.lo, hi: k.hi, months: k.months }; } // 這次沒算出來就用保留一季的
    const pts = monthly.slice(-37).map(([dt, c]) => { const e = [...ttmSeries].reverse().find(x => x[0] <= dt); return e ? [dt.slice(0, 7), c, e[1]] : null; }).filter(Boolean);
    const pes = pts.filter(p => p[2] > 0).map(p => p[1] / p[2]).sort((a, b) => a - b);
    if (pes.length >= 6 && out.ttm > 0) {
      const at = f => pes[Math.min(pes.length - 1, Math.floor(f * (pes.length - 1)))];
      const lo = at(0.1), hi = at(0.9), step = (hi - lo) / 4;
      out.river = { months: pts.map(p => p[0]), price: pts.map(p => p[1]), eps: pts.map(p => p[2]),
        mult: [0, 1, 2, 3, 4].map(i => Math.round((lo + step * i) * 10) / 10) };
    }
  }
  // 股價淨值比：台股用 FinMind 每天的 PBR（近 5 年），美股用 Yahoo 的 P/B；都用最新股價換算成「現在」的股淨比
  const pb = await pbBand(code, us, sym, bars, fixed.length ? fixed[fixed.length - 1][4] : bars[bars.length - 1][4]);
  if (pb) { delete pb.bps; out.pb = pb; }
  return out;
}

// 自選股的短線／長線訊號：日 KD 和週 KD（9,3,3），回傳今天和前一根的 K、D（判斷交叉用）
// 週 MACD(12,26,9)（Luna 2026-10-25：週 MACD 和月 MACD 一樣判斷）：bars 是 [高, 低, 收]
function wkMacd(bars) {
  if (bars.length < 30) return null;
  let e12 = bars[0][2], e26 = e12, dea = 0, dif = 0; const osc = [];
  bars.forEach((b, i) => { const c = b[2]; e12 += (c - e12) * 2 / 13; e26 += (c - e26) * 2 / 27; dif = e12 - e26; if (i) dea += (dif - dea) * 2 / 10; osc.push(dif - dea); });
  const r = v => +v.toPrecision(5);
  return { dif: r(dif), osc: r(osc.at(-1)), posc: r(osc.at(-2)) };
}
function kdLast2(bars, n = 9) {
  if (bars.length < n + 1) return null;
  let k = 50, dv = 50, prev = null;
  const ks = [], all = [], kd4 = []; let prev0 = null, g20 = 0;
  bars.forEach((b, i) => {
    const win = bars.slice(Math.max(0, i - n + 1), i + 1), H = Math.max(...win.map(x => x[0])), L = Math.min(...win.map(x => x[1]));
    const rsv = H === L ? 50 : (b[2] - L) / (H - L) * 100;
    if (i === bars.length - 1) prev = [k, dv];
    k = k * 2 / 3 + rsv / 3; dv = dv * 2 / 3 + k / 3;
    if (i >= bars.length - 3) ks.push(k);
    if (i >= bars.length - 25) all.push(k);
    if (i >= bars.length - 4) kd4.push([k, dv]);
    if (i >= bars.length - 20 && prev0 && prev0[0] <= prev0[1] && k > dv && Math.min(prev0[0], k) <= 20) g20++;
    prev0 = [k, dv];
  });
  const r = v => Math.round(v * 10) / 10;
  // ks：最近 3 根的 K（判斷鈍化：連 3 根 K≥80 或 ≤20）
  const out = { k: r(k), d: r(dv), pk: r(prev[0]), pd: r(prev[1]), ks: ks.map(r), g20 }; // g20：最近 20 根內 K 在 20 以下的金叉次數（二次金叉）
  // 最近 3 根內的交叉（之後 K 一直在 D 同一邊）：xc = [1 金叉／-1 死叉, 幾根前, 交叉時 K 的低點／高點]，讓訊號連續顯示 3 天（週）
  for (let a = 0; a < 3 && kd4.length >= a + 2; a++) {
    const [k1, d1] = kd4[kd4.length - 1 - a], [k0, d0] = kd4[kd4.length - 2 - a];
    const side = Math.sign(k1 - d1); if (!side) break;
    if (kd4.slice(kd4.length - a).some(([x, y]) => Math.sign(x - y) !== side)) break;
    if (Math.sign(k0 - d0) !== side) { out.xc = [side, a, r(side > 0 ? Math.min(k0, k1) : Math.max(k0, k1))]; break; }
  }
  // 背離：最近 5 根內最後一次「收盤創近 20 根新高（新低）」那根，K 比前一次高點（低點）那根的 K 低（高）→ dv = [1 頂背離／-1 底背離, 前一次的收盤, 前一次的 K]
  // 往回看 5 根：背離後股價通常先回落才出現死叉，只看最後一根的話「背離＋交叉」幾乎不會成立
  const cl = bars.map(b => b[2]), N = cl.length;
  const div = sgn => {
    for (let j = N - 1; j >= Math.max(24, N - 5); j--) {
      const w = cl.slice(j - 19, j + 1), c = cl[j], old = w.slice(0, 15), ex = sgn > 0 ? Math.max(...old) : Math.min(...old);
      if (!(sgn > 0 ? c >= Math.max(...w) && c > ex : c <= Math.min(...w) && c < ex)) continue;
      const ip = j - 19 + old.indexOf(ex), kj = all[all.length - (N - j)], kp = all[all.length - (N - ip)];
      if (kj == null || kp == null) return null;
      return sgn > 0 ? (kj < kp - 2 ? [1, ex, r(kp)] : null) : (kj > kp + 2 ? [-1, ex, r(kp)] : null); // 最近一次新高（低）沒背離就不算
    }
    return null;
  };
  const dvx = div(1) || div(-1); if (dvx) out.dv = dvx;
  return out;
}
// 天龍地虎（Luna 2026-11-01，和頁面 wdTL 同一套）：bars = [高, 低, 收]（Yahoo 日線是實際成交價）→ [龍, 虎]，沒有就是 null
// 龍＝最近一段 KD 黃金交叉（K>D，至少 2 根，正在進行的也算）的最高價且比現價高；那個高點是近 250 根最高（創新高）→ 沒有龍，虎＝這波前面那段死叉的最低點
// 其他情況虎＝最近一個比現價低、前後 3 根都沒有更低的轉折低點
function tlDay(bars) {
  const n = bars.length; if (n < 20) return null;
  const K = [], D = []; let k = 50, d = 50;
  bars.forEach((b, i) => { let H = -Infinity, L = Infinity; for (let j = Math.max(0, i - 8); j <= i; j++) { H = Math.max(H, bars[j][0]); L = Math.min(L, bars[j][1]); }
    const rsv = H === L ? 50 : (b[2] - L) / (H - L) * 100; k = k * 2 / 3 + rsv / 3; d = d * 2 / 3 + k / 3; K.push(k); D.push(d); });
  const c = bars[n - 1][2]; let dr = null, tg = null, ws = -1;
  for (let e = n - 1; e >= 0 && dr == null;) { const up = K[e] > D[e]; let s = e; while (s > 0 && (K[s - 1] > D[s - 1]) === up) s--;
    if (up && e > s) { // 至少 2 根；只有今天 1 根剛金叉的不算（Luna 2026-11-08 對照 2330）
    let b = s; for (let i = s; i <= e; i++) if (bars[i][0] > bars[b][0]) b = i; if (bars[b][0] > c) { dr = bars[b][0]; ws = s; } }
    e = s - 1; }
  if (dr != null) { let hi = 0; for (let i = Math.max(0, n - 250); i < n; i++) hi = Math.max(hi, bars[i][0]);
    if (dr >= hi) { dr = null; if (ws > 0) { const e = ws - 1; let s = e; while (s > 0 && !(K[s - 1] > D[s - 1])) s--; let lo = Infinity; for (let i = s; i <= e; i++) lo = Math.min(lo, bars[i][1]); if (lo < c) tg = lo; } } }
  for (let i = n - 4; i >= 3 && tg == null; i--) { const l = bars[i][1]; if (l >= c) continue; let ok = 1; for (let j = i - 3; j <= i + 3 && ok; j++) { if (j === i) continue; const x = bars[j][1]; if (x < l || (j > i && x === l)) ok = 0; } if (ok) tg = l; }
  const r = v => v == null ? null : Math.round(v * 100) / 100;
  return [r(dr), r(tg)];
}
// 短線過濾用：收盤在 20 日均線上／下、MACD 柱（正＝趨勢偏多）、最後一天量 ÷ 前 5 天平均量
function dayExtras(cl, vol) {
  const n = cl.length; if (n < 35) return {};
  const ma20 = cl.slice(-20).reduce((a, b) => a + b, 0) / 20;
  let e12 = cl[0], e26 = cl[0], dea = 0;
  cl.forEach((c, i) => { e12 += (c - e12) * 2 / 13; e26 += (c - e26) * 2 / 27; if (i) dea += (e12 - e26 - dea) * 2 / 10; });
  const ma10 = cl.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const out = { above20: cl[n - 1] >= ma20 ? 1 : 0, above10: cl[n - 1] >= ma10 ? 1 : 0, dn: cl[n - 1] < cl[n - 2] ? 1 : 0, osc: Math.round((e12 - e26 - dea) * 1000) / 1000 };
  if (vol && vol.length === n) { const p5 = vol.slice(-6, -1), a = p5.reduce((x, y) => x + y, 0) / 5; if (a > 0 && vol[n - 1] > 0) out.vr = Math.round(vol[n - 1] / a * 100) / 100; }
  return out;
}
async function kdList(list) {
  // 台股：Yahoo 日線慢 20 分鐘、偶爾缺最近幾天，用奇摩即時報價補今天那根（和畫面上的股價一致）
  const live = await twLive(list.filter(x => !x[1]).map(x => x[0])).catch(() => ({}));
  const one = async ([code, us]) => {
    for (const sym of us ? [code] : [code + ".TW", code + ".TWO"]) {
      try {
        const r = (await (await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`)).json()).chart.result[0];
        const q = r.indicators.quote[0], ts = r.timestamp || []; if (!ts.length) continue;
        const rows = [], weeks = new Map();
        ts.forEach((t, i) => {
          const b = [q.high[i], q.low[i], q.close[i]]; if (b.some(v => v == null)) return;
          // 台股休市日 Yahoo 會補一根量 0、高低收都一樣的假 K 棒（例如 10/23），不算進 KD
          if (!us && !(q.volume[i] > 0) && b[0] === b[1]) return;
          rows.push([ymdOff(t, 8), ...b, q.volume[i] || 0]);
        });
        const lv = !us && live[code];
        if (lv && lv.h != null && lv.l != null && rows.length) {
          const lb = rows[rows.length - 1];
          if (lv.date === lb[0]) rows[rows.length - 1] = [lb[0], lv.h, lv.l, lv.last, lb[4]];
          else if (lv.date > lb[0]) rows.push([lv.date, lv.h, lv.l, lv.last, 0]);
        }
        const day = rows.map(x => x.slice(1, 4)), vol = rows.map(x => x[4]);
        rows.forEach(([dt, ...b]) => {
          const d = new Date(dt + "T00:00:00Z"), wd = (d.getUTCDay() + 6) % 7;
          const mon = new Date(d.getTime() - wd * 864e5).toISOString().slice(0, 10);
          const w = weeks.get(mon); if (!w) weeks.set(mon, b.slice(0, 3)); else { w[0] = Math.max(w[0], b[0]); w[1] = Math.min(w[1], b[1]); w[2] = b[2]; }
        });
        const wk = [...weeks.keys()].sort().map(k => weeks.get(k));
        // 盤中今天的量還沒算完，不拿來比
        const reg = ((r.meta || {}).currentTradingPeriod || {}).regular, now = Date.now() / 1000;
        const open = reg && now >= reg.start && now < reg.end && ts[ts.length - 1] >= reg.start;
        return [code, { day: { ...kdLast2(day), ...dayExtras(day.map(b => b[2]), open ? null : vol), tl: tlDay(day), hi: Math.max(...day.map(b => b[0])) }, week: { ...kdLast2(wk), mac: wkMacd(wk) } }];
      } catch (_) {}
    }
    return [code, null];
  };
  return Object.fromEntries((await Promise.all(list.map(one))).filter(x => x[1]));
}

// 月 MACD（Luna 2026-10-24）：月線 MACD(12,26,9) 柱子、5 月線、10 月線，給「日KD／週KD／月MACD」三格和總結論用
function monthMacd(cl) {
  const n = cl.length; if (n < 12) return null;
  let e12 = cl[0], e26 = cl[0], dea = 0; const osc = []; let dif = 0;
  cl.forEach((c, i) => { e12 += (c - e12) * 2 / 13; e26 += (c - e26) * 2 / 27; if (i) dea += (e12 - e26 - dea) * 2 / 10; osc.push(e12 - e26 - dea); dif = e12 - e26; });
  const ma = (k, e = 0) => n - e < k ? null : cl.slice(n - e - k, n - e).reduce((a, b) => a + b, 0) / k, r = v => v == null ? null : +v.toPrecision(5);
  // 8 階段表（Luna 2026-10-24）另外要：60 月線、上個月的 5／10 月線（看均線往上）、前 11 個月最高收盤（創高）、
  // 上上個月柱子（翻紅）、背離 bd：近 3 個月內收盤創 12 個月新高，但那個月的 MACD 柱比前 12 個月最高的柱子低
  let bd = 0;
  for (let j = n - 1; j >= Math.max(12, n - 3); j--) {
    const pc = cl.slice(j - 12, j), po = osc.slice(j - 12, j);
    if (cl[j] >= Math.max(...pc) && osc[j] < Math.max(...po)) { bd = 1; break; }
  }
  // dif：DIF 快線，月 MACD 多空用 0 軸分（Luna 2026-10-25）
  return { dif: r(dif), osc: r(osc[n - 1]), posc: r(osc[n - 2]), pposc: r(osc[n - 3]), c: r(cl[n - 1]), ma5: r(ma(5)), ma10: r(ma(10)), ma60: r(ma(60)),
    pma5: r(ma(5, 1)), pma10: r(ma(10, 1)), hi: r(Math.max(...cl.slice(Math.max(0, n - 12), n - 1))), bd };
}
async function monthOne(sym) {
  if (sym === "^TWOII") { // Yahoo 沒有櫃買指數的月線，用 FinMind 日線取每月最後一天
    const j = await (await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=TPEx&start_date=${new Date().getUTCFullYear() - 10}-01-01`)).json();
    const m = new Map(); for (const x of j.data || []) if (x.close > 0) m.set(x.date.slice(0, 7), x.close);
    return monthMacd([...m.keys()].sort().map(k => m.get(k)));
  }
  if (/-TWD$/.test(sym)) { // MAX 日 K 合成月線（每月最後一天的收盤）
    const m = new Map(); for (const b of await maxDaily(sym)) m.set(b[0].slice(0, 7), b[4]);
    return monthMacd([...m.keys()].sort().map(k => m.get(k)));
  }
  if (/-USDT$/.test(sym)) {
    // Cloudflare 有些機房連不到幣安，連不到就改用 Yahoo 的 BTC-USD、ETH-USD 月線（K 線頁也是這樣備援）
    try {
      const j = await (await get(`https://data-api.binance.vision/api/v3/klines?symbol=${bnSym(sym)}&interval=1M&limit=120&timeZone=8`)).json();
      if (Array.isArray(j) && j.length) return monthMacd(j.map(x => +x[4]));
    } catch (_) {}
    sym = ixSym(sym);
  }
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10y&interval=1mo`, { headers: { "User-Agent": UA } });
      if (!r.ok) continue;
      const res = (await r.json()).chart?.result?.[0]; if (!res) return null;
      // Yahoo 月線最後常多一列「這個月到今天」（和這個月重複），用台灣時間的年月去重，留最後一筆；用還原收盤，和 K 線圖一樣
      const cl = res.indicators.adjclose?.[0]?.adjclose || res.indicators.quote[0].close || [], m = new Map();
      (res.timestamp || []).forEach((t, i) => { if (cl[i] != null) m.set(new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 7), cl[i]); });
      return monthMacd([...m.keys()].sort().map(k => m.get(k)));
    } catch (_) {}
  }
  return null;
}
async function monthList(tw, us, ks) {
  const ixs = { twii: "^TWII", txf: "^TWII", txfn: "^TWII", otc: "^TWOII", 2330: "2330.TW" };
  const jobs = [...tw.map(c => [c, async () => (await monthOne(c + ".TW")) || monthOne(c + ".TWO")]), ...us.map(c => [c, () => monthOne(c)]),
    ...ks.map(k => [k, () => monthOne(ixs[k] || ixSym(k) && (/-USDT$|-TWD$/.test(k) ? k : ixSym(k)))])];
  const got = await Promise.all(jobs.map(([c, f]) => f().then(v => [c, v], () => [c, null])));
  return Object.fromEntries(got.filter(x => x[1]));
}

// ───── 大盤高低指標：台股本益比、大盤融資維持率（Luna 2026-10-24：盤後更新就好）─────
// 本益比：證交所每日收盤行情 MI_INDEX 各股本益比，用市值加權（Σ市值 ÷ Σ獲利，虧損股不計）；市值＝收盤價 × 發行股數
// 發行股數（千股）取自證交所 t187ap03_L（2026-10-24），股數很少變，整份太大不在這裡每天抓
const TW_SHARES = {"1101":7523182,"1102":3546563,"1103":832875,"1104":686682,"1108":404738,"1109":341159,"1110":572001,"1201":506063,"1203":240000,"1210":894767,"1213":56623,"1215":294790,"1216":5682015,"1217":494513,"1218":499999,"1219":341238,"1220":177078,"1225":242268,"1227":915090,"1229":1831880,"1231":328300,"1232":159975,"1233":90592,"1234":401871,"1235":188578,"1236":86674,"1256":35781,"1301":6365741,"1303":7930822,"1304":1188764,"1305":581050,"1307":397818,"1308":593744,"1309":397587,"1310":527870,"1312":1506620,"1313":1330846,"1314":3784850,"1315":99099,"1316":401646,"1319":591477,"1321":227228,"1323":91275,"1324":75122,"1325":85281,"1326":5861186,"1337":268955,"1338":83840,"1339":74124,"1340":152923,"1341":52851,"1342":78501,"1402":5352875,"1409":1618409,"1410":62000,"1413":132112,"1414":198000,"1416":185342,"1417":189942,"1418":56834,"1419":300041,"1423":99648,"1432":108000,"1434":1684665,"1435":139780,"1436":194152,"1437":201871,"1438":120102,"1439":92000,"1440":1656816,"1441":61744,"1442":366211,"1443":135343,"1444":995595,"1445":130666,"1446":137710,"1447":910071,"1449":127115,"1451":198000,"1452":132641,"1453":116640,"1454":129834,"1455":531688,"1456":93720,"1457":316730,"1459":268972,"1460":694643,"1463":173268,"1464":425576,"1465":103607,"1466":111157,"1467":233625,"1468":160405,"1470":85767,"1471":150415,"1472":52488,"1473":146154,"1474":129897,"1475":66017,"1476":274367,"1477":246694,"1503":520972,"1504":2376441,"1506":300389,"1512":98183,"1513":503113,"1514":278571,"1515":181474,"1516":30008,"1517":220000,"1519":347469,"1521":76230,"1522":312898,"1524":165310,"1525":73400,"1526":60000,"1527":138571,"1528":191331,"1529":202850,"1530":103108,"1531":182108,"1532":422604,"1533":98547,"1535":123743,"1536":278960,"1537":82063,"1538":32300,"1539":65370,"1540":85474,"1541":78800,"1558":64536,"1560":150289,"1563":169206,"1568":103087,"1582":144269,"1583":119246,"1587":80056,"1589":153136,"1590":200000,"1597":89262,"1598":179142,"1603":191688,"1604":384200,"1605":4431333,"1608":632774,"1609":785262,"1611":322736,"1612":316080,"1614":269113,"1615":198630,"1616":194149,"1617":169515,"1618":192692,"1623":66000,"1626":149822,"1702":294133,"1707":148137,"1708":249002,"1709":477016,"1710":885703,"1711":547752,"1712":420493,"1713":150952,"1714":991825,"1717":1184245,"1718":1685906,"1720":196566,"1721":184884,"1722":980000,"1723":236904,"1725":181830,"1726":162000,"1727":128020,"1730":63234,"1731":132915,"1732":42444,"1733":99950,"1734":201609,"1735":99388,"1736":303395,"1737":200000,"1752":100988,"1760":85739,"1762":76918,"1773":300000,"1776":60107,"1783":89698,"1786":74828,"1789":790739,"1795":270035,"1802":2908061,"1805":134970,"1806":390404,"1808":714425,"1809":167042,"1810":302304,"1817":72600,"1903":260039,"1904":1108275,"1905":1102835,"1906":151000,"1907":1660371,"1909":1327686,"2002":15734861,"2006":730214,"2007":530652,"2008":190852,"2009":359622,"2010":647655,"2012":302163,"2013":200000,"2014":1435544,"2015":581599,"2017":446875,"2020":267031,"2022":337168,"2023":1821240,"2024":97500,"2025":172661,"2027":2584261,"2028":325715,"2029":321180,"2030":280526,"2031":321146,"2032":130522,"2033":120000,"2034":528996,"2038":194134,"2049":353792,"2059":95297,"2062":199994,"2069":166387,"2072":192000,"2101":733935,"2102":473329,"2103":825710,"2104":984734,"2105":3241416,"2106":954890,"2107":303593,"2108":492417,"2109":279349,"2114":77992,"2115":104373,"2201":1070001,"2204":553620,"2206":773676,"2207":557103,"2208":1274539,"2211":417091,"2227":300000,"2228":79780,"2231":135932,"2233":60289,"2236":63517,"2237":128886,"2239":117713,"2241":104602,"2243":77374,"2247":80711,"2248":47600,"2250":36388,"2254":63908,"2258":1751267,"2301":2316108,"2302":166303,"2303":12570094,"2305":205661,"2308":2597543,"2312":1505953,"2313":1233821,"2314":108596,"2316":182741,"2317":14075746,"2321":16555,"2323":980413,"2324":4407147,"2327":2063128,"2328":518346,"2329":658948,"2330":25932370,"2331":557403,"2332":602163,"2337":1981857,"2338":370349,"2340":438623,"2342":157335,"2344":4500000,"2345":561118,"2347":1667947,"2348":159486,"2349":693680,"2351":193734,"2352":1580507,"2353":3047854,"2354":1414485,"2355":397495,"2356":3587475,"2357":742760,"2359":171471,"2360":425246,"2362":622263,"2363":514988,"2364":57628,"2365":221528,"2367":706253,"2368":530595,"2369":380102,"2371":2150835,"2373":236203,"2374":337977,"2375":108675,"2376":669889,"2377":844856,"2379":515513,"2380":60000,"2382":4107627,"2383":358321,"2385":765721,"2387":195251,"2388":555956,"2390":192619,"2392":512327,"2393":443393,"2395":869046,"2397":114489,"2399":178100,"2401":591995,"2402":307537,"2404":190587,"2405":343427,"2406":350906,"2408":3450206,"2409":7547099,"2412":7757447,"2413":127359,"2414":161736,"2415":100000,"2417":157219,"2419":321317,"2420":152649,"2421":286944,"2423":145047,"2424":59585,"2425":96499,"2426":300622,"2427":198000,"2428":128113,"2429":86100,"2430":116800,"2431":80714,"2432":61860,"2433":144496,"2434":37000,"2436":204178,"2438":71196,"2439":248641,"2440":139117,"2441":568846,"2442":347227,"2444":106570,"2449":1283882,"2450":258253,"2451":431346,"2453":100000,"2454":1604953,"2455":186983,"2457":424772,"2458":303880,"2459":105596,"2460":169200,"2461":190294,"2462":150784,"2464":227369,"2465":93946,"2466":173459,"2467":161514,"2468":69961,"2471":47254,"2472":164735,"2474":538821,"2476":219070,"2477":158573,"2478":144731,"2480":106360,"2481":382115,"2482":77883,"2483":107890,"2484":159421,"2485":317689,"2486":240483,"2488":79999,"2489":610000,"2491":82008,"2492":485205,"2493":126797,"2495":273552,"2496":20055,"2497":130888,"2498":836097,"2501":1159561,"2504":1180000,"2505":380000,"2506":387000,"2509":224551,"2511":1623326,"2514":394729,"2515":1688460,"2516":226278,"2520":609487,"2524":366185,"2527":270306,"2528":501590,"2530":841256,"2534":474228,"2535":270794,"2536":332809,"2537":300558,"2538":445025,"2539":1455585,"2540":944874,"2542":2153084,"2543":528542,"2545":379735,"2546":146187,"2547":1035095,"2548":335705,"2597":310716,"2601":690379,"2603":2165043,"2605":585353,"2606":845056,"2607":533571,"2608":467000,"2609":3492104,"2610":6144989,"2611":189002,"2612":197485,"2613":148423,"2614":327265,"2615":2806146,"2616":137282,"2617":417294,"2618":5400444,"2630":209438,"2633":5628293,"2634":941867,"2636":141835,"2637":746409,"2642":95467,"2645":374571,"2646":3008735,"2701":449968,"2702":156613,"2704":366923,"2705":191313,"2706":499998,"2707":127403,"2712":105000,"2722":143170,"2723":180000,"2727":82940,"2731":93278,"2739":91526,"2748":105779,"2753":69977,"2762":112500,"2801":12060197,"2812":6425075,"2816":223608,"2820":1342960,"2832":253540,"2834":10398326,"2836":1858316,"2838":4607829,"2845":4923425,"2849":1957609,"2850":315963,"2851":800389,"2852":301164,"2855":1601414,"2880":14056135,"2881":14007365,"2882":14669210,"2883":16974612,"2884":17723510,"2885":13864396,"2886":14833378,"2887":25115062,"2889":3665902,"2890":14782169,"2891":19675933,"2892":14379469,"2897":2805358,"2901":73043,"2903":1416941,"2904":77834,"2905":1110372,"2906":209117,"2908":509888,"2910":175403,"2911":105126,"2912":1039622,"2913":790000,"2915":1104319,"2923":1740297,"2929":109494,"2939":45549,"2945":67500,"3002":102000,"3003":155655,"3004":64383,"3005":624570,"3006":298128,"3008":130798,"3010":259437,"3011":129566,"3013":213344,"3014":165954,"3015":187262,"3016":293257,"3017":392670,"3018":75378,"3019":279244,"3021":94683,"3022":176598,"3023":240069,"3024":277157,"3025":56736,"3026":165890,"3027":129160,"3028":237241,"3029":167005,"3030":236216,"3031":173203,"3032":113286,"3033":516559,"3034":611511,"3035":260550,"3036":1345563,"3037":1641292,"3038":157408,"3040":66225,"3041":142097,"3042":342993,"3043":38976,"3044":525606,"3045":3723431,"3046":78448,"3047":224762,"3048":269830,"3049":802011,"3050":154984,"3051":167000,"3052":233246,"3054":80651,"3055":114975,"3056":480555,"3057":67865,"3058":201723,"3059":307668,"3060":137563,"3062":330082,"3090":287567,"3092":106649,"3094":83117,"3130":33191,"3135":97159,"3138":56392,"3149":286234,"3150":44377,"3164":86010,"3167":89513,"3168":75100,"3189":526910,"3209":247161,"3229":64263,"3231":3429842,"3257":79824,"3266":352314,"3296":96724,"3305":143374,"3308":60000,"3311":100000,"3312":182627,"3321":86114,"3338":87908,"3346":121228,"3356":68550,"3376":195780,"3380":541718,"3406":112743,"3413":110924,"3416":84518,"3419":120480,"3432":42230,"3437":144548,"3443":134012,"3447":77449,"3450":145681,"3481":7989197,"3494":94800,"3501":118258,"3504":114060,"3515":123521,"3518":102467,"3528":66639,"3530":77476,"3532":387848,"3533":112535,"3535":79052,"3543":146263,"3545":222411,"3550":107550,"3557":84315,"3563":63961,"3576":1627795,"3583":83859,"3588":61991,"3591":130387,"3592":75855,"3593":60825,"3596":220354,"3605":175270,"3607":121662,"3617":94762,"3622":151328,"3645":136754,"3652":75098,"3653":147204,"3661":86305,"3665":199578,"3669":92920,"3673":406664,"3679":63022,"3686":76495,"3694":154891,"3701":236669,"3702":1751374,"3703":823216,"3704":415445,"3705":266423,"3706":1459934,"3708":89843,"3711":4470572,"3712":246242,"3714":400000,"3715":283575,"3716":150579,"3717":210948,"4104":188367,"4106":100912,"4108":198619,"4119":119509,"4133":60554,"4137":82492,"4142":429508,"4148":67236,"4155":125187,"4164":195664,"4169":66432,"4178":215905,"4190":61267,"4195":80000,"4306":676757,"4414":263796,"4426":172677,"4438":113425,"4439":38215,"4440":67598,"4441":68176,"4526":254826,"4532":494895,"4536":90820,"4540":115187,"4545":77000,"4551":115222,"4552":116000,"4555":69988,"4557":47972,"4560":68097,"4562":87546,"4564":232788,"4566":110381,"4569":30600,"4571":53017,"4572":40019,"4576":119802,"4581":33899,"4582":75480,"4583":80171,"4585":104609,"4588":42985,"4590":54838,"4720":114516,"4722":103765,"4736":103578,"4737":77398,"4739":124651,"4746":120256,"4755":100706,"4763":989147,"4764":91542,"4766":120571,"4770":79976,"4771":58709,"4807":48996,"4904":3607705,"4906":451706,"4912":66953,"4915":471881,"4916":124083,"4919":452398,"4927":264938,"4930":80000,"4934":225000,"4935":128864,"4938":2675709,"4942":142368,"4943":126694,"4949":67752,"4952":108816,"4956":100408,"4958":1133397,"4960":571705,"4961":121254,"4967":98566,"4968":92210,"4976":141218,"4977":90990,"4989":172776,"4994":66383,"4999":74417,"5007":294940,"5203":77343,"5215":64338,"5222":100108,"5225":79136,"5234":102716,"5236":60004,"5243":168529,"5244":68242,"5258":110365,"5269":74156,"5283":101617,"5284":55143,"5285":102041,"5288":69885,"5292":46319,"5306":126001,"5388":304343,"5434":194008,"5469":486166,"5471":167877,"5484":66801,"5515":201600,"5519":230157,"5521":492280,"5522":781596,"5525":318105,"5531":977589,"5533":285245,"5534":315326,"5538":201203,"5546":82353,"5607":370553,"5608":389276,"5706":83768,"5871":1745650,"5876":4910219,"5880":16072960,"5906":37528,"5907":195531,"6005":2455297,"6024":266683,"6108":108146,"6112":188357,"6115":187662,"6116":2858655,"6117":92587,"6120":599000,"6128":127589,"6133":117006,"6136":115536,"6139":235576,"6141":113354,"6142":304207,"6152":167738,"6153":636178,"6155":88024,"6164":80000,"6165":77753,"6166":217779,"6168":205762,"6176":348770,"6177":472371,"6183":150000,"6184":158231,"6189":263826,"6191":499303,"6192":96156,"6196":220330,"6197":123439,"6201":89200,"6202":230388,"6205":82236,"6206":143062,"6209":181888,"6213":363597,"6214":272243,"6215":83530,"6216":97420,"6224":85645,"6225":60000,"6226":115535,"6230":86343,"6235":199906,"6239":759147,"6243":45269,"6257":483912,"6269":323831,"6271":209058,"6272":81764,"6277":119471,"6278":292398,"6281":99173,"6282":856101,"6283":147581,"6285":483441,"6405":65800,"6409":88254,"6412":400769,"6414":151315,"6415":390363,"6416":73348,"6426":38509,"6431":97399,"6438":82206,"6442":81818,"6443":512797,"6446":422435,"6449":91878,"6451":117854,"6456":337940,"6464":133933,"6467":59909,"6472":128019,"6477":123787,"6491":78000,"6504":72600,"6505":9525960,"6515":36445,"6525":129047,"6526":167506,"6531":163149,"6533":50651,"6534":102800,"6541":265216,"6550":464846,"6552":83000,"6558":93789,"6573":80499,"6579":169451,"6581":111271,"6582":106174,"6585":72134,"6589":302068,"6591":41122,"6592":641845,"6598":102819,"6605":165816,"6606":110304,"6614":80661,"6625":57972,"6641":36500,"6645":60864,"6655":80572,"6657":89749,"6658":38370,"6666":47388,"6668":107116,"6669":560200,"6670":139387,"6671":60750,"6672":82312,"6674":68222,"6689":68000,"6691":133547,"6695":106948,"6698":66390,"6706":78549,"6715":68274,"6719":105517,"6722":88400,"6742":71268,"6743":150000,"6753":117254,"6754":66000,"6756":69990,"6757":459530,"6768":200095,"6770":4712081,"6771":31180,"6776":91581,"6781":85419,"6782":63000,"6789":318413,"6790":267129,"6792":47875,"6794":63637,"6796":40234,"6799":43652,"6805":68554,"6807":54000,"6830":54414,"6831":67500,"6834":88471,"6835":66172,"6838":150977,"6854":117679,"6861":41599,"6862":50000,"6863":74888,"6869":137830,"6873":142649,"6885":133099,"6887":74206,"6890":250297,"6901":853950,"6902":35550,"6906":33537,"6908":37180,"6909":67488,"6914":79471,"6916":67500,"6918":34571,"6919":1557201,"6921":32262,"6923":90439,"6924":20624,"6928":86000,"6931":66152,"6933":42572,"6934":36130,"6936":72804,"6937":67655,"6944":99694,"6947":106126,"6949":1311601,"6951":52000,"6952":68345,"6955":30381,"6957":56945,"6958":421454,"6962":492397,"6965":156336,"6969":43857,"6988":47600,"6994":74162,"7610":58305,"7631":20142,"7689":58507,"7705":66067,"7711":71700,"7721":55370,"7722":71400,"7730":38637,"7732":64680,"7736":76000,"7740":60000,"7749":46486,"7750":71843,"7760":64548,"7765":40681,"7768":70065,"7769":179930,"7780":810024,"7786":175954,"7788":79746,"7791":80000,"7795":78828,"7799":158245,"7803":94413,"7812":64399,"7818":164946,"7821":121913,"7822":45561,"7823":33491,"7827":140887,"7835":46544,"7855":277305,"8011":165922,"8016":120137,"8021":147088,"8028":183550,"8033":164630,"8039":263804,"8045":95042,"8046":646165,"8070":725648,"8072":80000,"8081":86172,"8101":52166,"8103":78437,"8104":104058,"8105":441545,"8110":517740,"8112":565293,"8114":76488,"8131":442222,"8150":704523,"8162":68702,"8163":280000,"8201":62366,"8210":125619,"8213":271242,"8215":320675,"8222":68574,"8249":137824,"8261":118878,"8271":129614,"8341":130000,"8367":92172,"8374":112250,"8404":419934,"8411":221139,"8422":1358763,"8429":185747,"8438":69943,"8442":70170,"8443":66800,"8454":264975,"8462":80380,"8463":150000,"8464":293020,"8466":79446,"8467":48374,"8473":182307,"8476":166226,"8478":93972,"8481":66602,"8482":107444,"8487":26535,"8488":73500,"8499":41166,"8908":324765,"8926":830282,"8940":67491,"8996":93502,"9103":549411,"910322":5620600,"9105":10450003,"910861":1673607,"9110":907680,"911608":480000,"911622":596749,"911868":2094465,"912000":2362546,"9136":1200008,"9802":200992,"9902":98050,"9904":2946787,"9905":305000,"9906":91143,"9907":1579145,"9908":516358,"9910":987483,"9911":222332,"9912":53793,"9914":298984,"9917":473757,"9918":180537,"9919":195363,"9921":392065,"9924":150762,"9925":387490,"9926":179504,"9927":120000,"9928":70725,"9929":101280,"9930":248540,"9931":120369,"9933":962012,"9934":411017,"9935":177839,"9937":309043,"9938":297964,"9939":295786,"9940":736846,"9941":587149,"9942":83161,"9943":125172,"9944":105908,"9945":2844225,"9946":326554,"9955":104425,"9958":266897};
const twseGet = async u => { const r = await get("https://www.twse.com.tw/rwd/zh/" + u); return r.json(); };
const fnum = s => { const v = parseFloat(String(s).replace(/,/g, "")); return isFinite(v) ? v : null; };
async function twseRecent(build) { // 從今天往回找最近一個有資料的交易日
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + 8 * 3600e3 - i * 864e5).toISOString().slice(0, 10), w = new Date(d + "T00:00:00Z").getUTCDay();
    if (w === 0 || w === 6) continue;
    const v = await build(d); if (v) return v;
  }
  throw new Error("no data");
}
async function dayClose(d) {
  const key = new Request(`https://close.cache/${d}`), hit = await caches.default.match(key).catch(() => null);
  if (hit) return hit.json();
  const mi = await twseGet(`afterTrading/MI_INDEX?response=json&date=${d.replace(/-/g, "")}&type=ALLBUT0999`);
  if (mi.stat !== "OK") return null;
  const tab = (mi.tables || []).find(x => (x.fields || []).includes("收盤價") && x.fields.includes("本益比")); if (!tab) return null;
  const ic = tab.fields.indexOf("收盤價"), ip = tab.fields.indexOf("本益比"), close = {}; let cap = 0, earn = 0;
  for (const r of tab.data) {
    const c = r[0].trim(), px = fnum(r[ic]), pe = fnum(r[ip]); if (!px) continue;
    close[c] = px; const n = TW_SHARES[c];
    if (pe > 0 && n) { cap += px * n; earn += px * n / pe; }
  }
  const out = { close, pe: earn ? Math.round(cap / earn * 100) / 100 : null };
  await caches.default.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "max-age=172800" } })).catch(() => {});
  return out;
}
// ───── 止跌訊號（Luna 2026-11-04）：6 個指標，都用證交所盤後資料 ─────
// 加權指數日 K（MI_5MINS_HIST）＋成交金額（FMTQIK）每月一份；漲跌／跌停家數（MI_INDEX MS）、融資餘額（MI_MARGN MS）、外資買賣超（BFI82U）每天一份
const rocD = s => { const [y, m, d] = String(s).trim().split("/"); return `${+y + 1911}-${m}-${d}`; };
async function twseMonth(path, ym) { // ym=YYYYMM；過去的月份快取 30 天，這個月 3 小時
  const key = new Request(`https://stopm.cache/v1/${path.replace(/\W/g, "_")}/${ym}`), hit = await caches.default.match(key).catch(() => null);
  if (hit) return hit.json();
  const j = await twseGet(`${path}?response=json&date=${ym}01`); if (j.stat !== "OK") return [];
  const cur = ym === twDay().slice(0, 7).replace("-", "");
  await caches.default.put(key, new Response(JSON.stringify(j.data || []), { headers: { "Cache-Control": `max-age=${cur ? 10800 : 2592000}` } })).catch(() => {});
  return j.data || [];
}
async function stopDay(d) { // 一天的漲跌家數、跌停、融資餘額（億）、外資（億）；三樣都有才長期快取
  const key = new Request(`https://stopd.cache/v2/${d}`), hit = await caches.default.match(key).catch(() => null);
  if (hit) return hit.json();
  const ds = d.replace(/-/g, ""), o = { d };
  const [mi, mg, fi] = await Promise.all([
    twseGet(`afterTrading/MI_INDEX?response=json&date=${ds}&type=MS`).catch(() => null),
    twseGet(`marginTrading/MI_MARGN?date=${ds}&selectType=MS&response=json`).catch(() => null),
    twseGet(`fund/BFI82U?response=json&type=day&dayDate=${ds}`).catch(() => null)]);
  const pc = s => { const m = String(s).replace(/,/g, "").match(/(\d+)\((\d+)\)/); return m ? [+m[1], +m[2]] : null; };
  const t = mi && mi.stat === "OK" && (mi.tables || []).find(x => /漲跌證券數/.test(x.title || ""));
  if (t) { const col = Math.max(1, t.fields.indexOf("股票")), up = t.data.find(r => /上漲/.test(r[0])), dn = t.data.find(r => /下跌/.test(r[0]));
    const u = up && pc(up[col]), w = dn && pc(dn[col]); if (u && w) { o.up = u[0]; o.lu = u[1]; o.dn = w[0]; o.ld = w[1]; } }
  const s = mg && mg.stat === "OK" && (mg.tables || []).find(x => (x.fields || [])[0] === "項目");
  const row = s && s.data.find(r => String(r[0]).startsWith("融資金額")); if (row) o.mg = Math.round(fnum(row[5]) / 1e5); // 仟元 → 億
  if (fi && fi.stat === "OK") { const v = Object.fromEntries(fi.data.map(r => [r[0], num(r[3]) || 0])); o.fx = Math.round(((v["外資及陸資(不含外資自營商)"] || 0) + (v["外資自營商"] || 0)) / 1e6) / 100; }
  const full = o.up != null && o.mg != null && o.fx != null;
  await caches.default.put(key, new Response(JSON.stringify(o), { headers: { "Cache-Control": `max-age=${full ? 2592000 : 1800}` } })).catch(() => {});
  return o;
}
// 融資減幅 vs 大盤跌幅（Luna 2026-11-06）：證交所融資金額（億）和加權指數收盤，比近 5 天、近 20 天、從一年高點以來的變化
async function mgDay(d) {
  const key = new Request(`https://mgd.cache/v1/${d}`), hit = await caches.default.match(key).catch(() => null);
  if (hit) return hit.json();
  const mg = await twseGet(`marginTrading/MI_MARGN?date=${d.replace(/-/g, "")}&selectType=MS&response=json`).catch(() => null), o = { d };
  const s = mg && mg.stat === "OK" && (mg.tables || []).find(x => (x.fields || [])[0] === "項目");
  const row = s && s.data.find(r => String(r[0]).startsWith("融資金額")); if (row) o.mg = Math.round(fnum(row[5]) / 1e5);
  await caches.default.put(key, new Response(JSON.stringify(o), { headers: { "Cache-Control": `max-age=${o.mg ? 2592000 : 1800}` } })).catch(() => {});
  return o;
}
async function mgCmp() {
  let r = null;
  for (const host of ["query1", "query2"]) {
    try { const j = await (await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/%5ETWII?range=1y&interval=1d`, { headers: { "User-Agent": UA } })).json(); r = j.chart.result[0]; if (r) break; } catch (_) {}
  }
  if (!r) throw new Error("no index");
  const q = r.indicators.quote[0], K = [];
  (r.timestamp || []).forEach((t, i) => { if (q.close[i] != null) K.push([new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 10), q.close[i]]); });
  let L = -1, mL = null;
  for (let i = K.length - 1; i >= K.length - 5 && i >= 0; i--) { const m = await mgDay(K[i][0]); if (m.mg) { L = i; mL = m.mg; break; } }
  if (L < 0) throw new Error("no margin");
  let p = 0; for (let i = 0; i <= L; i++) if (K[i][1] >= K[p][1]) p = i;
  const win = [["近 5 天", L - 5], ["近 20 天", L - 20], ["從高點", p]].filter(w => w[1] >= 0 && w[1] < L);
  const ms = await Promise.all(win.map(w => mgDay(K[w[1]][0])));
  const r1 = v => Math.round(v * 10) / 10;
  return { d: K[L][0], mg: mL, ix: Math.round(K[L][1]), rows: win.map((w, i) => ms[i].mg ? { k: w[0], d0: K[w[1]][0], ix0: Math.round(K[w[1]][1]), mg0: ms[i].mg, ixp: r1((K[L][1] / K[w[1]][1] - 1) * 100), mgp: r1((mL / ms[i].mg - 1) * 100) } : null).filter(Boolean) };
}
async function stopSig() {
  const now = twDay(), ms = [2, 1, 0].map(b => { const x = new Date(now + "T00:00:00Z"); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() - b); return x.toISOString().slice(0, 7).replace("-", ""); });
  const [px, vo] = await Promise.all([Promise.all(ms.map(m => twseMonth("TAIEX/MI_5MINS_HIST", m))), Promise.all(ms.map(m => twseMonth("afterTrading/FMTQIK", m)))]);
  const amt = {}; for (const r of vo.flat()) amt[rocD(r[0])] = fnum(r[2]) / 1e8;
  const K = px.flat().map(r => ({ d: rocD(r[0]), o: fnum(r[1]), h: fnum(r[2]), l: fnum(r[3]), c: fnum(r[4]), v: amt[rocD(r[0])] })).filter(x => x.c && x.v);
  if (K.length < 31) throw new Error("not enough days");
  const n = K.length, last = K[n - 1], C = K.map(x => x.c), ma = k => C.slice(n - k).reduce((a, b) => a + b, 0) / k, mn = (a, b) => Math.min(...K.slice(a, b).map(x => x.l));
  const days = await Promise.all(K.slice(n - 6).map(x => stopDay(x.d)));
  const S = [];
  // 1 低點不再破底：近 10 天最低沒有跌破前 20 天的最低；近 5 天最低比再前 5 天高＝低點墊高
  { const l10 = mn(n - 10, n), lp = mn(n - 30, n - 10), up5 = mn(n - 5, n) > mn(n - 10, n - 5);
    S.push({ k: "低點不再破底", ok: l10 > lp, v: `近 10 天最低 ${Math.round(l10)}，前 20 天最低 ${Math.round(lp)}`, r: l10 > lp ? (up5 ? "守住前低，低點墊高" : "守住前低") : "又跌破前低" }); }
  // 2 成交量：下跌時量縮，或近 5 天出現爆量長紅而且沒有再破低
  { const a20 = K.slice(n - 25, n - 5).reduce((s, x) => s + x.v, 0) / 20, a5 = K.slice(n - 5).reduce((s, x) => s + x.v, 0) / 5;
    let red = null, black = null; for (let i = n - 5; i < n; i++) { const ch = K[i].c / K[i - 1].c - 1; if (K[i].v >= a20 * 1.5) { if (ch >= 0.015) red = K[i]; if (ch <= -0.015) black = K[i]; } }
    const redOk = red && mn(K.indexOf(red) + 1 || n, n + 1) >= red.l, fall = last.c < K[n - 11].c, shrink = fall && a5 < a20 * 0.8;
    const ok = !!((red && (K.indexOf(red) === n - 1 || redOk)) || shrink);
    S.push({ k: "成交量", ok, v: `近 5 天平均 ${Math.round(a5).toLocaleString()} 億，前 20 天 ${Math.round(a20).toLocaleString()} 億`, r: red ? (ok ? "爆量長紅，沒有再破低" : "爆量長紅後又破低") : black ? "爆量長黑，賣壓還在" : shrink ? "下跌量縮，賣壓變小" : fall ? "還沒量縮" : "量能正常" }); }
  // 3 融資餘額：最近 5 個交易日減少 2% 以上
  { const a = days[0].mg, b = days[5].mg, ch = a && b ? (b / a - 1) * 100 : null;
    S.push({ k: "融資餘額下降", ok: ch != null && ch <= -2, v: b ? `${b.toLocaleString()} 億（5 天前 ${a.toLocaleString()} 億，${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%）` : "還沒公布", r: ch == null ? "資料還沒出來" : ch <= -2 ? "明顯下降，槓桿減少" : ch < 0 ? "小幅下降" : "沒有下降" }); }
  // 4 跌停家數：今天跌停比前 5 天最多的那天少一半以上，而且下跌家數沒有比上漲多很多
  { const td = days[5], pk = Math.max(...days.slice(0, 5).map(x => x.ld || 0)), ok = td.ld != null && td.ld <= Math.max(3, pk / 2) && td.dn <= td.up * 1.5;
    S.push({ k: "跌停家數減少", ok, v: td.ld != null ? `今天跌停 ${td.ld} 家（前 5 天最多 ${pk} 家），上漲 ${td.up}、下跌 ${td.dn}` : "還沒公布", r: td.ld == null ? "資料還沒出來" : ok ? "恐慌降溫" : "賣壓還很大" }); }
  // 5 外資：今天買超，或近 3 天賣超比前 3 天少
  { const f = days.map(x => x.fx), a = f.slice(0, 3).reduce((s, x) => s + (x || 0), 0), b = f.slice(3).reduce((s, x) => s + (x || 0), 0), t = f[5];
    const ok = t != null && (t > 0 || (a < 0 && b > a * 0.5));
    S.push({ k: "外資賣超收斂", ok, v: `近 3 天 ${b >= 0 ? "+" : ""}${b.toFixed(0)} 億，前 3 天 ${a >= 0 ? "+" : ""}${a.toFixed(0)} 億`, r: t == null ? "資料還沒出來" : t > 0 ? "今天轉買超" : ok ? "賣超縮小" : "還在大賣" }); }
  // 6 站回均線：收盤在 5 日、10 日、月線（20 日）之上
  { const m5 = ma(5), m10 = ma(10), m20 = ma(20), c = last.c, on = [c >= m5, c >= m10, c >= m20];
    S.push({ k: "站回重要均線", ok: on[0] && on[1] && on[2], v: `收盤 ${Math.round(c)}；5 日 ${Math.round(m5)}、10 日 ${Math.round(m10)}、月線 ${Math.round(m20)}`, r: on[2] ? (on[0] && on[1] ? "站上 5、10 日線和月線" : "在月線上，短線還沒站回") : on[0] && on[1] ? "站回 5、10 日線，還沒回月線" : on[0] ? "站回 5 日線" : "還在均線下面" }); }
  return { d: last.d, c: last.c, s: S, days };
}

async function marketPe() { return twseRecent(async d => { const x = await dayClose(d); return x && x.pe ? { pe: [[d, x.pe]] } : null; }); }
// 融資維持率 ＝ Σ(各股融資餘額張數 × 1000 × 收盤價) ÷ 融資金額餘額；證交所晚上 9 點多才公布當天的融資
// 指定那一天的大盤融資維持率（%）：上市＋上櫃合計（和財經 M 平方「上市櫃融資維持率」同口徑，Luna 2026-11-07）
// ＝ Σ(每檔融資餘額張數 × 1000 × 收盤價) ÷ 融資金額
async function tpexMg(d) {
  const ds = d.replace(/-/g, "/"), H = { headers: { "User-Agent": UA } };
  const [mb, cl] = await Promise.all([
    fetch(`https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${ds}&response=json`, H).then(r => r.json()),
    fetch(`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${ds}&type=EW&response=json`, H).then(r => r.json())]);
  const t = (mb.tables || [])[0], c = (cl.tables || [])[0]; if (!t || !c || !(t.data || []).length || !(c.data || []).length) return null;
  const px = {}; for (const r of c.data) { const v = fnum(r[2]); if (v) px[r[0].trim()] = v; }
  let val = 0, etf = 0; for (const r of t.data) { const c = r[0].trim(), n = fnum(r[6]), p = px[c]; if (n && p) { val += n * 1000 * p; if (/^0/.test(c)) etf += n * 1000 * p; } }
  const row = (t.summary || []).find(r => /融資金/.test(r[1] || "")), amt = row ? fnum(row[6]) * 1000 : 0;
  return amt ? { val, amt, etf } : null;
}
async function marginAt(d) {
    const [mm, tp] = await Promise.all([twseGet(`marginTrading/MI_MARGN?response=json&selectType=ALL&date=${d.replace(/-/g, "")}`), tpexMg(d).catch(() => null)]);
    if (mm.stat !== "OK") return null;
    // 上櫃網站有時擋 Cloudflare（Luna 2026-11-09 看到停在 10/22 的 176）：抓不到就先只算上市，不要整個沒資料
    const tq = tp || { val: 0, amt: 0, etf: 0 };
    const sum = (mm.tables || []).find(x => (x.fields || [])[0] === "項目"), det = (mm.tables || []).find(x => (x.fields || [])[0] === "代號");
    const row = sum && sum.data.find(r => String(r[0]).startsWith("融資金額")); if (!row || !det) return null;
    const x = await dayClose(d); if (!x) return null;
    let val = 0, etf = 0; for (const r of det.data) { const c = r[0].trim(), n = fnum(r[6]); if (n && x.close[c]) { val += n * 1000 * x.close[c]; if (/^0/.test(c)) etf += n * 1000 * x.close[c]; } }
    const amt = fnum(row[5]) * 1000; if (!amt) return null;
    // 扣除 ETF（Luna 2026-11-08）：證交所只公布融資總金額，ETF 借的錢用「ETF 融資市值 × 6 成（融資成數）」估算後扣掉
    const E = etf + tq.etf, V = val + tq.val, A = amt + tq.amt, r2 = v => Math.round(v * 10000) / 100;
    return { all: r2(V / A), ex: r2((V - E) / (A - E * 0.6)), ...(tp ? {} : { tw: 1 }) };
}
// 國安基金進場那天：加權指數收盤＋融資維持率；兩樣都有就快取 30 天，之後不再變
async function nsfDay(d) {
  const key = new Request(`https://nsf.cache/v2/${d}`), hit = await caches.default.match(key).catch(() => null);
  if (hit) return hit.json();
  const o = { d };
  try { const r = (await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?range=1mo&interval=1d`, { headers: { "User-Agent": UA } })).json()).chart.result[0], q = r.indicators.quote[0];
    (r.timestamp || []).forEach((t, i) => { if (new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 10) === d && q.close[i] != null) o.c = Math.round(q.close[i] * 100) / 100; }); } catch (_) {}
  const m = await marginAt(d).catch(() => null); o.mt = m ? m.all : null;
  if (o.c != null && o.mt != null) await caches.default.put(key, new Response(JSON.stringify(o), { headers: { "Cache-Control": "max-age=2592000" } })).catch(() => {});
  return o;
}
async function marginRatio() {
  return twseRecent(async d => { const v = await marginAt(d); return v ? { margin: [[d, v.all]], marginEx: [[d, v.ex]], ...(v.tw ? { mgTw: 1 } : {}) } : null; });
}

// 同一個網址在 sec 秒內大家共用同一份結果
// 大盤 K 線：加權、櫃買用 FinMind（成交量用成交金額），台指期用 FinMind 近月合約（日盤、量最大的那一個月），美股指數用 Yahoo
async function indexKline(key, part = 0) {
  const ymd5 = `${new Date().getUTCFullYear() - 5}-01-01`;
  if (key === "twii" || key === "otc") {
    const j = await (await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${key === "twii" ? "TAIEX" : "TPEx"}&start_date=${ymd5}`)).json();
    const k = (j.data || []).filter(x => x.close > 0).map(x => [x.date, x.open, x.max, x.min, x.close, x.Trading_money]);
    if (!k.length) throw new Error("no data");
    return { kline: k, volUnit: "money" };
  }
  if (key === "txfn") {
    const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10), p = Math.min(2, Math.max(0, part | 0)), from = day((p + 1) * 243 - 1);
    const j = await (await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${day((p + 1) * 243 + 9)}&end_date=${day(p * 243 - 10)}`)).json();
    const to = p ? day(p * 243 - 1) : "9999", k = txNightBars(j.data).filter(b => b[0] >= from && b[0] < to);
    if (!k.length) throw new Error("no data");
    return { kline: k, volUnit: "lots" };
  }
  if (key === "txf") {
    // 期貨資料很大（每天十幾個合約），分三段各 8 個月，網頁同時抓三段再接起來，每段計算量才不會超過上限
    const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10), p = Math.min(2, Math.max(0, part | 0));
    const j = await (await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${day((p + 1) * 243 - 1)}&end_date=${day(p * 243)}`)).json();
    const best = {};
    for (const x of j.data || []) {
      if (x.trading_session !== "position" || !/^\d{6}$/.test(x.contract_date) || !(x.close > 0)) continue;
      const b = best[x.date]; if (!b || x.volume > b.volume) best[x.date] = x;
    }
    const k = Object.keys(best).sort().map(d => { const x = best[d]; return [d, x.open, x.max, x.min, x.close, x.volume]; });
    if (!k.length) throw new Error("no data");
    return { kline: k, volUnit: "lots" };
  }
  if (key === "2330") {
    const d = await chart("2330.TW"); if (!d || !(d.timestamp || []).length) throw new Error("no data");
    const q = d.indicators.quote[0];
    const k = d.timestamp.map((t, i) => [ymd(t, "Asia/Taipei"), rp(q.open[i]), rp(q.high[i]), rp(q.low[i]), rp(q.close[i]), q.volume[i] || 0]).filter(b => b.slice(1, 5).every(v => v != null));
    return { kline: k, volUnit: "twshares" };
  }
  if (/-TWD$/.test(key)) return { kline: await maxDaily(key), volUnit: "shares" };
  if (/-USDT$/.test(key)) {
    const k = await bnDaily(key).catch(() => null);
    if (k && k.length) return { kline: k, volUnit: "shares" };
  }
  if (/^\^?[A-Z0-9]{2,6}$|^[A-Z]{3,6}=X$|^[A-Z]{2}=F$|-USDT$/.test(key)) {
    const d = await chart(ixSym(key)); if (!d || !(d.timestamp || []).length) throw new Error("no data");
    const q = d.indicators.quote[0], n = fxScale(key), f = v => v == null ? null : rp(v * n);
    const k = d.timestamp.map((t, i) => [ymd(t, ixTz(ixSym(key))), f(q.open[i]), f(q.high[i]), f(q.low[i]), f(q.close[i]), q.volume[i] || 0]).filter(b => b.slice(1, 5).every(v => v != null));
    return { kline: k, volUnit: "shares" };
  }
  throw new Error("bad key");
}

// 幣安日 K（台灣時間換日，最近 1000 天）：[日期, 開, 高, 低, 收, 量]
async function bnDaily(key) {
  const j = await (await get(`https://data-api.binance.vision/api/v3/klines?symbol=${bnSym(key)}&interval=1d&limit=1000&timeZone=8`)).json();
  return j.map(x => [ymd(x[0] / 1000, "Asia/Taipei"), rp(+x[1]), rp(+x[2]), rp(+x[3]), rp(+x[4]), Math.round(+x[5])]);
}
// 大盤的短線（日 KD）、長線（週 KD）：用上面的日 K，台股三個再接上今天盤中的最新價
async function indexKd(keys) {
  const y1 = `${new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10)}`;
  const one = async key => {
    try {
      let k; // [[日期, 高, 低, 收]]，近一年就夠算 KD
      if (key === "otc") {
        const j = await (await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=TPEx&start_date=${y1}`)).json();
        k = (j.data || []).filter(x => x.close > 0).map(x => [x.date, x.max, x.min, x.close, x.Trading_money || 0]);
      } else if (key === "txfn") {
        const j = await (await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${new Date(Date.now() - 220 * 864e5).toISOString().slice(0, 10)}`)).json();
        k = txNightBars(j.data).map(b => [b[0], b[2], b[3], b[4], b[5]]);
      } else if (key === "txf") {
        const j = await (await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${new Date(Date.now() - 220 * 864e5).toISOString().slice(0, 10)}`)).json();
        const best = {};
        for (const x of j.data || []) {
          if (x.trading_session !== "position" || !/^\d{6}$/.test(x.contract_date) || !(x.close > 0)) continue;
          const b = best[x.date]; if (!b || x.volume > b.volume) best[x.date] = x;
        }
        k = Object.keys(best).sort().map(d => [d, best[d].max, best[d].min, best[d].close, best[d].volume || 0]);
      } else if (/-TWD$/.test(key)) {
        k = (await maxDaily(key)).slice(-400).map(b => [b[0], b[2], b[3], b[4], b[5]]);
      } else if (/-USDT$/.test(key) && (k = await bnDaily(key).catch(() => null)) && k.length) {
        k = k.slice(-400).map(b => [b[0], b[2], b[3], b[4], b[5]]);
      } else {
        const sym = key === "twii" ? "^TWII" : key === "2330" ? "2330.TW" : ixSym(key), tz = ixTz(sym);
        const r = (await (await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`)).json()).chart.result[0];
        const q = r.indicators.quote[0];
        k = (r.timestamp || []).map((t, i) => [ymd(t, tz), q.high[i], q.low[i], q.close[i], q.volume[i] || 0]).filter(b => b.slice(0, 4).every(v => v != null));
      }
      if (key === "otc" || key === "txf" || key === "txfn") { // 這幾個的日 K 只到昨天，接上今天盤中（夜指期接最近一段夜盤）
        const live = await (key === "txf" ? txfAny() : key === "txfn" ? wtx().then(txfNight) : yahooTw("^TWOII", "")).catch(() => null);
        if (live && live.pts.length && k.length && live.date > k[k.length - 1][0]) {
          const v = live.pts.map(p => p[1]);
          k.push([live.date, Math.max(...v), Math.min(...v), v[v.length - 1], 0]);
        }
      }
      if (!k.length) return [key, null];
      const weeks = new Map();
      for (const b of k) {
        const d = new Date(b[0] + "T00:00:00Z"), wd = (d.getUTCDay() + 6) % 7;
        const mon = new Date(d.getTime() - wd * 864e5).toISOString().slice(0, 10);
        const w = weeks.get(mon); if (!w) weeks.set(mon, b.slice(1)); else { w[0] = Math.max(w[0], b[1]); w[1] = Math.min(w[1], b[2]); w[2] = b[3]; }
      }
      const vl = k.map(b => b[4]), hasV = vl[vl.length - 1] > 0;
      return [key, { day: { ...kdLast2(k.map(b => b.slice(1, 4))), ...dayExtras(k.map(b => b[3]), hasV ? vl : null), tl: tlDay(k.map(b => b.slice(1, 4))), hi: Math.max(...k.slice(-245).map(b => b[1])) }, week: (wb => ({ ...kdLast2(wb), mac: wkMacd(wb) }))([...weeks.keys()].sort().map(x => weeks.get(x))) }];
    } catch (_) { return [key, null]; }
  };
  return Object.fromEntries((await Promise.all(keys.map(one))).filter(x => x[1]));
}

// 另外留一份 3 天的備份：資料來源一時抓不到時，先給上一次成功的結果，不讓畫面空白
async function cached(request, ctx, sec, make) {
  const cache = caches.default, key = new Request(request.url);
  // 備份不分 v 版本：換新版時也能先用舊版的完整資料
  const u = new URL(request.url); u.searchParams.delete("v"); u.searchParams.set("__backup", "1");
  const backupKey = new Request(u.toString());
  const u0 = new URL(request.url); u0.searchParams.set("__backup", "1");
  const backup = async () => (await cache.match(backupKey)) || (await cache.match(new Request(u0.toString()))); // 舊版的備份網址帶著 v
  const hit = await cache.match(key);
  if (hit) return hit;
  try {
    const data = await make(), partial = data && data.__partial;
    // 有資料來源一時沒抓到（__partial）：有完整的備份就先給備份，沒有就只快取 5 分鐘，也不蓋掉備份
    if (partial) {
      delete data.__partial;
      const old = await backup();
      if (old) return new Response(old.body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
      const res = new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" } });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }
    const body = JSON.stringify(data);
    const res = new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${sec}` } });
    ctx.waitUntil(cache.put(key, res.clone()));
    ctx.waitUntil(cache.put(backupKey, new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=259200" } })));
    return res;
  } catch (e) {
    const old = await backup();
    if (old) return new Response(old.body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
}

// 加入 iPhone 主畫面時的圖示（Luna 用 Gemini 做的金幣上升箭頭，180×180 PNG）
const ICON_PNG = "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";

// 使用人數：每台手機／電腦第一次打開時給一個隨機編號，同一天同一個編號只算 1 位
// 存在 Cloudflare 的 Durable Object（免費方案就有，不用另外設定）
export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS visit (day TEXT, vid TEXT, PRIMARY KEY (day, vid))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS person (vid TEXT PRIMARY KEY, first TEXT)");
  }
  hit(vid, day) {
    if (vid) {
      this.sql.exec("INSERT OR IGNORE INTO visit VALUES (?, ?)", day, vid);
      this.sql.exec("INSERT OR IGNORE INTO person VALUES (?, ?)", vid, day);
    }
    const one = q => this.sql.exec(q, day).one().n;
    return { today: one("SELECT COUNT(*) AS n FROM visit WHERE day = ?"), total: 10000 + this.sql.exec("SELECT COUNT(*) AS n FROM person").one().n }; // Luna：累計從 10000 開始往上加
  }
}

// 一年股利收入（Luna 2026-10-23）：近兩年多的每一次現金股利 [除息日, 每股金額, 發放日]
// 台股用 FinMind 股利政策（含已公布還沒除息的）；美股用 Nasdaq 配息紀錄（ETF 和個股網址不同，兩個都試）
async function divYear(code, us) {
  const y0 = new Date().getUTCFullYear() - 2;
  try {
    if (!us) {
      let j = null;
      try { j = await (await get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockDividend&data_id=${code}&start_date=${y0}-01-01`)).json(); } catch (_) {}
      // FinMind 一次抓太多檔會被限流（Luna 的 00878 沒出現）：改用 Yahoo 月線的配息紀錄（只有已除息的，沒有預告）
      if (!j || !Array.isArray(j.data) || !j.data.length) return await divYahoo(code, y0);
      const divs = j.data.filter(x => x.CashExDividendTradingDate && (x.CashEarningsDistribution + x.CashStatutorySurplus) > 0)
        .map(x => [x.CashExDividendTradingDate, rp(x.CashEarningsDistribution + x.CashStatutorySurplus), x.CashDividendPaymentDate || ""]).sort((a, b) => a[0] < b[0] ? -1 : 1);
      return { divs };
    }
    const iso = s => s && s.includes("/") ? `${s.slice(6)}-${s.slice(0, 2)}-${s.slice(3, 5)}` : "";
    for (const ac of ["etf", "stocks"]) {
      const j = await (await get(`https://api.nasdaq.com/api/quote/${code}/dividends?assetclass=${ac}`, { headers: { Accept: "application/json" } })).json();
      const rows = ((j.data || {}).dividends || {}).rows || [];
      if (rows.length) return { divs: rows.filter(r => r.type === "Cash" && iso(r.exOrEffDate) >= `${y0}-01-01`).map(r => [iso(r.exOrEffDate), rp(parseFloat(String(r.amount).replace(/[$,]/g, ""))), iso(r.paymentDate)]).filter(r => r[1] > 0).sort((a, b) => a[0] < b[0] ? -1 : 1) };
    }
    return { divs: [] };
  } catch (_) { return { divs: [], __partial: 1 }; }
}

async function divYahoo(code, y0) {
  for (const sfx of [".TW", ".TWO"]) for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${code}${sfx}?range=3y&interval=1mo&events=div`, { headers: { "User-Agent": UA } });
      if (!r.ok) continue;
      const res = ((await r.json()).chart || {}).result;
      if (!res || !res[0]) continue;
      const divs = Object.values((res[0].events || {}).dividends || {}).map(v => [ymd(v.date, "Asia/Taipei"), rp(v.amount), ""]).filter(v => v[0] >= `${y0}-01-01` && v[1] > 0).sort((a, b) => a[0] < b[0] ? -1 : 1);
      return { divs, src: "yahoo" };
    } catch (_) {}
  }
  return { divs: [], __partial: 1 };
}

// ETF 成分股前十大（Luna 2026-10-23）：台股用 Yahoo 奇摩股市「持股」頁（每月更新），美股用 Yahoo Finance 的 holdings 頁
async function etfHold(code, us) {
  if (!us) {
    for (const sfx of [".TW", ".TWO"]) {
      let h;
      try { h = await (await get(`https://tw.stock.yahoo.com/quote/${code}${sfx}/holding`)).text(); } catch (_) { continue; }
      const i = h.indexOf('"holdingDetail":');
      if (i < 0) continue;
      const s = h.slice(i + 16, i + 16 + 4);
      if (s === "null") return { list: [] };
      const arr = JSON.parse(h.slice(i + 16, h.indexOf("]", i) + 1));
      return { date: (arr[0] && arr[0].date || "").replace(/\//g, "-"), list: arr.slice(0, 10).map(x => [String(x.ticker || "").replace(/\.TWO?$/, ""), x.name, parseFloat(x.weighting) || 0]) };
    }
    return { list: [], __partial: 1 };
  }
  const h = await (await get(`https://finance.yahoo.com/quote/${code}/holdings/`)).text();
  const i = h.indexOf('\\"holdings\\":[');
  if (i < 0) return { list: [], __partial: 1 };
  const seg = h.slice(i, h.indexOf("]", i)), list = [];
  for (const m of seg.matchAll(/\\"symbol\\":\\"([^\\"]*)\\",\\"holdingName\\":\\"((?:[^"\\]|\\\\.)*)\\",\\"holdingPercent\\":\{\\"raw\\":([\d.eE-]+)/g))
    list.push([m[1], m[2].replace(/\\\\(.)/g, "$1"), Math.round(parseFloat(m[3]) * 1e4) / 100]);
  return { list: list.slice(0, 10) };
}

// 個股融資維持率（估算，Luna 2026-11-01）：官方只公布每檔融資張數，沒有借款金額
// 用近 2 年每天融資買進張數 × 當天收盤累積成本，賣出、現金償還照平均成本扣掉；借款 = 成本 × 6 成（上櫃 5 成）
// 回傳 b 融資餘額（張）、loan 借款（張×元），網頁用即時股價 × b ÷ loan 算維持率
async function marginEst(code) {
  const st = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10), fm = ds => get(`https://api.finmindtrade.com/api/v4/data?dataset=${ds}&data_id=${code}&start_date=${st}`).then(r => r.json());
  const [m, p, inf] = await Promise.all([fm("TaiwanStockMarginPurchaseShortSale"), fm("TaiwanStockPrice"), get(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&data_id=${code}`).then(r => r.json()).catch(() => ({}))]);
  const px = {}; for (const x of p.data || []) if (x.close > 0) px[x.date] = x.close;
  const md = m.data || []; if (!md.length || !Object.keys(px).length) return { __partial: 1 };
  const it = (inf.data || []).slice(-1)[0], rate = it && it.type === "tpex" ? 0.5 : 0.6;
  let B = 0, C = 0, d = null, c = null, r = null;
  for (const x of md) {
    const k = px[x.date]; if (!k) continue;
    if (!B && !C) { B = x.MarginPurchaseTodayBalance; C = B * k; continue; }
    const red = x.MarginPurchaseSell + x.MarginPurchaseCashRepayment;
    if (B > 0) C -= C / B * Math.min(red, B);
    C += x.MarginPurchaseBuy * k; B = x.MarginPurchaseTodayBalance; if (B <= 0) C = 0;
    d = x.date; c = k;
  }
  if (!(B > 0 && C > 0)) return { b: 0 };
  return { b: B, loan: Math.round(C * rate * 100) / 100, d, c, r: Math.round(B * c / (C * rate) * 1000) / 10, rate };
}

// 公司買賣股票（Luna 2026-11-01，目前只看龍巖 5530、寶島科 5312）：Yahoo 奇摩股市「公告」裡的「取得／處分有價證券」重大訊息
// Yahoo 只留最近約一年（35 則左右），抓到的存在快取 400 天，舊的不會不見
const CORP_REQ = `{"requests":{"g0":{"resource":"ApacStreamService","operation":"read","params":{"ui":{"summary":true,"view":"mega"},"category":"CUSTOM:NEWS","cgParams":{"overrides":{"listAlias":"finance-TW-zh-Hant-TW-ticker-press-release","listId":"91953860-06f2-11eb-bfef-6f1d3995cd22","queryVariables":"{\\"tickerSymbol\\":[\\"5530.TW\\",\\"5530.TWO\\"]}"}},"releasesParams":{"limit":20,"offset":0},"ncpParams":{"query":{"adsSlotsEnabled":true,"id":"twfinance-partner-stream","namespace":"abu","version":"v1","listAlias":"finance-tw-zh-hant-tw-ticker-press-release","listId":"91953860-06f2-11eb-bfef-6f1d3995cd22","s":["5530.TW","5530.TWO"]}},"useNCP":true,"useCG":true,"useCGV2":true,"batches":{"pagination":true,"size":20,"timeout":1300,"total":170},"content_type":"qsp"}}},"context":{"feature":"useCG,useCGV2","intl":"tw","lang":"zh-Hant-TW","region":"TW","site":"finance","device":"desktop"}}`;
async function corpOne(code) {
  const ent = t => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/<[^>]+>/g, "");
  // 第一頁：Yahoo 公告頁本身（最近 20 則）；第二頁起用頁面給的「下一頁」接著抓
  const items = [], seen = new Set();
  let sym = code + ".TWO", h = await (await get(`https://tw.stock.yahoo.com/quote/${sym}/announcement`)).text();
  if (!/StretchedBox/.test(h)) { sym = code + ".TW"; h = await (await get(`https://tw.stock.yahoo.com/quote/${sym}/announcement`)).text(); }
  const re = /<h3 class="Mt\(0\) Mb\(8px\)"><a href="([^"]+)"[^>]*><u class="StretchedBox"><\/u>([^<]*)<\/a><\/h3><p[^>]*>([^<]*)<\/p>/g;
  let m; while ((m = re.exec(h))) { const title = ent(m[2]); if (seen.has(title + m[1])) continue; seen.add(title + m[1]); items.push({ id: m[1], title, summary: ent(m[3]), link: m[1] }); }
  const pm = h.match(/"pagination":\{"nextParams":\{"after":"([^"]+)"/);
  if (pm) {
    try {
      const b = JSON.parse(CORP_REQ.replaceAll("5530", code));
      b.requests.g0.params.ncpParams.body = { gqlVariables: { lightyearList: { pagination: { nextParams: { after: pm[1], first: 20 } } } } };
      const j = await (await get("https://tw.stock.yahoo.com/_td-stock/api/resource?intl=tw&lang=zh-Hant-TW&region=TW&site=finance&device=desktop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();
      for (const x of (j.g0 && j.g0.data && j.g0.data.stream_items) || []) if (x.title && x.summary) items.push({ id: x.link || x.id, title: x.title, summary: x.summary, link: x.link || x.url });
    } catch (_) {}
  }
  const g = (t, re) => { const m = t.match(re); return m ? m[1].trim() : null; };
  return items.filter(x => /(取得|處分)[^】]*有價證券/.test(x.title)).map(x => {
    const t = x.summary.replace(/\s+/g, " "), dm = t.match(/日\s*期[:：]\s*(\d{4})年(\d{2})月(\d{2})日/);
    return {
      id: x.id, d: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : "", act: /處分/.test(x.title) ? "賣" : "買", sum: /累積/.test(x.title) ? 1 : 0,
      name: g(t, /證券名稱[:：]\s*(.+?)\s*2\.\s*交易日期/), when: g(t, /交易日期[:：]\s*(.+?)\s*3\./),
      qty: g(t, /交易數量[:：]\s*([\d,，.]+\s*(?:股|張|單位)?)/), px: g(t, /每單位價格(?:\(元\))?[:：]\s*(.+?)\s*交易總金額/),
      amt: g(t, /交易總金額(?:\(元\))?[:：]\s*([^:：]+?)\s*6\./), pl: (g(t, /處分利益（或損失）（[^）]*）[:：]\s*(.+?)\s*7\./) || "").replace(/^處分(利益|損失)[:：]\s*/, "").replace(/[（(].*$/, "") || null,
      hold: g(t, /持有數量[:：]\s*([\d,，.]+\s*(?:股|張|單位)?)/), link: x.link,
    };
  });
}
async function corpTrades(codes) {
  const out = {}; let partial = false;
  for (const c of codes) {
    const key = new Request(`https://corp.cache/${c}`), cache = caches.default;
    let old = []; try { const r = await cache.match(key); if (r) old = await r.json(); } catch (_) {}
    let now = null; try { now = await corpOne(c); } catch (_) { partial = true; }
    const m = new Map(old.map(x => [x.id, x])); (now || []).forEach(x => m.set(x.id, x));
    const list = [...m.values()].sort((a, b) => a.d < b.d ? 1 : -1);
    if (now) await cache.put(key, new Response(JSON.stringify(list), { headers: { "Cache-Control": "public, max-age=34560000" } }));
    out[c] = list;
  }
  return partial ? { ...out, __partial: 1 } : out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/api/hit": {
        // ?id=隨機編號 → 記一次，回傳 { today, total }
        if (!env.COUNTER) return new Response("{}", { headers: { "Content-Type": "application/json" } });
        const id = (url.searchParams.get("id") || "").slice(0, 40).replace(/[^\w-]/g, "");
        const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
        try {
          const r = await env.COUNTER.get(env.COUNTER.idFromName("main")).hit(id, day);
          return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
        } catch (e) { return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { "Content-Type": "application/json" } }); }
      }
      case "/apple-touch-icon.png":
      case "/apple-touch-icon-precomposed.png":
        return new Response(Uint8Array.from(atob(ICON_PNG), c => c.charCodeAt(0)), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
      case "/api/idx": return cached(request, ctx, CACHE_SEC, build);
      case "/api/nav": return cached(request, ctx, CACHE_SEC, navTable);
      case "/api/divcal": return cached(request, ctx, 6 * 3600, divCal);
      case "/api/mkt": return cached(request, ctx, 1800, market);
      case "/api/bt": {
        // ?c=0050 或 ?us=VOO → 5 年含息還原日線（開高低收），6 小時內共用
        const c = url.searchParams.get("c") || "", u = url.searchParams.get("us") || "";
        if (/^[0-9A-Z]{4,7}$/.test(c)) return cached(request, ctx, 21600, () => btBars(c, false));
        if (/^[A-Z.]{1,6}$/.test(u)) return cached(request, ctx, 21600, () => btBars(u, true));
        return new Response("{}", { status: 400 });
      }
      case "/api/px": {
        // ?c=0050 或 ?us=VOO → 最近 3 個月每天的收盤價，30 分鐘內共用
        const c = url.searchParams.get("c") || "", u = url.searchParams.get("us") || "";
        if (/^[0-9A-Z]{4,7}$/.test(c)) return cached(request, ctx, 1800, () => closes(c, false));
        if (/^[A-Z.]{1,6}$/.test(u)) return cached(request, ctx, 1800, () => closes(u, true));
        return new Response("{}", { status: 400 });
      }
      case "/api/dd": return cached(request, ctx, 1800, ddHist); // 歷史跌幅（Luna 2026-11-06）
      case "/api/mgc": return cached(request, ctx, 3600, mgCmp); // 融資減幅 vs 大盤跌幅（Luna 2026-11-06）
      case "/api/nsf": { const d = url.searchParams.get("d") || ""; if (!/^\d{4}-\d\d-\d\d$/.test(d)) return new Response("{}", { status: 400 }); return cached(request, ctx, 1800, () => nsfDay(d)); }
      case "/api/stop": return cached(request, ctx, 3600, stopSig); // 止跌訊號（Luna 2026-11-04）
      case "/api/mval": {
        // ?k=pe 台股本益比、?k=mg 大盤融資維持率；盤後資料，3 小時內共用
        const k = url.searchParams.get("k");
        if (k === "pe") return cached(request, ctx, 10800, marketPe);
        if (k === "mg") return cached(request, ctx, 10800, marginRatio);
        return new Response("{}", { status: 400 });
      }
      case "/api/mk": {
        // ?c=2330&us=NVDA&k=twii,BTC-USDT → 每檔的月 MACD，最多 20 檔，1 小時內共用
        const tw = (url.searchParams.get("c") || "").split(",").filter(c => /^[0-9A-Z]{4,7}$/.test(c)).slice(0, 20);
        const us = (url.searchParams.get("us") || "").split(",").filter(c => /^[A-Z.]{1,6}$/.test(c)).slice(0, 20);
        const ks = (url.searchParams.get("k") || "").split(",").filter(k => IXKEY.test(k) || k === "txfn").slice(0, 20);
        return cached(request, ctx, 3600, () => monthList(tw, us, ks));
      }
      case "/api/quote": {
        // ?c=2330,00981A&us=TSM → 最多 40 檔
        const tw = (url.searchParams.get("c") || "").split(",").filter(c => /^[0-9A-Z]{4,7}$/.test(c)).slice(0, 40);
        const us = (url.searchParams.get("us") || "").split(",").filter(c => /^[A-Z.]{1,6}$/.test(c)).slice(0, 40);
        return cached(request, ctx, CACHE_SEC, () => quotes(tw, us));
      }
      case "/api/detail": {
        // ?c=2330 或 ?us=NVDA → 一檔的詳細資料，1 小時內共用
        const c = url.searchParams.get("c") || "", u = url.searchParams.get("us") || "";
        if (/^[0-9A-Z]{4,7}$/.test(c)) return cached(request, ctx, 3600, () => detail(c, false));
        if (/^[A-Z.]{1,6}$/.test(u)) return cached(request, ctx, 3600, () => detail(u, true));
        return new Response("{}", { status: 400 });
      }
      case "/api/val": {
        // ?c=2330 或 ?us=NVDA → 今年預估 EPS 和近 5 年本益比區間，變化很慢，1 天內共用（Luna 2026-10-23）
        const c = url.searchParams.get("c") || "", u = url.searchParams.get("us") || "";
        if (/^[0-9A-Z]{4,7}$/.test(c)) return cached(request, ctx, 86400, () => valuation(c, false));
        if (/^[A-Z.]{1,6}$/.test(u)) return cached(request, ctx, 86400, () => valuation(u, true));
        return new Response("{}", { status: 400 });
      }
      case "/api/divy": {
        // ?c=2330 或 ?us=NVDA → 近兩年多的現金股利，1 天內共用
        const c = url.searchParams.get("c") || "", u = url.searchParams.get("us") || "";
        if (/^[0-9A-Z]{4,7}$/.test(c)) return cached(request, ctx, 86400, () => divYear(c, false));
        if (/^[A-Z.]{1,6}$/.test(u)) return cached(request, ctx, 86400, () => divYear(u, true));
        return new Response("{}", { status: 400 });
      }
      case "/api/mgr": {
        // ?c=2330 → 融資維持率（估算）；融資資料每天晚上才公布，3 小時內共用
        const c = url.searchParams.get("c") || "";
        if (/^[0-9A-Z]{4,7}$/.test(c)) return cached(request, ctx, 10800, () => marginEst(c));
        return new Response("{}", { status: 400 });
      }
      case "/api/corp": {
        // ?c=5530,5312 → 公司自己買賣股票的公告，6 小時內共用
        const cs = (url.searchParams.get("c") || "").split(",").filter(c => /^[0-9A-Z]{4,7}$/.test(c)).slice(0, 5);
        return cached(request, ctx, 21600, () => corpTrades(cs));
      }
      case "/api/etfh": {
        // ?c=0050 或 ?us=SOXX → ETF 前十大成分股，1 天內共用
        const c = url.searchParams.get("c") || "", u = url.searchParams.get("us") || "";
        if (/^[0-9A-Z]{4,7}$/.test(c)) return cached(request, ctx, 86400, () => etfHold(c, false));
        if (/^[A-Z.]{1,6}$/.test(u)) return cached(request, ctx, 86400, () => etfHold(u, true));
        return new Response("{}", { status: 400 });
      }
      case "/api/ixk": {
        // ?k=twii | otc | txf | ^GSPC … → 大盤的日 K（1 小時內共用）
        const k = url.searchParams.get("k") || "";
        if (!IXKEY.test(k)) return new Response("{}", { status: 400 });
        return cached(request, ctx, 3600, () => indexKline(k, +(url.searchParams.get("p") || 0)));
      }
      case "/api/ixkd": {
        // ?k=twii,txf,otc,2330 → 大盤每一列的日 KD、週 KD，10 分鐘更新一次
        const ks = (url.searchParams.get("k") || "").split(",").filter(k => IXKEY.test(k)).slice(0, 12);
        return cached(request, ctx, 600, () => indexKd(ks));
      }
      case "/api/kd": {
        // ?c=2330,0050&us=NVDA → 每檔的日 KD、週 KD，最多 20 檔，10 分鐘更新一次
        const tw = (url.searchParams.get("c") || "").split(",").filter(c => /^[0-9A-Z]{4,7}$/.test(c));
        const us = (url.searchParams.get("us") || "").split(",").filter(c => /^[A-Z.]{1,6}$/.test(c));
        return cached(request, ctx, 600, () => kdList([...tw.map(c => [c, false]), ...us.map(c => [c, true])].slice(0, 20)));
      }
      case "/api/stk": {
        // ?c=2330,00981A&us=SOXX → 最多 6 檔
        const tw = (url.searchParams.get("c") || "").split(",").filter(c => /^[0-9A-Z]{4,7}$/.test(c));
        const us = (url.searchParams.get("us") || "").split(",").filter(c => /^[A-Z.]{1,6}$/.test(c));
        const list = [...tw.map(c => [c, false]), ...us.map(c => [c, true])].slice(0, 6);
        return cached(request, ctx, CACHE_SEC, () => stocks(list));
      }
    }
    return env.ASSETS.fetch(request);
  },
};
