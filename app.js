(() => {
const VERSION = 'v4.1.1'; // sw.js の VERSION と合わせて上げる
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toast = (msg, ms = 2600) => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); };
$('ver').textContent = VERSION;
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};

// ======================= 計算用 Worker（UIを止めない） =======================
let W = null, rpcId = 0;
const pend = new Map();
function startWorker() {
  W = new Worker('worker.js');
  W.onmessage = (e) => { const p = pend.get(e.data.id); if (!p) return; pend.delete(e.data.id); e.data.ok ? p.res(e.data.out) : p.rej(new Error(e.data.error)); };
  W.onerror = (e) => { for (const p of pend.values()) p.rej(new Error('計算処理でエラーが起きました')); pend.clear(); };
}
startWorker();
const call = (type, data = {}, transfer = []) => new Promise((res, rej) => { const id = ++rpcId; pend.set(id, { res, rej }); W.postMessage(Object.assign({ id, type }, data), transfer); });
window.__call = call; // 検証用
window.__toScreen = (x, y) => { const r = cv.getBoundingClientRect(), p = toScreen({ x, y }); return { x: p.x + r.left, y: p.y + r.top }; }; // 検証用

// ======================= 格子（grid.tToImage の標本）=======================
// Worker が grid.tToImage(t,x) を t×x の格子で標本化して返す。補間して表示とタップの逆変換に使う。
function latCol(lat, x) { const f = Math.min(Math.max(((x - lat.x0) / ((lat.x1 - lat.x0) || 1)) * (lat.nx - 1), 0), lat.nx - 1); const j = Math.min(lat.nx - 2, Math.floor(f)); return { j, a: f - j }; }
function latPoint(lat, t, x) {
  const { j, a } = latCol(lat, x), nt = lat.nt;
  let f = ((t - lat.t0) / (lat.t1 - lat.t0)) * (nt - 1);
  let i = Math.min(nt - 2, Math.max(0, Math.floor(f))); const b = f - i; // 範囲外は端の区間で外挿
  const P = (A) => { const v00 = A[j * nt + i], v01 = A[j * nt + i + 1], v10 = A[(j + 1) * nt + i], v11 = A[(j + 1) * nt + i + 1]; return (v00 + (v01 - v00) * b) * (1 - a) + (v10 + (v11 - v10) * b) * a; };
  return { x: P(lat.X), y: P(lat.Y) };
}
function latInvT(lat, x, y) {
  const { j, a } = latCol(lat, x), nt = lat.nt, Y = lat.Y;
  const yy = (i) => Y[j * nt + i] * (1 - a) + Y[(j + 1) * nt + i] * a;
  let lo = 0, hi = nt - 1;
  if (y <= yy(0)) { lo = 0; hi = 1; } else if (y >= yy(nt - 1)) { lo = nt - 2; hi = nt - 1; }
  else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (yy(m) <= y) lo = m; else hi = m; } }
  const y0 = yy(lo), y1 = yy(hi), tt = (i) => lat.t0 + ((lat.t1 - lat.t0) * i) / (nt - 1);
  return tt(lo) + (tt(hi) - tt(lo)) * ((y - y0) / ((y1 - y0) || 1e-9));
}
function latPoly(lat, t, map, n = 16, xa = lat.x0, xb = lat.x1) { const out = []; for (let i = 0; i <= n; i++) out.push(map(latPoint(lat, t, xa + ((xb - xa) * i) / n))); return out; }

// ======================= 状態 =======================
const S = {
  img: null, iw: 0, ih: 0,
  up: [], lo: [], mode: 'up', undo: [],
  view: { s: 1, tx: 0, ty: 0 },
  res: null, lines: [], topT: 0, botT: 1, review: null, stale: false, flags: [], flagIdx: -1,
  cards: [], okMarks: [], okTop: false, okBot: false, okSpecial: new Set(), special: [], globalFlags: [], stage: '', range: null, busy: false, source: '', reviewSeq: 0,
};
const cv = $('cv'), ctx = cv.getContext('2d');
const MAX_SIDE = 3000; // 静止画の最大長辺（メモリと精度の折り合い）
const allBounds = () => [S.topT, ...S.lines, S.botT];

function showWork(on) {
  $('startCard').classList.toggle('hidden', on); $('work').classList.toggle('hidden', !on);
  syncDock();
}
function setImage(canvas) {
  S.img = canvas; S.iw = canvas.width; S.ih = canvas.height;
  S.up = []; S.lo = []; S.undo = []; clearResult();
  S.mode = 'up'; S.stage = 'range'; S.range = { roi: null, top: null, bot: null, path: null }; S.auto = null; S.autoDet = null;
  showWork(true);
  $('err').classList.add('hidden');
  syncStage(); resize(); fit();
}
function toCanvas(src, sw, sh, maxSide = MAX_SIDE) {
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const oc = document.createElement('canvas'); oc.width = Math.round(sw * k); oc.height = Math.round(sh * k);
  oc.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, oc.width, oc.height);
  return oc;
}
async function decodeFile(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { return await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); }); }
}
async function loadFile(file) {
  if (!file) return;
  let bmp;
  try { bmp = await decodeFile(file); } catch (e) { toast('画像を読み込めませんでした'); return; }
  const oc = toCanvas(bmp, bmp.width, bmp.height);
  tab(false); setImage(oc);
  await runStill([oc], 'photo');
}
for (const id of ['inCam', 'inPick', 'inChange']) $(id).addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
$('bRot').onclick = async () => {
  if (!S.img || S.busy) return;
  const oc = document.createElement('canvas'); oc.width = S.ih; oc.height = S.iw;
  const c = oc.getContext('2d', { willReadFrequently: true });
  c.translate(oc.width, 0); c.rotate(Math.PI / 2); c.drawImage(S.img, 0, 0);
  setImage(oc); toast('90°回転しました'); await runStill([oc], 'photo');
};
function clearResult() {
  S.res = null; S.lines = []; S.review = null; S.stale = false; S.flagIdx = -1; S.flags = []; S.cards = []; S.okMarks = []; S.okTop = S.okBot = false;
  $('result').classList.add('hidden'); $('stale').classList.add('hidden');
}
function setBusy(on, msg) {
  S.busy = on;
  if (on) $('hint').innerHTML = `<b style="color:#ffd400">${msg || '解析中…'}</b>`; else sync();
  syncDock();
}

// 静止画（1コマ or 連写）をWorkerで数える。自動検出→多数決 → 「範囲の確認」（半自動）へ
async function runStill(canvases, source, detOpts) {
  S.source = source;
  setBusy(true, canvases.length > 1 ? `解析中…（${canvases.length}コマで多数決）` : '解析中…');
  const frames = canvases.map((c) => { const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height); return { rgba: d.data.buffer, w: c.width, h: c.height }; });
  let out;
  try { out = await call('still', Object.assign({ frames }, detOpts ? { detOpts } : {}), frames.map((f) => f.rgba)); }
  catch (e) { setBusy(false); toast('解析に失敗しました：' + e.message); return; }
  const chosen = canvases[out.idx] || canvases[0];
  if (chosen !== S.img) { S.img = chosen; S.iw = chosen.width; S.ih = chosen.height; fit(); }
  setBusy(false);
  S.auto = out.ok ? out.res : null; S.autoMs = out.ms;
  S.autoDet = out.ok ? { up: out.res.up, lo: out.res.lo } : out.det ? { up: out.det.up, lo: out.det.lo } : null;
  if (S.autoDet) { S.up = S.autoDet.up.map((p) => ({ x: p.x, y: p.y })); S.lo = S.autoDet.lo.map((p) => ({ x: p.x, y: p.y })); }
  enterRange(detOpts && detOpts.hint ? detOpts.hint : null);
  window.__runs = (window.__runs || 0) + 1;
}
window.__runFiles = async (urls) => { // 検証用：URLの画像を連写として流す
  const cs = []; for (const u of urls) { const b = await (await fetch(u)).blob(); const bm = await createImageBitmap(b); cs.push(toCanvas(bm, bm.width, bm.height)); }
  tab(false); setImage(cs[0]); await runStill(cs, 'test');
};

