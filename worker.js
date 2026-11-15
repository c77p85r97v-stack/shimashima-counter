// シマシマカウンター 計算用 Web Worker
// engine.js（DOM非依存）を読み込み、UIスレッドを止めずに検出・計数する。
// メッセージ: {id, type, ...} -> {id, ok, out | error}
//   live   : {rgba|gray, w, h}               -> Engine.analyzeLive の結果（直列化）＋ motion（コマ間差分）
//   still  : {frames:[{rgba|gray, w, h}]}    -> Engine.analyzeStill で多数決。コマは保持（再計算用）
//   analyze: {up, lo}                        -> 保持中の採用コマを手動の上端・下端で数え直す
//   detectHint: {roi?, hint?}                -> 半自動: 利用者の範囲・上端/下端ヒントで Engine.detect → analyze
//   useAuto                                  -> 自動の結果に戻す（「自動のまま数える」）
//   live の追加引数: mapSize（既定384）, hint（上端・下端のヒント）
//   still の追加引数: detOpts（{hint}。1コマ目で検出した縁を全コマに使う）
//   review : {lines}                         -> Engine.reReview（手動修正後の再点検）
//   imageToT / tToImage                      -> 保持中の結果の grid で座標変換（厳密値が要るとき用）
//   reset                                    -> 保持データを捨てる
importScripts('engine.js');

let still = null; // { frames:[{gray,w,h}], idx, res }
let prevThumb = null;

function grayOf(m) {
  if (m.gray) return m.gray instanceof Float32Array ? m.gray : new Float32Array(m.gray);
  return Engine.toGray(new Uint8ClampedArray(m.rgba), m.w, m.h);
}

// 表示用の格子: t（積みの正規化座標）と x（帯の左右）で grid.tToImage を標本化しておく。
// UI側はこれを補間して線を描き、タップを t に戻す（斜め補正が入っても表示が一致する）。
function lattice(grid, band, nx, nt) {
  const t0 = Math.min(-0.15, (grid.tMin ?? 0) - 0.02), t1 = Math.max(1.15, (grid.tMax ?? 1) + 0.02);
  const X = new Float32Array(nx * nt), Y = new Float32Array(nx * nt);
  for (let j = 0; j < nx; j++) {
    const x = band.x0 + ((band.x1 - band.x0) * j) / (nx - 1);
    for (let i = 0; i < nt; i++) {
      const t = t0 + ((t1 - t0) * i) / (nt - 1);
      const p = grid.tToImage(t, x);
      X[j * nt + i] = p.x; Y[j * nt + i] = p.y;
    }
  }
  return { nx, nt, t0, t1, x0: band.x0, x1: band.x1, X, Y };
}

function pack(res, w, h, full) {
  const band = res.band || { x0: res.grid.x0, x1: res.grid.x1 };
  const o = {
    w, h, count: res.count, lines: Array.from(res.lines), topT: res.topT ?? 0, botT: res.botT ?? 1,
    confidence: res.confidence, pitchPx: res.pitchPx, Hpx: res.Hpx, band, review: res.review,
    angleWarn: !!(res.grid && res.grid.angleWarn), beta: res.grid ? res.grid.beta : 0,
    lat: lattice(res.grid, band, full ? 17 : 9, full ? 401 : 161),
  };
  if (full) Object.assign(o, {
    ratio: res.ratio, columns: res.columns, polarity: res.polarity, plot: res.plot, minC: res.minC, maxC: res.maxC,
    candidates: (res.candidates || []).map((c) => ({ count: c.count, lines: Array.from(c.lines), topT: c.topT, botT: c.botT })),
    votes: res.votes || null, agreement: res.agreement ?? null, perFrame: res.perFrame || null, up: res.up || null, lo: res.lo || null,
    photometry: res.photometry || null, R: res.R,
    rr: res._r ? Float32Array.from(res._r) : null, tMin: res.grid ? res.grid.tMin : 0, tMax: res.grid ? res.grid.tMax : 1,
  });
  return o;
}