// ---------- 半自動：範囲の確認（既定の流れ）----------
// 自動検出の結果を「提案の枠」として見せ、利用者が (a) 指でなぞって範囲を囲む (b) 上端→下端の順にタップ を示す。
// 確定で Engine.detect(gray,w,h,{roi, hint}) → analyze（Worker の detectHint）。「自動のまま数える」も残す。
function enterRange(preHint) {
  clearResult();
  S.stage = 'range'; S.range = { roi: null, top: preHint ? preHint.top : null, bot: preHint ? preHint.bot : null, path: null };
  S.mode = 'up';
  syncStage(); fit(); renderRange();
}
function syncStage() {
  const rg = S.stage === 'range';
  $('rangePanel').classList.toggle('hidden', !rg); $('editArea').classList.toggle('hidden', rg);
  if (rg) $('result').classList.add('hidden');
  syncDock(); sync();
}
function renderRange() {
  if (S.stage !== 'range') return;
  const R = S.range, st = (id, done, on) => { const el = $(id); el.classList.toggle('done', !!done); el.classList.toggle('on', !done && !!on); };
  st('rsRoi', R.roi, !R.roi && !R.top); st('rsTop', R.top, !R.top); st('rsBot', R.bot, R.top && !R.bot);
  $('rsRoi').textContent = R.roi ? '✓ 範囲' : '① 指でなぞって囲む'; $('rsTop').textContent = R.top ? '✓ 上端' : '② 上端をタップ'; $('rsBot').textContent = R.bot ? '✓ 下端' : '③ 下端をタップ';
  const a = S.auto;
  let msg = a ? `点線の枠が自動の提案です（${a.count}枚・明瞭さ${(CONF[a.confidence] || CONF.low)[0]}）。積みの範囲を指でなぞって囲み、上端と下端を1回ずつタップすると精度が上がります。`
    : '自動では積みを見つけられませんでした。指でなぞって囲むか、上端→下端の順にタップしてください。';
  if (R.top && !R.bot) msg = '次に、一番下の資材の<b>下の縁</b>をタップしてください。';
  else if (R.roi && !R.top) msg = '範囲を受け付けました。上端→下端の順にタップすると、さらに確実です（省略可）。';
  else if (R.top && R.bot) msg = '準備ができました。下の「この範囲で数える」を押してください。もう一度タップすると上端からやり直します。';
  $('rangeMsg').innerHTML = msg;
  syncDock(); draw();
}
const rangeReady = () => S.range && (S.range.roi || (S.range.top && S.range.bot));
$('rgReset').onclick = () => { if (!S.range) return; S.range = { roi: null, top: null, bot: null, path: null }; renderRange(); };
$('rgFit').onclick = () => fit();
function rangeTap(ip) {
  const R = S.range;
  if (!R.top || (R.top && R.bot)) { R.top = ip; R.bot = null; }
  else { R.bot = ip; if (R.bot.y < R.top.y) { const t = R.top; R.top = R.bot; R.bot = t; } }
  if (navigator.vibrate) try { navigator.vibrate(15); } catch (e) {}
  renderRange();
}
function rangeLasso(path) {
  const xs = path.map((p) => p.x), ys = path.map((p) => p.y);
  const roi = { x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)), x1: Math.min(S.iw - 1, Math.max(...xs)), y1: Math.min(S.ih - 1, Math.max(...ys)) };
  if (roi.x1 - roi.x0 < 20 || roi.y1 - roi.y0 < 20) { toast('もう少し大きく囲んでください'); return; }
  S.range.roi = roi; renderRange();
}
async function confirmRange() {
  if (S.busy || !rangeReady()) return;
  const R = S.range, args = {};
  if (R.roi) args.roi = R.roi;
  if (R.top && R.bot) args.hint = { top: R.top, bot: R.bot };
  setBusy(true, '示した範囲で数えています…');
  try {
    const out = await call('detectHint', args);
    setBusy(false);
    S.up = out.res.up.map((p) => ({ x: p.x, y: p.y })); S.lo = out.res.lo.map((p) => ({ x: p.x, y: p.y }));
    S.stage = 'result'; S.method = 'range'; S.rangeUsed = args;
    applyResult(out.res, out.ms); syncStage();
  } catch (e) { setBusy(false); toast(e.message || String(e), 4000); }
  window.__runs = (window.__runs || 0) + 1;
}
async function useAuto() {
  if (S.busy || !S.auto) return;
  try { await call('useAuto'); } catch (e) { toast(e.message); return; }
  S.up = S.auto.up.map((p) => ({ x: p.x, y: p.y })); S.lo = S.auto.lo.map((p) => ({ x: p.x, y: p.y }));
  S.stage = 'result'; S.method = 'auto'; S.rangeUsed = null;
  applyResult(S.auto, S.autoMs); syncStage();
  window.__runs = (window.__runs || 0) + 1;
}
$('bRange').onclick = confirmRange; $('bAuto').onclick = useAuto;
$('bReRange').onclick = () => { if (!S.img || S.busy) return; const keep = S.range; enterRange(null); if (keep) { S.range.roi = keep.roi; S.range.top = keep.top; S.range.bot = keep.bot; renderRange(); } };
function drawRange() {
  const R = S.range; if (!R) return;
  // 自動の提案（点線の枠）
  if (S.autoDet) {
    let e; try { e = Engine.edges(S.iw, S.ih, S.autoDet.up, S.autoDet.lo); } catch (err) { e = null; }
    if (e) {
      const poly = (t) => { const o = []; for (let i = 0; i <= 16; i++) { const x = e.x0 + ((e.x1 - e.x0) * i) / 16; o.push(toScreen({ x, y: e.top(x) + t * (e.bot(x) - e.top(x)) })); } return o; };
      const a = poly(0), b = poly(1).reverse();
      ctx.setLineDash([8, 6]); ctx.lineWidth = 2.5; ctx.strokeStyle = '#7CFC9A';
      ctx.beginPath(); [...a, ...b].forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = 'bold 13px sans-serif'; ctx.fillStyle = 'rgba(0,0,0,.7)'; const lb = S.auto ? `自動の提案 ${S.auto.count}枚` : '自動の提案';
      const w2 = ctx.measureText(lb).width + 10; ctx.fillRect(a[0].x, a[0].y - 22, w2, 20); ctx.fillStyle = '#7CFC9A'; ctx.textBaseline = 'middle'; ctx.fillText(lb, a[0].x + 5, a[0].y - 12);
    }
  }
  if (R.roi) {
    const p0 = toScreen({ x: R.roi.x0, y: R.roi.y0 }), p1 = toScreen({ x: R.roi.x1, y: R.roi.y1 });
    ctx.fillStyle = 'rgba(0,0,0,.35)'; const W = cv.width, H = cv.height;
    ctx.fillRect(0, 0, W, p0.y); ctx.fillRect(0, p1.y, W, H); ctx.fillRect(0, p0.y, p0.x, p1.y - p0.y); ctx.fillRect(p1.x, p0.y, W, p1.y - p0.y);
    ctx.lineWidth = 3; ctx.strokeStyle = '#2ee6ff'; ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
  }
  if (R.path && R.path.length > 1) { ctx.lineWidth = 4; ctx.strokeStyle = '#2ee6ff'; strokePoly(ctx, R.path.map(toScreen)); }
  const xa = R.roi ? R.roi.x0 : 0, xb = R.roi ? R.roi.x1 : S.iw;
  for (const [p, col, lab] of [[R.top, '#4f8cff', '上端'], [R.bot, '#ff7a3d', '下端']]) {
    if (!p) continue;
    const a = toScreen({ x: xa, y: p.y }), b = toScreen({ x: xb, y: p.y }), q = toScreen(p);
    ctx.setLineDash([10, 6]); ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(q.x, q.y, 12, 0, Math.PI * 2); ctx.fillStyle = col + '66'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
    ctx.font = 'bold 14px sans-serif'; ctx.textBaseline = 'middle'; const tw = ctx.measureText(lab).width + 10;
    ctx.fillStyle = col; ctx.fillRect(q.x + 16, q.y - 11, tw, 22); ctx.fillStyle = '#fff'; ctx.fillText(lab, q.x + 21, q.y);
  }
}

function applyResult(r, ms) {
  S.res = r; S.res.ms = ms; S.lines = r.lines.slice(); S.topT = r.topT; S.botT = r.botT;
  S.stale = false; S.undo = []; S.okMarks = []; S.okTop = S.okBot = false; S.flagIdx = -1;
  // エンジンの要確認のうち、線の再点検（reReview）では出ない種類は最初の結果から引き継ぐ
  const core = { thick: 1, thin: 1, weak: 1 };
  S.special = ((r.review && r.review.items) || []).filter((it) => !core[it.kind]).map((it, i) => Object.assign({ id: 'sp' + i }, it));
  S.okSpecial = new Set();
  S.globalFlags = (r.review && r.review.globalFlags) || [];
  $('stale').classList.add('hidden'); $('result').classList.remove('hidden'); $('err').classList.add('hidden');
  renderVotes(); renderDetail(); renderGlobal();
  afterLinesChanged();
  $('viewer').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderGlobal() {
  const g = S.globalFlags || [];
  $('gfBox').innerHTML = g.length ? `<div class="gf">${g.map((x) => `<b>⚠ ${esc(x.msg)}</b>`).join('')}撮り直すと精度が上がります。</div>` : '';
}

// ======================= メインビューア =======================
function resize() { const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1; cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d); draw(); }
function fit() {
  if (!S.img) return;
  const r = cv.getBoundingClientRect(), s = Math.min(r.width / S.iw, r.height / S.ih) * 0.96;
  S.view = { s, tx: (r.width - S.iw * s) / 2, ty: (r.height - S.ih * s) / 2 }; draw();
}
const toScreen = (p) => ({ x: p.x * S.view.s + S.view.tx, y: p.y * S.view.s + S.view.ty });
const toImage = (x, y) => ({ x: (x - S.view.tx) / S.view.s, y: (y - S.view.ty) / S.view.s });
function draw() {
  const d = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#222'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!S.img) return;
  ctx.setTransform(d * S.view.s, 0, 0, d * S.view.s, d * S.view.tx, d * S.view.ty);
  ctx.imageSmoothingEnabled = S.view.s < 2; ctx.drawImage(S.img, 0, 0);
  ctx.setTransform(d, 0, 0, d, 0, 0);
  if (S.stage === 'range') { drawRange(); return; }
  if (S.res && !S.stale && $('ovl').checked) drawLines(ctx, S.res.lat, toScreen, S.view.s, true);
  else drawEdgesPreview();
  const pt = (p, col) => {
    const q = toScreen(p);
    ctx.beginPath(); ctx.arc(q.x, q.y, 10, 0, Math.PI * 2); ctx.fillStyle = col + '55'; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = col; ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.beginPath();
    ctx.moveTo(q.x - 14, q.y); ctx.lineTo(q.x - 4, q.y); ctx.moveTo(q.x + 4, q.y); ctx.lineTo(q.x + 14, q.y);
    ctx.moveTo(q.x, q.y - 14); ctx.lineTo(q.x, q.y - 4); ctx.moveTo(q.x, q.y + 4); ctx.lineTo(q.x, q.y + 14); ctx.stroke();
  };
  ctx.globalAlpha = S.mode === 'ed' ? 0.4 : 1; S.up.forEach((p) => pt(p, '#2563eb')); S.lo.forEach((p) => pt(p, '#e8590c')); ctx.globalAlpha = 1;
}
function strokePoly(g, pts) { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.stroke(); }
function drawEdgesPreview() {
  if (!S.up.length || !S.lo.length) return;
  let e; try { e = Engine.edges(S.iw, S.ih, S.up, S.lo); } catch (err) { return; }
  const poly = (t) => { const o = []; for (let i = 0; i <= 16; i++) { const x = e.x0 + ((e.x1 - e.x0) * i) / 16; o.push(toScreen({ x, y: e.top(x) + t * (e.bot(x) - e.top(x)) })); } return o; };
  ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
  ctx.strokeStyle = 'rgba(96,150,255,.9)'; strokePoly(ctx, poly(0));
  ctx.strokeStyle = 'rgba(255,140,80,.9)'; strokePoly(ctx, poly(1));
  ctx.setLineDash([]);
}
// 境界線の描画（ビューア・カード・証拠画像で共用）。map: 画像座標→描画座標、scale: 画像1pxあたりの描画px
function drawLines(g, lat, map, scale, withFlags, opt = {}) {
  const all = allBounds(), rv = S.review;
  const poly = (t) => latPoly(lat, t, map, opt.n || 16);
  if (withFlags && rv) {
    g.fillStyle = 'rgba(255,40,40,.28)';
    rv.sheetFlags.forEach((f, i) => {
      if (!f || i + 1 >= all.length) return;
      const a = poly(all[i]), b = poly(all[i + 1]).reverse();
      g.beginPath(); [...a, ...b].forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.fill();
    });
  }
  const pxGap = S.res.pitchPx * scale, thin = pxGap < 3;
  g.lineWidth = opt.edgeW || 2; g.strokeStyle = '#4f8cff'; strokePoly(g, poly(S.topT));
  g.strokeStyle = '#ff7a3d'; strokePoly(g, poly(S.botT));
  S.lines.forEach((t, i) => {
    const n = i + 1, major = n % 10 === 0, weak = rv && rv.lineFlags[i];
    if (thin && !major && !weak) return;
    const pts = poly(t);
    g.lineWidth = (major ? 2.2 : 1.2) * (opt.lw || 1);
    g.strokeStyle = 'rgba(0,0,0,.5)'; g.save(); g.translate(0, 1); strokePoly(g, pts); g.restore();
    g.strokeStyle = weak ? '#ff3b3b' : major ? '#ffd400' : 'rgba(255,212,0,.9)';
    if (weak) g.setLineDash([5, 4]);
    strokePoly(g, pts); g.setLineDash([]);
    if (major && pxGap * 10 > 14 && opt.labels !== false) {
      const p = pts[pts.length - 1];
      g.font = `bold ${opt.font || 12}px sans-serif`; g.textBaseline = 'middle'; g.textAlign = 'left';
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.75)'; g.strokeText(String(n), p.x + 5, p.y);
      g.fillStyle = '#ffd400'; g.fillText(String(n), p.x + 5, p.y);
    }
  });
  if (g === ctx && S.flagIdx >= 0 && S.flags[S.flagIdx]) {
    const f = S.flags[S.flagIdx], p = map(latPoint(lat, f.t, (lat.x0 + lat.x1) / 2));
    g.lineWidth = 3; g.strokeStyle = '#fff'; g.beginPath(); g.arc(p.x, p.y, 26, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 1.5; g.strokeStyle = '#ff3b3b'; g.stroke();
  }
}
const ptrs = new Map(); let gesture = null;
const hitPoint = (sx, sy) => {
  if (S.mode === 'ed') return null;
  let best = null, bd = 26;
  for (const [arr, kind] of [[S.up, 'up'], [S.lo, 'lo']]) arr.forEach((p, i) => { const q = toScreen(p), dd = Math.hypot(q.x - sx, q.y - sy); if (dd < bd) { bd = dd; best = { kind, i }; } });
  return best;
};
const local = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
cv.addEventListener('pointerdown', (e) => {
  if (!S.img || S.busy) return;
  cv.setPointerCapture(e.pointerId);
  const p = local(e); ptrs.set(e.pointerId, p);
  if (ptrs.size === 1 && S.stage === 'range') { gesture = { type: 'lasso', start: p, last: p, moved: 0, multi: false }; S.range.path = [toImage(p.x, p.y)]; }
  else if (ptrs.size === 1) { const hit = hitPoint(p.x, p.y); gesture = { type: hit ? 'drag' : 'pan', hit, start: p, last: p, moved: 0, multi: false }; if (hit) pushUndo(); }
  else if (ptrs.size === 2) { if (S.range) S.range.path = null; const [a, b] = [...ptrs.values()]; gesture = { type: 'pinch', multi: true, d0: Math.hypot(a.x - b.x, a.y - b.y), s0: S.view.s, c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...S.view } }; }
});
cv.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId) || !gesture) return;
  const p = local(e); ptrs.set(e.pointerId, p);
  if (gesture.type === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const s = clampS((gesture.s0 * d) / gesture.d0), ip = { x: (gesture.c0.x - gesture.v0.tx) / gesture.v0.s, y: (gesture.c0.y - gesture.v0.ty) / gesture.v0.s };
    S.view = { s, tx: c.x - ip.x * s, ty: c.y - ip.y * s }; draw(); return;
  }
  const dx = p.x - gesture.last.x, dy = p.y - gesture.last.y; gesture.moved += Math.abs(dx) + Math.abs(dy); gesture.last = p;
  if (gesture.type === 'lasso') { if (gesture.moved > 10) S.range.path.push(clampPt(toImage(p.x, p.y))); draw(); return; }
  if (gesture.type === 'drag') { (gesture.hit.kind === 'up' ? S.up : S.lo)[gesture.hit.i] = clampPt(toImage(p.x, p.y)); markStale(); draw(); }
  else if (gesture.type === 'pan' && gesture.moved > 8) { S.view.tx += dx; S.view.ty += dy; draw(); }
});
const endPtr = (e) => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId); if (!gesture) return;
  if (gesture.type === 'lasso' && ptrs.size === 0) {
    const path = S.range.path; S.range.path = null;
    if (gesture.moved > 14 && path && path.length > 2) rangeLasso(path);
    else { const ip = toImage(gesture.start.x, gesture.start.y); if (ip.x >= 0 && ip.y >= 0 && ip.x < S.iw && ip.y < S.ih) rangeTap(ip); else draw(); }
  }
  if (gesture.type === 'pan' && !gesture.multi && gesture.moved <= 8 && ptrs.size === 0) tap(gesture.start);
  if (gesture.type === 'drag') { if (gesture.moved <= 3) S.undo.pop(); sync(); }
  if (ptrs.size === 0) gesture = null;
  else if (gesture.type === 'pinch') { const q = [...ptrs.values()][0]; gesture = { type: 'pan', multi: true, start: q, last: q, moved: 99 }; }
};
cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
cv.addEventListener('wheel', (e) => { e.preventDefault(); const p = local(e); zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
const clampS = (s) => Math.min(Math.max(s, 0.05), 40);
const clampPt = (p) => ({ x: Math.min(Math.max(p.x, 0), S.iw - 1), y: Math.min(Math.max(p.y, 0), S.ih - 1) });
function zoomAt(x, y, f) { const ip = toImage(x, y), s = clampS(S.view.s * f); S.view = { s, tx: x - ip.x * s, ty: y - ip.y * s }; draw(); }
$('zIn').onclick = () => { const r = cv.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.6); };
$('zOut').onclick = () => { const r = cv.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.6); };
$('bFit').onclick = fit;
function pushUndo() { S.undo.push({ up: S.up.map((p) => ({ ...p })), lo: S.lo.map((p) => ({ ...p })), lines: [...S.lines], stale: S.stale, okMarks: [...S.okMarks], okTop: S.okTop, okBot: S.okBot, okSpecial: new Set(S.okSpecial || []) }); if (S.undo.length > 200) S.undo.shift(); }
function tap(sp) {
  const ip = toImage(sp.x, sp.y);
  if (ip.x < 0 || ip.y < 0 || ip.x >= S.iw || ip.y >= S.ih) return;
  if (S.mode === 'ed') return editLine(ip);
  pushUndo(); (S.mode === 'up' ? S.up : S.lo).push(ip); markStale(); sync();
}
// 線の修正モード: タップ位置を grid の t に戻し（格子の逆変換）、近い線を削除／なければ追加
function editLine(ip) {
  if (!S.res || S.stale) return;
  const lat = S.res.lat, x = Math.min(Math.max(ip.x, lat.x0), lat.x1);
  const t = latInvT(lat, x, ip.y);
  if (t <= S.topT || t >= S.botT) { toast('上端と下端の間をタップしてください'); return; }
  const hLoc = latPoint(lat, S.botT, x).y - latPoint(lat, S.topT, x).y;
  const tolT = Math.max(9 / S.view.s / hLoc, (0.3 * S.res.pitchPx) / hLoc) * (S.botT - S.topT);
  let bi = -1, bd = Infinity; S.lines.forEach((u, i) => { const dd = Math.abs(u - t); if (dd < bd) { bd = dd; bi = i; } });
  pushUndo();
  if (bi >= 0 && bd < tolT) { S.lines.splice(bi, 1); toast(`線を削除 → ${S.lines.length + 1}枚`); }
  else { S.lines.push(t); S.lines.sort((a, b) => a - b); toast(`線を追加 → ${S.lines.length + 1}枚`); }
  afterLinesChanged();
}
$('bUndo').onclick = () => {
  const u = S.undo.pop(); if (!u) return;
  const ptsChanged = JSON.stringify([u.up, u.lo]) !== JSON.stringify([S.up, S.lo]);
  S.up = u.up; S.lo = u.lo; S.lines = u.lines; S.stale = u.stale; S.okMarks = u.okMarks || []; S.okTop = !!u.okTop; S.okBot = !!u.okBot; S.okSpecial = u.okSpecial || new Set();
  $('stale').classList.toggle('hidden', !S.stale);
  if (S.res && !ptsChanged) afterLinesChanged(); else sync();
};
$('bClear').onclick = () => { if (!S.up.length && !S.lo.length) return; pushUndo(); S.up = []; S.lo = []; markStale(); setMode('up'); toast('点をすべて消しました（↶で戻せます）'); };
function setMode(m) {
  if (m === 'ed' && (!S.res || S.stale)) return;
  S.mode = m; sync();
}
$('mUp').onclick = () => setMode('up'); $('mLo').onclick = () => setMode('lo'); $('mEd').onclick = () => setMode('ed');
function markStale() { if (S.res && !S.stale) { S.stale = true; $('stale').classList.remove('hidden'); if (S.mode === 'ed') S.mode = 'up'; } syncDock(); }
function sync() {
  $('nUp').textContent = S.up.length; $('nLo').textContent = S.lo.length;
  $('bUndo').disabled = !S.undo.length;
  $('mEd').disabled = !S.res || S.stale;
  for (const [id, k] of [['mUp', 'up'], ['mLo', 'lo'], ['mEd', 'ed']]) $(id).classList.toggle('on', S.mode === k);
  const sub = '<br><span style="opacity:.75">ピンチ/ホイールで拡大・ドラッグで移動</span>';
  if (!S.busy && S.stage === 'range') $('hint').innerHTML = '<b style="color:#2ee6ff">指でなぞって積みを囲む</b>／<b style="color:#8fb4ff">上端</b>→<b style="color:#ffab7a">下端</b>の順にタップ<br><span style="opacity:.75">2本指で拡大</span>';
  else if (!S.busy) $('hint').innerHTML = S.mode === 'up' ? '<b style="color:#8fb4ff">上端</b>：一番上の資材の<b>上の縁</b>をタップ。左右に2〜3点。点はドラッグで微調整。' + sub
    : S.mode === 'lo' ? '<b style="color:#ffab7a">下端</b>：一番下の資材の<b>下の縁</b>をタップ。左右に2〜3点。' + sub
    : '<b style="color:#ffd400">線の修正</b>：抜けている境界をタップで<b>追加</b>、余分な線をタップで<b>削除</b>。' + sub;
  syncDock(); draw();
}
function syncDock() {
  const inWork = !$('work').classList.contains('hidden'), inHist = !$('viewH').classList.contains('hidden');
  $('dockStart').classList.toggle('hidden', inWork || inHist);
  $('dockWork').classList.toggle('hidden', !inWork || inHist);
  $('dockHist').classList.toggle('hidden', !inHist);
  const rg = S.stage === 'range', needCalc = !rg && (!S.res || S.stale);
  $('bCalc').classList.toggle('hidden', !needCalc); $('bSave').classList.toggle('hidden', rg || needCalc);
  $('bAuto').classList.toggle('hidden', !rg); $('bRange').classList.toggle('hidden', !rg); $('bReRange').classList.toggle('hidden', rg || !S.img);
  if (rg) {
    $('bAuto').disabled = S.busy || !S.auto;
    $('bAuto').className = 'btn two' + (rangeReady() ? '' : ' dark');
    $('bAuto').innerHTML = S.auto ? `自動のまま数える<small>提案 ${S.auto.count}枚</small>` : '自動のまま<small>見つかりません</small>';
    $('bRange').disabled = S.busy || !rangeReady();
    $('bRange').className = 'btn two' + (rangeReady() ? ' pri' : '');
    $('bRange').innerHTML = S.busy ? '解析中…' : `この範囲で数える<small>${S.range && S.range.roi ? '範囲' : ''}${S.range && S.range.roi && S.range.top && S.range.bot ? '＋' : ''}${S.range && S.range.top && S.range.bot ? '上端・下端' : ''}${rangeReady() ? '' : 'なぞる／タップ'}</small>`;
  }
  $('bCalc').disabled = S.busy || !(S.up.length && S.lo.length);
  $('bCalc').textContent = S.busy ? '解析中…' : S.res ? 'もう一度数える' : '枚数を数える';
  updateSaveLabel();
}
$('bCalc').onclick = async () => {
  if (S.busy) return;
  $('err').classList.add('hidden'); setBusy(true, '解析中…');
  try {
    const out = await call('analyze', { up: S.up, lo: S.lo });
    setBusy(false);
    out.res.votes = null; applyResult(out.res);
  } catch (e) { setBusy(false); $('err').textContent = e.message || String(e); $('err').classList.remove('hidden'); }
};
function useCandidate(i, noUndo) {
  if (!noUndo) pushUndo();
  const c = S.res.candidates[i]; S.lines = [...c.lines];
  if (c.topT != null) S.topT = c.topT; if (c.botT != null) S.botT = c.botT;
  afterLinesChanged();
}
const CONF = { high: ['高', 'high'], mid: ['中', 'mid'], low: ['低', 'low'] };

// 線が変わったら Worker で再点検 → 要確認カードを作り直す
async function afterLinesChanged() {
  const seq = ++S.reviewSeq; S.saved = false;
  let rv;
  try { rv = await call('review', { lines: S.lines }); } catch (e) { rv = { sheetFlags: [], lineFlags: [], medGap: (S.botT - S.topT) / (S.lines.length + 1) }; }
  if (seq !== S.reviewSeq) return;
  S.review = rv;
  const all = allBounds(), flags = [];
  if (rv.items) {
    // M5 以降: review.items（kind, t, sheet(0始まり), line?, action, val）
    for (const it of rv.items) if (it.t != null && isFinite(it.t)) flags.push(Object.assign({}, it, { sheet: (it.sheet != null ? it.sheet : sheetAt(it.t)) + 1 }));
  } else {
    rv.sheetFlags.forEach((f, i) => { if (f && i + 1 < all.length) flags.push({ t: (all[i] + all[i + 1]) / 2, kind: all[i + 1] - all[i] > rv.medGap ? 'thick' : 'thin', sheet: i + 1 }); });
    rv.lineFlags.forEach((f, i) => { if (f) flags.push({ t: S.lines[i], kind: 'weak', sheet: i + 1, line: i }); });
  }
  flags.sort((a, b) => a.t - b.t); S.flags = flags; S.flagIdx = -1;
  const count = S.lines.length + 1, auto = S.res.count, diff = count - auto, c = CONF[S.res.confidence] || CONF.low;
  $('num').textContent = count;
  const v = S.res.votes;
  const voteTxt = v && v.reduce((a, b) => a + b.n, 0) > 1 ? `　連写 ${v.reduce((a, b) => a + b.n, 0)}コマ中${Math.max(...v.map((x) => x.n))}コマ一致` : '';
  $('metaLine').innerHTML = `自動検出 <b>${auto}枚</b>　縞の明瞭さ <span class="badge ${c[1]}">${c[0]}</span>${voteTxt}` + (diff ? `<br><b style="color:var(--warn)">手動修正 ${diff > 0 ? '+' : ''}${diff}</b>` : '');
  $('review').innerHTML = flags.length || (S.special || []).length ? '' : `<div class="alert" style="background:#e9f6ee;border:1px solid #b6dec5;color:#1d5c37">✓ 境界の間隔はすべて自然です。上端・下端のカードだけ確認してください。</div>`;
  $('cands').innerHTML = '';
  const others = (S.res.candidates || []).map((cd, i) => ({ ...cd, i })).filter((cd) => cd.count !== count);
  if (others.length) {
    const lab = document.createElement('span'); lab.className = 'muted'; lab.textContent = '別の解釈:'; lab.style.alignSelf = 'center'; $('cands').appendChild(lab);
    others.slice(0, 3).forEach((cd) => { const b = document.createElement('button'); b.textContent = cd.count + '枚'; b.onclick = () => { useCandidate(cd.i); toast(`${cd.count}枚の解釈に切り替えました`); }; $('cands').appendChild(b); });
  }
  buildCards(); renderStd(); sync(); drawSpec();
}