// コマ間差分（手ぶれ・動きの指標）: 32x24 に縮小し、平均で正規化した絶対差の平均（0〜255換算）
function motionOf(gray, w, h) {
  const TW = 32, TH = 24, t = new Float32Array(TW * TH);
  const sx = w / TW, sy = h / TH;
  let mean = 0;
  for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
    let s = 0, n = 0;
    for (let y = Math.floor(j * sy); y < Math.floor((j + 1) * sy); y += 2) for (let x = Math.floor(i * sx); x < Math.floor((i + 1) * sx); x += 2) { s += gray[y * w + x]; n++; }
    t[j * TW + i] = s / Math.max(1, n); mean += t[j * TW + i];
  }
  mean /= TW * TH;
  let d = null;
  if (prevThumb) { d = 0; for (let k = 0; k < t.length; k++) d += Math.abs(t[k] - prevThumb.t[k] * (mean / (prevThumb.mean || 1))); d /= t.length; }
  // 縞の細かさ（鮮明さの目安）: 横方向に対する縦方向の高周波エネルギー
  prevThumb = { t, mean };
  return d;
}

function sharpOf(gray, w, h, rect) {
  if (!rect) return null;
  const x0 = Math.max(1, Math.round(rect.x0 + (rect.x1 - rect.x0) * 0.3)), x1 = Math.min(w - 2, Math.round(rect.x1 - (rect.x1 - rect.x0) * 0.3));
  const y0 = Math.max(1, Math.round(rect.y0)), y1 = Math.min(h - 2, Math.round(rect.y1));
  let s = 0, n = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 3) { const i = y * w + x; const lap = 2 * gray[i] - gray[i - w] - gray[i + w]; s += lap * lap; n++; }
  return n ? Math.sqrt(s / n) : null;
}