// ======================= 要確認カード =======================
const KIND_TXT = {
  thick: '厚すぎる（線が抜けている？）', thin: '薄すぎる（余分な線？）', weak: '線が薄い（本当に境界？）',
  band: '左・中・右で線がそろわない（余分な線？）', bandAdd: '左右の帯ではここにも線がある（抜け？）',
  polarity: '境界が暗い線か明るい線かあいまい（端の1枚を確認）', harmonic: '倍または半分に数えている可能性（線の間隔を確認）',
  frames: '連写のコマで枚数が割れた（端を確認）', edgeTop: '上端の位置を確認（余分な1枚・足りない1枚？）', edgeBot: '下端の位置を確認（余分な1枚・足りない1枚？）',
  layers: '積層（板の中の層）を数えている可能性',
};
const sheetAt = (t) => S.lines.filter((u) => u < t).length; // 0始まり
const nearestLine = (t) => { let bi = -1, bd = Infinity; S.lines.forEach((u, i) => { const d = Math.abs(u - t); if (d < bd) { bd = d; bi = i; } }); return bi; };
function isOk(f) { if (f.id) return S.okSpecial.has(f.id); const tol = 0.5 * (S.review ? S.review.medGap : 0.01); return S.okMarks.some((m) => m.kind === f.kind && Math.abs(m.t - f.t) < tol); }
// 1件の要確認から、カードの既定の「足す位置」「消す線」を決める
function defaults(f) {
  const all = allBounds(), k = Math.min(Math.max(0, f.sheet - 1), all.length - 2), mid = (all[k] + all[k + 1]) / 2;
  const o = { addT: mid, delIdx: -1, hiSheet: k };
  if (f.kind === 'thick' || f.kind === 'bandAdd') { o.addT = f.kind === 'bandAdd' ? f.t : mid; }
  else if (f.kind === 'thin') {
    const cand = [k - 1, k].filter((i) => i >= 0 && i < S.lines.length);
    o.delIdx = cand.length ? cand.sort((a, b) => lineResp(a) - lineResp(b))[0] : -1;
  } else if (f.kind === 'weak' || f.kind === 'band') { o.delIdx = f.line != null && f.line < S.lines.length && Math.abs(S.lines[f.line] - f.t) < 1e-6 ? f.line : nearestLine(f.t); o.addT = f.t; o.hiSheet = null; }
  else if (f.kind === 'edgeTop') { o.delIdx = S.lines.length ? 0 : -1; o.addT = (all[0] + all[1]) / 2; o.hiSheet = 0; }
  else if (f.kind === 'edgeBot') { o.delIdx = S.lines.length - 1; o.addT = (all[all.length - 2] + all[all.length - 1]) / 2; o.hiSheet = all.length - 2; }
  return o;
}
function altCandidate(count) { const c = S.res.candidates || []; const i = c.findIndex((x) => x.count === count && x.lines); return i >= 0 ? { i, count } : null; }
function buildCards() {
  const all = allBounds(), n = S.lines.length + 1, cards = [], cur = n;
  const specials = (S.special || []).map((sp) => Object.assign({}, sp, { sheet: Math.min(sheetAt(sp.t), n - 1) + 1 }));
  const seen = new Set(), items = [...S.flags, ...specials.filter((f) => { const k = f.kind + ':' + f.sheet; if (seen.has(k)) return false; seen.add(k); return true; })];
  const EDGE_MERGE = { thick: 1, thin: 1, edgeTop: 1, edgeBot: 1, polarity: 1, frames: 1 };
  const atEdge = (f, which) => EDGE_MERGE[f.kind] && (f.kind === 'edgeTop' ? which === 'top' : f.kind === 'edgeBot' ? which === 'bot' : which === 'top' ? f.sheet === 1 : f.sheet === n);
  const edgeCard = (which) => {
    const fs = items.filter((f) => atEdge(f, which)), top = which === 'top';
    const c = { key: which, edge: which, t: top ? (all[0] + all[1]) / 2 : (all[n - 1] + all[n]) / 2, sheet: top ? 1 : n,
      title: top ? '一番上の1枚' : `一番下の1枚（${n}枚目）`, sub: top ? '上の縁の位置と、1枚目の境界を確認' : '下の縁の位置と、最後の境界を確認',
      addT: top ? (all[0] + all[1]) / 2 : (all[n - 1] + all[n]) / 2, delIdx: top ? (S.lines.length ? 0 : -1) : S.lines.length - 1, hiSheet: top ? 0 : n - 1,
      merged: fs, done: (top ? S.okTop : S.okBot) && fs.every(isOk) };
    if (fs.length) { c.warn = true; c.sub = fs.map((f) => '⚠ ' + KIND_TXT[f.kind]).filter((x, i, a) => a.indexOf(x) === i).join('<br>'); const r = fs.find((f) => f.kind === 'thin' || f.action === 'remove'); if (r && r.kind !== 'thin') { const d = defaults(r); if (d.delIdx >= 0) c.delIdx = d.delIdx; } }
    return c;
  };
  cards.push(edgeCard('top'));
  for (const f of items) {
    if (atEdge(f, 'top') || atEdge(f, 'bot')) continue; // 端のカードにまとめる
    const d = defaults(f);
    const c = Object.assign({ key: (f.id || f.kind) + f.t.toFixed(5), flag: f, kind: f.kind, t: f.t, sheet: f.sheet, title: `上から${f.sheet}枚目付近`, sub: KIND_TXT[f.kind] || f.kind, done: isOk(f) }, d);
    if (f.kind === 'weak' || f.kind === 'band') c.title = `上から${(c.delIdx >= 0 ? c.delIdx : f.sheet - 1) + 1}本目の線`;
    if (f.kind === 'layers') {
      c.title = '積層の可能性'; c.layers = true; c.t = (all[0] + all[n]) / 2; c.hiSheet = null;
      c.sub = f.val && f.val === cur ? `積層（板の中の層）を数えている可能性。深いすき間で数えても <b>${f.val}枚</b>（いまの数と同じ）。線が板と板の境目にあるか確認してください`
        : f.val ? `積層（板の中の層）を数えている可能性：深いすき間で数えると <b>${f.val}枚</b>` : '積層（板の中の層）を数えている可能性：深いすき間（板と板の境目）だけを数えてください';
      c.switchTo = f.val && f.val !== cur ? altCandidate(f.val) : null;
      if (f.val && f.val !== cur && !c.switchTo) c.sub += '（候補がないため、線の修正で直してください）';
    }
    if (f.kind === 'harmonic') {
      const alts = (S.res.candidates || []).map((x, i) => ({ i, count: x.count })).filter((x) => x.count !== cur && (Math.abs(x.count - cur * 2) <= Math.max(1, cur * 0.1) || Math.abs(x.count - cur / 2) <= Math.max(1, cur * 0.05)));
      if (alts.length) c.switchTo = alts[0];
    }
    cards.push(c);
  }
  cards.push(edgeCard('bot'));
  S.cards = cards;
  renderCards();
}
function lineResp(i) { const r = S.res && S.res.rr; if (!r) return 0; const t = S.lines[i], k = Math.round(((t - S.res.tMin) / ((S.res.tMax - S.res.tMin) || 1)) * (r.length - 1)); return r[Math.min(r.length - 1, Math.max(0, k))] || 0; }
function unconfirmed() { return S.cards.filter((c) => !c.done).length; }
function renderCards() {
  const box = $('cards'); box.innerHTML = '';
  S.cards.forEach((c, ci) => {
    const el = document.createElement('div');
    el.className = 'rcard' + (c.edge && !c.warn ? ' edge' : '') + (c.done ? ' done' : '');
    el.dataset.key = c.key;
    el.innerHTML = `<div class="ttl">${c.done ? '✓ ' : ''}${c.title}<small>${c.sub}</small></div><canvas></canvas>
      ${c.switchTo ? `<div class="acts sw"><button class="btn ok" data-a="ok">OK</button><button class="btn swb" data-a="switch">${c.switchTo.count}枚に切り替える</button></div>` : ''}
      ${c.layers && !c.switchTo ? `<div class="acts sw"><button class="btn ok" data-a="ok">OK（このまま）</button><button class="btn" data-a="zoom">線を直す</button></div>` : ''}
      ${!c.layers && !c.switchTo ? `<div class="acts"><button class="btn ok" data-a="ok">OK</button><button class="btn" data-a="add">＋線を足す</button><button class="btn" data-a="del" ${c.delIdx >= 0 ? '' : 'disabled'}>−線を消す</button></div>` : ''}
      ${c.switchTo && !c.layers ? `<div class="acts"><button class="btn" data-a="add" style="grid-column:2">＋線を足す</button><button class="btn" data-a="del" ${c.delIdx >= 0 ? '' : 'disabled'}>−線を消す</button></div>` : ''}
      <button class="more" data-a="zoom">拡大して直す（線の修正モード）</button>`;
    box.appendChild(el);
    const cc = el.querySelector('canvas');
    requestAnimationFrame(() => drawCard(c, cc));
    cc.addEventListener('click', (e) => { // カード内タップで「足す／消す」の位置を選ぶ
      const r = cc.getBoundingClientRect(), m = c._m; if (!m) return;
      const ix = (e.clientX - r.left - m.ox) / m.s + m.x0, iy = (e.clientY - r.top - m.oy) / m.s + m.y0;
      const t = latInvT(S.res.lat, Math.min(Math.max(ix, S.res.lat.x0), S.res.lat.x1), iy);
      c.addT = Math.min(Math.max(t, S.topT + 1e-4), S.botT - 1e-4);
      let bi = -1, bd = Infinity; S.lines.forEach((u, i) => { const d = Math.abs(u - t); if (d < bd) { bd = d; bi = i; } });
      c.delIdx = bi; const db = el.querySelector('[data-a=del]'); if (db) db.disabled = bi < 0;
      drawCard(c, cc);
    });
    el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => cardAction(c, b.dataset.a)));
  });
  const n = unconfirmed();
  $('rvPill').textContent = n ? `未確認 ${n}件` : 'すべて確認済み'; $('rvPill').classList.toggle('ok', !n);
  updateSaveLabel();
}
function drawCard(c, cc) {
  const r = cc.getBoundingClientRect(), d = window.devicePixelRatio || 1; if (!r.width) return;
  cc.width = Math.round(r.width * d); cc.height = Math.round(r.height * d);
  const g = cc.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
  const lat = S.res.lat, xm = (lat.x0 + lat.x1) / 2, cp = latPoint(lat, c.t, xm);
  const pitch = Math.max(2, S.res.pitchPx);
  let hh = Math.min(S.ih, Math.max(60, pitch * 7)), ww = hh * (r.width / r.height);
  if (ww > S.iw) { ww = S.iw; hh = ww * (r.height / r.width); }
  const x0 = Math.min(Math.max(0, cp.x - ww / 2), S.iw - ww), y0 = Math.min(Math.max(0, cp.y - hh / 2), S.ih - hh);
  const s = r.width / ww; c._m = { s, ox: 0, oy: 0, x0, y0 };
  g.fillStyle = '#222'; g.fillRect(0, 0, r.width, r.height);
  g.imageSmoothingEnabled = s < 3; g.drawImage(S.img, x0, y0, ww, hh, 0, 0, r.width, r.height);
  const map = (p) => ({ x: (p.x - x0) * s, y: (p.y - y0) * s });
  const all = allBounds();
  if (c.hiSheet != null && c.hiSheet + 1 < all.length) {
    const a = latPoly(lat, all[c.hiSheet], map), b = latPoly(lat, all[c.hiSheet + 1], map).reverse();
    g.fillStyle = c.edge && !c.warn ? 'rgba(80,140,255,.22)' : 'rgba(255,40,40,.25)';
    g.beginPath(); [...a, ...b].forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.fill();
  }
  drawLines(g, lat, map, s, false, { lw: 1.3, edgeW: 3, labels: false, n: 24 });
  // 「足す」位置（水色の破線）と「消す」線（赤い×）
  g.setLineDash([7, 5]); g.lineWidth = 2.5; g.strokeStyle = '#2ee6ff'; strokePoly(g, latPoly(lat, c.addT, map, 24)); g.setLineDash([]);
  const lp = map(latPoint(lat, c.addT, lat.x0)); g.font = 'bold 16px sans-serif'; g.fillStyle = '#2ee6ff'; g.textBaseline = 'middle'; g.fillText('＋', Math.max(4, lp.x + 4), lp.y - 10);
  if (c.delIdx >= 0 && c.delIdx < S.lines.length) {
    g.lineWidth = 3; g.strokeStyle = '#ff3b3b'; strokePoly(g, latPoly(lat, S.lines[c.delIdx], map, 24));
    const q = map(latPoint(lat, S.lines[c.delIdx], xm)); g.fillStyle = '#ff3b3b'; g.font = 'bold 18px sans-serif'; g.textAlign = 'center'; g.fillText('×', q.x, q.y - 10); g.textAlign = 'left';
  }
}
function markCardOk(c) {
  const mark = (f) => { if (f.id) S.okSpecial.add(f.id); else S.okMarks.push({ kind: f.kind, t: f.t }); };
  if (c.edge === 'top') S.okTop = true; else if (c.edge === 'bot') S.okBot = true;
  (c.merged || []).forEach(mark);
  if (c.flag) mark(c.flag);
}
function cardAction(c, a) {
  if (a === 'zoom') { zoomTo(c.t); setMode('ed'); return; }
  pushUndo();
  if (a === 'ok') { markCardOk(c); c.done = true; renderCards(); scrollNextCard(c); return; }
  if (a === 'switch' && c.switchTo) {
    markCardOk(c);
    // 同じ根拠の要確認（積層・倍数）は解釈を切り替えたら確認済み
    (S.special || []).forEach((sp) => { if (sp.kind === 'layers' || sp.kind === 'harmonic') S.okSpecial.add(sp.id); });
    useCandidate(c.switchTo.i, true); toast(`${c.switchTo.count}枚の解釈に切り替えました`); return;
  }
  if (a === 'add') { S.lines.push(c.addT); S.lines.sort((x, y) => x - y); toast(`線を足しました → ${S.lines.length + 1}枚`); }
  if (a === 'del') { if (c.delIdx < 0) return; S.lines.splice(c.delIdx, 1); toast(`線を消しました → ${S.lines.length + 1}枚`); }
  markCardOk(c);
  // 修正した場所の近くは確認済みとして扱う（再点検で新たに出たものは未確認のまま）
  if (c.flag) S.okMarks.push({ kind: 'thick', t: c.t }, { kind: 'thin', t: c.t });
  afterLinesChanged();
}
function scrollNextCard(c) {
  const i = S.cards.indexOf(c), nx = S.cards.find((k, j) => j > i && !k.done) || S.cards.find((k) => !k.done);
  if (!nx) return; const el = $('cards').querySelector(`[data-key="${nx.key}"]`); if (el) el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}
function zoomTo(t) {
  const lat = S.res.lat, x = (lat.x0 + lat.x1) / 2, p = latPoint(lat, t, x);
  const r = cv.getBoundingClientRect(), s = clampS(Math.max(S.view.s, Math.min(40, 90 / S.res.pitchPx)));
  S.view = { s, tx: r.width / 2 - p.x * s, ty: r.height / 2 - p.y * s };
  $('viewer').scrollIntoView({ behavior: 'smooth', block: 'start' }); draw();
}
$('ovl').onchange = draw;

function renderVotes() {
  const v = S.res.votes, box = $('voteBox'); box.innerHTML = '';
  if (!v || v.length <= 1) return;
  const total = v.reduce((a, b) => a + b.n, 0), top = Math.max(...v.map((x) => x.n));
  const txt = v.slice().sort((a, b) => b.n - a.n).map((x) => `${x.count}枚×${x.n}`).join('・');
  box.innerHTML = `<div class="alert ${top / total < 0.6 ? 'bad' : 'warn'}"><b>連写のコマで枚数が割れました</b>（${txt}）。多い方を採用しています。<b>もう一度撮る</b>ことをおすすめします。<button class="btn pri block" id="bRetry">🎥 もう一度撮る</button></div>`;
  $('bRetry').onclick = openCam;
}
function renderDetail() {
  const r = S.res;
  $('detail').innerHTML = `解析幅: ${Math.round(r.band.x1 - r.band.x0)}px（${r.columns}列） ／ 積み高さ: 約${Math.round(r.Hpx)}px ／ 1枚あたり約${r.pitchPx.toFixed(1)}px ／ 境界: ${r.polarity === 'dark' ? '暗い線' : '明るい線'} ／ ピーク比: ${(r.ratio || 0).toFixed(1)}` +
    (r.ms ? ` ／ 処理 ${Math.round(r.ms)}ms` : '') + ` ／ 画像 ${S.iw}×${S.ih}<br>グラフは縞の周期スペクトル（横軸＝枚数）。1枚あたりが3px未満だと精度が落ちるので、近づくか上下に分けて撮影してください。`;
}
function drawSpec() {
  const c = $('spec'), r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1; if (!r.width || !S.res || !S.res.plot || !S.res.plot.length) return;
  c.width = r.width * d; c.height = r.height * d;
  const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
  const W2 = r.width, H = r.height, pl = 8, pr = 8, pb = 18, pt = 6, pts = S.res.plot;
  g.clearRect(0, 0, W2, H);
  const x0 = pts[0][0], x1 = pts[pts.length - 1][0], ym = Math.max(...pts.map((p) => p[1])) || 1;
  const X = (x) => pl + ((x - x0) / (x1 - x0)) * (W2 - pl - pr), Y = (y) => H - pb - (y / ym) * (H - pb - pt);
  g.strokeStyle = '#ccc'; g.beginPath(); g.moveTo(pl, H - pb); g.lineTo(W2 - pr, H - pb); g.stroke();
  g.fillStyle = '#888'; g.font = '10px sans-serif'; g.textAlign = 'center';
  const mag = Math.pow(10, Math.floor(Math.log10((x1 - x0) / 4))), step = mag * ([1, 2, 5].find((m) => (x1 - x0) / (mag * m) <= 6) || 10);
  for (let v = Math.ceil(x0 / step) * step; v <= x1; v += step) g.fillText(v, X(v), H - 5);
  g.strokeStyle = '#1d1f22'; g.lineWidth = 1.3; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.stroke();
  const n = S.lines.length + 1;
  if (n >= x0 && n <= x1) { g.strokeStyle = '#f2b705'; g.lineWidth = 2; g.beginPath(); g.moveTo(X(n), pt); g.lineTo(X(n), H - pb); g.stroke(); }
}
document.querySelector('details').addEventListener('toggle', drawSpec);

// ======================= 品名（最近5件・マスタ・バーコード）=======================
const K_RECENT = 'shimashima-recent-v1', K_MASTER = 'shimashima-products-v1', K_WHO = 'shimashima-who-v1';
let recent = LS.get(K_RECENT, []), master = LS.get(K_MASTER, []);
$('fWho').value = LS.get(K_WHO, '');
$('fWho').addEventListener('change', () => LS.set(K_WHO, $('fWho').value.trim()));
const findMaster = (name) => master.find((m) => m.name === name);
function renderRecent() {
  const cur = $('fName').value.trim();
  $('recent').innerHTML = recent.map((n) => `<button data-n="${esc(n)}" class="${n === cur ? 'on' : ''}">${esc(n)}</button>`).join('');
  $('nameList').innerHTML = master.map((m) => `<option value="${esc(m.name)}">${m.std ? m.std + '枚' : ''}</option>`).join('');
}
$('recent').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $('fName').value = b.dataset.n; renderRecent(); renderStd(); });
$('fName').addEventListener('input', () => { renderRecent(); renderStd(); });
function pushRecent(name) { if (!name || name === '（品名なし）') return; recent = [name, ...recent.filter((n) => n !== name)].slice(0, 5); LS.set(K_RECENT, recent); renderRecent(); }
function renderStd() {
  const m = findMaster($('fName').value.trim()), box = $('stdBox');
  if (!m || !m.std || !S.res) { box.innerHTML = ''; return; }
  const n = S.lines.length + 1, d = n - m.std;
  box.innerHTML = d ? `<div class="alert bad"><b>標準枚数 ${m.std}枚と違います（${d > 0 ? '+' : ''}${d}枚）</b>。数え間違い・端数・積み違いを確認してください。</div>`
    : `<div class="alert" style="background:#e9f6ee;border:1px solid #b6dec5;color:#1d5c37">✓ 標準枚数 ${m.std}枚と一致</div>`;
}
function openModal(html) { $('sheet').innerHTML = html; $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); $('sheet').innerHTML = ''; if (scan.stream) stopScan(); }
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
function openMaster() {
  openModal(`<h3>品名マスタ</h3><p class="muted">タップで選択。削除は「削除」を長押し。標準枚数を入れると、結果が違うときに警告します。</p>
    <div id="mList" style="margin:8px 0"></div>
    <div class="addgrid"><label class="field"><span>品名</span><input id="mName" placeholder="例：合板 12mm"></label><label class="field"><span>標準枚数</span><input id="mStd" type="number" inputmode="numeric" placeholder="任意"></label></div>
    <label class="field"><span>バーコード（任意）</span><input id="mCode" placeholder="読み取り値"></label>
    <div class="row"><button class="btn pri grow" id="mAdd">追加・更新</button><button class="btn grow" id="mClose">閉じる</button></div>`);
  const draw2 = () => {
    $('mList').innerHTML = master.length ? master.map((m, i) => `<div class="mrow"><button class="t btn" style="justify-content:flex-start;background:none;text-align:left" data-pick="${i}"><span><span class="nm">${esc(m.name)}</span><br><span class="muted">${m.std ? '標準 ' + m.std + '枚' : '標準枚数なし'}${m.code ? '・' + esc(m.code) : ''}</span></span></button><button class="hold" data-del="${i}"><span>削除</span></button></div>`).join('') : '<p class="muted">まだありません</p>';
    $('mList').querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => { $('fName').value = master[+b.dataset.pick].name; renderRecent(); renderStd(); closeModal(); });
    $('mList').querySelectorAll('[data-del]').forEach((b) => holdToDelete(b, () => { master.splice(+b.dataset.del, 1); LS.set(K_MASTER, master); draw2(); renderRecent(); renderStd(); toast('マスタから削除しました'); }));
  };
  draw2();
  $('mName').value = $('fName').value.trim();
  $('mAdd').onclick = () => {
    const name = $('mName').value.trim(); if (!name) { toast('品名を入れてください'); return; }
    const std = parseInt($('mStd').value, 10) || 0, code = $('mCode').value.trim();
    const ex = findMaster(name); if (ex) { ex.std = std || ex.std; ex.code = code || ex.code; } else master.push({ name, std, code });
    LS.set(K_MASTER, master); draw2(); renderRecent(); renderStd(); toast('マスタに保存しました');
    $('mName').value = ''; $('mStd').value = ''; $('mCode').value = '';
  };
  $('mClose').onclick = closeModal;
}
$('bMaster').onclick = openMaster;
// バーコード（BarcodeDetector がある端末のみ。iOS Safari は非対応→手入力）
const scan = { stream: null, timer: 0 };
if (!('BarcodeDetector' in window)) $('bScan').classList.add('hidden');
async function stopScan() { clearTimeout(scan.timer); if (scan.stream) scan.stream.getTracks().forEach((t) => t.stop()); scan.stream = null; }
$('bScan').onclick = async () => {
  let det; try { det = new BarcodeDetector(); } catch (e) { toast('この端末はバーコード読み取りに対応していません'); return; }
  openModal(`<h3>バーコードを読み取る</h3><video id="scanV" playsinline muted autoplay style="width:100%;border-radius:10px;background:#000;max-height:50svh"></video><p class="muted" id="scanMsg" style="margin:8px 0">バーコードを枠に入れてください</p><button class="btn block" id="scanClose">閉じる</button>`);
  $('scanClose').onclick = closeModal;
  try { scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } }); } catch (e) { toast('カメラを起動できませんでした'); closeModal(); return; }
  const v = $('scanV'); v.srcObject = scan.stream; await v.play().catch(() => {});
  const tick = async () => {
    if (!scan.stream) return;
    try { const r = await det.detect(v); if (r.length) { const code = r[0].rawValue; const m = master.find((x) => x.code === code); $('fName').value = m ? m.name : code; renderRecent(); renderStd(); closeModal(); toast(m ? `品名：${m.name}` : `読み取り：${code}（マスタ未登録）`); if (navigator.vibrate) navigator.vibrate(40); return; } } catch (e) {}
    scan.timer = setTimeout(tick, 250);
  };
  tick();
};
renderRecent();