const H = {
  live(m) {
    const gray = grayOf(m), t0 = performance.now();
    const motion = motionOf(gray, m.w, m.h);
    const r = Engine.analyzeLive(gray, m.w, m.h, Object.assign({ mapSize: m.mapSize || 384 }, m.hint ? { hint: m.hint } : {}));
    const det = r.det ? { ok: r.det.ok, rect: r.det.rect || null, tilt: r.det.tilt, vertical: !!r.det.vertical, reason: r.det.reason || null } : { ok: false };
    if (r.det && r.det.up && r.det.lo) det.edges = { up: r.det.up, lo: r.det.lo };
    const out = { ok: !!r.ok, det, light: r.light || null, status: r.status || null, motion, sharp: sharpOf(gray, m.w, m.h, det.rect), ms: 0 };
    if (r.ok && r.res) out.res = pack(r.res, m.w, m.h, false);
    out.ms = performance.now() - t0;
    return out;
  },
  still(m) {
    const t0 = performance.now();
    const frames = m.frames.map((f) => ({ gray: grayOf(f), w: f.w, h: f.h }));
    still = { frames, idx: 0, res: null, auto: null };
    prevThumb = null;
    const detOpts = m.detOpts || null; // カメラで上端・下端のヒントがあれば、1コマ目で検出して全コマに使う
    let res, up = null, lo = null, d0 = null;
    try {
      if (detOpts) { d0 = Engine.detect(frames[0].gray, frames[0].w, frames[0].h, detOpts); if (d0.ok) { up = d0.up; lo = d0.lo; } }
      res = up ? Engine.analyzeStill(frames, up, lo) : Engine.analyzeStill(frames);
    } catch (e) {
      // 自動で数えられない：最初に検出できたコマを表示用に残す（半自動で範囲を示してもらう）
      let i = 0, det = null;
      for (let k = 0; k < frames.length; k++) { let d; try { d = Engine.detect(frames[k].gray, frames[k].w, frames[k].h); } catch (er) { d = { ok: false }; } if (d.ok) { i = k; det = { up: d.up, lo: d.lo, rect: d.rect }; break; } }
      still = { frames: [frames[i]], idx: 0, res: null };
      return { ok: false, error: e.message || String(e), idx: i, det, ms: performance.now() - t0 };
    }
    // 採用コマ: 全コマで数えられたときは vote の frameIndex がそのまま使える。欠けたときは検出の一致で探す
    let idx = -1;
    if (res.perFrame && res.perFrame.length === frames.length && res.frameIndex != null && res.frameIndex >= 0) idx = res.frameIndex;
    if (idx < 0) {
      for (let k = 0; k < frames.length && idx < 0; k++) { if (up) { idx = 0; break; } try { const d = Engine.detect(frames[k].gray, frames[k].w, frames[k].h); if (d.ok && JSON.stringify(d.up) === JSON.stringify(res.up)) idx = k; } catch (e) {} }
      if (idx < 0) idx = 0;
    }
    const f = frames[idx];
    still = { frames: [f], idx: 0, res, autoRes: res }; // 採用コマだけ残してメモリを空ける
    return { ok: true, idx, res: pack(res, f.w, f.h, true), ms: performance.now() - t0 };
  },
  // 半自動: 利用者が示した範囲（roi）・上端/下端のヒントで検出し直して数える
  detectHint(m) {
    if (!still) throw new Error('画像がありません');
    const f = still.frames[0], t0 = performance.now(), opts = {};
    if (m.roi) opts.roi = m.roi;
    if (m.hint) opts.hint = m.hint;
    let d = null;
    try { d = Engine.detect(f.gray, f.w, f.h, opts); } catch (e) { d = { ok: false, reason: e.message }; }
    let up, lo, method = d && d.method;
    if (d && d.ok) { up = d.up; lo = d.lo; }
    else if (m.hint) {
      // 検出できなくてもヒントがあれば、ヒントを通る水平な縁で数える（範囲があればその幅）
      const xa = m.roi ? m.roi.x0 : Math.max(0, m.hint.top.x - f.w * 0.2), xb = m.roi ? m.roi.x1 : Math.min(f.w - 1, m.hint.top.x + f.w * 0.2);
      up = [{ x: xa, y: m.hint.top.y }, { x: xb, y: m.hint.top.y }]; lo = [{ x: xa, y: m.hint.bot.y }, { x: xb, y: m.hint.bot.y }]; method = 'hint-direct';
    } else throw new Error('示した範囲で積みを見つけられませんでした。上端・下端もタップしてください');
    const res = Engine.analyze(f.gray, f.w, f.h, up, lo);
    res.up = up; res.lo = lo;
    still.res = res;
    return { ok: true, idx: 0, method, res: pack(res, f.w, f.h, true), ms: performance.now() - t0 };
  },
  analyze(m) {
    if (!still) throw new Error('画像がありません');
    const f = still.frames[still.idx];
    const res = Engine.analyze(f.gray, f.w, f.h, m.up, m.lo);
    res.up = m.up; res.lo = m.lo;
    still.res = res;
    return { ok: true, idx: still.idx, res: pack(res, f.w, f.h, true) };
  },
  useAuto() { if (!still || !still.autoRes) throw new Error('自動の結果がありません'); still.res = still.autoRes; return true; },
  review(m) { if (!still || !still.res) throw new Error('結果がありません'); return Engine.reReview(still.res, m.lines); },
  imageToT(m) { return still.res.grid.imageToT(m.x, m.y); },
  tToImage(m) { return still.res.grid.tToImage(m.t, m.x); },
  reset() { still = null; prevThumb = null; return true; },
  ping() { return { ok: true, engine: typeof Engine === 'object' }; },
};

onmessage = (e) => {
  const m = e.data;
  let out;
  try {
    const fn = H[m.type];
    if (!fn) throw new Error('unknown ' + m.type);
    out = fn(m);
    postMessage({ id: m.id, ok: true, out });
  } catch (err) {
    postMessage({ id: m.id, ok: false, error: (err && err.message) || String(err) });
  }
};