// ======================= 長押しで削除 =======================
function holdToDelete(el, onDone, ms = 800) {
  let tm = 0;
  const start = (e) => { e.preventDefault(); el.classList.add('pressing'); tm = setTimeout(() => { el.classList.remove('pressing'); if (navigator.vibrate) navigator.vibrate(30); onDone(); }, ms); };
  const stop = () => { clearTimeout(tm); if (el.classList.contains('pressing')) { el.classList.remove('pressing'); toast('削除するには長押ししてください', 1500); } };
  el.addEventListener('pointerdown', start); el.addEventListener('pointerup', stop); el.addEventListener('pointerleave', stop); el.addEventListener('pointercancel', stop);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ======================= 証拠画像（IndexedDB）=======================
const IDB = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open('shimashima', 1); r.onupgradeneeded = () => r.result.createObjectStore('evidence', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('evidence', mode), st = t.objectStore('evidence'); const q = fn(st); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  return { put: (v) => tx('readwrite', (s) => s.put(v)), get: (id) => tx('readonly', (s) => s.get(id)), del: (id) => tx('readwrite', (s) => s.delete(id)) };
})();
function makeEvidence(meta) {
  const k = Math.min(1, 1600 / Math.max(S.iw, S.ih)), w = Math.round(S.iw * k), h = Math.round(S.ih * k), bar = Math.max(64, Math.round(w * 0.075));
  const c = document.createElement('canvas'); c.width = w; c.height = h + bar;
  const g = c.getContext('2d'); g.drawImage(S.img, 0, 0, w, h);
  drawLines(g, S.res.lat, (p) => ({ x: p.x * k, y: p.y * k }), k, true, { font: 22, edgeW: 4, lw: 1.8, n: 32 });
  g.fillStyle = '#111'; g.fillRect(0, h, w, bar);
  const fs = Math.round(bar * 0.3); g.font = `bold ${fs}px sans-serif`; g.fillStyle = '#fff'; g.textBaseline = 'top';
  g.fillText(`${meta.count}枚  ${meta.name}  ${fmt(meta.ts)}`, 10, h + bar * 0.12);
  g.font = `${Math.round(fs * 0.8)}px sans-serif`; g.fillStyle = '#ddd';
  g.fillText(`担当:${meta.who || '-'}  ${meta.method || ''}  自動:${meta.est}枚  信頼度:${(CONF[meta.conf] || ['-'])[0]}  ${meta.votes || ''}  未確認:${meta.unconfirmed}  ${VERSION}`, 10, h + bar * 0.56);
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.85));
}
function makeThumb() {
  const lat = S.res.lat, a = latPoint(lat, S.topT, lat.x0), b = latPoint(lat, S.botT, lat.x1), a2 = latPoint(lat, S.topT, lat.x1), b2 = latPoint(lat, S.botT, lat.x0);
  let x0 = lat.x0, x1 = lat.x1, y0 = Math.min(a.y, a2.y), y1 = Math.max(b.y, b2.y);
  const pad = Math.max(x1 - x0, y1 - y0) * 0.12 + 20;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(S.iw, x1 + pad); y1 = Math.min(S.ih, y1 + pad);
  const k = 160 / Math.max(x1 - x0, y1 - y0), c = document.createElement('canvas');
  c.width = Math.round((x1 - x0) * k); c.height = Math.round((y1 - y0) * k);
  c.getContext('2d').drawImage(S.img, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

// ======================= 履歴・保存・CSV =======================
let db = null, records = [], useLocal = true;
const LS_KEY = 'shimashima-history-v1';
const lsGet = () => LS.get(LS_KEY, []);
const lsSet = (a) => LS.set(LS_KEY, a);
const setStoreNote = (t) => { $('storeNote').textContent = t; };
records = lsGet(); setStoreNote('この端末のブラウザに保存しています（ブラウザのデータを消すと消えます。定期的にCSV保存を）。'); renderList();
(async () => {
  try {
    if (!window.claude || !window.claude.use) return;
    db = await window.claude.use('db'); if (!db) return;
    const timer = setTimeout(() => setStoreNote('共有データベースに接続できません。表示が古い可能性があります。'), 10000);
    db.collection('records').orderBy('ts', 'desc').limit(1000).onSnapshot((snap) => {
      if (!snap.metadata.fromCache) clearTimeout(timer);
      useLocal = false; records = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setStoreNote('履歴はこのページを共有しているメンバー全員で共有されます（証拠画像はこの端末のみ）。'); renderList();
    }, () => { clearTimeout(timer); db = null; useLocal = true; records = lsGet(); setStoreNote('共有保存が使えないため、この端末に保存しています。'); renderList(); });
  } catch (e) { db = null; }
})();
let saveArmed = 0;
function updateSaveLabel() {
  const n = S.res ? unconfirmed() : 0, b = $('bSave');
  if (S.saved) { b.textContent = '✓ 保存しました'; b.classList.remove('warnb', 'pri'); return; }
  b.textContent = n ? `保存（未確認 ${n}件）` : 'この枚数で保存';
  b.classList.toggle('warnb', !!n); b.classList.toggle('pri', !n);
}
$('bSave').onclick = async () => {
  if (!S.res || S.stale) { toast('先に枚数を数えてください'); return; }
  if (S.saved && Date.now() - saveArmed > 5000) { saveArmed = Date.now(); toast('保存済みです。別の記録としてもう一度保存するなら、もう一度押してください', 3500); return; }
  const n = S.saved ? 0 : unconfirmed();
  if (n && Date.now() - saveArmed > 5000) { saveArmed = Date.now(); toast(`未確認が${n}件あります。このまま保存するなら、もう一度押してください`, 4000); const el = $('cards').querySelector('.rcard:not(.done)'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }); return; }
  saveArmed = 0;
  const name = $('fName').value.trim() || '（品名なし）', m = findMaster(name), v = S.res.votes;
  const ts = Date.now();
  const rec = { ts, name, who: $('fWho').value.trim(), memo: $('fMemo').value.trim(), count: S.lines.length + 1, est: S.res.count, conf: S.res.confidence, flags: S.flags.length,
    unconfirmed: n, std: m && m.std ? m.std : '', votes: v && v.length ? v.map((x) => `${x.count}x${x.n}`).join(' ') : '', method: S.method === 'range' ? '範囲指定' : '自動', eid: ts + '-' + Math.random().toString(36).slice(2, 7), thumb: makeThumb(), ver: VERSION };
  LS.set(K_WHO, rec.who);
  $('bSave').disabled = true;
  try {
    try { const blob = await makeEvidence(rec); await IDB.put({ id: rec.eid, ts, blob, name, count: rec.count }); if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); }
    catch (e) { rec.eid = ''; toast('証拠画像を保存できませんでした（記録は保存します）'); }
    if (db && !useLocal) await db.collection('records').add(rec);
    else { rec.id = String(ts); records.unshift(rec); if (!lsSet(records)) toast('この端末に保存できませんでした'); renderList(); }
    pushRecent(name); S.saved = true; updateSaveLabel();
    toast(`保存しました：${rec.name} ${rec.count}枚`); $('fMemo').value = '';
  } catch (e) { toast(e && e.code === 'quota_exceeded' ? '保存容量がいっぱいです。古い履歴を削除してください' : '保存に失敗しました'); }
  $('bSave').disabled = false;
};
function fmt(ts) { const d = new Date(ts), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function filtered() { const q = $('q').value.trim().toLowerCase(); return q ? records.filter((r) => (r.name + ' ' + (r.memo || '') + ' ' + (r.who || '')).toLowerCase().includes(q)) : records; }
function renderList() {
  const list = filtered(), total = list.reduce((a, r) => a + (Number(r.count) || 0), 0);
  $('sum').textContent = list.length ? `${list.length}件 ／ 合計 ${total.toLocaleString()}枚` : '';
  $('list').innerHTML = list.length ? list.map((r) => {
    const adj = r.count !== r.est ? `<span style="color:var(--warn)">（自動${esc(r.est)}→修正）</span>` : '';
    const stdw = r.std && Number(r.std) !== Number(r.count) ? `<span style="color:var(--bad)">標準${esc(r.std)}枚と相違</span>` : '';
    const unc = r.unconfirmed ? `<span style="color:var(--bad)">未確認${esc(r.unconfirmed)}</span>` : '';
    const thumb = typeof r.thumb === 'string' && r.thumb.startsWith('data:image/') ? r.thumb : '';
    return `<div class="item"><img src="${esc(thumb)}" alt="証拠画像" data-ev="${esc(r.eid || '')}" data-id="${esc(r.id)}"><div class="t"><div class="nm">${esc(r.name)}</div><div class="dt">${fmt(r.ts)}${r.who ? ' ・' + esc(r.who) : ''} ${adj}</div>${r.memo || stdw || unc ? `<div class="dt">${esc(r.memo || '')} ${stdw} ${unc}</div>` : ''}</div>
      <div class="ct">${Number(r.count) || 0}<small>枚</small></div><button class="hold del" data-id="${esc(r.id)}" data-ev="${esc(r.eid || '')}" aria-label="長押しで削除"><span>削除</span></button></div>`;
  }).join('') : '<p class="muted" style="padding:20px 0;text-align:center">まだ記録がありません。計測して「保存」すると、ここに並びます。</p>';
  $('list').querySelectorAll('.del').forEach((b) => holdToDelete(b, () => delRecord(b.dataset.id, b.dataset.ev)));
}
$('q').addEventListener('input', renderList);
async function delRecord(id, eid) {
  try {
    if (db && !useLocal) await db.collection('records').doc(id).delete(); else { records = records.filter((r) => r.id !== id); lsSet(records); renderList(); }
    if (eid) IDB.del(eid).catch(() => {});
    toast('削除しました');
  } catch (err) { toast('削除できませんでした'); }
}
$('list').addEventListener('click', async (e) => {
  const im = e.target.closest('img[data-id]'); if (!im) return;
  const r = records.find((x) => x.id === im.dataset.id); if (!r) return;
  let url = im.src, has = false;
  if (r.eid) { try { const ev = await IDB.get(r.eid); if (ev && ev.blob) { url = URL.createObjectURL(ev.blob); has = true; } } catch (err) {} }
  openModal(`<h3>${esc(r.name)}　${esc(r.count)}枚</h3><img src="${esc(url)}" alt="証拠画像"><p class="muted" style="margin:8px 0">${fmt(r.ts)}　担当：${esc(r.who || '-')}　自動：${esc(r.est)}枚　信頼度：${(CONF[r.conf] || ['-'])[0]}${r.votes ? '　連写：' + esc(r.votes) : ''}${has ? '' : '<br>（この端末には証拠画像がありません。縮小写真を表示しています）'}</p>
    <div class="row">${has ? '<a class="btn grow" id="evDl">画像を保存</a>' : ''}<button class="btn pri grow" id="evClose">閉じる</button></div>`);
  if (has) { const a = $('evDl'); a.href = url; a.download = `証拠_${r.name}_${r.count}枚_${r.ts}.jpg`; }
  $('evClose').onclick = closeModal;
});
function csv() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['日時', '品名', '枚数', '自動検出', '手動修正', '縞の明瞭さ', 'メモ', '担当者', '未確認', '標準枚数', '連写', '証拠画像ID', '数え方'];
  const rows = filtered().map((r) => [fmt(r.ts), r.name, r.count, r.est, r.count - r.est, (CONF[r.conf] || ['-'])[0], r.memo || '', r.who || '', r.unconfirmed ?? '', r.std ?? '', r.votes || '', r.eid || '', r.method || ''].map(q).join(','));
  return [head.map(q).join(','), ...rows].join('\r\n');
}
$('bCopy').onclick = async () => {
  const text = csv();
  try { await navigator.clipboard.writeText(text); toast('CSVをコピーしました'); }
  catch (e) { const t = $('csvBox'); t.value = text; t.classList.remove('hidden'); t.select(); toast('下の枠から選択してコピーしてください'); }
};
let downloads = null;
(async () => { try { if (window.claude && window.claude.use) downloads = await window.claude.use('downloads'); } catch (e) {} })();
$('bCsv').onclick = async () => {
  const d = new Date(), z = (n) => String(n).padStart(2, '0'), name = `シマシマ計測_${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}.csv`, data = '﻿' + csv();
  if (downloads) { try { await downloads.save({ filename: name, data }); } catch (e) { toast('保存がキャンセルされました'); } return; }
  try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
  catch (e) { $('bCopy').click(); }
};
function tab(h) { $('tabM').classList.toggle('on', !h); $('tabH').classList.toggle('on', h); $('viewM').classList.toggle('hidden', h); $('viewH').classList.toggle('hidden', !h); syncDock(); if (!h) resize(); else renderList(); }
$('tabM').onclick = () => tab(false); $('tabH').onclick = () => tab(true);
window.addEventListener('resize', () => { if (S.img) resize(); });

// ======================= カメラ（ライブ計数・案内・自動シャッター・連写）=======================
const cam = { stream: null, track: null, ic: null, icFail: false, running: false, capturing: false, hist: [], motion: [], last: null, torch: false, timer: 0,
  auto: LS.get('shimashima-auto-v1', true), audio: null, readyRun: 0, fired: false };
const camSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
const work = document.createElement('canvas'), wctx = work.getContext('2d', { willReadFrequently: true });
let LIVE_SIDE = 1024;       // ライブ解析の長辺。M5 の detect は重いので 1280→1024。遅い端末では 800 まで自動で下げる
const LIVE_MAPSIZE = 384;   // ライブだけ geometry の opts.mapSize を下げる（既定512の約0.6倍の時間）
const PITCH_MIN = 6;        // 1枚あたりの最小px（元映像基準）
const MOTION_MAX = 4.0;     // コマ間差分（0〜255）の上限＝手ぶれ判定
const STABLE_N = 4;         // 枚数がこの回数連続で一致したら安定
const TILT_MAX = 12;        // 傾きの上限（度）。上端・下端の線の傾き
if (!camSupported) {
  $('bLive').disabled = true; $('bLive2').disabled = true;
  $('liveNote').textContent = 'リアルタイムのカメラモードは https で公開したページで使えます。「写真」で撮って数えてください。';
}
$('bLive').onclick = openCam; $('bLive2').onclick = openCam; $('bRetake').onclick = openCam;
$('camAuto').classList.toggle('on', cam.auto);
$('camAuto').onclick = () => { cam.auto = !cam.auto; LS.set('shimashima-auto-v1', cam.auto); $('camAuto').classList.toggle('on', cam.auto); toast(cam.auto ? '自動シャッター：オン' : '自動シャッター：オフ（手動で撮影）'); };
async function openCam() {
  if (!camSupported) return;
  try {
    // iOS は ImageCapture が無いため、動画を最大解像度で開いてそのコマを静止画に使う
    cam.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } } });
  } catch (e) {
    try { cam.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } }); }
    catch (e2) { toast(e2 && e2.name === 'NotAllowedError' ? 'カメラの使用が許可されていません（ブラウザの設定で許可してください）' : 'カメラを起動できませんでした'); return; }
  }
  cam.track = cam.stream.getVideoTracks()[0];
  cam.ic = null; cam.icFail = false;
  cam.photoMax = 0;
  if ('ImageCapture' in window) {
    try { cam.ic = new ImageCapture(cam.track); cam.ic.getPhotoCapabilities().then((c) => { cam.photoMax = (c && c.imageWidth && c.imageWidth.max) || 0; }).catch(() => {}); } catch (e) { cam.ic = null; }
  }
  const caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
  $('camTorch').classList.toggle('hidden', !caps.torch);
  try { if (!cam.audio) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) cam.audio = new AC(); } if (cam.audio && cam.audio.state === 'suspended') cam.audio.resume(); } catch (e) {}
  const v = $('vid'); v.srcObject = cam.stream; await v.play().catch(() => {});
  $('cam').classList.remove('hidden'); document.body.style.overflow = 'hidden';
  $('camBusy').classList.add('hidden');
  cam.running = true; cam.capturing = false; cam.fired = false; cam.hist = []; cam.motion = []; cam.last = null; cam.hint = { top: null, bot: null }; cam.ms = [];
  renderCamHint(); sizeCamOv(); loop();
}
function closeCam() {
  cam.running = false; clearTimeout(cam.timer);
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = null; cam.track = null; cam.ic = null; cam.torch = false; $('camTorch').classList.remove('on');
  $('cam').classList.add('hidden'); document.body.style.overflow = '';
}
$('camClose').onclick = closeCam;
// ライブ画面のタップで上端→下端のヒント（元映像の座標で保持。3回目で上端からやり直し）
function renderCamHint() {
  const h = cam.hint || {};
  $('camHint').textContent = h.top && h.bot ? '上端✓ 下端✓（タップでやり直し）' : h.top ? '次に下端をタップ' : '画面をタップ：上端→下端を示せます';
}
$('camOv').addEventListener('click', (e) => {
  if (!cam.running || cam.capturing) return;
  const v = $('vid'); if (!v.videoWidth) return;
  const r = $('camOv').getBoundingClientRect(), m = camMap();
  const p = { x: (e.clientX - r.left - m.ox) / m.s, y: (e.clientY - r.top - m.oy) / m.s };
  const h = cam.hint;
  if (!h.top || (h.top && h.bot)) { h.top = p; h.bot = null; } else { h.bot = p; if (h.bot.y < h.top.y) { const t = h.top; h.top = h.bot; h.bot = t; } }
  cam.hist = []; // ヒントが変わったら安定判定をやり直す
  if (navigator.vibrate) try { navigator.vibrate(15); } catch (er) {}
  renderCamHint(); drawCam();
});
$('camTorch').onclick = async () => {
  if (!cam.track) return;
  cam.torch = !cam.torch;
  try { await cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] }); $('camTorch').classList.toggle('on', cam.torch); }
  catch (e) { cam.torch = false; toast('ライトを点けられませんでした'); }
};
function sizeCamOv() { const c = $('camOv'), r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1; c.width = r.width * d; c.height = r.height * d; }
window.addEventListener('resize', () => { if (cam.running) sizeCamOv(); });
function camMap() {
  const v = $('vid'), r = $('camOv').getBoundingClientRect(), vw = v.videoWidth, vh = v.videoHeight;
  const s = Math.max(r.width / vw, r.height / vh);
  return { s, ox: (r.width - vw * s) / 2, oy: (r.height - vh * s) / 2 };
}
function grabLive() {
  const v = $('vid'), vw = v.videoWidth, vh = v.videoHeight;
  if (!vw) return null;
  const k = Math.min(1, LIVE_SIDE / Math.max(vw, vh));
  work.width = Math.round(vw * k); work.height = Math.round(vh * k);
  wctx.drawImage(v, 0, 0, work.width, work.height);
  const d = wctx.getImageData(0, 0, work.width, work.height);
  return { k, w: work.width, h: work.height, buf: d.data.buffer };
}
async function loop() {
  if (!cam.running || cam.capturing) return;
  const t0 = performance.now();
  const f = grabLive();
  if (f) {
    try {
      const h = cam.hint && cam.hint.top && cam.hint.bot ? { top: { x: cam.hint.top.x * f.k, y: cam.hint.top.y * f.k }, bot: { x: cam.hint.bot.x * f.k, y: cam.hint.bot.y * f.k } } : null;
      const tw = performance.now();
      const out = await call('live', { rgba: f.buf, w: f.w, h: f.h, mapSize: LIVE_MAPSIZE, hint: h }, [f.buf]);
      out.k = f.k; out.rtt = performance.now() - tw; onLive(out);
      // 処理が重い端末では解析解像度を下げる（直近5コマの中央値 > 350ms）
      cam.ms.push(out.ms); if (cam.ms.length > 5) cam.ms.shift();
      const med = [...cam.ms].sort((a, b) => a - b)[cam.ms.length >> 1];
      if (cam.ms.length === 5 && med > 350 && LIVE_SIDE > 800) { LIVE_SIDE = 800; cam.ms = []; }
      window.__liveStats = { side: LIVE_SIDE, ms: out.ms, rtt: out.rtt, n: (window.__liveStats ? window.__liveStats.n : 0) + 1 };
    } catch (e) { cam.last = null; }
  }
  if (!cam.running || cam.capturing) return;
  drawCam();
  if (cam.auto && !cam.fired && cam.info && cam.info.ready) { cam.fired = true; burst('auto'); return; }
  const dt = performance.now() - t0;
  cam.timer = setTimeout(loop, Math.max(30, 220 - dt)); // 毎秒4〜5回
}
function onLive(out) {
  cam.last = out;
  cam.hist.push(out.ok && out.res ? out.res.count : null); if (cam.hist.length > 8) cam.hist.shift();
  cam.motion.push(out.motion == null ? -1 : out.motion); if (cam.motion.length > 8) cam.motion.shift();
  cam.info = camStatus();
}
// 1行案内（優先順位：はみ出し→縦向き→近さ→角度→影→暗い/白とび→傾き→ブレ）と自動シャッターの条件
function camStatus() {
  const st = cam.last, items = [];
  const R = (msg, level, sub) => ({ items, msg, level, sub: sub || '', ready: false, stableN: 0 });
  if (!st) return R('カメラを準備しています…', 'warn');
  const s = st.status, L = st.light, res = st.res;
  if (!st.ok || !res || !s) {
    if (st.det && st.det.vertical) return R('スマホを90°回して、縞を横向きに', 'bad', '縞が縦向きになっています');
    return R('積んだ資材の側面を画面に入れてください', 'warn', '上の縁から下の縁まで全部');
  }
  // 傾き：検出した上端・下端の線の傾きから求める（det.tilt は画面全体の勾配で、影の縁などに引っ張られるため）
  const lat = res.lat, eT = (t) => { const a = latPoint(lat, t, lat.x0), b = latPoint(lat, t, lat.x1); return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; };
  const tilt = (eT(res.topT) + eT(res.botT)) / 2;
  const pitch = s.pitchPx / st.k, tiltOk = Math.abs(tilt) < TILT_MAX;
  const bOk = L ? !L.dark && !L.glare : true;
  items.push([tiltOk ? '傾き OK' : '水平に', tiltOk ? 'ok' : 'warn']);
  items.push([bOk ? '明るさ OK' : L.dark ? '暗い' : '白とび', bOk ? 'ok' : 'warn']);
  items.push([`1枚 ${pitch.toFixed(pitch < 10 ? 1 : 0)}px`, pitch >= PITCH_MIN ? 'ok' : pitch >= 4 ? 'warn' : 'bad']);
  const mNow = cam.motion.slice(-2), still = mNow.length === 2 && mNow.every((m) => m >= 0 && m <= MOTION_MAX), shaky = mNow.some((m) => m > MOTION_MAX);
  // 安定：枚数が STABLE_N 回連続で同じ
  const h = cam.hist; let stableN = 0; for (let i = h.length - 1; i >= 0 && h[i] !== null && h[i] === h[h.length - 1]; i--) stableN++;
  let msg = '', level = 'ok', sub = '';
  if (s.cutTop || s.cutBot) { msg = `${s.cutTop && s.cutBot ? '上下' : s.cutTop ? '上' : '下'}がはみ出しています。少し離れて`; level = 'bad'; sub = '上の縁から下の縁まで画面に入れる'; }
  else if (s.vertical) { msg = 'スマホを90°回して、縞を横向きに'; level = 'bad'; }
  else if (pitch < PITCH_MIN || s.tooFine || (s.small && pitch < 10)) { msg = 'もう少し近づいてください'; level = pitch < 4 ? 'bad' : 'warn'; sub = s.tooFine && pitch >= PITCH_MIN ? '縞が細かすぎます。積みが高いときは上下に分けて撮る' : `1枚が${pitch.toFixed(1)}pxしかありません（${PITCH_MIN}px以上）。積みが高いときは上下に分けて撮る`; }
  else if (s.angleWarn) { msg = '斜めがきついです。もっと正面から'; level = 'warn'; sub = '側面に対してまっすぐ立つ'; }
  else if (L && L.dark) { msg = '暗いです。ライトを点けてください'; level = 'warn'; sub = $('camTorch').classList.contains('hidden') ? '明るい場所へ、または照明を当てる' : '左下の💡を押す'; }
  else if (L && L.glare) { msg = '白とびしています。角度を少し変えて'; level = 'warn'; sub = '光の反射を避ける'; }
  else if (!tiltOk) { msg = 'スマホを水平に構えてください'; level = 'warn'; sub = `傾き ${Math.abs(tilt).toFixed(0)}°`; }
  else if (shaky) { msg = 'ブレています。動かさずに構えて'; level = 'warn'; sub = '脇をしめて、両手か壁で支える'; }
  const quality = !msg && still;
  const ready = quality && stableN >= STABLE_N && res.confidence !== 'low';
  if (!msg) {
    if (res.confidence === 'low') { msg = '縞がはっきりしません。近づくか正面から'; level = 'warn'; sub = '積みが高いときは上下に分けて撮る／光が横から当たる位置が見やすい'; }
    else if (!ready) { msg = 'そのまま動かさずに…'; level = 'ok'; sub = `安定まで ${Math.max(0, STABLE_N - stableN)}`; }
    else { msg = cam.auto ? '撮影します' : '数が安定しました。シャッターを押してください'; level = 'ok'; }
    // 影は現場では避けにくく、エンジン側で対処しているので撮影は止めない（案内だけ出す）
    if (L && L.shadow) sub = (sub ? sub + '／' : '') + '影の縁あり：避けられるなら立ち位置を変える';
  }
  return { items, msg, level, sub, ready, stableN: quality ? stableN : 0 };
}
window.__guideTest = (last, hist, motion) => { cam.last = last; cam.hist = hist; cam.motion = motion; return camStatus(); }; // 検証用
function drawCam() {
  const c = $('camOv'), g = c.getContext('2d'), d = window.devicePixelRatio || 1;
  g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, c.width, c.height);
  const st = cam.last, info = cam.info || camStatus();
  if (cam.hint && $('vid').videoWidth) {
    const m = camMap();
    for (const [p, col, lab] of [[cam.hint.top, '#4f8cff', '上端'], [cam.hint.bot, '#ff7a3d', '下端']]) {
      if (!p) continue; const q = { x: p.x * m.s + m.ox, y: p.y * m.s + m.oy };
      g.setLineDash([10, 6]); g.lineWidth = 2; g.strokeStyle = col; g.beginPath(); g.moveTo(0, q.y); g.lineTo(c.width, q.y); g.stroke(); g.setLineDash([]);
      g.beginPath(); g.arc(q.x, q.y, 14, 0, Math.PI * 2); g.fillStyle = col + '88'; g.fill(); g.lineWidth = 3; g.stroke();
      g.font = 'bold 15px sans-serif'; g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(lab, q.x + 20, q.y);
    }
  }
  $('camPills').innerHTML = info.items.map(([t, k]) => `<span class="cp ${k}">${t}</span>`).join('');
  $('camMsg').innerHTML = esc(info.msg) + (info.sub ? `<small>${esc(info.sub)}</small>` : '');
  $('camMsg').className = 'camGuide ' + info.level;
  $('camN').textContent = st && st.res ? st.res.count : '–';
  $('camSt').textContent = st && st.res ? (info.ready ? '安定' : '計測中') : '探しています';
  $('camSt').className = info.ready ? 'ok' : '';
  $('shutter').classList.toggle('ready', info.ready);
  $('shRing').style.strokeDashoffset = String(245 * (1 - Math.min(1, (info.stableN || 0) / STABLE_N)));
  $('camTorch').classList.toggle('blink', !!(st && st.light && st.light.dark && !cam.torch));
  if (!st || !st.res || !$('vid').videoWidth) return;
  const m = camMap(), K = 1 / st.k, lat = st.res.lat;
  const P = (p) => ({ x: p.x * K * m.s + m.ox, y: p.y * K * m.s + m.oy });
  const gap = (st.status.pitchPx * K) * m.s;
  g.strokeStyle = 'rgba(255,212,0,.85)';
  st.res.lines.forEach((t, i) => { const major = (i + 1) % 10 === 0; if (gap < 4 && !major) return; g.lineWidth = major ? 2.4 : 1.1; strokePoly(g, latPoly(lat, t, P, 12)); });
  g.lineWidth = 3; g.strokeStyle = info.ready ? '#3ddc84' : '#4f8cff'; strokePoly(g, latPoly(lat, st.res.topT, P, 12));
  g.strokeStyle = info.ready ? '#3ddc84' : '#ff7a3d'; strokePoly(g, latPoly(lat, st.res.botT, P, 12));
}
function feedback(kind) {
  // 振動（Android）。無ければ画面フラッシュ。どちらの場合も短い音
  if (navigator.vibrate) { try { navigator.vibrate(kind === 'done' ? [40, 60, 40] : 80); } catch (e) {} }
  const f = $('flash'); f.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
  try { const a = cam.audio; if (a) { const o = a.createOscillator(), gn = a.createGain(); o.frequency.value = kind === 'done' ? 1320 : 880; gn.gain.value = 0.08; o.connect(gn); gn.connect(a.destination); o.start(); o.stop(a.currentTime + 0.08); } } catch (e) {}
  window.__fb = (window.__fb || 0) + 1;
}
// 高解像度の1コマ: Android Chrome は ImageCapture.takePhoto()、失敗時・iOS は動画の最大解像度コマ
async function grabStill(usePhoto) {
  const v = $('vid');
  // 写真の方が動画より十分大きいときだけ takePhoto（1枚0.5〜1秒かかるため）。?photo=1 で強制
  const vmax = Math.max(v.videoWidth, v.videoHeight), forcePhoto = /[?&]photo=1/.test(location.search);
  if (usePhoto && cam.ic && !cam.icFail && (forcePhoto || cam.photoMax > vmax * 1.25)) {
    try {
      const blob = await Promise.race([cam.ic.takePhoto(), sleep(2500).then(() => { throw new Error('timeout'); })]);
      let bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      let c = toCanvas(bmp, bmp.width, bmp.height);
      // 写真の向きが動画と違う（縦横が逆）なら動画に合わせて回す
      if ((v.videoHeight > v.videoWidth) !== (c.height > c.width) && v.videoWidth) {
        const r = document.createElement('canvas'); r.width = c.height; r.height = c.width;
        const g = r.getContext('2d', { willReadFrequently: true }); g.translate(r.width, 0); g.rotate(Math.PI / 2); g.drawImage(c, 0, 0); c = r;
      }
      c._src = 'photo'; return c;
    } catch (e) { cam.icFail = true; }
  }
  const c = toCanvas(v, v.videoWidth, v.videoHeight); c._src = 'video'; return c;
}
async function burst(why) {
  if (!cam.running || cam.capturing) return;
  const v = $('vid'); if (!v.videoWidth) return;
  cam.capturing = true; clearTimeout(cam.timer);
  const hint = cam.hint ? { top: cam.hint.top, bot: cam.hint.bot } : null, vidW = v.videoWidth;
  feedback('shot');
  // takePhoto は1枚に0.5〜1秒かかるため、高解像度写真は1枚目だけ。残りは0.3秒間隔の動画コマ（計4コマで多数決）
  const N = 4, frames = [], times = [], t0 = performance.now();
  $('camBusy').classList.remove('hidden');
  for (let i = 0; i < N; i++) {
    $('camBusyTxt').textContent = `撮影中 ${i + 1}/${N}　動かさないで`;
    const ts = performance.now();
    try { frames.push(await grabStill(i === 0)); } catch (e) {}
    times.push(Math.round(performance.now() - ts));
    if (i < N - 1) await sleep(300);
  }
  const capMs = performance.now() - t0;
  feedback('done');
  closeCam();
  if (!frames.length) { toast('撮影できませんでした'); return; }
  tab(false); setImage(frames[0]);
  window.__lastBurst = { why, n: frames.length, src: frames.map((f) => f._src), capMs, times, w: frames[0].width, h: frames[0].height };
  // ライブ画面で示した上端・下端は、動画コマの座標に直して静止画の検出にも使う（写真コマは画角が違いうるので使わない）
  let detOpts = null;
  if (hint && hint.top && hint.bot && frames.every((f) => f._src === 'video')) {
    const k = frames[0].width / vidW;
    detOpts = { hint: { top: { x: hint.top.x * k, y: hint.top.y * k }, bot: { x: hint.bot.x * k, y: hint.bot.y * k } } };
  }
  window.__lastBurst.hint = !!detOpts;
  await runStill(frames, why === 'auto' ? 'camera-auto' : 'camera', detOpts);
  window.__lastBurst.totalMs = Math.round(performance.now() - t0);
}
$('shutter').onclick = () => burst('manual');

// ======================= PWA（圏外対応・更新通知・ホーム画面追加）=======================
if ('serviceWorker' in navigator && window.isSecureContext) {
  let refreshing = false; const hadCtl = !!navigator.serviceWorker.controller; // 初回インストール時は再読み込みしない
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (refreshing || !hadCtl) return; refreshing = true; location.reload(); });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => { $('updBar').classList.remove('hidden'); $('bUpd').onclick = () => { w.postMessage('skipWaiting'); $('updBar').classList.add('hidden'); }; };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => { const w = reg.installing; w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); }); });
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  }).catch(() => {});
}
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; if (!standalone) $('installBox').classList.remove('hidden'); });
$('bInstall').onclick = async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); try { await deferredPrompt.userChoice; } catch (e) {} deferredPrompt = null; $('installBox').classList.add('hidden'); };
if (!standalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
  $('installTxt').innerHTML = 'ホーム画面に追加すると、圏外でも起動でき、カメラ許可も聞かれにくくなります：<b>共有ボタン（□↑）→「ホーム画面に追加」</b>';
  $('bInstall').classList.add('hidden'); $('installBox').classList.remove('hidden');
}
syncDock(); sync();
})();
