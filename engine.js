// ===== core: 共通ユーティリティ（全担当が使う。変更は統合担当のみ）=====
const Core = (() => {
  function toGray(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    return g;
  }
  function bilinear(g, w, h, x, y) {
    x = Math.min(Math.max(x, 0), w - 1); y = Math.min(Math.max(y, 0), h - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const dx = x - x0, dy = y - y0;
    return (g[y0 * w + x0] * (1 - dx) + g[y0 * w + x1] * dx) * (1 - dy) + (g[y1 * w + x0] * (1 - dx) + g[y1 * w + x1] * dx) * dy;
  }
  function fft(re, im) {
    const P = re.length;
    for (let i = 1, j = 0; i < P; i++) {
      let bit = P >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= P; len <<= 1) {
      const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < P; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const n = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = n;
        }
      }
    }
  }
  function movAvg(x, win) {
    const n = x.length, out = new Float64Array(n), h = Math.max(1, Math.floor(win / 2));
    const cs = new Float64Array(n + 1); for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + x[i];
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - h), b = Math.min(n, i + h + 1); out[i] = (cs[b] - cs[a]) / (b - a); }
    return out;
  }
  function gaussSmooth(x, sigma) {
    if (sigma < 0.5) return x;
    const r = Math.ceil(sigma * 3), k = []; let s = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); s += v; }
    const n = x.length, out = new Float64Array(n);
    for (let i = 0; i < n; i++) { let a = 0; for (let j = -r; j <= r; j++) { const q = Math.min(n - 1, Math.max(0, i + j)); a += x[q] * k[j + r]; } out[i] = a / s; }
    return out;
  }
  function boxBlur(a, w, h, r) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) { s += a[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; } }
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      o[y * w + x] = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
    return o;
  }
  return { toGray, bilinear, fft, movAvg, gaussSmooth, boxBlur };
})();

// ===== geometry（幾何担当）: 縁・帯・平行化グリッド・積みの自動検出 =====
// 契約:
//   Geometry.rectify(gray, w, h, upper, lower, opts) -> grid
//     grid = { nc, R, tMin, tMax, Hpx, x0, x1, colX, colH,
//              map(j, s) -> {x, y}   // 列j の補正後の位置 s（0=上端,1=下端、シートが等間隔になる座標）を画像座標へ
//              colWeight: Float64Array(nc),  // 列の重み（既定は全て1。opts.colWeight='near' で列の高さ²）
//              tToImage(s, x) -> {x, y}, imageToT(x, y) -> s,  // 表示・タップ用（x は画像座標）。β込みで正確に往復
//              beta,            // 上下の遠近の1次元射影補正。画像上の正規化位置 t と s の関係: t = s(1+β)/(1+βs), s = t/(1+β(1−t))
//                               // β>0: 上側が手前（上のシートが厚く写る）。上辺幅/下辺幅 ≈ 1+β。既定は自動推定（opts.beta で固定、opts.perspective=false で 0）
//              pitchFarPx,      // 奥側の1枚の px（概算）
//              angleWarn,       // 角度がきつい：奥側の1枚 < 4px、|β| > 0.5、左右の高さ比 < 0.45
//              tooFine,         // 1枚が細かすぎる（< 3px、またはナイキスト近くに数えていない縞のエネルギー）
//              describe() -> 純データ {v,w,h,x0,x1,nc,R,tMin,tMax,Hpx,beta,pitchFarPx,angleWarn,tooFine,upper,lower}（postMessage 可）
//              survey: { cEst, conc, ... }  // 下見の診断値 }
//     t のサンプル位置: i=0..R-1 で s = tMin + (tMax - tMin) * i / (R - 1)
//   Geometry.fromDescription(desc) -> { ...desc, tToImage, imageToT, top(x), bot(x) }   // describe() から変換を復元
//   Geometry.detect(gray, w, h, opts) -> { ok, up, lo (各5点), rect, tilt(縁の傾き,度), stripeTilt, vertical, reason?,
//     opts.roi = {x0,y0,x1,y1}  利用者がなぞった大まかな範囲（その中で検出。座標は画像全体のまま返す。d.roi に使った範囲）
//     opts.hint = {top:{x,y}, bot:{x,y}}  上端・下端を1点ずつ。検出した縁がヒントから半枚以上ずれたら、ヒントを通るよう移して近くの段差へ寄せる
//     d.method: 'v2'（縞の強さのプロファイル）| 'v3'（線のそろい具合の領域）| 'hint'、d.hybrid: 両者の選択の根拠
//                                         faces:[{up,lo,x0,x1,score}], chosen, corner, pallet, pitchPx, tooFine, method }
//   Geometry.edges(w, h, upper, lower) -> { top(x), bot(x), x0, x1 }
const Geometry = (() => {
  const { gaussSmooth, boxBlur, bilinear, fft, movAvg } = Core;
  function dedupe(pts) {
    const s = [...pts].sort((a, b) => a.x - b.x), out = [];
    for (const p of s) {
      const q = out[out.length - 1];
      if (q && Math.abs(q.x - p.x) < 3) { q.y = (q.y * q.n + p.y) / (q.n + 1); q.x = (q.x * q.n + p.x) / (q.n + 1); q.n++; }
      else out.push({ x: p.x, y: p.y, n: 1 });
    }
    return out;
  }
  function makeEdge(pts, fallbackSlope) {
    const p = dedupe(pts);
    if (p.length === 1) return (x) => p[0].y + fallbackSlope * (x - p[0].x);
    return (x) => {
      let i = 0;
      if (x <= p[0].x) i = 0; else if (x >= p[p.length - 1].x) i = p.length - 2;
      else while (i < p.length - 2 && x > p[i + 1].x) i++;
      const a = p[i], b = p[i + 1];
      return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
    };
  }
  const slopeOf = (pts) => { const p = dedupe(pts); if (p.length < 2) return null; const a = p[0], b = p[p.length - 1]; return (b.y - a.y) / (b.x - a.x); };
  function edges(w, h, upper, lower) {
    if (!upper.length || !lower.length) throw new Error('上端と下端の点をそれぞれ1つ以上打ってください');
    const su = slopeOf(upper), sl = slopeOf(lower);
    const top = makeEdge(upper, su ?? sl ?? 0), bot = makeEdge(lower, sl ?? su ?? 0);
    const xs = [...upper, ...lower].map((p) => p.x);
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    const midX = (x0 + x1) / 2, Hc = bot(midX) - top(midX);
    if (Hc < 12) throw new Error('下端の点は上端の点より下に打ってください（間隔が狭すぎます）');
    if (x1 - x0 < 40) { const half = Math.max(25, Hc * 0.06); x0 = midX - half; x1 = midX + half; }
    x0 = Math.max(0, x0); x1 = Math.min(w - 1, x1);
    return { top, bot, x0, x1 };
  }
  // ---- 1次元射影補正 ----
  // s: 補正後の座標（シートが等間隔に並ぶ）, t: 画像上の上端→下端の正規化位置
  //   t = s(1+β)/(1+βs),  s = t/(1+β(1−t))
  //   β>0: 上側が手前（上のシートが厚く写る）、β<0: 上側が奥。上辺幅/下辺幅 ≈ 1+β
  const sToT = (s, b) => (b === 0 ? s : (s * (1 + b)) / (1 + b * s));
  const tToS = (t, b) => (b === 0 ? t : t / (1 + b * (1 - t)));
  const BMAX = 0.6;
  const TF_CONC = 0.25, TF_NYQ = 0.1; // tooFine の閾値（下見スペクトル）
  // 補正後プロファイルのスペクトルの「主ピークへのエネルギー集中度」
  function peakConc(q, M, b, P, re, im, minC, maxC, out, hwC = 0.6) {
    const m = q.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    const v = out || new Float64Array(M);
    for (let i = 0; i < M; i++) {
      const t = sToT(i / (M - 1), b) * (m - 1);
      const k = Math.min(m - 2, Math.max(0, Math.floor(t))), f = t - k;
      v[i] = q[k] * (1 - f) + q[k + 1] * f;
      sx += i; sy += v[i]; sxx += i * i; sxy += i * v[i];
    }
    const sl = (M * sxy - sx * sy) / (M * sxx - sx * sx || 1), ic = (sy - sl * sx) / M;
    re.fill(0); im.fill(0);
    for (let i = 0; i < M; i++) re[i] = (v[i] - ic - sl * i) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (M - 1)));
    fft(re, im);
    const k0 = Math.max(1, Math.floor((minC * P) / (M - 1))), k1 = Math.min(P / 2 - 2, Math.ceil((maxC * P) / (M - 1)));
    let tot = 0, km = k0, vm = -1;
    for (let k = k0; k <= k1; k++) { const e = re[k] * re[k] + im[k] * im[k]; re[k] = e; tot += e; if (e > vm) { vm = e; km = k; } }
    // ピーク±hwC枚分のエネルギー / 帯域全体（粗い探索では窓を広げて目的関数をなめらかにする）
    const hw = Math.max(1, Math.round((hwC * P) / (M - 1)));
    let pk = 0; for (let k = Math.max(k0, km - hw); k <= Math.min(k1, km + hw); k++) pk += re[k];
    // 基本周波数の推定（倍音を加味）
    return { conc: pk / (tot || 1e-12), spec: re, kmax: km, k0, k1 };
  }
  function fundamental(spec, P, M, minC, maxC) {
    const S = (c) => { const k = (c * P) / (M - 1), a = Math.floor(k); if (a + 1 >= P / 2) return 0; return spec[a] * (1 - (k - a)) + spec[a + 1] * (k - a); };
    let bc = minC, bv = -1;
    for (let c = minC; c <= maxC; c += 0.25) { const v = S(c) + 0.5 * S(2 * c) + 0.33 * S(3 * c); if (v > bv) { bv = v; bc = c; } }
    return bc;
  }
  // 速い下見: 少数の列で画像 t 空間のプロファイルを作り、β・列の明瞭さ・概算枚数を求める
  function survey(gray, w, h, colX, top, bot, Hpx, opts) {
    const nc = colX.length, nq = Math.min(nc, 24);
    const m = Math.max(64, Math.min(1600, Math.round(1.3 * Hpx)));
    const cols = [], qx = [];
    const mean = new Float64Array(m);
    for (let q = 0; q < nq; q++) {
      const j = Math.min(nc - 1, Math.floor(((q + 0.5) * nc) / nq)), x = colX[j], a = top(x), b = bot(x);
      const c = new Float64Array(m); let mu = 0;
      for (let i = 0; i < m; i++) { c[i] = bilinear(gray, w, h, x, a + ((b - a) * i) / (m - 1)); mu += c[i]; }
      mu /= m; let ss = 0; for (let i = 0; i < m; i++) { c[i] -= mu; ss += c[i] * c[i]; }
      const sd = Math.sqrt(ss / m) || 1; for (let i = 0; i < m; i++) { c[i] /= sd; mean[i] += c[i] / nq; }
      cols.push(c); qx.push(j);
    }
    const M = Math.min(2048, m), P = 2 * (1 << Math.ceil(Math.log2(M)));
    const re = new Float64Array(P), im = new Float64Array(P), buf = new Float64Array(M);
    const minC = 3, maxC = Math.max(minC + 1, Math.min((M - 1) / 2.5, Hpx / 2.2));
    // β の探索は縞の帯域だけで評価する（照明ムラ・影などの低い周波数に引っぱられないように）
    // さらに、β=0 での基本周波数（倍音込み）の近く（0.55〜1.8倍）だけで集中度を見る：
    // 影の縁・はみ出し・合板の層など、シート以外の強い成分に β を合わせてしまうのを防ぐ
    const rz = peakConc(mean, M, 0, P, re, im, minC, maxC, buf);
    const c0 = fundamental(rz.spec, P, M, minC, maxC);
    const minCb = Math.max(Math.min(10, maxC - 1), 0.55 * c0), maxCb = Math.min(maxC, Math.max(minCb + 2, 1.8 * c0));
    const scache = new Map();
    const sc = (b, hwC) => { const key = Math.round(b * 1e4) + ':' + hwC; if (!scache.has(key)) scache.set(key, peakConc(mean, M, b, P, re, im, minCb, maxCb, buf, hwC).conc); return scache.get(key); };
    let beta = 0, s0 = sc(0, 0.6), conc = s0, betaGain, betaRaw;
    if (opts.beta !== undefined) { beta = opts.beta; conc = sc(beta, 0.6); }
    else if (opts.perspective !== false && c0 >= 12) {
      // 主ピークの位置（概算枚数）。誤った β ではピークが ±N·Δβ 程度に広がる
      const r0 = peakConc(mean, M, 0, P, re, im, minCb, maxCb, buf);
      const cpk = (r0.kmax * (M - 1)) / P;
      const win = (st) => Math.max(0.6, cpk * st * 1.2);
      let bb = 0, bv = -1;
      for (let b = -BMAX; b <= BMAX + 1e-9; b += 0.1) { const v = sc(Math.round(b * 1e4) / 1e4, win(0.1)); if (v > bv) { bv = v; bb = b; } }
      for (const st of [0.04, 0.015, 0.005]) {
        const c0 = bb; bv = -1;
        for (let k = -2; k <= 2; k++) { const b = Math.round((c0 + k * st) * 1e4) / 1e4; if (Math.abs(b) > BMAX + 1e-9) continue; const v = sc(b, win(st)); if (v > bv) { bv = v; bb = b; } }
      }
      bb = Math.round(bb * 1e4) / 1e4;
      const v1 = sc(bb, 0.6);
      // β=0 を優先する正則化：集中度が十分に上がった時だけ採用
      betaGain = v1 / (s0 || 1e-12); betaRaw = bb;
      const need = 1.25 + 1.0 * Math.abs(bb);
      if (betaGain > need) {
        // 枚数が少ない（基本周波数 < 12）なら β は使わない：効果が小さく、誤推定の害が大きい
        const rb = peakConc(mean, M, bb, P, re, im, minC, maxC, buf);
        if (fundamental(rb.spec, P, M, minC, maxC) >= 12) beta = bb;
      }
    }
    conc = sc(beta, 0.6);
    const res = peakConc(mean, M, beta, P, re, im, minC, maxC, buf);
    const cEst = fundamental(res.spec, P, M, minC, maxC);
    // 細かすぎる縞の目安：1枚 3.5px 未満に当たる帯域のエネルギー割合
    let eAll = 0, eFine = 0; const cFine = Hpx / 3.5;
    for (let k = res.k0; k <= res.k1; k++) { eAll += res.spec[k]; if ((k * (M - 1)) / P > cFine) eFine += res.spec[k]; }
    const fineFrac = eFine / (eAll || 1e-12);
    // ナイキスト近く（1枚 1.5〜2.6px）のエネルギー割合（帯域制限なしの別計算）
    let nyq = 0;
    { const r2 = peakConc(mean, M, beta, P, re, im, 1, (M - 1) / 2.05, buf); let a = 0, b = 0;
      const cLo = Hpx / 2.6, cHi = Hpx / 1.5;
      for (let k = r2.k0; k <= r2.k1; k++) { const c = (k * (M - 1)) / P; const v = r2.spec[k]; if (c < Hpx / 40) continue; a += v; if (c >= cLo && c <= cHi) b += v; }
      nyq = b / (a || 1e-12); }
    // 列ごとの明瞭さ：t空間のハイパス後に平均プロファイルと相関
    const pw = Math.max(3, Math.round((m / cEst) * 1.0));
    const hpf = (x) => { const b2 = movAvg(x, pw), o = new Float64Array(m); for (let i = 0; i < m; i++) o[i] = x[i] - b2[i]; return o; };
    const mh = hpf(mean); let mm = 0; for (let i = 0; i < m; i++) mm += mh[i] * mh[i];
    const clar = new Float64Array(nq);
    for (let q = 0; q < nq; q++) {
      const ch = hpf(cols[q]); let cc = 0, c2 = 0;
      for (let i = 0; i < m; i++) { cc += ch[i] * mh[i]; c2 += ch[i] * ch[i]; }
      clar[q] = Math.max(0, cc / Math.sqrt(c2 * mm + 1e-12));
    }
    return { beta, conc, cEst, clar, qx, betaGain, betaRaw, fineFrac, nyq };
  }
  function rectify(gray, w, h, upper, lower, opts = {}) {
    const e = edges(w, h, upper, lower);
    const { top, bot, x0, x1 } = e;
    const nc = Math.max(8, Math.min(400, Math.round(x1 - x0)));
    const colX = Float64Array.from({ length: nc }, (_, j) => x0 + ((x1 - x0) * (j + 0.5)) / nc);
    let Hpx = 0, Hmin = Infinity; const colH = new Float64Array(nc);
    for (let j = 0; j < nc; j++) { colH[j] = bot(colX[j]) - top(colX[j]); Hpx = Math.max(Hpx, colH[j]); Hmin = Math.min(Hmin, colH[j]); }
    if (Hpx < 12) throw new Error('下端の点は上端の点より下に打ってください');
    const sv = survey(gray, w, h, colX, top, bot, Hpx, opts);
    const beta = sv.beta;
    const R = Math.min(12000, Math.round(2 * Hpx * (1 + 2 * Math.max(0, opts.tMargin || 0))) + 1);
    const m = Math.max(0, opts.tMargin || 0); // 上下の余白（端を動かす計数のため）。0なら t∈[0,1]
    const tMin = -m, tMax = 1 + m;
    // 列の重み：手前（列の高さpx）重視 × 縞の明瞭さ
    const colWeight = new Float64Array(nc);
    const { clar, qx } = sv;
    let cmax = 0; for (const c of clar) cmax = Math.max(cmax, c);
    for (let j = 0; j < nc; j++) {
      let c;
      if (j <= qx[0]) c = clar[0]; else if (j >= qx[qx.length - 1]) c = clar[qx.length - 1];
      else { let q = 0; while (q < qx.length - 2 && j > qx[q + 1]) q++; const f = (j - qx[q]) / (qx[q + 1] - qx[q] || 1); c = clar[q] * (1 - f) + clar[q + 1] * f; }
      const cl = cmax > 0 ? Math.max(0.1, c / cmax) : 1;
      const hr = colH[j] / Hpx;
      // 既定は 1（M1 の photometry が列ごとの正規化・重み付けをするため、手前重視はベンチで悪化した）。opts.colWeight='near' で高さ²の重み
      colWeight[j] = opts.colWeight === 'near' ? hr * hr : 1;
    }
    const map = (j, s) => { const x = colX[j], a = top(x); return { x, y: a + sToT(s, beta) * (bot(x) - a) }; };
    const tToImage = (s, x) => { const a = top(x); return { x, y: a + sToT(s, beta) * (bot(x) - a) }; };
    const imageToT = (x, y) => { const a = top(x); return tToS((y - a) / (bot(x) - a), beta); };
    // 角度の限界：奥側の1枚の px と |β|、左右の高さ比
    const pitchFarPx = (Hmin / Math.max(1, sv.cEst)) * Math.min(1 + beta, 1 / (1 + beta));
    const pitchPx = Hpx / Math.max(1, sv.cEst);
    // 1枚 3px 未満、または「ナイキスト近くに数えていない細かい縞のエネルギーがある」
    const tooFine = pitchPx < 3 || (sv.nyq > TF_NYQ && sv.conc < TF_CONC && pitchPx > 3.5);
    const angleWarn = pitchFarPx < 4 || Math.abs(beta) > 0.5 || Hmin / Hpx < 0.45;
    const pts = (P) => dedupe(P).map((q) => ({ x: q.x, y: q.y }));
    const describe = () => ({ v: 1, w, h, x0, x1, nc, R, tMin, tMax, Hpx, beta, pitchFarPx, angleWarn, tooFine,
      upper: pts(upper), lower: pts(lower) });
    return { nc, R, tMin, tMax, Hpx, x0, x1, colX, colH, map, colWeight, tToImage, imageToT, beta, pitchFarPx, angleWarn, tooFine, describe, edges: e,
      survey: { cEst: sv.cEst, conc: sv.conc, fineFrac: sv.fineFrac, nyq: sv.nyq, betaGain: sv.betaGain, betaRaw: sv.betaRaw } };
  }
  // 縁の傾き（度）：上端・下端の両端を結ぶ直線の傾きの平均。画像座標（y下向き）で右下がりが正
  function edgeTilt(up, lo) {
    const sl = (P) => { const a = P[0], b = P[P.length - 1]; return P.length >= 2 && b.x !== a.x ? (b.y - a.y) / (b.x - a.x) : null; };
    const v = [sl(up), sl(lo)].filter((x) => x !== null);
    return v.length ? (Math.atan(v.reduce((a, b) => a + b, 0) / v.length) * 180) / Math.PI : 0;
  }
  function runAround(p, thr, seed, maxGap) {
    let a = seed, b = seed, gap = 0;
    for (let i = seed - 1; i >= 0; i--) { if (p[i] > thr) { a = i; gap = 0; } else if (++gap > maxGap) break; }
    gap = 0;
    for (let i = seed + 1; i < p.length; i++) { if (p[i] > thr) { b = i; gap = 0; } else if (++gap > maxGap) break; }
    return [a, b];
  }
  function detectLegacy(gray, w, h) {
    const k = Math.max(1, Math.round(Math.max(w, h) / 240)), sw = Math.floor(w / k), sh = Math.floor(h / k);
    const sm = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let s = 0; for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += gray[(y * k + j) * w + x * k + i];
      sm[y * sw + x] = s / (k * k);
    }
    const gx = new Float32Array(sw * sh), gy = new Float32Array(sw * sh);
    for (let y = 1; y < sh * k - 1 && y < h - 1; y++) {
      const by_ = Math.floor(y / k); if (by_ >= sh) break;
      for (let x = 1; x < sw * k - 1 && x < w - 1; x++) {
        const bx_ = Math.floor(x / k); if (bx_ >= sw) break;
        const i = y * w + x;
        gx[by_ * sw + bx_] += Math.abs(gray[i + 1] - gray[i - 1]);
        gy[by_ * sw + bx_] += Math.abs(gray[i + w] - gray[i - w]);
      }
    }
    for (let i = 0; i < gx.length; i++) { gx[i] /= k * k; gy[i] /= k * k; }
    const bx = boxBlur(gx, sw, sh, 3), by = boxBlur(gy, sw, sh, 3);
    const st = new Float32Array(sw * sh);
    for (let i = 0; i < st.length; i++) st[i] = Math.max(0, by[i] - 1.3 * bx[i]);
    let Jxx = 0, Jyy = 0, Jxy = 0;
    for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
      const dx = sm[y * sw + x + 1] - sm[y * sw + x - 1], dy = sm[(y + 1) * sw + x] - sm[(y - 1) * sw + x];
      Jxx += dx * dx; Jyy += dy * dy; Jxy += dx * dy;
    }
    const gradAngle = 0.5 * Math.atan2(2 * Jxy, Jxx - Jyy) * 180 / Math.PI;
    const tilt = gradAngle > 0 ? gradAngle - 90 : gradAngle + 90;
    const vertical = Jxx > 1.5 * Jyy;
    const rp = new Float64Array(sh);
    const cx0 = Math.floor(sw * 0.3), cx1 = Math.ceil(sw * 0.7);
    for (let y = 0; y < sh; y++) { let s = 0; for (let x = cx0; x < cx1; x++) s += st[y * sw + x]; rp[y] = s / (cx1 - cx0); }
    const rps = gaussSmooth(rp, 1.5);
    let ym = 0; for (let y = Math.floor(sh * 0.1); y < sh * 0.9; y++) if (rps[y] > rps[ym]) ym = y;
    if (rps[ym] < 1.5) return { ok: false, reason: 'none', tilt, vertical };
    const [y0, y1] = runAround(rps, rps[ym] * 0.3, ym, 4);
    const cp = new Float64Array(sw);
    for (let x = 0; x < sw; x++) { let s = 0; for (let y = y0; y <= y1; y++) s += st[y * sw + x]; cp[x] = s / (y1 - y0 + 1); }
    const cps = gaussSmooth(cp, 1.5);
    let xm = Math.floor(sw / 2); for (let x = Math.floor(sw * 0.2); x < sw * 0.8; x++) if (cps[x] > cps[xm]) xm = x;
    const [x0, x1] = runAround(cps, cps[xm] * 0.3, xm, 3);
    if (y1 - y0 < sh * 0.1 || x1 - x0 < sw * 0.1) return { ok: false, reason: 'small', tilt, vertical };
    const X0 = x0 * k, X1 = (x1 + 1) * k, Y0 = y0 * k, Y1 = (y1 + 1) * k, Hs = Y1 - Y0;
    const cols = [X0 + 0.18 * (X1 - X0), (X0 + X1) / 2, X1 - 0.18 * (X1 - X0)];
    const half = Math.max(3, Math.round((X1 - X0) * 0.04));
    const win = Math.max(4 * k, Math.round(Hs * 0.06));
    const refine = (xc, yc, dirDown) => {
      const ya = Math.max(2, Math.round(yc - win)), yb = Math.min(h - 3, Math.round(yc + win));
      const p = [];
      for (let y = ya - 4; y <= yb + 4; y++) { let s = 0, n = 0; for (let x = Math.round(xc - half); x <= Math.round(xc + half); x++) { if (x < 0 || x >= w || y < 0 || y >= h) continue; s += gray[y * w + x]; n++; } p.push(n ? s / n : 0); }
      const steps = [];
      for (let y = ya; y <= yb; y++) { const i = y - (ya - 4); steps.push(Math.abs((p[i] + p[i + 1] + p[i + 2]) / 3 - (p[i - 1] + p[i - 2] + p[i - 3]) / 3)); }
      const mx = Math.max(...steps);
      const order = steps.map((_, j) => j); if (!dirDown) order.reverse();
      let j0 = order.find((j) => steps[j] >= 0.6 * mx);
      while (j0 + 1 < steps.length && steps[j0 + 1] > steps[j0] && dirDown) j0++;
      while (j0 - 1 >= 0 && steps[j0 - 1] > steps[j0] && !dirDown) j0--;
      return ya + j0 - 0.5;
    };
    const up = cols.map((x) => ({ x, y: refine(x, Y0, true) }));
    const lo = cols.map((x) => ({ x, y: refine(x, Y1, false) }));
    return { ok: true, up, lo, rect: { x0: X0, x1: X1, y0: Y0, y1: Y1 }, tilt: edgeTilt(up, lo), stripeTilt: tilt, vertical };
  }
  // ---- 自動検出 v2 ----
  // 対数輝度（影の中の縞も明部と同じ強さに）
  const LOG = (() => { const a = new Float32Array(256); for (let v = 0; v < 256; v++) a[v] = 130 * Math.log((v + 10) / 10); return a; })();
  const lg = (v) => LOG[v <= 0 ? 0 : v >= 255 ? 255 : v | 0];
  function blurHV(a, w, h, rx, ry) {
    const t = new Float32Array(w * h), o = new Float32Array(w * h);
    const cr = new Float64Array(w + 1);
    for (let y = 0; y < h; y++) { const r = y * w, cs = cr;
      for (let x = 0; x < w; x++) cs[x + 1] = cs[x] + a[r + x];
      for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - rx), x1 = Math.min(w, x + rx + 1); t[r + x] = (cs[x1] - cs[x0]) / (x1 - x0); } }
    const cs = new Float64Array(h + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) cs[y + 1] = cs[y] + t[y * w + x];
      for (let y = 0; y < h; y++) { const y0 = Math.max(0, y - ry), y1 = Math.min(h, y + ry + 1); o[y * w + x] = (cs[y1] - cs[y0]) / (y1 - y0); }
    }
    return o;
  }
  function lsLine(pts, wts) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach((p, i) => { const q = wts ? wts[i] : 1; sw += q; sx += q * p.x; sy += q * p.y; sxx += q * p.x * p.x; sxy += q * p.x * p.y; });
    const d = sw * sxx - sx * sx; const b = Math.abs(d) < 1e-9 ? 0 : (sw * sxy - sx * sy) / d; const a = (sy - b * sx) / (sw || 1);
    return [a, b];
  }
  function lsPoly(pts, deg) {
    // 正規方程式（x は中心化してスケール）
    const n = deg + 1, xm = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const sc = Math.max(1, Math.max(...pts.map((p) => Math.abs(p.x - xm))));
    const A = Array.from({ length: n }, () => new Float64Array(n + 1));
    for (const p of pts) { const u = (p.x - xm) / sc; const pw = [1]; for (let i = 1; i < n; i++) pw.push(pw[i - 1] * u);
      for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) A[i][j] += pw[i] * pw[j]; A[i][n] += pw[i] * p.y; } }
    for (let i = 0; i < n; i++) { let piv = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      [A[i], A[piv]] = [A[piv], A[i]]; if (Math.abs(A[i][i]) < 1e-12) return null;
      for (let r = 0; r < n; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c]; } }
    const c = A.map((row, i) => row[n] / row[i]);
    return (x) => { const u = (x - xm) / sc; let v = 0, pw = 1; for (let i = 0; i < n; i++) { v += c[i] * pw; pw *= u; } return v; };
  }
  // RANSAC で直線（必要なら2次曲線）を当てはめる
  function ransacEdge(pts, tol, allowQuad = true) {
    const n = pts.length; if (n < 2) return null;
    let best = null;
    const pairs = [];
    if (n <= 24) { for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]); }
    else { let sd = 12345; const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
      for (let t = 0; t < 300; t++) { const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n); if (i !== j) pairs.push([Math.min(i, j), Math.max(i, j)]); } }
    for (const [i, j] of pairs) {
      const p = pts[i], q = pts[j]; if (Math.abs(q.x - p.x) < 1e-6) continue;
      const b = (q.y - p.y) / (q.x - p.x), a = p.y - b * p.x;
      let cnt = 0, err = 0; for (const r of pts) { const d = Math.abs(r.y - a - b * r.x); if (d <= tol) { cnt++; err += d; } }
      if (!best || cnt > best.cnt || (cnt === best.cnt && err < best.err)) best = { cnt, err, a, b };
    }
    if (!best) return null;
    let inl = pts.filter((r) => Math.abs(r.y - best.a - best.b * r.x) <= tol);
    const [a, b] = lsLine(inl);
    inl = pts.filter((r) => Math.abs(r.y - a - b * r.x) <= tol);
    let f = (x) => a + b * x, kind = 'line';
    const rms = (g, P) => Math.sqrt(P.reduce((s, r) => s + (r.y - g(r.x)) ** 2, 0) / Math.max(1, P.length));
    if (allowQuad && n >= 6 && n <= 24) {
      // 反り: 2次曲線のほうが明らかに多く・よく合うなら採用
      let bq = null;
      for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) { const k = (i + j) >> 1;
        const g = lsPoly([pts[i], pts[k], pts[j]], 2); if (!g) continue;
        let cnt = 0, err = 0; for (const r of pts) { const d = Math.abs(r.y - g(r.x)); if (d <= tol) { cnt++; err += d; } }
        if (!bq || cnt > bq.cnt || (cnt === bq.cnt && err < bq.err)) bq = { cnt, err, g }; }
      if (bq) {
        const qi = pts.filter((r) => Math.abs(r.y - bq.g(r.x)) <= tol);
        const g2 = qi.length >= 4 ? lsPoly(qi, 2) : null;
        if (g2) {
          const qi2 = pts.filter((r) => Math.abs(r.y - g2(r.x)) <= tol);
          if (qi2.length >= inl.length + 2 || (qi2.length >= inl.length && rms(g2, qi2) < 0.5 * rms(f, inl) && rms(f, inl) > 1.0)) { f = g2; inl = qi2; kind = 'quad'; }
        }
      }
    }
    return { f, inliers: inl, kind, rms: rms(f, inl), slope: b };
  }
  // 折れ線（ヒンジ）当てはめ：角から撮った2面の境目を探す
  function hingeFit(pts0) {
    const sk = Math.max(1, Math.ceil(pts0.length / 60)), pts = pts0.filter((_, i) => i % sk === 0);
    const n = pts.length; if (n < 8) return null;
    const [a1, b1] = lsLine(pts); let sse1 = 0; for (const p of pts) sse1 += (p.y - a1 - b1 * p.x) ** 2;
    let best = null;
    for (let m = Math.floor(n * 0.15); m <= Math.ceil(n * 0.85) && m < n - 2; m++) {
      if (m < 3) continue;
      const xb = pts[m].x;
      // y = a + b x + c max(0, x - xb)
      let S = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
      for (const p of pts) { const v = [1, p.x - xb, Math.max(0, p.x - xb)]; for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) S[i][j] += v[i] * v[j]; S[i][3] += v[i] * p.y; } }
      for (let i = 0; i < 3; i++) { let piv = i; for (let r = i + 1; r < 3; r++) if (Math.abs(S[r][i]) > Math.abs(S[piv][i])) piv = r; [S[i], S[piv]] = [S[piv], S[i]];
        if (Math.abs(S[i][i]) < 1e-9) { S = null; break; } for (let r = 0; r < 3; r++) if (r !== i) { const f = S[r][i] / S[i][i]; for (let c = i; c < 4; c++) S[r][c] -= f * S[i][c]; } }
      if (!S) continue;
      const a = S[0][3] / S[0][0], b = S[1][3] / S[1][1], c = S[2][3] / S[2][2];
      let sse = 0; for (const p of pts) sse += (p.y - a - b * (p.x - xb) - c * Math.max(0, p.x - xb)) ** 2;
      if (!best || sse < best.sse) best = { sse, xb, c, b };
    }
    if (!best) return null;
    best.sse1 = sse1; return best;
  }
  // 画像中央の細い縦帯から縞の周期(px)を概算（大きなシートでも縞の途切れをつなぐため）
  function centerPitch(gray, w, h0, ya = 0, yb = h0) {
    ya = Math.max(0, Math.round(ya)); yb = Math.min(h0, Math.round(yb)); const h = yb - ya; if (h < 16) return 0;
    const hw = Math.max(2, Math.round(w * 0.01)), xc = Math.round(w / 2);
    let P = 1; while (P < 2 * h) P <<= 1;
    const re = new Float64Array(P), im = new Float64Array(P);
    let mu = 0; const p = new Float64Array(h); gray = gray.subarray(ya * w);
    for (let y = 0; y < h; y++) { let s = 0; for (let x = xc - hw; x <= xc + hw; x++) { const v = gray[y * w + x]; s += LOG[v > 255 ? 255 : v < 0 ? 0 : v | 0]; } p[y] = s / (2 * hw + 1); mu += p[y]; }
    mu /= h;
    for (let y = 0; y < h; y++) re[y] = (p[y] - mu) * (0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (h - 1)));
    fft(re, im);
    const sp = new Float64Array(P / 2); for (let i = 0; i < P / 2; i++) sp[i] = re[i] * re[i] + im[i] * im[i];
    const S = (c) => { const kk = (c * P) / h, a = Math.floor(kk); return a + 1 < P / 2 ? sp[a] * (1 - kk + a) + sp[a + 1] * (kk - a) : 0; };
    let bc = 0, bv = -1; for (let c = Math.min(6, h / 12); c <= h / 3; c += 0.5) { const v = S(c) + 0.5 * S(2 * c) + 0.33 * S(3 * c); if (v > bv) { bv = v; bc = c; } }
    return bc > 0 ? h / bc : 0;
  }
  // 縁 fE から内側へ「横方向にそろった細い線（シートの境界）」が続く範囲を調べ、縁の推定位置のずれ(px)を返す。
  //   シートの境界は横幅いっぱいにそろうので、列の平均をとっても残る。上面の木目・壁・床の模様はそろわないので平均で消える。
  //   coherence = (列平均のハイパスのエネルギー) / (各列のハイパスのエネルギーの平均)
  function periodicEdge(gray, w, h, fE, fO, xa, xb, p, isTop) {
    const nx = 32, W = Math.max(8, Math.round(2 * p)), k = Math.max(1, Math.round(p / 2));
    const xm = (xa + xb) / 2, H = Math.abs(fO(xm) - fE(xm));
    if (H < 6 * W) return null;
    const dir = isTop ? 1 : -1;
    const oa = -Math.round(Math.min(0.4 * H, 40 * p)), ob = Math.round(0.55 * H), n = ob - oa + 1;
    const V = new Float32Array(n * nx);
    // 上端・下端の間の線形補間（t 空間）で行を取る：線の向きが高さで変わっても揃う
    for (let i = 0; i < n; i++) { const t = (oa + i) / H;
      for (let q = 0; q < nx; q++) { const x = xa + ((xb - xa) * (q + 0.5)) / nx, e0 = fE(x), y = e0 + t * (fO(x) - e0);
        let v = NaN; if (y >= 0 && y <= h - 1) { const g = bilinear(gray, w, h, x, y); v = LOG[g > 255 ? 255 : g < 0 ? 0 : g | 0]; } V[i * nx + q] = v; } }
    const em = new Float64Array(n), ec = new Float64Array(n), ok = new Uint8Array(n);
    for (let i = k; i < n - k; i++) { let sm = 0, sc = 0, c = 0;
      for (let q = 0; q < nx; q++) { const a0 = V[(i - k) * nx + q], a1 = V[i * nx + q], a2 = V[(i + k) * nx + q]; if (Number.isNaN(a0) || Number.isNaN(a1) || Number.isNaN(a2)) continue;
        const d = a1 - 0.5 * (a0 + a2); sm += d; sc += d * d; c++; }
      if (c < nx * 0.8) continue; ok[i] = 1; em[i] = (sm / c) ** 2; ec[i] = sc / c; }
    const cm = new Float64Array(n + 1), cc = new Float64Array(n + 1), co = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { cm[i + 1] = cm[i] + em[i]; cc[i + 1] = cc[i] + ec[i]; co[i + 1] = co[i] + ok[i]; }
    const score = (i) => { if (i < 0 || i + W > n || co[i + W] - co[i] < W) return NaN; return (cm[i + W] - cm[i]) / (cc[i + W] - cc[i] + 1e-9); };
    // 基準：積みの中ほど（縁から 0.3H〜0.5H 内側）
    const i0 = -oa, ia = i0 + Math.round(0.3 * H), ib = i0 + Math.round(0.5 * H); const ref = [];
    for (let i = ia; i + W <= Math.min(n, ib + W); i += Math.max(1, k)) { const v = score(i); if (!Number.isNaN(v)) ref.push(v); }
    if (ref.length < 3) return null;
    ref.sort((a, b) => a - b); const R = ref[ref.length >> 1];
    if (R < 0.15) return null;                       // 中ほどでも線がそろっていない：判定しない
    const thr = 0.4 * R;
    let iS = null, miss = 0;
    for (let i = ia; i >= 0; i--) { const v = score(i); if (Number.isNaN(v)) break; if (v >= thr) { iS = i; miss = 0; } else if (++miss > Math.max(4, 1.5 * p)) break; }
    if (iS === null) return null;
    return dir * (iS + oa + 0.6 * W); // 中央列での px（t·H）
  }
  function palletShift(gray, w, h, fb, xa, xb, p, Hm) {
    const nx = 64, oa = -Math.round(Math.min(14 * p, 0.5 * Hm)), ob = Math.round(Math.max(4 * p, 8)), n = ob - oa + 1;
    const mean = new Float64Array(n), sd = new Float64Array(n), V = new Float32Array(n * nx);
    for (let i = 0; i < n; i++) { let s = 0, c = 0;
      for (let q = 0; q < nx; q++) { const x = xa + ((xb - xa) * (q + 0.5)) / nx, y = fb(x) + oa + i; let v = -1;
        if (y >= 0 && y <= h - 1) { v = LOG[Math.max(0, Math.min(255, bilinear(gray, w, h, x, y) | 0))]; s += v; c++; }
        V[i * nx + q] = v; }
      mean[i] = c ? s / c : 0; }
    // 積みの中（上側）の明るさの基準と、それより大幅に暗い（開口部の影）画素の割合
    const ref = []; for (let i = 0; i < Math.max(3, Math.round(n * 0.35)); i++) ref.push(mean[i]); ref.sort((a, b) => a - b);
    const mref = ref[ref.length >> 1];
    for (let i = 0; i < n; i++) { let d = 0, c = 0; for (let q = 0; q < nx; q++) { const v = V[i * nx + q]; if (v < 0) continue; c++; if (v < mref - 180) d++; } sd[i] = c ? d / c : 0; }
    const thr = 0.3;
    const runs = []; let a = -1;
    for (let i = 0; i <= n; i++) { const hole = i < n && sd[i] > thr; if (hole && a < 0) a = i; if (!hole && a >= 0) { if (i - a >= Math.max(3, Math.min(0.8 * p, 12))) runs.push([a, i - 1]); a = -1; } }
    // 下端の近く（-3p より下で終わる）の開口部の帯
    const near = runs.filter((r) => r[1] + oa >= -3 * p);
    if (!near.length) return null;
    const run = near[0], yh = run[0];               // 開口部の上の行（index）
    // デッキは縞のない板：開口部の上から上へたどり、最初に現れる十分な段差・線が積みの下端
    const feat = (i) => (i - 2 >= 0 && i + 2 < n ? Math.abs(mean[i - 2] - mean[i + 2]) : 0);
    const pw = Math.max(4, Math.round(p)), wm = [];
    for (let i = 0; i + pw <= Math.round(n * 0.35); i += pw) { let m = 0; for (let k = i; k < i + pw; k++) m = Math.max(m, feat(k)); wm.push(m); }
    if (!wm.length) return null;
    wm.sort((x, y) => x - y); const T = wm[wm.length >> 1];
    const st = Math.round(yh - Math.max(5, 0.4 * p)), lim = Math.max(2, Math.round(yh - 3.5 * p));
    let best = -1;
    for (let i = st; i >= lim; i--) if (feat(i) >= 0.4 * T) { best = i; while (best - 1 >= lim && feat(best - 1) > feat(best)) best--; break; }
    if (best < 0) return null;
    return { off: best + oa, holeTop: yh + oa };
  }
  // ---- 縞の地図 v3：向きつき「線のそろい具合」 ----
  // 中解像度（長辺 ~640px）で、傾き s ごとに画像をずらして（線を水平に）横方向に平均したとき、
  // 縦のハイパスがどれだけ残るか（coherence）を測る。シートの境界は長い平行線なので残り、
  // 木目・布の柄・砂利・ノイズは平均で消える。さらに、線に沿った方向の変化（目盛り・柄・縦の帯）が
  // 大きい所は減点する（anisotropy）。返り値の score は 0..1。
  function stripeMap(gray, w, h, opts = {}) {
    const K = Math.max(1, Math.ceil(Math.max(w, h) / (opts.mapSize || 512))), mw = Math.floor(w / K), mh = Math.floor(h / K);
    const v = new Float32Array(mw * mh), kk = 1 / (K * K);
    for (let y = 0; y < mh; y++) { const o = y * mw;
      for (let j = 0; j < K; j++) { let r = (y * K + j) * w;
        for (let x = 0; x < mw; x++) { let s = 0; for (let i = 0; i < K; i++) s += gray[r++]; v[o + x] += s; } }
      for (let x = 0; x < mw; x++) v[o + x] = LOG[Math.min(255, Math.max(0, (v[o + x] * kk) | 0))]; }
    // 縦方向の2次差分（線に垂直な高周波）と横方向の2次差分（線に沿った変化）
    const hp = new Float32Array(mw * mh), ha = new Float32Array(mw * mh);
    for (let y = 1; y < mh - 1; y++) for (let x = 1; x < mw - 1; x++) { const i = y * mw + x;
      hp[i] = v[i] - 0.5 * (v[i - mw] + v[i + mw]); ha[i] = v[i] - 0.5 * (v[i - 1] + v[i + 1]); }
    const Wx = Math.max(12, Math.round(mw * (opts.cohW || 0.06))), Wy = 4, hw = Wx >> 1;
    const slopes = []; for (let s = -0.7; s <= 0.7001; s += (opts.slopeStep || 0.1)) slopes.push(+s.toFixed(3));
    const best = new Float32Array(mw * mh), bestS = new Float32Array(mw * mh);
    const xc = mw / 2;
    const S = new Float32Array(mw * mh), A = new Float32Array(mw * mh), B = new Float32Array(mw * mh);
    const fy = new Int32Array(mw), fr = new Float32Array(mw), ry = new Int32Array(mw), wcnt = new Float32Array(mw);
    for (let x = 0; x < mw; x++) wcnt[x] = Math.min(mw - 1, x + hw) - Math.max(0, x - hw) + 1;
    const va = new Float64Array(mw), vb = new Float64Array(mw);
    for (const s of slopes) {
      for (let x = 0; x < mw; x++) { const dy = s * (x - xc); fy[x] = Math.floor(dy); fr[x] = dy - fy[x]; ry[x] = Math.round(dy); }
      // ずらし（行優先）: S[y][x] = hp(x, y + s(x-xc))
      for (let y = 0; y < mh; y++) { const r = y * mw;
        for (let x = 0; x < mw; x++) { const yy = y + fy[x];
          S[r + x] = yy >= 0 && yy + 1 < mh ? hp[yy * mw + x] * (1 - fr[x]) + hp[(yy + 1) * mw + x] * fr[x] : 0; } }
      // 横の窓和（Σ と Σ²）
      for (let y = 0; y < mh; y++) { let a = 0, b = 0; const r = y * mw;
        for (let x = 0; x < Math.min(mw, hw); x++) { const t = S[r + x]; a += t; b += t * t; }
        for (let x = 0; x < mw; x++) { const xa = x + hw, xr = x - hw - 1;
          if (xa < mw) { const t = S[r + xa]; a += t; b += t * t; }
          if (xr >= 0) { const t = S[r + xr]; a -= t; b -= t * t; }
          A[r + x] = a * a; B[r + x] = b * wcnt[x]; } }
      // 縦の窓和（行単位の足し引き）→ coherence を S に
      va.fill(0); vb.fill(0);
      for (let y = 0; y < Math.min(mh, Wy); y++) { const r = y * mw; for (let x = 0; x < mw; x++) { va[x] += A[r + x]; vb[x] += B[r + x]; } }
      for (let y = 0; y < mh; y++) { const ya = y + Wy, yr = y - Wy - 1, r = y * mw;
        if (ya < mh) { const q = ya * mw; for (let x = 0; x < mw; x++) { va[x] += A[q + x]; vb[x] += B[q + x]; } }
        if (yr >= 0) { const q = yr * mw; for (let x = 0; x < mw; x++) { va[x] -= A[q + x]; vb[x] -= B[q + x]; } }
        for (let x = 0; x < mw; x++) S[r + x] = vb[x] > 1e-6 ? va[x] / vb[x] : 0; }
      // 元の座標へ戻して最大値（行優先）
      for (let y = 0; y < mh; y++) { const r = y * mw;
        for (let x = 0; x < mw; x++) { const yy = y - ry[x]; if (yy < 0 || yy >= mh) continue; const c = S[yy * mw + x];
          if (c > best[r + x]) { best[r + x] = c; bestS[r + x] = s; } } }
    }
    // 異方性（線に垂直な変化 / 全体）。局所平均で
    const ep = new Float32Array(mw * mh), ea = new Float32Array(mw * mh);
    for (let i = 0; i < ep.length; i++) { ep[i] = hp[i] * hp[i]; ea[i] = ha[i] * ha[i]; }
    const bp = blurHV(ep, mw, mh, 4, 4), ba = blurHV(ea, mw, mh, 4, 4);
    const score = new Float32Array(mw * mh), anis = new Float32Array(mw * mh);
    // 強さ：線に垂直な高周波のエネルギー（画像内の 90 パーセンタイルで正規化）。側面の境界線は強く、上面の木目は弱い
    let e90 = 0; { const NB = 1024; let mx = 0; for (let i = 0; i < bp.length; i++) if (bp[i] > mx) mx = bp[i];
      if (mx > 0) { const hst = new Int32Array(NB); for (let i = 0; i < bp.length; i++) hst[Math.min(NB - 1, ((bp[i] / mx) * NB) | 0)]++;
        let acc = 0; for (let b = 0; b < NB; b++) { acc += hst[b]; if (acc >= 0.9 * bp.length) { e90 = ((b + 0.5) / NB) * mx; break; } } } }
    const eW = opts.energyWeight === false ? 0 : 1;
    for (let i = 0; i < score.length; i++) { const an = bp[i] / (bp[i] + ba[i] + 1e-6); anis[i] = an;
      const en = eW && e90 > 0 ? Math.min(1, Math.sqrt(bp[i] / e90)) : 1;
      score[i] = best[i] * Math.min(1, Math.max(0, (an - 0.35) / 0.4)) * en; }
    return { K, mw, mh, coh: best, slope: bestS, anis, score, energy: bp };
  }
  // stripeMap から「縞の面」の候補領域を作る。傾きがそろった連結成分ごとに、列ごとの上下の範囲を返す
  function faceRegions(M, opts = {}) {
    const { mw, mh, K } = M;
    // 縦方向に長めにぼかす（厚いシートでは境界線の間が平坦で地図が途切れるため）
    const sc = blurHV(M.score, mw, mh, 2, opts.regionRy || 6);
    // 傾きは score で重み付けした局所平均
    const ws = new Float32Array(mw * mh), wv = new Float32Array(mw * mh);
    for (let i = 0; i < ws.length; i++) { ws[i] = M.score[i] * M.slope[i]; wv[i] = M.score[i]; }
    const bs = blurHV(ws, mw, mh, 6, 6), bw = blurHV(wv, mw, mh, 6, 6);
    const sl = new Float32Array(mw * mh); for (let i = 0; i < sl.length; i++) sl[i] = bw[i] > 1e-6 ? bs[i] / bw[i] : 0;
    // 95 パーセンタイル（ヒストグラムで）
    const NB = 512, hist = new Int32Array(NB); let nv = 0;
    for (let i = 0; i < sc.length; i++) { const v = sc[i]; if (v > 0.02) { hist[Math.min(NB - 1, (v * NB) | 0)]++; nv++; } }
    if (nv < 50) return [];
    let acc = 0, p95 = 1; for (let b = 0; b < NB; b++) { acc += hist[b]; if (acc >= 0.95 * nv) { p95 = (b + 0.5) / NB; break; } }
    const thr = Math.max(0.06, (opts.regionThr || 0.2) * p95);
    // 細いつながり（上面の縁・帯など）を切るため、二値化した領域を少し削ってから成分に分け、あとで削った分を戻す
    const er = opts.regionErode === undefined ? 2 : opts.regionErode;
    const mask = new Float32Array(mw * mh); for (let i = 0; i < mask.length; i++) mask[i] = sc[i] >= thr ? 1 : 0;
    const mb = er > 0 ? blurHV(mask, mw, mh, er, er) : mask;
    const core = (i) => mb[i] > 0.999;
    const lab = new Int32Array(mw * mh).fill(-1), comps = [];
    const stack = [];
    // 種は score の高い順（64段のバケット）に。成分の中の傾きは種の傾きから ±slopeDev までに制限する
    //（傾きが少しずつ変わって隣の面・背景の積みへ回り込むのを防ぐ）
    const order = []; { const NBk = 64, bk = Array.from({ length: NBk }, () => []);
      for (let i = 0; i < mw * mh; i++) if (core(i)) bk[Math.min(NBk - 1, (sc[i] / (p95 * 1.5)) * NBk | 0)].push(i);
      for (let b = NBk - 1; b >= 0; b--) for (const i of bk[b]) order.push(i); }
    const sDev = opts.slopeDev || 0.12;
    for (const i0 of order) {
      if (lab[i0] >= 0) continue;
      const s0 = sl[i0];
      const id = comps.length; let n = 0, sum = 0, sx = 0, sy = 0, ssl = 0;
      lab[i0] = id; stack.push(i0);
      while (stack.length) { const i = stack.pop(), x = i % mw, y = (i / mw) | 0; n++; sum += sc[i]; sx += x; sy += y; ssl += sl[i] * sc[i];
        for (let q = 0; q < 4; q++) {
          const j = q === 0 ? (x > 0 ? i - 1 : -1) : q === 1 ? (x < mw - 1 ? i + 1 : -1) : q === 2 ? (y > 0 ? i - mw : -1) : (y < mh - 1 ? i + mw : -1);
          if (j < 0 || lab[j] >= 0 || !core(j)) continue;
          if (Math.abs(sl[j] - sl[i]) > 0.08 || Math.abs(sl[j] - s0) > sDev) continue;     // 傾きが急に変わる所（2面の角）で分ける
          lab[j] = id; stack.push(j); } }
      comps.push({ id, n, sum, cx: sx / n, cy: sy / n, slope: ssl / sum });
    }
    // 削った分を戻す（元の二値領域の中で、隣のラベルを er+1 回広げる）
    for (let it = 0; it < er + 1; it++) { const add = [];
      for (let i = 0; i < mw * mh; i++) { if (lab[i] >= 0 || !mask[i]) continue; const x = i % mw;
        const nb = x > 0 && lab[i - 1] >= 0 ? lab[i - 1] : x < mw - 1 && lab[i + 1] >= 0 ? lab[i + 1] : i >= mw && lab[i - mw] >= 0 ? lab[i - mw] : i + mw < mw * mh && lab[i + mw] >= 0 ? lab[i + mw] : -1;
        if (nb >= 0) add.push(i, nb); }
      for (let q = 0; q < add.length; q += 2) { lab[add[q]] = add[q + 1]; comps[add[q + 1]].n++; } }
    const out = [];
    for (const c of comps) {
      if (c.n < 0.01 * mw * mh) continue;
      // 列ごとの範囲
      const top = new Float64Array(mw).fill(-1), bot = new Float64Array(mw).fill(-1), cnt = new Int32Array(mw);
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (lab[y * mw + x] === c.id) { if (top[x] < 0) top[x] = y; bot[x] = y; cnt[x]++; }
      const lt = [], lb = [];
      for (let x = 0; x < mw; x++) if (cnt[x] >= 3) { lt.push({ x: (x + 0.5) * K, y: top[x] * K }); lb.push({ x: (x + 0.5) * K, y: (bot[x] + 1) * K }); }
      if (lt.length < 6) continue;
      const dx = (c.cx - mw / 2) / (mw / 2), dy = (c.cy - mh / 2) / (mh / 2);
      const center = 1 - 0.35 * Math.min(1, Math.hypot(dx, dy));
      // 手前の積みほど面が高く写る：面の平均の高さ（画像の高さ比）の平方根を掛ける
      let hs = 0; for (let q = 0; q < lt.length; q++) hs += lb[q].y - lt[q].y; hs /= lt.length;
      let hf = opts.heightWeight === false ? 1 : Math.min(1, hs / (mh * K));
      // 画像の上の縁にかかる領域は奥の積み・背景であることが多い
      let ttop = 0; for (const q of lt) if (q.y <= K) ttop++;
      if (ttop > 0.2 * lt.length) hf *= 0.7;
      out.push({ n: c.n, mean: c.sum / c.n, slope: c.slope, lt, lb, x0: lt[0].x, x1: lt[lt.length - 1].x, score: c.sum * center * hf, cx: c.cx * K, cy: c.cy * K, hImg: hs });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }
  // 傾きがそろい、縦の範囲が重なる横並びの領域（ベルト・帯で切れた同じ面）をつなぐ
  function mergeRegions(R, M) {
    const K = M.K;
    for (const r of R) { const ys = r.lt.map((p) => p.y), ye = r.lb.map((p) => p.y); r.h = (ye.reduce((a, b) => a + b, 0) - ys.reduce((a, b) => a + b, 0)) / ys.length; }
    let changed = true;
    while (changed) { changed = false;
      for (let i = 0; i < R.length && !changed; i++) for (let j = i + 1; j < R.length && !changed; j++) {
        const a = R[i], b = R[j];
        if (Math.abs(a.slope - b.slope) > 0.15) continue;
        // 縦に重なる（同じ面が厚い板の継ぎ目などで上下に切れた）：横の範囲が重なり、上下の隙間が小さい
        { const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), wmin = Math.min(a.x1 - a.x0, b.x1 - b.x0);
          if (ox > 0.5 * wmin) {
            const U = a.cy <= b.cy ? a : b, D = U === a ? b : a;
            const xs = Math.max(a.x0, b.x0), xe = Math.min(a.x1, b.x1);
            const inR = (pts) => pts.filter((p) => p.x >= xs && p.x <= xe).map((p) => p.y);
            const ub = inR(U.lb), dt = inR(D.lt);
            if (ub.length && dt.length) {
              const med = (v) => v.sort((p, q) => p - q)[v.length >> 1];
              const gapv = med(dt) - med(ub);
              if (gapv < 0.25 * Math.min(U.h, D.h) && gapv > -0.5 * Math.min(U.h, D.h)) {
                const byx = (P, Q, f) => { const m = new Map(); for (const p of [...P, ...Q]) { const k = Math.round(p.x); m.set(k, m.has(k) ? { x: p.x, y: f(m.get(k).y, p.y) } : { x: p.x, y: p.y }); } return [...m.values()].sort((p, q) => p.x - q.x); };
                const lt = byx(a.lt, b.lt, Math.min), lb = byx(a.lb, b.lb, Math.max);
                const m = { n: a.n + b.n, mean: (a.mean * a.n + b.mean * b.n) / (a.n + b.n), slope: (a.slope * a.n + b.slope * b.n) / (a.n + b.n), lt, lb,
                  x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), score: a.score + b.score, cx: (a.cx * a.n + b.cx * b.n) / (a.n + b.n), cy: (a.cy * a.n + b.cy * b.n) / (a.n + b.n), h: U.h + D.h + Math.max(0, gapv) };
                R.splice(j, 1); R[i] = m; changed = true; continue; } } } }
        const L = a.x0 <= b.x0 ? a : b, Rr = L === a ? b : a;
        const gap = Rr.x0 - L.x1; if (gap > 0.08 * M.mw * K || gap < -0.3 * Math.min(a.x1 - a.x0, b.x1 - b.x0)) continue;
        // 継ぎ目での上下の位置の一致（傾きで外挿）
        const yAt = (r, pts, x) => { const q = pts.reduce((m, p) => (Math.abs(p.x - x) < Math.abs(m.x - x) ? p : m), pts[0]); return q.y + r.slope * (x - q.x); };
        const xm = (L.x1 + Rr.x0) / 2, hh = Math.min(L.h, Rr.h);
        const dt = Math.abs(yAt(L, L.lt, xm) - yAt(Rr, Rr.lt, xm)), db = Math.abs(yAt(L, L.lb, xm) - yAt(Rr, Rr.lb, xm));
        if (dt > 0.25 * hh || db > 0.25 * hh) continue;
        const m = { n: a.n + b.n, mean: (a.mean * a.n + b.mean * b.n) / (a.n + b.n), slope: (a.slope * a.n + b.slope * b.n) / (a.n + b.n),
          lt: [...L.lt, ...Rr.lt.filter((p) => p.x > L.x1)], lb: [...L.lb, ...Rr.lb.filter((p) => p.x > L.x1)], x0: L.x0, x1: Math.max(L.x1, Rr.x1),
          score: a.score + b.score, cx: (a.cx * a.n + b.cx * b.n) / (a.n + b.n), cy: (a.cy * a.n + b.cy * b.n) / (a.n + b.n), h: Math.max(a.h, b.h) };
        R.splice(j, 1); R[i] = m; changed = true; }
    }
    R.sort((x, y) => y.score - x.score);
    return R;
  }
  // 領域の上下の端にある「線の帯」（定規・台の縁・額縁など）を切り離す：
  // 面の傾きに沿った行ごとの score の平均で、深い谷（中央値の35%未満が3行以上）の外側が薄い（範囲の20%未満）なら外側を捨てる
  function trimRegion(r, M, opts = {}) {
    if (opts.trim === false) return r;
    const K = M.K, s = r.slope, xc = M.mw / 2, xa = Math.max(0, Math.round(r.x0 / K)), xb = Math.min(M.mw - 1, Math.round(r.x1 / K));
    const ut = r.lt.map((p) => p.y / K - s * (p.x / K - xc)).sort((a, b) => a - b), ub = r.lb.map((p) => p.y / K - s * (p.x / K - xc)).sort((a, b) => a - b);
    const u0 = Math.round(ut[ut.length >> 1]), u1 = Math.round(ub[ub.length >> 1]), n = u1 - u0 + 1;
    if (n < 12) return r;
    const P = new Float64Array(n), AN = new Float64Array(n);
    for (let i = 0; i < n; i++) { let a = 0, an = 0, c = 0; for (let x = xa; x <= xb; x++) { const y = Math.round(u0 + i + s * (x - xc)); if (y < 0 || y >= M.mh) continue; a += M.score[y * M.mw + x]; an += M.anis[y * M.mw + x]; c++; } P[i] = c ? a / c : 0; AN[i] = c ? an / c : 0.5; }
    // 谷の閾値：中ほど（20〜80%）にある局所最小（シートの継ぎ目の谷）の中央値の半分。継ぎ目より明らかに深い谷だけで切る
    const mins = []; for (let i = Math.max(1, Math.floor(n * 0.2)); i < Math.min(n - 1, Math.ceil(n * 0.8)); i++) if (P[i] <= P[i - 1] && P[i] <= P[i + 1]) mins.push(P[i]);
    const srt = Array.from(P).sort((a, b) => a - b), med = srt[n >> 1];
    mins.sort((a, b) => a - b);
    const thr = Math.min(0.35 * med, mins.length ? 0.5 * mins[mins.length >> 1] : 0.35 * med);
    let cutTop = 0, cutBot = n - 1;
    // 端の弱い行（上面・床・影など、領域に入ったが線のそろいが弱い所）を落とす
    const edgeThr = (opts.edgeTrim || 0.4) * med;
    while (cutTop < n - 1 && P[cutTop] < edgeThr) cutTop++;
    while (cutBot > cutTop && P[cutBot] < edgeThr) cutBot--;
    if (cutBot - cutTop < 0.5 * n) { cutTop = 0; cutBot = n - 1; }
    // 下側
    const t0 = cutTop, b0 = cutBot, m2 = opts.trimDip === false ? 0 : b0 - t0 + 1;
    // 谷が「線に沿った方向の模様（目盛り・柄）」による（異方性が低い）ときだけ切る。板の間の暗い溝（平坦）では切らない
    const anLow = (a, b) => { let m = 0, c = 0; for (let q = Math.max(0, a); q <= Math.min(n - 1, b); q++) { m += AN[q]; c++; } return c && m / c < (opts.dipAnis || 0.45); };
    for (let i = b0, run = 0; m2 > 0 && i >= b0 - Math.floor(m2 * 0.2); i--) { if (P[i] < thr) { if (++run >= 3) { let j = i; while (j > 0 && P[j - 1] < thr) j--; let e = i; while (e < n - 1 && P[e + 1] < thr) e++; if (anLow(j, e)) cutBot = j - 1; break; } } else run = 0; }
    for (let i = t0, run = 0; m2 > 0 && i <= t0 + Math.ceil(m2 * 0.2); i++) { if (P[i] < thr) { if (++run >= 3) { let j = i; while (j < n - 1 && P[j + 1] < thr) j++; let e = i; while (e > 0 && P[e - 1] < thr) e--; if (anLow(e, j)) cutTop = j + 1; break; } } else run = 0; }
    if (cutTop === 0 && cutBot === n - 1) return r;
    const yT = (x) => (u0 + cutTop + s * (x / K - xc)) * K, yB = (x) => (u0 + cutBot + 1 + s * (x / K - xc)) * K;
    return Object.assign({}, r, { lt: r.lt.map((p) => ({ x: p.x, y: Math.max(p.y, yT(p.x)) })), lb: r.lb.map((p) => ({ x: p.x, y: Math.min(p.y, yB(p.x)) })), trimmed: [cutTop, n - 1 - cutBot] });
  }
  function regionFace(r) { const pad = 0.02 * (r.x1 - r.x0); return { fx0: r.x0 + pad, fx1: r.x1 - pad, lt: r.lt, lb: r.lb, rscore: r.score }; }
  // ---- 半自動：範囲（roi）と縁のヒント（hint）----
  // opts.roi = {x0,y0,x1,y1}：利用者がなぞった大まかな範囲。少し広げて切り出し、その中で自動検出し、座標を戻す。
  // opts.hint = {top:{x,y}, bot:{x,y}}：上端・下端を1点ずつ。検出した縁がヒントから離れていれば、ヒントを通るように平行移動してから
  //   近くの段差へ寄せ直す。roi が無くヒントだけなら、ヒントから範囲を作る（高さの 2倍の幅、上下に 15% の余白）。
  function detect(gray, w, h, opts = {}) {
    if (typeof globalThis !== 'undefined' && globalThis.SHIMA_GEO_OPTS) opts = Object.assign({}, globalThis.SHIMA_GEO_OPTS, opts);
    let roi = opts.roi;
    const hint = opts.hint && opts.hint.top && opts.hint.bot ? opts.hint : null;
    if (!roi && hint) {
      const H = Math.abs(hint.bot.y - hint.top.y), xc = (hint.top.x + hint.bot.x) / 2;
      roi = { x0: xc - 1.2 * H, x1: xc + 1.2 * H, y0: Math.min(hint.top.y, hint.bot.y) - 0.15 * H, y1: Math.max(hint.top.y, hint.bot.y) + 0.15 * H };
    }
    if (!roi) return detectAuto(gray, w, h, opts);
    const mx = 0.05 * (roi.x1 - roi.x0), my = 0.05 * (roi.y1 - roi.y0);
    const X0 = Math.max(0, Math.floor(Math.min(roi.x0, roi.x1) - mx)), X1 = Math.min(w, Math.ceil(Math.max(roi.x0, roi.x1) + mx));
    const Y0 = Math.max(0, Math.floor(Math.min(roi.y0, roi.y1) - my)), Y1 = Math.min(h, Math.ceil(Math.max(roi.y0, roi.y1) + my));
    const cw = X1 - X0, ch = Y1 - Y0;
    if (cw < 24 || ch < 24) return { ok: false, reason: 'roi' };
    const sub = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) sub.set(gray.subarray((y + Y0) * w + X0, (y + Y0) * w + X1), y * cw);
    const o2 = Object.assign({}, opts, { roi: undefined, hint: undefined, inRoi: true });
    let d = detectAuto(sub, cw, ch, o2);
    const mv = (P) => P.map((p) => ({ x: p.x + X0, y: p.y + Y0 }));
    if (d.ok) {
      d.up = mv(d.up); d.lo = mv(d.lo);
      d.rect = { x0: d.rect.x0 + X0, x1: d.rect.x1 + X0, y0: d.rect.y0 + Y0, y1: d.rect.y1 + Y0 };
      if (d.faces) d.faces = d.faces.map((f) => Object.assign({}, f, { up: mv(f.up), lo: mv(f.lo), x0: f.x0 + X0, x1: f.x1 + X0 }));
    } else if (hint) {
      // 検出できなくても、ヒントを通る水平に近い線から始める（傾きは縞の向き）
      const sl = Math.tan(((d.tilt || 0) * Math.PI) / 180);
      const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => X0 + f * cw);
      d = { ok: true, up: xs.map((x) => ({ x, y: hint.top.y + sl * (x - hint.top.x) })), lo: xs.map((x) => ({ x, y: hint.bot.y + sl * (x - hint.bot.x) })), method: 'hint' };
    }
    if (d.ok && hint) {
      const pitch = d.pitchPx || 8;
      const fix = (P, pt, isTop) => {
        const at = (x) => { let i = 0; while (i < P.length - 2 && x > P[i + 1].x) i++; const a = P[i], b = P[i + 1]; return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x); };
        const dy = pt.y - at(pt.x);
        if (Math.abs(dy) <= Math.max(3, 0.5 * pitch)) return P;          // 検出がヒントと合っている
        const Q = P.map((p) => ({ x: p.x, y: p.y + dy }));
        return snapEdge(gray, w, h, Q, isTop, Math.max(3, Math.round(0.5 * pitch)));
      };
      d.up = fix(d.up, hint.top, true); d.lo = fix(d.lo, hint.bot, false);
      d.hinted = true;
    }
    if (d.ok) { d.roi = { x0: X0, y0: Y0, x1: X1, y1: Y1 }; d.tilt = edgeTilt(d.up, d.lo); }
    return d;
  }
  // 縁の点列を、各点の近く（±win）で最も強い明るさの段差へ寄せる（縁の傾きに沿った細い帯の平均で）
  function snapEdge(gray, w, h, P, isTop, win) {
    const sl = P.length > 1 ? (P[P.length - 1].y - P[0].y) / (P[P.length - 1].x - P[0].x || 1) : 0;
    const span = P.length > 1 ? P[P.length - 1].x - P[0].x : 40, hw = Math.max(3, Math.round(span / (P.length * 4)));
    return P.map((p) => {
      const prof = [];
      for (let dy = -win - 3; dy <= win + 3; dy++) { let s = 0, n = 0;
        for (let dx = -hw; dx <= hw; dx++) { const x = Math.round(p.x + dx), y = p.y + dy + sl * dx; if (x < 0 || x >= w || y < 0 || y > h - 1) continue; s += bilinear(gray, w, h, x, y); n++; }
        prof.push(n ? s / n : 0); }
      let best = 0, bv = -1;
      for (let i = 3; i < prof.length - 3; i++) { const st = Math.abs((prof[i] + prof[i + 1] + prof[i + 2]) - (prof[i - 1] + prof[i - 2] + prof[i - 3])); if (st > bv) { bv = st; best = i; } }
      return { x: p.x, y: p.y + best - win - 3 - 0.5 };
    });
  }
  function detectAuto(gray, w, h, opts = {}) {
    // 調整用：globalThis.SHIMA_GEO_OPTS の値を既定値として使う（本番では未設定）
    if (typeof globalThis !== 'undefined' && globalThis.SHIMA_GEO_OPTS) opts = Object.assign({}, globalThis.SHIMA_GEO_OPTS, opts);
    const k = Math.max(1, Math.round(Math.max(w, h) / 240)), sw = Math.floor(w / k), sh = Math.floor(h / k);
    const sm = new Float32Array(sw * sh), kk = 1 / (k * k);
    for (let y = 0; y < sh; y++) { const o = y * sw;
      for (let j = 0; j < k; j++) { let r = (y * k + j) * w;
        for (let x = 0; x < sw; x++) { let s = 0; for (let i = 0; i < k; i++) s += gray[r++]; sm[o + x] += s; } }
      for (let x = 0; x < sw; x++) sm[o + x] *= kk; }
    // 縞の強さ（対数輝度の縦勾配 − 横勾配）。1画素おきに間引いて計算
    const gx = new Float32Array(sw * sh), gy = new Float32Array(sw * sh);
    const stp = k >= 8 ? 3 : k >= 4 ? 2 : 1;
    let cnt = null;
    { // 対数輝度の勾配（大きい画像は1画素おきに間引く）
      cnt = new Float32Array(sw * sh);
      const LT = LOG;
      for (let yy = 1; yy < Math.min(h - 1, sh * k); yy += stp) {
        const by_ = (yy / k) | 0, r = yy * w, ro = by_ * sw;
        for (let xx = 1 + (stp > 1 ? ((yy / stp) | 0) % stp : 0); xx < Math.min(w - 1, sw * k); xx += stp) {
          const i = r + xx, o = ro + ((xx / k) | 0);
          const a = gray[i + 1], b = gray[i - 1], c = gray[i + w], e = gray[i - w];
          gx[o] += Math.abs(LT[a > 255 ? 255 : a | 0] - LT[b > 255 ? 255 : b | 0]);
          gy[o] += Math.abs(LT[c > 255 ? 255 : c | 0] - LT[e > 255 ? 255 : e | 0]);
          cnt[o]++;
        }
      }
    }
    for (let i = 0; i < gx.length; i++) { const c = cnt[i] || 1; gx[i] /= c; gy[i] /= c; }
    const bx = blurHV(gx, sw, sh, 3, 3), by = blurHV(gy, sw, sh, 3, 3);
    const st = new Float32Array(sw * sh);
    for (let i = 0; i < st.length; i++) st[i] = Math.max(0, by[i] - 1.3 * bx[i]);
    let Jxx = 0, Jyy = 0, Jxy = 0;
    for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
      const dx = sm[y * sw + x + 1] - sm[y * sw + x - 1], dy = sm[(y + 1) * sw + x] - sm[(y - 1) * sw + x];
      Jxx += dx * dx; Jyy += dy * dy; Jxy += dx * dy;
    }
    const gradAngle = 0.5 * Math.atan2(2 * Jxy, Jxx - Jyy) * 180 / Math.PI;
    const tilt = gradAngle > 0 ? gradAngle - 90 : gradAngle + 90;
    const vertical = Jxx > 1.5 * Jyy;
    // 失敗時は旧方式へ退避（opts.legacy=false で無効）
    const fail = (reason) => { if (opts.legacy !== false) { const L = detectLegacy(gray, w, h); if (L.ok) { L.method = 'legacy'; L.why = reason; return L; } } return { ok: false, reason, tilt, vertical }; };
    
    const roughV2 = () => {
    // 行ごとの縞の強さ → 縦の範囲。背景の縞（棚板など）とは谷で分ける
    const rp = new Float64Array(sh);
    const cx0 = Math.floor(sw * 0.3), cx1 = Math.ceil(sw * 0.7);
    for (let y = 0; y < sh; y++) { let s = 0; for (let x = cx0; x < cx1; x++) s += st[y * sw + x]; rp[y] = s / (cx1 - cx0); }
    const rps = gaussSmooth(rp, 1.0);
    let pk = 0; for (let y = Math.floor(sh * 0.05); y < sh * 0.95; y++) pk = Math.max(pk, rps[y]);
    if (pk < 1.2) return { fail: 'none' };
    const segment = (G) => {
      const segs = [];
      const thr = 0.3 * pk, deep = 0.12 * pk; let y = 0;
      while (y < sh) {
        if (rps[y] <= thr) { y++; continue; }
        let a = y, b = y, gap = 0, low = 0;
        for (let i = y + 1; i < sh; i++) {
          if (rps[i] > thr) { b = i; gap = 0; low = 0; }
          else { gap++; if (rps[i] < deep) low++; if (gap > G || low >= G - 2) break; }
        }
        let s = 0; for (let i = a; i <= b; i++) s += rps[i];
        segs.push({ a, b, mean: s / (b - a + 1) }); y = b + 1;
      }
      for (const g of segs) { const len = g.b - g.a + 1, c = (g.a + g.b) / 2;
        g.score = len * Math.sqrt(g.mean) * (1 - 0.5 * Math.min(1, Math.abs(c - sh / 2) / (sh / 2))); }
      return segs;
    };
    // 1回目は小さい隙間だけつなぐ → その範囲の周期から、大きいシート用の隙間の許容を決めて2回目
    //（画像全体の周期だと、壁の羽目板などの背景の縞の周期を拾って積みと背景をつないでしまう）
    let segs = segment(4), seg = segs.reduce((a, g) => (!a || g.score > a.score ? g : a), null);
    const p0 = centerPitch(gray, w, h, seg.a * k, (seg.b + 1) * k), G = Math.max(4, Math.ceil((1.3 * p0) / k) - 2);
    if (G > 4) { const s1 = seg; segs = segment(G); seg = segs.filter((g) => g.b >= s1.a && g.a <= s1.b).reduce((a, g) => (!a || g.score > a.score ? g : a), null) || s1; }
    const y0 = seg.a, y1 = seg.b;
    if (y1 - y0 < sh * 0.1) return { fail: 'small' };
    const cp = new Float64Array(sw);
    for (let x = 0; x < sw; x++) { let s = 0; for (let y = y0; y <= y1; y++) s += st[y * sw + x]; cp[x] = s / (y1 - y0 + 1); }
    const cps = gaussSmooth(cp, 1.5);
    let xm = Math.floor(sw / 2); for (let x = Math.floor(sw * 0.2); x < sw * 0.8; x++) if (cps[x] > cps[xm]) xm = x;
    const [x0, x1] = runAround(cps, cps[xm] * 0.3, xm, 3);
    if (x1 - x0 < sw * 0.1) return { fail: 'small' };
    // 列ごとの粗い上端・下端（低解像度）
    const ymid = Math.round((y0 + y1) / 2), qh = Math.max(1, Math.round((y1 - y0) / 4));
    const lt = [], lb = [];
    const ecol = new Float64Array(sh);
    for (let x = x0; x <= x1; x++) {
      for (let y = 0; y < sh; y++) ecol[y] = st[y * sw + x];
      let sd = ymid; for (let y = ymid - qh; y <= ymid + qh; y++) if (ecol[y] > ecol[sd]) sd = y;
      const band = []; for (let y = y0; y <= y1; y++) band.push(ecol[y]); band.sort((p, q) => p - q);
      const med = band[band.length >> 1];
      if (ecol[sd] < 0.25 * pk) continue;
      const [a, b] = runAround(ecol, Math.max(0.3 * med, 0.12 * pk), sd, G - 1);
      lt.push({ x: (x + 0.5) * k, y: a * k }); lb.push({ x: (x + 0.5) * k, y: (b + 1) * k });
    }
    if (lt.length < 4) return { fail: 'small' };
    // 2面写りの判定（上端は角で最も高く、下端は角で最も低い折れ線になる）
    const Wd = (x1 - x0 + 1) * k;
    let faces = [{ fx0: x0 * k, fx1: (x1 + 1) * k }];
    const ht = hingeFit(lt), hb = hingeFit(lb);
    let corner = null;
    if (ht && hb && ht.c > 0.1 && hb.c < -0.1 && Math.abs(ht.xb - hb.xb) < 0.1 * Wd && ht.sse < 0.5 * ht.sse1 && hb.sse < 0.5 * hb.sse1) {
      const xc = (ht.xb + hb.xb) / 2, mg = 0.03 * Wd; corner = xc;
      faces = [{ fx0: x0 * k, fx1: xc - mg }, { fx0: xc + mg, fx1: (x1 + 1) * k }].filter((f) => f.fx1 - f.fx0 > 0.08 * Wd);
    }
    return { lt, lb, faces, corner };
    };
    // v3: 向きつきの「線のそろい具合」の地図から面の領域を選ぶ（上面・木目・布・目盛り・砂利を除外し、複数の積みから中央の最大の面を選ぶ）
    const roughV3 = () => {
      const M = stripeMap(gray, w, h, opts);
      let R = faceRegions(M, opts);
      if (!R.length) return null;
      R = mergeRegions(R, M);
      const best = R[0];
      if (best.n < (opts.v3MinArea || 0.03) * M.mw * M.mh) return null;
      const faces = [Object.assign(regionFace(trimRegion(best, M, opts)), { K: M.K })];
      // 2面写り：隣り合う、傾きの違う領域（スコアが最良の 25% 以上）
      for (const r of R.slice(1, 4)) {
        if (r.score < 0.25 * best.score || Math.abs(r.slope - best.slope) < 0.1) continue;
        const gap = Math.max(r.x0 - best.x1, best.x0 - r.x1);
        if (gap > 0.06 * w) continue;
        const ov = Math.min(r.cy + 0.5 * r.h, best.cy + 0.5 * best.h) - Math.max(r.cy - 0.5 * r.h, best.cy - 0.5 * best.h);
        if (ov < 0.3 * Math.min(r.h, best.h)) continue;
        faces.push(Object.assign(regionFace(trimRegion(r, M, opts)), { K: M.K })); break;
      }
      return { lt: faces[0].lt, lb: faces[0].lb, faces, corner: faces.length > 1 ? (faces[0].fx1 < faces[1].fx0 ? faces[0].fx1 : faces[0].fx0) : null, v3: true, regions: R.length, M };
    };
    const solve = (RG) => {
    const { lt, lb, faces, corner } = RG;
    const rough = (pts, f) => { const P = pts.filter((p) => p.x >= f.fx0 && p.x <= f.fx1); return P.length >= 2 ? ransacEdge(P, 2.5 * (f.K || k), false) : null; };
    const L = lg;
    const out = [];
    for (const f of faces) {
      let rt = rough(f.lt || lt, f), rb = rough(f.lb || lb, f);
      if (!rt || !rb) continue;
      if (f.K) {
        // 上端と下端の当てはまりが、同じ列で両方成り立つように（領域が別の積みや上面へ広がった列を除く）
        const TL = f.lt.filter((p) => p.x >= f.fx0 && p.x <= f.fx1), BL = f.lb.filter((p) => p.x >= f.fx0 && p.x <= f.fx1);
        const tol = 2.5 * f.K, inT = new Set(), inB = new Set();
        TL.forEach((p, i) => { if (Math.abs(p.y - rt.f(p.x)) <= tol) inT.add(i); }); BL.forEach((p, i) => { if (Math.abs(p.y - rb.f(p.x)) <= tol) inB.add(i); });
        const joint = [...inT].filter((i) => inB.has(i)).length;
        if (joint < 0.6 * Math.min(inT.size, inB.size)) {
          const tB = ransacEdge(TL.filter((_, i) => inB.has(i)), tol, false), bT = ransacEdge(BL.filter((_, i) => inT.has(i)), tol, false);
          const cntJ = (et, eb) => { let c = 0; TL.forEach((p, i) => { if (Math.abs(p.y - et.f(p.x)) <= tol && Math.abs(BL[i].y - eb.f(BL[i].x)) <= tol) c++; }); return c; };
          let best = [rt, rb, joint];
          if (tB) { const c = cntJ(tB, rb); if (c > best[2]) best = [tB, rb, c]; }
          if (bT) { const c = cntJ(rt, bT); if (c > best[2]) best = [rt, bT, c]; }
          [rt, rb] = best;
        }
        if (rb.f((f.fx0 + f.fx1) / 2) - rt.f((f.fx0 + f.fx1) / 2) < 12) continue;
      }
      const fw = f.fx1 - f.fx0, xmid = (f.fx0 + f.fx1) / 2;
      const Hm = rb.f(xmid) - rt.f(xmid); if (Hm < 12) continue;
      const hw = Math.max(2, Math.min(10, Math.round(fw * 0.015)));
      // 斜めにずらした細い帯の縦プロファイル（対数輝度）
      const strip = (xc, ya, yb, slope) => {
        const p = new Float64Array(Math.max(1, yb - ya + 1));
        for (let y = ya; y <= yb; y++) { let s = 0, n = 0;
          for (let x = Math.round(xc - hw); x <= Math.round(xc + hw); x++) { if (x < 0 || x >= w) continue; const yy = y + slope * (x - xc);
            if (yy < 0 || yy > h - 1) continue; const y0_ = Math.floor(yy), fy = yy - y0_; const y1_ = Math.min(h - 1, y0_ + 1);
            s += L(gray[y0_ * w + x]) * (1 - fy) + L(gray[y1_ * w + x]) * fy; n++; }
          p[y - ya] = n ? s / n : 0; }
        return p;
      };
      // 1枚の厚さの概算（中央の帯のスペクトル）
      let pitch = Math.max(4, Hm / 40);
      { const ta0 = rt.f(xmid), tb0 = rb.f(xmid), ta = Math.round(ta0 + 0.2 * (tb0 - ta0)), tb = Math.round(tb0 - 0.2 * (tb0 - ta0)), sl = (rt.slope + rb.slope) / 2; // 中央60%（パレット・背景を避ける）
        const p = strip(xmid, ta, tb, sl), m = p.length;
        let P = 1; while (P < 2 * m) P <<= 1; const re = new Float64Array(P), im = new Float64Array(P);
        const base = movAvg(p, Math.max(5, Math.round(m / 10)));   // 照明ムラ・影の低い周波数を除く
        for (let i = 0; i < m; i++) re[i] = (p[i] - base[i]) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1)));
        fft(re, im); const sp = new Float64Array(P / 2); for (let i = 0; i < P / 2; i++) sp[i] = re[i] * re[i] + im[i] * im[i];
        const S = (c) => { const kk = (c * P) / m, a = Math.floor(kk); return a + 1 < P / 2 ? sp[a] * (1 - kk + a) + sp[a + 1] * (kk - a) : 0; };
        let bc = 4, bv = -1; for (let c = 4; c <= m / 2.5; c += 0.5) { const v = S(c) + 0.5 * S(2 * c) + 0.33 * S(3 * c); if (v > bv) { bv = v; bc = c; } }
        pitch = Math.max(2.5, m / bc); }
      const Ls = Math.max(6, Math.round(2.2 * pitch)), d = Math.max(1, Math.round(pitch / 2));
      const v3 = !!f.K; // v3 の領域から来た面：粗い縁が確かなので、近くの最も強い段差を選ぶ
      const win = f.win ? Math.round(f.win * Hm) : v3 ? Math.max(3 * f.K, Math.round(Hm * (opts.v3Win || 0.04))) : Math.max(4 * k, Math.round(Hm * 0.05));
      const refine = (xc, yc, slope, isTop, wn = win) => {
        const ya = Math.max(2, Math.round(yc - wn)), yb = Math.min(h - 3, Math.round(yc + wn));
        if (!(yb - ya >= 6)) return null;
        const pad = Ls + d + 4, A = Math.max(0, ya - pad), p = strip(xc, A, Math.min(h - 1, yb + pad), slope);
        const n = p.length, hf = new Float64Array(n);
        for (let i = d; i < n - d; i++) hf[i] = Math.abs(p[i] - 0.5 * (p[i - d] + p[i + d]));
        const cs = new Float64Array(n + 1); for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + hf[i];
        const mean = (i0, i1) => { i0 = Math.max(0, i0); i1 = Math.min(n, i1); return i1 > i0 ? (cs[i1] - cs[i0]) / (i1 - i0) : 0; };
        const sc = [], stv = [];
        for (let y = ya; y <= yb; y++) { const i = y - A; if (i < 3 || i + 3 >= n) { sc.push(0); stv.push(0); continue; }
          const step = Math.abs((p[i] + p[i + 1] + p[i + 2]) / 3 - (p[i - 1] + p[i - 2] + p[i - 3]) / 3);
          let below = mean(i + 2, i + 2 + Ls), above = mean(i - 2 - Ls, i - 2);
          if (v3 && RG.M) {
            // v3: 内側・外側の判定に「線のそろい具合」の地図を使う（上面の木目・床の模様は縞と数えない）
            const Mm = RG.M, Kk = Mm.K, mx_ = Math.min(Mm.mw - 1, Math.max(0, Math.round(xc / Kk))), Lm = Math.max(2, Math.round(Math.max(Ls, 2 * Kk) / Kk));
            const yy = y / Kk; let sb = 0, sa = 0, nb = 0, na = 0;
            for (let t = 1; t <= Lm; t++) { const yb_ = Math.round(yy + t + 0.5), ya_ = Math.round(yy - t - 0.5);
              if (yb_ >= 0 && yb_ < Mm.mh) { sb += Mm.score[yb_ * Mm.mw + mx_]; nb++; } if (ya_ >= 0 && ya_ < Mm.mh) { sa += Mm.score[ya_ * Mm.mw + mx_]; na++; } }
            below = nb ? sb / nb : 0; above = na ? sa / na : 0;
          }
          const inn = isTop ? below : above, outv = isTop ? above : below;
          const q = Math.min(1, Math.max(0.05, (inn - outv) / (inn + outv + 1e-6)));
          stv.push(step); sc.push(step * q); }
        const mx = Math.max(...sc); if (!(mx > 0)) return null;
        const order = sc.map((_, j) => j); if (!isTop) order.reverse();
        // v3: 粗い縁（線のそろい具合から決めた）の近くで最も強い段差へ寄せるだけ
        let j0 = v3 && opts.v3Snap ? stv.indexOf(Math.max(...stv)) : order.find((j) => sc[j] >= 0.6 * mx);
        if (isTop) while (j0 + 1 < stv.length && stv[j0 + 1] > stv[j0]) j0++;
        else while (j0 - 1 >= 0 && stv[j0 - 1] > stv[j0]) j0--;
        return { y: ya + j0 - 0.5, s: mx };
      };
      const nC = 12, xa = f.fx0 + 0.04 * fw, xb = f.fx1 - 0.04 * fw;
      const pt = [], pb = [];
      for (let i = 0; i < nC; i++) {
        const x = xa + ((xb - xa) * i) / (nC - 1);
        const a = refine(x, rt.f(x), rt.slope, true), b = refine(x, rb.f(x), rb.slope, false);
        if (a) pt.push({ x, y: a.y }); if (b) pb.push({ x, y: b.y });
      }
      const tol = Math.max(2.5, Math.min(0.35 * pitch, 0.01 * Hm));
      let et = ransacEdge(pt, tol, !v3), eb = ransacEdge(pb, tol, !v3);
      if (!et || !eb || et.inliers.length < 4 || eb.inliers.length < 4) continue;
      // 周期性の確認：縁の外側に「縞の周期が続かない」面（上面・木目・パネル・パレット）を含んでいたら、周期が始まる所まで縁を寄せる
      const per = [];
      if (opts.periodic !== false && pitch >= 3 && !v3) {
        // 下端はパレット処理に任せる（下端に使うと反り・ぶれで線がそろわない所を誤って切った）。opts.periodicBottom=true で有効
        for (const isTop of opts.periodicBottom ? [true, false] : [true]) {
          const E0 = isTop ? et : eb, Eo = isTop ? eb : et;
          const sh = periodicEdge(gray, w, h, E0.f, Eo.f, f.fx0 + 0.06 * fw, f.fx1 - 0.06 * fw, pitch, isTop);
          per.push(sh);
          if (sh === null || Math.abs(sh) < 1.2 * pitch) continue;
          const P2 = [];
          for (let i = 0; i < nC; i++) { const x = xa + ((xb - xa) * i) / (nC - 1); const r = refine(x, E0.f(x) + sh, E0.slope, isTop, Math.max(4, Math.round(1.6 * pitch))); if (r) P2.push({ x, y: r.y }); }
          const E2 = ransacEdge(P2, tol);
          if (E2 && E2.inliers.length >= 4) { if (isTop) et = E2; else eb = E2; }
        }
      }
      // パレット：下端のすぐ上に「暗い開口部（横方向のばらつきが大きい行）」があれば、その上の板（デッキ）の上を積みの下端にする
      let pal = null;
      if (opts.pallet !== false) {
        pal = palletShift(gray, w, h, eb.f, f.fx0 + 0.05 * fw, f.fx1 - 0.05 * fw, pitch, Hm);
        if (pal) { const g0 = eb.f, o = pal.off; eb.f = (x) => g0(x) + o; }
      }
      // 帯の範囲：上下とも当てはまった列の範囲から内側へ
      const ix = (E) => [Math.min(...E.inliers.map((p) => p.x)), Math.max(...E.inliers.map((p) => p.x))];
      const [ta, tb] = ix(et), [ba, bb] = ix(eb);
      let ua = Math.max(ta, ba), ub = Math.min(tb, bb);
      if (ub - ua < 0.3 * fw) { ua = xa; ub = xb; }
      const span = ub - ua, oa = ua + 0.07 * span, ob = ub - 0.07 * span;
      const np = 5, up = [], lo = [];
      for (let i = 0; i < np; i++) { const x = oa + ((ob - oa) * i) / (np - 1); up.push({ x, y: et.f(x) }); lo.push({ x, y: eb.f(x) }); }
      // 面のスコア：面積 × 縞の明瞭さ
      let es = 0, en = 0;
      for (let x = Math.ceil(f.fx0 / k); x <= Math.floor(f.fx1 / k) && x < sw; x++) { const t0 = Math.round(et.f((x + 0.5) * k) / k), t1 = Math.round(eb.f((x + 0.5) * k) / k);
        for (let y = Math.max(0, t0); y <= Math.min(sh - 1, t1); y++) { es += st[y * sw + x]; en++; } }
      const area = span * Hm;
      out.push({ up, lo, x0: ua, x1: ub, pitch, score: f.rscore !== undefined ? f.rscore : area * Math.sqrt(es / Math.max(1, en)), pallet: pal, per, fit: { top: et.kind, bot: eb.kind, nt: et.inliers.length, nb: eb.inliers.length, rt: et.rms, rb: eb.rms } });
    }
    if (!out.length) return { fail: 'fit' };
    let ci = 0; for (let i = 1; i < out.length; i++) if (out[i].score > out[ci].score) ci = i;
    const F = out[ci];
    const ys = [...F.up, ...F.lo].map((p) => p.y);
    return { ok: true, up: F.up, lo: F.lo, rect: { x0: F.x0, x1: F.x1, y0: Math.min(...ys), y1: Math.max(...ys) }, tilt: edgeTilt(F.up, F.lo), stripeTilt: tilt, vertical,
      faces: out.map((o) => ({ up: o.up, lo: o.lo, x0: o.x0, x1: o.x1, score: o.score })), chosen: ci, corner, method: RG.v3 ? 'v3' : 'v2', fit: F.fit, pallet: F.pallet, pitchPx: F.pitch, tooFine: F.pitch < 3 };
    };
    // v2（縞の強さの行・列プロファイル）と v3（線のそろい具合の領域）の両方を作り、
    // v2 の帯が v3 の主な面の領域と十分に重なるなら v2（縁の精度が高い）を、そうでなければ v3 を使う。
    // （v2 は上面・背景・定規などへ外れやすい。v3 は面の選択が頑健だが縁の精度が劣る）
    if (opts.inRoi && opts.roiMode !== 'auto') {
      // 範囲の中：縁は切り出しの上下の端から 1/12 ほど内側にあるはず（範囲を ±10% で取る前提）。
      // 縞の向きで傾けた線を粗い縁とし、高さの ±(roiWin) の窓で段差を探す
      const sl = Math.tan((tilt * Math.PI) / 180), m0 = 0.5 / 6, xs = []; for (let i = 0; i <= 20; i++) xs.push(w * (0.05 + 0.9 * i / 20));
      const xc_ = w / 2;
      const lt = xs.map((x) => ({ x, y: h * m0 + sl * (x - xc_) })), lb = xs.map((x) => ({ x, y: h * (1 - m0) + sl * (x - xc_) }));
      const RR = { lt, lb, faces: [{ fx0: w * 0.05, fx1: w * 0.95, lt, lb, win: opts.roiWin || 0.1 }], corner: null };
      const DR = solve(RR);
      if (opts.roiMode === 'direct') return DR.fail ? fail(DR.fail) : DR;
      // 自動検出（下の通常の流れ）を範囲内で行い、縁が切り出しの端に張り付いた（範囲の外の上面・背景を拾った）ときだけ、
      // その縁を範囲の内側で探した結果に置き換える
      const DA = detectAuto(gray, w, h, Object.assign({}, opts, { roiMode: 'auto' }));
      if (!DA.ok) return DR.fail ? DA : DR;
      if (DR.fail) return DA;
      const meanY = (P) => P.reduce((a, p) => a + p.y, 0) / P.length;
      const edgeM = opts.roiEdge || 0.06;
      let rep = '';
      if (meanY(DA.up) < edgeM * h) { DA.up = DR.up; rep += 't'; }
      if (meanY(DA.lo) > (1 - edgeM) * h) { DA.lo = DR.lo; rep += 'b'; }
      if (rep) { DA.roiReplaced = rep; const xs = DA.up.map((q) => q.x); }
      return DA;
    }
    const R2 = roughV2(); const D2 = R2.fail ? R2 : solve(R2);
    const R3 = opts.v3 !== false ? roughV3() : null;
    if (!R3) return D2.fail ? fail(D2.fail) : D2;
    const D3 = solve(R3);
    if (D3.fail) return D2.fail ? fail(D2.fail) : D2;
    if (D2.fail) return D3;
    if (opts.v3Only) return D3;
    // 帯の「縞の証拠」：帯の中の score − τ の和（線のそろった所は正、無地・背景・上面は負）。大きい方を採る
    const M = R3.M, K = M.K;
    let p95 = 0; { const NB = 256, hst = new Int32Array(NB); for (let i = 0; i < M.score.length; i++) hst[Math.min(NB - 1, (M.score[i] * NB) | 0)]++;
      let acc = 0; for (let q = 0; q < NB; q++) { acc += hst[q]; if (acc >= 0.95 * M.score.length) { p95 = (q + 0.5) / NB; break; } } }
    const tau = (opts.hybTau || 0.3) * p95;
    const evid = (D) => { const xs = D.up.map((p) => p.x), xa = Math.min(...xs), xb = Math.max(...xs);
      const at = (P, x) => { let i = 0; while (i < P.length - 2 && x > P[i + 1].x) i++; const a0 = P[i], b0 = P[i + 1]; return a0.y + ((b0.y - a0.y) * (x - a0.x)) / (b0.x - a0.x); };
      let e = 0; for (let mx = Math.ceil(xa / K); mx <= Math.floor(xb / K) && mx < M.mw; mx++) { const x = (mx + 0.5) * K, t = at(D.up, x) / K, bb = at(D.lo, x) / K;
        for (let my = Math.max(0, Math.ceil(t)); my <= Math.min(M.mh - 1, Math.floor(bb)); my++) e += M.score[my * M.mw + mx] - tau; }
      return e; };
    const e2 = evid(D2), e3 = evid(D3);
    // 重なり：v3 が選んだ面の領域（列ごとの上下）と v2 の帯
    const f3 = R3.faces[0], at2 = (P, x) => { let i = 0; while (i < P.length - 2 && x > P[i + 1].x) i++; const a0 = P[i], b0 = P[i + 1]; return a0.y + ((b0.y - a0.y) * (x - a0.x)) / (b0.x - a0.x); };
    let inter = 0, a2 = 0, a3 = 0;
    { const xs2 = D2.up.map((p) => p.x), x2a = Math.min(...xs2), x2b = Math.max(...xs2);
      const colStep = f3.lt.length > 1 ? Math.max(1e-6, (f3.lt[f3.lt.length - 1].x - f3.lt[0].x) / (f3.lt.length - 1)) : 1;
      for (let q = 0; q < f3.lt.length; q++) { const x = f3.lt[q].x, t3 = f3.lt[q].y, b3 = f3.lb[q].y; a3 += Math.max(0, b3 - t3);
        if (x >= x2a && x <= x2b) { const t2 = at2(D2.up, x), b2 = at2(D2.lo, x); inter += Math.max(0, Math.min(b2, b3) - Math.max(t2, t3)); } }
      for (let x = x2a; x <= x2b; x += colStep) a2 += Math.max(0, at2(D2.lo, x) - at2(D2.up, x)); }
    const prec = inter / Math.max(1, a2), cov = inter / Math.max(1, a3);
    const useV2 = (opts.hyb || 'overlap') === 'overlap' ? prec >= (opts.hybPrec || 0.6) && cov >= (opts.hybCov || 0.4) : e2 >= (opts.hybRatio || 0.8) * e3;
    const D = useV2 ? D2 : D3;
    D.hybrid = { e2: Math.round(e2), e3: Math.round(e3), prec: +prec.toFixed(2), cov: +cov.toFixed(2), use: useV2 ? 'v2' : 'v3' };
    return D;
  }
  // grid.describe() の純データから表示・タップ用の変換を復元（Worker→UI 用）
  function fromDescription(d) {
    const e = edges(d.w, d.h, d.upper, d.lower), b = d.beta || 0;
    const tToImage = (s, x) => { const a = e.top(x); return { x, y: a + sToT(s, b) * (e.bot(x) - a) }; };
    const imageToT = (x, y) => { const a = e.top(x); return tToS((y - a) / (e.bot(x) - a), b); };
    return Object.assign({}, d, { tToImage, imageToT, top: e.top, bot: e.bot });
  }
  return { rectify, detect, edges, fromDescription, stripeMap, faceRegions, mergeRegions, trimRegion };
})();

// ===== photometry（影・画質担当）: 帯から頑健なプロファイルを作る =====
// 契約:
//   Photometry.profile(gray, w, h, grid, opts) -> { prof: Float64Array(R), stepScore?: Float64Array(R), colWeight?: Float64Array(nc), info? }
//     prof[i] は t = grid.tMin + (grid.tMax-grid.tMin)*i/(R-1) における帯の代表的な明暗（ゼロ平均でよい）
//     opts.cols = [j0, j1) を渡すとその列範囲だけで作る（左・中・右の帯用）
//   Photometry.lighting(gray, w, h, grid) -> { dark, glare, shadow, bright, sat } // 実装メモ（v4 影・画質担当）:
//   1) 列ごとに双一次サンプリング → 白とび画素(近傍に>=SAT)は除外 → 隣接列グループで平均 → log(I + off)
//      off = max(8, 2σ)（σ: 横方向差分から推定した画素ノイズ）
//   2) 隣接列を G 個（<=MAXG）のグループにまとめる
//   3) グループごとにトレンド除去（中心窓 3周期の平均）→ 局所RMS（±1周期、下限付き）で割ってコントラスト正規化。
//      log 領域なので影（乗算）は加算的な段差になり、影の中の縞も明部と同じ振幅になる
//   4) 各 t で重み付きトリム平均（上下 TRIM ずつ除外）。重み = colWeight × 縞の明瞭さ（テンプレートとの局所相関）× 白とびでない割合
//   5) stepScore[i] = 段差らしさ（左右の平均差 / 局所RMS、グループの重み付き平均。log 領域）
//   info = { pitch, off, sigma, satFrac, darkFrac, shadowRatio, stepMax, nGroups }
const Photometry = (() => {
  const { fft } = Core;
  const SAT = 250, MAXG = 48, TRIM = 0.2;
  const cache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  // --- 帯の生サンプル。列範囲（グループ）ごとに、白とびでない画素の線形輝度を平均する
  //     ranges: [[ja,jb),...] → [{ja, jb, lin: Float32Array(R) (NaN=全部白とび), gw, gsat}]
  function sampleGroups(gray, w, h, grid, ranges) {
    const { R, tMin, tMax } = grid, out = [];
    const dt = (tMax - tMin) / (R - 1);
    for (const [ja, jb] of ranges) {
      const s = new Float64Array(R), cw = new Float64Array(R);
      let wsum = 0, nsat = 0, ntot = 0;
      for (let j = ja; j < jb; j++) {
        const wj = grid.colWeight ? grid.colWeight[j] : 1; wsum += wj;
        // map(j,t) が t について1次式なら（5点で確認）呼び出しを省いて増分計算する
        const pa = grid.map(j, tMin), pb = grid.map(j, tMax);
        let lin = true;
        for (const f of [0.25, 0.5, 0.75, 0.9]) {
          const q = grid.map(j, tMin + (tMax - tMin) * f);
          if (Math.abs(q.x - (pa.x + (pb.x - pa.x) * f)) > 1e-3 || Math.abs(q.y - (pa.y + (pb.y - pa.y) * f)) > 1e-3) { lin = false; break; }
        }
        const ddx = (pb.x - pa.x) / (R - 1), ddy = (pb.y - pa.y) / (R - 1);
        for (let i = 0; i < R; i++) {
          let x, y;
          if (lin) { x = pa.x + ddx * i; y = pa.y + ddy * i; } else { const p = grid.map(j, tMin + dt * i); x = p.x; y = p.y; }
          const x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0, fx = x - x0, fy = y - y0;
          const a = gray[y0 * w + x0], b = gray[y0 * w + x1], c = gray[y1 * w + x0], d = gray[y1 * w + x1];
          // 白とび: 近傍4画素のどれかが飽和していれば除外（混ざりを避ける）
          if (a >= SAT || b >= SAT || c >= SAT || d >= SAT) { nsat++; continue; }
          s[i] += wj * ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy); cw[i] += wj;
        }
        ntot += R;
      }
      const lin = new Float32Array(R);
      for (let i = 0; i < R; i++) lin[i] = cw[i] > 0 ? s[i] / cw[i] : NaN;
      out.push({ ja, jb, lin, gw: wsum / Math.max(1, jb - ja), gsat: 1 - nsat / Math.max(1, ntot) });
    }
    return out;
  }
  function splitRange(c0, c1, G) { const r = [], n = c1 - c0; for (let g = 0; g < G; g++) { const a = c0 + Math.floor((n * g) / G), b = c0 + Math.floor((n * (g + 1)) / G); if (b > a) r.push([a, b]); } return r; }

  // grid ごとのキャッシュ（帯3本＋全体で4回、さらに lighting で呼ばれるため）
  function sampleAll(gray, w, h, grid) {
    let c = cache && cache.get(grid);
    if (c && c.gray === gray) return c;
    const { nc, R, tMin, tMax } = grid;
    // 全体のグループ: 3帯の境界にそろえる（帯ごとに MAXG/3 グループ）→ 帯のプロファイルで使い回す
    let ranges;
    if (nc >= 24) { ranges = []; for (let b = 0; b < 3; b++) ranges.push(...splitRange(Math.floor((nc * b) / 3), Math.floor((nc * (b + 1)) / 3), MAXG / 3)); }
    else ranges = splitRange(0, nc, Math.min(nc, MAXG));
    const groups = sampleGroups(gray, w, h, grid, ranges);
    // 画素ノイズ σ の推定: 横方向差分（縞は横向きなので主にノイズ）
    const diffs = [];
    const stepI = Math.max(1, Math.floor(R / 200)), stepJ = Math.max(1, Math.floor(nc / 40));
    for (let j = 0; j < nc; j += stepJ) for (let i = 0; i < R; i += stepI) {
      const p = grid.map(j, tMin + ((tMax - tMin) * i) / (R - 1));
      const x = Math.round(p.x), y = Math.round(p.y);
      if (x < 1 || x >= w - 1 || y < 0 || y >= h) continue;
      const a = gray[y * w + x], b = gray[y * w + x + 1];
      if (a >= SAT || b >= SAT) continue;
      diffs.push(Math.abs(a - b));
    }
    diffs.sort((a, b) => a - b);
    const sigma = diffs.length ? (1.4826 * diffs[diffs.length >> 1]) / Math.SQRT2 : 2;
    const off = Math.max(8, 2 * sigma);
    const i0 = Math.max(0, Math.ceil(((0 - tMin) / (tMax - tMin)) * (R - 1))), i1 = Math.min(R - 1, Math.floor(((1 - tMin) / (tMax - tMin)) * (R - 1)));
    // 白とび・暗さの集計（t∈[0,1] のみ）
    let nIn = 0, nDark = 0, bsum = 0, satAcc = 0;
    for (const g of groups) { satAcc += 1 - g.gsat; for (let i = i0; i <= i1; i += 2) { const v = g.lin[i]; nIn++; if (v === v) { bsum += v; if (v < 40) nDark++; } else bsum += 255; } }
    c = { gray, groups, sigma, off, i0, i1, satFrac: satAcc / Math.max(1, groups.length), darkFrac: nDark / Math.max(1, nIn), bright: bsum / Math.max(1, nIn), pitch: 0 };
    for (const g of groups) toLog(g, off);
    if (cache) cache.set(grid, c);
    return c;
  }
  function toLog(g, off) { const R = g.lin.length; g.x = new Float64Array(R); for (let i = 0; i < R; i++) { const v = g.lin[i]; g.x[i] = v === v ? Math.log(v + off) : NaN; } }

  // 周期（サンプル数）の粗い推定: 平均プロファイルの調和和スペクトル
  function estimatePitch(prof, Hpx) {
    const m = prof.length;
    let mu = 0; for (let i = 0; i < m; i++) mu += prof[i]; mu /= m;
    let P = 1; while (P < m * 2) P <<= 1;
    const re = new Float64Array(P), im = new Float64Array(P);
    for (let i = 0; i < m; i++) re[i] = (prof[i] - mu) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1)));
    fft(re, im);
    const S = new Float64Array(P / 2); for (let k = 0; k < P / 2; k++) S[k] = re[k] * re[k] + im[k] * im[k];
    // c = 枚数相当（m サンプル中の周期数）。k = c * P / m
    const cMin = 2, cMax = Math.max(3, Math.floor((m - 1) / 4.4));
    let best = 0, bc = 0;
    for (let k = Math.ceil((cMin * P) / m); k < S.length && (k * m) / P <= cMax; k++) {
      const Sw = (q) => (q < S.length ? S[q] : 0);
      const v = Sw(k) + 0.5 * Sw(2 * k) + 0.33 * Sw(3 * k);
      if (v > best) { best = v; bc = k; }
    }
    if (!bc) return m / 10;
    // 注: 「半分の周波数を優先する」補正はベンチで悪化したため入れていない（枚数が少ない時に低周波の照明ムラを拾う）
    return P / bc; // サンプル数/周期
  }

  // 1グループの信号 x（NaN=無効）: 段差を保つトレンド除去。hr: 除去後, st: 段差(符号付き, 床なし), ms: 局所二乗平均
  function detrendGroup(x, n, p, hr, st, ms, valid) {
    const W = Math.max(3, Math.round(1.5 * p)); // 片側の窓長（トレンド窓 = 3周期）
    const cs = new Float64Array(n + 1), cq = new Float64Array(n + 1), cn = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const v = x[i], ok = v === v;
      valid[i] = ok ? 1 : 0;
      cs[i + 1] = cs[i] + (ok ? v : 0); cq[i + 1] = cq[i] + (ok ? v * v : 0); cn[i + 1] = cn[i] + (ok ? 1 : 0);
    }
    const W2 = 2 * W;
    for (let i = 0; i < n; i++) {
      // トレンド: 中心窓 [i-W, i+W] の平均（有効画素のみ）。
      // 注: 左・中・右の分散最小窓を選ぶ「段差保存」版も試したが、ベンチでは単純な中心窓の方が良かった
      const a = i - W < 0 ? 0 : i - W, b = i + W + 1 > n ? n : i + W + 1, k = cn[b] - cn[a];
      const base = k > 0 ? (cs[b] - cs[a]) / k : 0;
      hr[i] = valid[i] ? x[i] - base : 0;
      // 段差: 左右窓 [i-2W,i), [i,i+2W) の平均差 / 標準偏差
      const a0 = i - W2 < 0 ? 0 : i - W2, b1 = i + W2 > n ? n : i + W2;
      const ka = cn[i] - cn[a0], kb = cn[b1] - cn[i];
      if (ka >= 2 && kb >= 2) {
        const ma = (cs[i] - cs[a0]) / ka, mb = (cs[b1] - cs[i]) / kb;
        const va = (cq[i] - cq[a0]) / ka - ma * ma, vb = (cq[b1] - cq[i]) / kb - mb * mb;
        st[i] = (mb - ma) / Math.sqrt(Math.max(1e-8, 0.5 * (va + vb)));
      } else st[i] = 0;
    }
    // 局所二乗平均（窓 ≈ ±1周期。ベンチで ±0.7〜±3 周期を比較し最良）
    const H = Math.max(3, Math.round(p)), cr = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cr[i + 1] = cr[i] + hr[i] * hr[i];
    for (let i = 0; i < n; i++) {
      const a = i - H < 0 ? 0 : i - H, b = i + H + 1 > n ? n : i + H + 1, k = cn[b] - cn[a];
      ms[i] = k > 0 ? (cr[b] - cr[a]) / k : 0;
    }
  }

  function movSum(x, n, H, out) {
    const c = new Float64Array(n + 1); for (let i = 0; i < n; i++) c[i + 1] = c[i] + x[i];
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - H), b = Math.min(n, i + H + 1); out[i] = c[b] - c[a]; }
  }

  // 重み付きトリム平均（列方向）。idx は前の t の並び順を引き継ぐ（ほぼ整列済みなので挿入ソートが速い）
  function trimmedMean(vals, wts, G, idx) {
    let W = 0;
    for (let k = 0; k < G; k++) W += wts[k];
    if (W <= 0) return 0;
    for (let a = 1; a < G; a++) { const v = idx[a], vv = vals[v]; let b = a - 1; while (b >= 0 && vals[idx[b]] > vv) { idx[b + 1] = idx[b]; b--; } idx[b + 1] = v; }
    const lo = TRIM * W, hi = (1 - TRIM) * W;
    let acc = 0, s = 0, sw = 0;
    for (let a = 0; a < G; a++) {
      const k = idx[a], wk = wts[k]; if (wk <= 0) continue;
      const a0 = acc, a1 = acc + wk; acc = a1;
      if (a1 <= lo) continue; if (a0 >= hi) break;
      const ov = (a1 < hi ? a1 : hi) - (a0 > lo ? a0 : lo);
      s += ov * vals[k]; sw += ov;
    }
    return sw > 0 ? s / sw : 0;
  }

  // グループの正規化（周期 p・下限 floor が決まった後）
  function finishGroups(groups, R, p, C) {
    for (const g of groups) {
      if (g.nx) continue;
      g.hr = new Float64Array(R); g.st = new Float64Array(R); g.ms = new Float64Array(R); g.valid = new Uint8Array(R);
      detrendGroup(g.x, R, p, g.hr, g.st, g.ms, g.valid);
    }
    if (!C.floor2) {
      const rr = [];
      for (const g of groups) for (let i = C.i0; i <= C.i1; i += 17) if (g.valid[i]) rr.push(g.ms[i]);
      rr.sort((a, b) => a - b);
      const med = rr.length ? Math.sqrt(rr[rr.length >> 1]) : 0.05;
      C.floor2 = (0.25 * med + 1e-4) ** 2;
    }
    for (const g of groups) {
      if (g.nx) continue;
      g.nx = new Float64Array(R);
      for (let i = 0; i < R; i++) g.nx[i] = g.valid[i] ? g.hr[i] / Math.sqrt(g.ms[i] + C.floor2) : 0;
    }
  }

  function template(groups, R, vals, wts, idx, useCw) {
    const G = groups.length, out = new Float64Array(R);
    for (let k = 0; k < G; k++) idx[k] = k;
    for (let i = 0; i < R; i++) {
      for (let g = 0; g < G; g++) { const q = groups[g]; vals[g] = q.nx[i]; wts[g] = q.valid[i] ? q.gw * q.gsat * (useCw ? q.cw[i] : 1) : 0; }
      out[i] = trimmedMean(vals, wts, G, idx);
    }
    return out;
  }
  // 縞の明瞭さ: テンプレートとの局所相関（窓 ≈ ±3周期）
  function clarity(groups, tmpl, R, p) {
    const H3 = Math.max(4, Math.round(3 * p));
    const tt = new Float64Array(R); for (let i = 0; i < R; i++) tt[i] = tmpl[i] * tmpl[i];
    const sTT = new Float64Array(R); movSum(tt, R, H3, sTT);
    const a1 = new Float64Array(R), a2 = new Float64Array(R), sXT = new Float64Array(R), sXX = new Float64Array(R);
    for (const g of groups) {
      if (g.cw) continue;
      const x = g.nx;
      for (let i = 0; i < R; i++) { a1[i] = x[i] * tmpl[i]; a2[i] = x[i] * x[i]; }
      movSum(a1, R, H3, sXT); movSum(a2, R, H3, sXX);
      const c = new Float64Array(R); let cm = 0;
      for (let i = 0; i < R; i++) { const r = sXT[i] / Math.sqrt(sXX[i] * sTT[i] + 1e-12); const q = r > 0 ? r : 0; c[i] = 0.05 + q * q; cm += c[i]; }
      g.cw = c; g.clar = cm / R;
    }
  }

  function profile(gray, w, h, grid, opts = {}) {
    const { nc, R } = grid;
    const C = sampleAll(gray, w, h, grid);
    const [c0, c1] = opts.cols || [0, nc];
    if (!C.tmpl) {
      // 周期推定: グループ平均の1次差分（段差の影響を弱める）
      const m0 = new Float64Array(R);
      for (const g of C.groups) for (let i = 0; i < R; i++) { const v = g.x[i]; if (v === v) m0[i] += v; }
      const d = new Float64Array(R); for (let i = 1; i < R; i++) d[i] = m0[i] - m0[i - 1];
      C.pitch = Math.max(3, estimatePitch(d, grid.Hpx));
      finishGroups(C.groups, R, C.pitch, C);
      const n = C.groups.length, vals = new Float64Array(n), wts = new Float64Array(n), idx = new Int32Array(n);
      C.tmpl = template(C.groups, R, vals, wts, idx, false);
      clarity(C.groups, C.tmpl, R, C.pitch);
      // 段差スコア（全体）
      C.step = new Float64Array(R);
      for (let i = 0; i < R; i++) { let ss = 0, sw = 0; for (const g of C.groups) if (g.valid[i]) { ss += g.gw * Math.abs(g.st[i]); sw += g.gw; } C.step[i] = sw ? ss / sw : 0; }
    }
    let groups = C.groups.filter((g) => g.ja >= c0 && g.jb <= c1);
    const covered = groups.reduce((s, g) => s + g.jb - g.ja, 0);
    let step = C.step;
    if (covered !== c1 - c0) { // 帯の分割と合わない列範囲 → その場で作る
      groups = sampleGroups(gray, w, h, grid, splitRange(c0, c1, Math.min(MAXG, Math.max(1, c1 - c0))));
      for (const g of groups) toLog(g, C.off);
      finishGroups(groups, R, C.pitch, C);
      clarity(groups, C.tmpl, R, C.pitch);
      step = null;
    }
    const G = groups.length, vals = new Float64Array(G), wts = new Float64Array(G), idx = new Int32Array(G);
    const prof = template(groups, R, vals, wts, idx, true);
    if (!step || opts.cols) {
      step = new Float64Array(R);
      for (let i = 0; i < R; i++) { let ss = 0, sw = 0; for (const g of groups) if (g.valid[i]) { ss += g.gw * Math.abs(g.st[i]); sw += g.gw; } step[i] = sw ? ss / sw : 0; }
    }
    let mu = 0; for (let i = 0; i < R; i++) mu += prof[i]; mu /= R;
    for (let i = 0; i < R; i++) prof[i] -= mu;
    let stepMax = 0; for (let i = C.i0; i <= C.i1; i++) if (step[i] > stepMax) stepMax = step[i];
    const info = { pitch: C.pitch, off: C.off, sigma: C.sigma, satFrac: C.satFrac, darkFrac: C.darkFrac, bright: C.bright, stepMax, nGroups: G, clarity: groups.map((g) => +g.clar.toFixed(3)) };
    return { prof, stepScore: step, info };
  }

  // カメラ案内: 暗い・白とび・影（帯を 8×8 ブロックに分けた明るさの比 / 隣接ブロックの段差）
  //   -> { bright, sat, dark, glare, shadow, shadowRatio, shadowEdge, shadowDir, darkFrac, noise, sharp(0〜1, null=不明), advice }
  function lighting(gray, w, h, grid) {
    const C = sampleAll(gray, w, h, grid);
    const G = C.groups.length, NB = 8, NX = Math.min(NB, G);
    const B = new Float64Array(NX * NB), N = new Float64Array(NX * NB);
    const span = Math.max(1, C.i1 - C.i0 + 1);
    for (let g = 0; g < G; g++) {
      const bx = Math.min(NX - 1, Math.floor((g * NX) / G)), lin = C.groups[g].lin;
      for (let i = C.i0; i <= C.i1; i += 2) {
        const v = lin[i]; if (v !== v) continue;
        const by = Math.min(NB - 1, Math.floor(((i - C.i0) * NB) / span));
        B[by * NX + bx] += v; N[by * NX + bx]++;
      }
    }
    const M = new Float64Array(NX * NB).fill(NaN);
    let mx = 0, mn = Infinity;
    for (let k = 0; k < M.length; k++) if (N[k] > 0) { M[k] = B[k] / N[k]; mx = Math.max(mx, M[k]); mn = Math.min(mn, M[k]); }
    const shadowRatio = mx / Math.max(4, mn);
    // 隣接ブロックの明るさ比（くっきりした影の縁）。横に隣接＝縦の影の縁、縦に隣接＝横（縞と平行）の影の縁
    let ex = 1, ey = 1;
    const r = (a, b) => (a === a && b === b ? Math.max(a, b) / Math.max(4, Math.min(a, b)) : 1);
    for (let by = 0; by < NB; by++) for (let bx = 0; bx < NX; bx++) {
      const v = M[by * NX + bx];
      if (bx + 1 < NX) ex = Math.max(ex, r(v, M[by * NX + bx + 1]));
      if (by + 1 < NB) ey = Math.max(ey, r(v, M[(by + 1) * NX + bx]));
    }
    const bright = C.bright, sat = C.satFrac;
    // 鮮明さ（ピンぼけ・ブレ）: 縦方向の差分エネルギーを 1px と 2px の間隔で比べる（ノイズ分 2σ² を差し引く）
    //   q = √(D1/D3)（1px 差と 2px 差/2 の比）。ぼけ→1/3 付近、合成のくっきり画像で ≈0.5。sharp = (q − 1/3)/0.2 を 0〜1 に丸める
    let d1 = 0, d2 = 0, nd = 0;
    const { nc, R, tMin, tMax } = grid;
    const sj = Math.max(1, Math.floor(nc / 24)), si = Math.max(1, Math.floor(R / 300));
    for (let j = 0; j < nc; j += sj) for (let i = 0; i < R; i += si) {
      const t = tMin + ((tMax - tMin) * i) / (R - 1); if (t < 0.02 || t > 0.98) continue;
      const p = grid.map(j, t), x = Math.round(p.x), y = Math.round(p.y);
      if (x < 0 || x >= w || y < 2 || y >= h - 2) continue;
      const a = gray[(y - 1) * w + x], b = gray[y * w + x], c = gray[(y + 1) * w + x], e = gray[(y + 2) * w + x];
      if (a >= SAT || b >= SAT || c >= SAT || e >= SAT) continue;
      d1 += (c - b) * (c - b); d2 += (e - a) * (e - a) / 2; nd++;
    }
    let sharp = null;
    if (nd > 50) {
      const n2 = 2 * C.sigma * C.sigma;
      const D1 = Math.max(1e-6, d1 / nd - n2), D3 = Math.max(1e-6, (2 * d2) / nd - n2);
      const q = Math.sqrt(D1 / D3); // ぼけ: ≈1/3、くっきり: ≈1
      sharp = Math.max(0, Math.min(1, (q - 1 / 3) / 0.2)); // 目安: くっきり≥0.6、ぼけ σ≈1px で ≈0.3、σ≥2px で ≈0.1
    }
    const dark = bright <= 55, glare = sat >= 0.05, shadow = shadowRatio > 3 || Math.max(ex, ey) > 2.2;
    const advice = glare ? '反射しています：角度を変えてください' : shadow ? '影がかかっています：立ち位置を変えてください' : dark ? '暗いです：ライトを当ててください' : '';
    return {
      bright, sat, dark, glare, shadow, shadowRatio, shadowEdge: Math.max(ex, ey), shadowDir: ex >= ey ? 'x' : 'y',
      darkFrac: C.darkFrac, noise: C.sigma, sharp, advice,
    };
  }

  // 連写の重ね合わせ: 縦方向の平行移動のみ（位相相関）。相関の弱いコマは捨てる
  function stack(frames, w, h) {
    if (!frames || !frames.length) return null;
    if (frames.length === 1) return Float32Array.from(frames[0]);
    const x0 = Math.floor(w * 0.25), x1 = Math.ceil(w * 0.75);
    let P = 1; while (P < h * 2) P <<= 1;
    const rowProf = (g) => {
      const re = new Float64Array(P), im = new Float64Array(P);
      const r = new Float64Array(h);
      for (let y = 0; y < h; y++) { let s = 0; for (let x = x0; x < x1; x++) s += Math.log(g[y * w + x] + 8); r[y] = s / (x1 - x0); }
      for (let y = 1; y < h; y++) re[y] = (r[y] - r[y - 1]) * (0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (h - 1)));
      fft(re, im); return [re, im];
    };
    const [Rr, Ri] = rowProf(frames[0]);
    const acc = Float64Array.from(frames[0]), cnt = new Float64Array(w * h).fill(1);
    const maxShift = Math.round(h * 0.1);
    for (let f = 1; f < frames.length; f++) {
      const [Fr, Fi] = rowProf(frames[f]);
      const re = new Float64Array(P), im = new Float64Array(P);
      for (let k = 0; k < P; k++) { const a = Rr[k] * Fr[k] + Ri[k] * Fi[k], b = Ri[k] * Fr[k] - Rr[k] * Fi[k]; const m = Math.hypot(a, b) + 1e-12; re[k] = a / m; im[k] = -b / m; }
      fft(re, im); // 逆変換の代わり（実部は対称）
      let best = -Infinity, bs = 0; let sum = 0, sq = 0;
      for (let s = -maxShift; s <= maxShift; s++) { const v = re[(s + P) % P]; sum += v; sq += v * v; if (v > best) { best = v; bs = s; } }
      const nS = 2 * maxShift + 1, mean = sum / nS, sd = Math.sqrt(Math.max(1e-12, sq / nS - mean * mean));
      if ((best - mean) / sd < 6) continue; // 位置合わせ失敗 → 捨てる
      const vm = re[(bs - 1 + P) % P], vp = re[(bs + 1) % P], den = vm - 2 * best + vp;
      const sub = den < 0 ? (0.5 * (vm - vp)) / den : 0;
      const shift = -(bs + sub); // frames[f](y + shift) ≈ frames[0](y)
      const g = frames[f];
      for (let y = 0; y < h; y++) {
        const ys = y + shift; if (ys < 0 || ys > h - 1) continue;
        const ya = Math.floor(ys), yb = Math.min(h - 1, ya + 1), fy = ys - ya;
        for (let x = 0; x < w; x++) { acc[y * w + x] += g[ya * w + x] * (1 - fy) + g[yb * w + x] * fy; cnt[y * w + x]++; }
      }
    }
    const out = new Float32Array(w * h); for (let i = 0; i < out.length; i++) out[i] = acc[i] / cnt[i];
    return out;
  }

  return { profile, lighting, stack };
})();

// ===== count（信号処理担当）: プロファイルから境界線を1本ずつ決めて数える =====
// 契約:
//   Count.count(prof, grid, opts) -> { count, lines: t[] (上端・下端を除く境界, 昇順, grid の t 座標),
//        pitchPx, polarity, confidence:'high'|'mid'|'low', ratio, candidates:[{count, lines}],
//        review:{sheetFlags, lineFlags, medGap, edgeFlags?, bandAgree?, reasons?}, plot, minC, maxC, _r, topT?, botT? }
//   Count.review(res, lines) -> review   // 手動修正後の再点検
//   topT/botT: 上端・下端を動かした場合の最終位置（省略時 0/1）。枚数は「上端〜下端の間の区間数」= lines.length + 1
//   Count.vote(results[]) -> 1つの結果   // 連写の各コマの結果を多数決で1つにまとめる
//   opts.bandProfs: [左, 中, 右] のプロファイル（同じ grid の t 座標）。照合に使ってよい
//   opts.stepScore: 段差らしさ（0..1 程度, prof と同じ長さ）。あれば応答を減衰する
//   prof の t 範囲は grid.tMin..grid.tMax。lines と topT/botT もこの t 座標で返す
//   grid.tMin<0 / tMax>1（opts.tMargin）のとき、上端・下端を ±0.6枚の範囲で DP 内で動かす
// v4 の変更点（信号処理担当）:
//   ・端を動ける特殊ノードにして DP で同時最適化（縁の段差の強さ＋タップ位置の事前分布）
//   ・応答は「両側が明るい（暗い）ときだけ反応する」細い谷検出（段差に弱い）と従来の帯域通過の積
//   ・2パス目で局所周期 p(t) を推定し、ペナルティを局所 p で評価
//   ・候補（倍音・半周期）は DP の結果（線上応答・中点応答）で比較
//   ・左中右の3帯を同じ方法で数え、境界列を位置合わせして照合（不一致は要確認）
//   ・要確認：端のあいまいさ、帯の不一致、間隔・応答の外れ、候補の競合
const Count = (() => {
  const { fft, movAvg, gaussSmooth } = Core;
  let RESP_MODE = 'mix', RESP_MIX = 0.5;
  const EDGE_RANGE = 0.9; // 端を動かせる範囲（枚）
  // 要確認のしきい値（dev の tap/auto で較正）
  const END_Z = 1e9; // 端の区間の明るさ外れ（z>3）は誤警報が多く見逃しがほぼ減らないので無効（dev と ext で評価）
  const COARSE_MAXN = 30, COARSE_SCORE = 0.35, COARSE_RATIO = 0.4;
  const TIER_SEP = 1.5, TIER_CON = 3, PLY_SKEW = 0.3, PLY_MAXN = 20;
  const EF_AT2 = 1e9, // 端そのものが強い線だけで要確認にする案は dev の誤警報が 22%→76% になるため無効
   EF_OUT = 0.6, EF_AT = 0.7, EF_GLO = 0.7, EF_GHI = 1.35, WEAK_REL = -0.3, THIN_REL = 0.6, THICK_REL = 1.33;
  const STEP_LO = 3, STEP_HI = 8, STEP_FLOOR = 0.25; // stepScore による減衰

  // ---------- 周期推定（倍音和スペクトル） ----------
  function spectrum(prof, Hpx, minCount) {
    const m = prof.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < m; i++) { sx += i; sy += prof[i]; sxx += i * i; sxy += i * prof[i]; }
    const b = (m * sxy - sx * sy) / (m * sxx - sx * sx || 1), a = (sy - b * sx) / m;
    let P = 1; while (P < m * 8) P <<= 1;
    const re = new Float64Array(P), im = new Float64Array(P);
    for (let i = 0; i < m; i++) re[i] = (prof[i] - a - b * i) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1)));
    fft(re, im);
    const spec = new Float64Array(P / 2);
    for (let k = 0; k < P / 2; k++) spec[k] = re[k] * re[k] + im[k] * im[k];
    const S = (c) => { const k = (c * P) / (m - 1), k0 = Math.floor(k); if (k0 + 1 >= spec.length) return 0; return spec[k0] * (1 - (k - k0)) + spec[k0 + 1] * (k - k0); };
    const minC = Math.max(2, minCount || 2), maxC = Math.max(minC + 1, Math.floor(Hpx / 2.2));
    const Hs = (c) => S(c) + 0.5 * S(2 * c) + 0.33 * S(3 * c);
    const step = 0.05, grid = [], score = [];
    for (let c = minC; c <= maxC; c += step) { grid.push(c); score.push(Hs(c)); }
    const peaks = [];
    for (let i = 1; i < score.length - 1; i++) if (score[i] >= score[i - 1] && score[i] > score[i + 1]) {
      const A = score[i - 1], B = score[i], C = score[i + 1], den = A - 2 * B + C;
      peaks.push({ c: grid[i] + (den ? (0.5 * (A - C)) / den : 0) * step, score: B });
    }
    peaks.sort((x, y) => y.score - x.score);
    const sorted = [...score].sort((x, y) => x - y), median = sorted[Math.floor(sorted.length / 2)] || 1e-12;
    const plot = []; const stride = Math.max(1, Math.floor(grid.length / 400));
    for (let i = 0; i < grid.length; i += stride) plot.push([grid[i], score[i]]);
    return { peaks, median, plot, minC, maxC, Hs };
  }

  // Welch 法（区間ごとのパワーの平均）: 厚さのばらつきで位相がずれても周期の山が崩れにくい
  function spectrumWelch(prof, minC, maxC, nseg) {
    const m = prof.length, Lw = Math.floor((2 * m) / (nseg + 1));
    if (Lw < 32) return null;
    let P = 1; while (P < Lw * 4) P <<= 1;
    const acc = new Float64Array(P / 2), re = new Float64Array(P), im = new Float64Array(P);
    const hop = Math.floor(Lw / 2);
    let segs = 0;
    for (let a = 0; a + Lw <= m; a += hop) {
      re.fill(0); im.fill(0);
      let mu = 0; for (let i = 0; i < Lw; i++) mu += prof[a + i]; mu /= Lw;
      for (let i = 0; i < Lw; i++) re[i] = (prof[a + i] - mu) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (Lw - 1)));
      fft(re, im);
      for (let k = 0; k < P / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
      segs++;
    }
    // c（全体での枚数）→ 区間内の周波数 bin: k = c * (Lw-1)/(m-1) * P/(Lw-1) = c*P/(m-1)
    const S = (c) => { const k = (c * P) / (m - 1), k0 = Math.floor(k); if (k0 + 1 >= acc.length) return 0; return acc[k0] * (1 - (k - k0)) + acc[k0 + 1] * (k - k0); };
    const Hs = (c) => S(c) + 0.5 * S(2 * c) + 0.33 * S(3 * c);
    // 区間内で 3 周期以上ある範囲だけ
    const cLo = Math.max(minC, (3 * (m - 1)) / Lw);
    const step = Math.max(0.05, cLo * 0.01), grid = [], score = [];
    for (let c = cLo; c <= maxC; c += Math.max(step, c * 0.004)) { grid.push(c); score.push(Hs(c)); }
    const peaks = [];
    for (let i = 1; i < score.length - 1; i++) if (score[i] >= score[i - 1] && score[i] > score[i + 1]) {
      const A = score[i - 1], B = score[i], C = score[i + 1], den = A - 2 * B + C, st = grid[i + 1] - grid[i];
      peaks.push({ c: grid[i] + (den ? (0.5 * (A - C)) / den : 0) * st, score: B });
    }
    peaks.sort((x, y) => y.score - x.score);
    const sorted = [...score].sort((x, y) => x - y), median = sorted[Math.floor(sorted.length / 2)] || 1e-12;
    return { peaks, median, Hs };
  }

  // ---------- 境界応答 ----------
  // polarity: 1=境界が暗い谷（bright ではない）, -1=明るい線。null なら歪度で決める
  function response(prof, p, opts = {}) {
    const n = prof.length;
    const sm = gaussSmooth(prof, Math.max(0.6, p / 10));
    const base = movAvg(sm, Math.max(3, Math.round(p)));
    const hp = new Float64Array(n); for (let i = 0; i < n; i++) hp[i] = sm[i] - base[i];
    let sign = opts.sign;
    if (!sign) {
      // 歪度は内側（端の段差を除く）で評価
      const a = opts.i0 != null ? Math.max(0, Math.round(opts.i0 + p)) : 0, b = opts.i1 != null ? Math.min(n, Math.round(opts.i1 - p)) : n;
      let m3 = 0; for (let i = a; i < b; i++) m3 += hp[i] * hp[i] * hp[i];
      if (b - a < 3 * p) { m3 = 0; for (const v of hp) m3 += v * v * v; }
      let m2 = 0; for (let i = a; i < b; i++) m2 += hp[i] * hp[i];
      if (b - a < 3 * p) { m2 = 0; for (const v of hp) m2 += v * v; }
      const cnt = b - a < 3 * p ? n : b - a;
      sign = m3 > 0 ? 1 : -1;
      var skew = (m3 / cnt) / Math.pow(m2 / cnt + 1e-12, 1.5);
    }
    const polarity = sign > 0 ? 'bright' : 'dark';
    const sq = new Float64Array(n); for (let i = 0; i < n; i++) sq[i] = hp[i] * hp[i];
    const rms = movAvg(sq, Math.max(5, Math.round(4 * p)));
    // 細い谷（線）検出：中心と両側の平均の差の小さい方（段差では片側が0になる）
    const w1 = Math.max(1, Math.round(p * 0.2)), w2 = Math.max(w1 + 1, Math.round(p * 0.45));
    const cs = new Float64Array(n + 1); for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + sm[i];
    const mean = (a, b) => { a = Math.max(0, a); b = Math.min(n, b); return b > a ? (cs[b] - cs[a]) / (b - a) : NaN; };
    const r = new Float64Array(n);
    const step = opts.stepScore;
    for (let i = 0; i < n; i++) {
      const sd = Math.sqrt(rms[i] + 1e-9);
      const bp = (sign * hp[i]) / sd;
      let L = mean(i - w2, i - w1 + 1), Rr = mean(i + w1, i + w2 + 1);
      if (isNaN(L)) L = Rr; if (isNaN(Rr)) Rr = L;
      const c = sm[i] * sign;
      const dl = c - sign * L, dr = c - sign * Rr; // 線（境界の極性方向）が両側より突出している量
      const thin = Math.min(dl, dr) / sd;
      // 帯域通過応答と細線応答の組み合わせ：細線が負（片側だけ）なら抑える
      const vt = thin > 0 ? Math.min(bp, 0.5 * bp + thin) : Math.min(bp, 0) + thin;
      let v;
      if (RESP_MODE === 'bp') v = bp; else if (RESP_MODE === 'thin') v = vt;
      else if (RESP_MODE === 'mix') v = RESP_MIX * bp + (1 - RESP_MIX) * vt;
      else { // 'edge': 端の近く（段差が線に化けやすい）は細線検出、内側は帯域通過（影の縁が線と重なっても消えない）
        const de = Math.min(Math.abs(i - (opts.i0 != null ? opts.i0 : -1e9)), Math.abs(i - (opts.i1 != null ? opts.i1 : 1e9))) / p;
        const wb = de <= 1.5 ? 0 : de >= 2.5 ? 1 : de - 1.5;
        v = wb * bp + (1 - wb) * vt;
      }
      // stepScore（log 領域の段差らしさ: 細い谷 0〜2、影の縁 5 以上）: 段差の位置の応答を弱める
      if (step && step[i] > STEP_LO && v > 0) v *= Math.max(STEP_FLOOR, 1 - (step[i] - STEP_LO) / (STEP_HI - STEP_LO));
      r[i] = v;
    }
    return { r, polarity, sign, sm, rms, skew };
  }

  // 端の段差の強さ（窓 p の平均差 / 内側の振幅）
  function stepStrength(sm, p, amp) {
    const n = sm.length, w = Math.max(2, Math.round(p));
    const cs = new Float64Array(n + 1); for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + sm[i];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - w), b = Math.min(n, i + w);
      if (i - a < 2 || b - i < 2) continue;
      out[i] = Math.abs((cs[b] - cs[i]) / (b - i) - (cs[i] - cs[a]) / (i - a)) / (amp + 1e-9);
    }
    return out;
  }

  // ---------- DP：端ノードつき ----------
  // r: 応答, pl: 局所周期(サンプル)の配列 or 数, i0/i1: タップされた端（サンプル, 小数可）
  // edge: { top: Float64Array|null, bot: ...（端らしさのスコア）}, free: 端を動かすか
  function placeBoundaries(r, pl, i0, i1, o = {}) {
    const n = r.length, K = o.K || 6;
    const pAt = typeof pl === 'number' ? () => pl : (i) => pl[Math.min(n - 1, Math.max(0, i))];
    const p0 = typeof pl === 'number' ? pl : pAt(Math.round(i0)), p1 = typeof pl === 'number' ? pl : pAt(Math.round(i1));
    const free = !!o.free, ER = o.edgeRange || EDGE_RANGE;
    let sA = free ? Math.max(0, Math.ceil(i0 - ER * p0)) : Math.max(0, Math.round(i0));
    let sB = free ? Math.min(n - 1, Math.floor(i0 + ER * p0)) : sA;
    let eA = free ? Math.max(0, Math.ceil(i1 - ER * p1)) : Math.min(n - 1, Math.round(i1));
    let eB = free ? Math.min(n - 1, Math.floor(i1 + ER * p1)) : eA;
    if (o.sRange) { sA = Math.max(0, Math.round(o.sRange[0])); sB = Math.min(n - 1, Math.round(o.sRange[1])); if (sB < sA) return null; }
    if (o.eRange) { eA = Math.max(0, Math.round(o.eRange[0])); eB = Math.min(n - 1, Math.round(o.eRange[1])); if (eB < eA) return null; }
    // タップ位置の事前分布（画素単位: タップ誤差は枚の厚さによらない）
    const sigS = o.sigS || p0 * 0.5, sigE = o.sigE || p1 * 0.5;
    const wP = o.wP == null ? 0.5 : o.wP, wE = o.wE == null ? 1 : o.wE;
    // 端らしさ：探索範囲内の最大値で正規化した形 × 明瞭さ（上限 capE）
    const cap = o.capE == null ? 4 : o.capE;
    const norm = (arr, A, B) => { if (!arr) return null; let m = 0; for (let i = A; i <= B; i++) if (arr[i] > m) m = arr[i]; return m > 0 ? { m, c: Math.min(cap, m) } : null; };
    const nT = norm(o.edgeTop, sA, sB), nB = norm(o.edgeBot, eA, eB);
    const wR = o.wR == null ? 1 : o.wR; // 端そのものが谷（線）に見える場合の報酬
    const startVal = (s) => (nT ? wE * nT.c * (o.edgeTop[s] / nT.m) : 0) + wR * Math.max(0, r[s]) - wP * ((s - i0) / sigS) ** 2;
    const endVal = (e) => (nB ? wE * nB.c * (o.edgeBot[e] / nB.m) : 0) + wR * Math.max(0, r[e]) - wP * ((e - i1) / sigE) ** 2;
    const best = new Float64Array(n).fill(-Infinity), prev = new Int32Array(n).fill(-1), isStart = new Uint8Array(n);
    const val = new Float64Array(n).fill(-Infinity);
    for (let s = sA; s <= sB; s++) { val[s] = startVal(s); isStart[s] = 1; }
    let bestEnd = -Infinity, bestE = -1, bestEPrev = -1;
    const isNum = typeof pl === 'number';
    let pMax = isNum ? pl : 0; if (!isNum) for (let i = 0; i < n; i++) if (pl[i] > pMax) pMax = pl[i];
    const LG = new Float64Array(Math.round(1.75 * pMax) + 3); for (let g = 1; g < LG.length; g++) LG[g] = Math.log(g);
    // 固定周期ならペナルティ表を作る
    let PEN = null, gminC = 0, gmaxC = 0;
    if (isNum) { gminC = Math.max(1, Math.round(0.55 * pl)); gmaxC = Math.max(gminC + 1, Math.round(1.75 * pl)); PEN = new Float64Array(gmaxC + 1); const lp = Math.log(pl); for (let g = gminC; g <= gmaxC; g++) { const d = LG[g] - lp; PEN[g] = K * d * d; } }
    for (let i = sA + 1; i <= eB; i++) {
      let gmin, gmax, bv = -Infinity, bj = -1;
      if (isNum) {
        gmin = gminC; gmax = gmaxC;
        const gm = Math.min(gmax, i - sA);
        for (let g = gmin; g <= gm; g++) { const vj = val[i - g]; if (vj === -Infinity) continue; const v = vj - PEN[g]; if (v > bv) { bv = v; bj = i - g; } }
      } else {
        const p = pl[i], lp = Math.log(p);
        gmin = Math.max(1, Math.round(0.55 * p)); gmax = Math.max(gmin + 1, Math.round(1.75 * p));
        const gm = Math.min(gmax, i - sA);
        for (let g = gmin; g <= gm; g++) { const vj = val[i - g]; if (vj === -Infinity) continue; const d = LG[g] - lp; const v = vj - K * d * d; if (v > bv) { bv = v; bj = i - g; } }
      }
      if (bj < 0) continue;
      // 終端として
      if (i >= eA && i <= eB) { const ev = bv + endVal(i); if (ev > bestEnd) { bestEnd = ev; bestE = i; bestEPrev = bj; } }
      // 境界として（終端範囲の奥には置かない）
      if (i < eB - gmin + 1 || i < eA) {
        best[i] = bv + r[i]; prev[i] = bj;
        if (best[i] > val[i]) { val[i] = best[i]; isStart[i] = 0; } else if (isStart[i]) { /* start のまま */ }
      }
    }
    if (bestE < 0) return null;
    const idx = []; let j = bestEPrev;
    while (j >= 0 && !isStart[j]) { idx.push(j); j = prev[j]; }
    // isStart[j] が立っていても best 経由だった可能性 → val と best を比較して判定済み
    const s = j;
    return { idx: idx.reverse(), s, e: bestE, score: bestEnd };
  }

  // 局所周期：DP 結果の間隔から滑らかな p(i) を作る
  function localPitch(idx, s, e, p, n) {
    const b = [s, ...idx, e];
    if (b.length < 6) return null;
    const mids = [], gaps = [];
    for (let k = 1; k < b.length; k++) { mids.push((b[k] + b[k - 1]) / 2); gaps.push(b[k] - b[k - 1]); }
    // 移動中央値（9区間）→ 移動平均
    const W = Math.min(9, gaps.length | 1), h = W >> 1, med = [];
    for (let k = 0; k < gaps.length; k++) {
      const a = Math.max(0, k - h), c = Math.min(gaps.length, k + h + 1);
      const w = gaps.slice(a, c).sort((x, y) => x - y); med.push(w[w.length >> 1]);
    }
    const sm = med.map((_, k) => { const a = Math.max(0, k - 2), c = Math.min(med.length, k + 3); let t = 0; for (let q = a; q < c; q++) t += med[q]; return t / (c - a); });
    const pl = new Float64Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) {
      while (k < mids.length - 1 && mids[k + 1] <= i) k++;
      let v;
      if (i <= mids[0]) v = sm[0]; else if (i >= mids[mids.length - 1]) v = sm[sm.length - 1];
      else { const f = (i - mids[k]) / (mids[k + 1] - mids[k]); v = sm[k] * (1 - f) + sm[k + 1] * f; }
      pl[i] = Math.min(1.5 * p, Math.max(p / 1.5, v));
    }
    return pl;
  }

  function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

  // 境界の深さの2階層（板の境界＝深い谷 / 板の中の層・木目＝浅い谷）
  // 極性をそろえた細かい平滑化プロファイルの極大の「地形的プロミネンス」を求め、
  // 深い群と浅い群がはっきり分かれ、深い群が規則的に並ぶとき、深い群を境界とする候補を返す。
  function deepTier(prof, sign, a, b, o = {}) {
    const n = prof.length, s = gaussSmooth(prof, o.sigma || 1.2);
    const u = new Float64Array(n); for (let i = 0; i < n; i++) u[i] = sign * s[i];
    const lo = Math.max(1, Math.ceil(a) + 2), hi = Math.min(n - 2, Math.floor(b) - 2);
    const pk = [];
    for (let i = lo; i <= hi; i++) if (u[i] > u[i - 1] && u[i] >= u[i + 1]) pk.push(i);
    if (pk.length < 3) return null;
    const A = Math.max(0, Math.round(a)), Bn = Math.min(n - 1, Math.round(b));
    const MS = o.maxScan || n; // 探索距離の上限（数周期で十分）
    const prom = pk.map((i) => {
      const h = u[i]; let mL = h, mR = h;
      const jA = Math.max(A, i - MS), jB = Math.min(Bn, i + MS);
      for (let j = i - 1; j >= jA; j--) { if (u[j] > h) break; if (u[j] < mL) mL = u[j]; }
      for (let j = i + 1; j <= jB; j++) { if (u[j] > h) break; if (u[j] < mR) mR = u[j]; }
      return h - Math.max(mL, mR);
    });
    const ord = prom.map((v, k) => k).sort((x, y) => prom[y] - prom[x]);
    const P = ord.map((k) => prom[k]);
    // 分かれ目：大津法（線形のプロミネンスで群間分散最大）。深い群は1本以上、浅い群は2本以上
    let bestK = -1, bestV = -1; const tot = P.reduce((x, y) => x + y, 0);
    let cum = 0;
    for (let k = 1; k <= P.length - 2; k++) { cum += P[k - 1]; const w0 = k, w1 = P.length - k, m0 = cum / w0, m1 = (tot - cum) / w1, v = w0 * w1 * (m0 - m1) * (m0 - m1); if (v > bestV) { bestV = v; bestK = k; } }
    if (bestK < 1) return null;
    // 分離度：深い群の最小 / 浅い群の上位10%点（端の面取りなど少数の外れは許す）
    const sh = P.slice(bestK), qIdx = Math.min(sh.length - 1, Math.floor(0.1 * sh.length));
    const bestR = P[bestK - 1] / Math.max(1e-9, sh[qIdx]);
    const deep = P.slice(0, bestK), shallow = P.slice(bestK);
    const meanD = deep.reduce((x, y) => x + y, 0) / deep.length, medS = median(shallow);
    const pos = ord.slice(0, bestK).map((k) => pk[k]).sort((x, y) => x - y);
    // 端から半枚未満の深い谷は端の面取り・上面の縁とみなして除く
    while (pos.length >= 2 && pos[0] - a < 0.5 * (pos[1] - pos[0])) pos.shift();
    while (pos.length >= 2 && b - pos[pos.length - 1] < 0.5 * (pos[pos.length - 1] - pos[pos.length - 2])) pos.pop();
    // 縁の外側の面（上面など縞のない領域）が帯に入っている：端の区間が規則的な間隔より大きく、中に有意な谷が無い
    // → その区間は「1枚＋縞のない面」とみなし、端を最初（最後）の深い谷の1間隔外へ寄せる
    let trimTop = false, trimBot = false;
    const minDeep = P[bestK - 1];
    const hasValley = (x0, x1) => pk.some((i, k) => i > x0 && i < x1 && prom[k] >= 0.5 * minDeep);
    if (pos.length >= 4) {
      // 内側の区間の平均の明るさ（板らしさの基準）
      const mean = (x0, x1) => { let t = 0, c = 0; for (let i = Math.round(x0) + 1; i < Math.round(x1); i++) { t += prof[i]; c++; } return c ? t / c : 0; };
      const sm = []; for (let k = 0; k + 1 < pos.length; k++) sm.push(mean(pos[k], pos[k + 1]));
      const med = median(sm), mad = median(sm.map((v) => Math.abs(v - med))) * 1.4826 + 1e-6;
      const sheetLike = (x0, x1) => Math.abs(mean(x0, x1) - med) / mad < 2;
      const r0 = pos[1] - pos[0], r1 = pos[pos.length - 1] - pos[pos.length - 2];
      const span0 = b - a, maxTrim = 0.28 * span0; // 帯の3割近くが縞のない面なら検出が大きく外れている：削らず要確認だけ
      if (pos[0] - a > 1.7 * r0 && pos[0] - a < maxTrim && !hasValley(a + 0.5 * r0, pos[0] - 0.5 * r0)) { a = sheetLike(pos[0] - r0, pos[0]) ? pos[0] - r0 : pos[0]; trimTop = true; }
      if (b - pos[pos.length - 1] > 1.7 * r1 && b - pos[pos.length - 1] < maxTrim && !hasValley(pos[pos.length - 1] + 0.5 * r1, b - 0.5 * r1)) { const L = pos[pos.length - 1]; b = sheetLike(L, L + r1) ? L + r1 : L; trimBot = true; }
      // 端の谷そのものを端にしたときは深い谷の列から外す
      if (trimTop && a === pos[0]) pos.shift();
      if (trimBot && b === pos[pos.length - 1]) pos.pop();
    }
    const Bt = [a, ...pos, b];
    const gaps = []; for (let k = 1; k < Bt.length; k++) gaps.push(Bt[k] - Bt[k - 1]);
    // 規則性：各区間が隣の区間の 0.6〜1.6 倍（遠近でゆっくり変わるのは可）。端の区間は 0.5〜1.7 倍
    let regular = true, worst = 1;
    for (let k = 0; k < gaps.length; k++) {
      const nb = []; if (k > 0) nb.push(gaps[k - 1]); if (k + 1 < gaps.length) nb.push(gaps[k + 1]);
      if (!nb.length) continue;
      const q = gaps[k] / median(nb), edge = k === 0 || k === gaps.length - 1;
      const qq = q >= 1 ? q : 1 / q; if (qq > worst) worst = qq;
      if (edge ? q < 0.6 || q > 1.5 : q < 0.6 || q > 1.6) regular = false;
    }
    return { B: Bt, count: gaps.length, trimTop, trimBot, sep: bestR, contrast: meanD / Math.max(1e-9, medS), regular, worst, nShallow: shallow.length, nDeep: deep.length };
  }

  // 1つの周期候補について数える
  function runCandidate(prof, p, i0, i1, ctx, opts) {
    const n = prof.length;
    const resp = response(prof, p, { i0, i1, stepScore: opts.stepScore, sign: ctx.sign });
    const { r } = resp;
    // 端らしさ：段差（内側振幅で正規化）
    let edgeTop = null, edgeBot = null;
    if (ctx.free) {
      const a = Math.max(0, Math.round(i0)), b = Math.min(n, Math.round(i1));
      const amp = Math.sqrt(median(Array.from(resp.rms.subarray(a, b)))) || 1;
      const st = stepStrength(resp.sm, p, amp);
      edgeTop = st; edgeBot = st;
    }
    const dpo = { free: ctx.free, edgeTop, edgeBot, wE: ctx.wE, wP: ctx.wP, wR: ctx.wR, K: ctx.K, sigS: ctx.sig, sigE: ctx.sig, edgeRange: ctx.edgeRange };
    let dp = placeBoundaries(r, p, i0, i1, dpo);
    if (!dp) return null;
    let pl = null;
    if (ctx.localP) {
      pl = localPitch(dp.idx, dp.s, dp.e, p, n);
      if (pl) { const dp2 = placeBoundaries(r, pl, i0, i1, dpo); if (dp2) dp = dp2; }
    }
    return { dp, r, resp, pl, p, edgeTop, edgeBot };
  }

  // 線上応答・中点応答（候補比較と倍音検出）
  function lineStats(r, b) {
    const on = [], mid = [];
    for (let k = 1; k < b.length - 1; k++) on.push(r[b[k]]);
    for (let k = 1; k < b.length; k++) {
      const a = b[k - 1], c = b[k], g = c - a, lo = Math.round(a + 0.3 * g), hi = Math.round(c - 0.3 * g);
      let mx = -Infinity; for (let i = lo; i <= hi; i++) if (r[i] > mx) mx = r[i];
      mid.push(mx);
    }
    return { on: median(on), mid: median(mid) };
  }

  // 端のあいまいさ：端の外側/内側にもう1本の線があり得るか
  function edgeAmbiguity(r, b, pAtI, edgeArr, isTop, rmed) {
    // b: [s, ...idx, e]
    const s = isTop ? b[0] : b[b.length - 1];
    const inner = isTop ? b[1] : b[b.length - 2];
    const p = pAtI(s), dir = isTop ? -1 : 1, n = r.length;
    // 外側にもう1枚: s から外向きに ~1p の位置に強い応答があるか
    let outMax = -Infinity;
    for (let i = Math.round(s + dir * 0.75 * p); dir < 0 ? i >= Math.round(s - 1.3 * p) : i <= Math.round(s + 1.3 * p); i += dir) {
      if (i < 0 || i >= n) break; if (r[i] > outMax) outMax = r[i];
    }
    // 端の位置での応答（端そのものが線に見える＝外側に1枚あるかも）
    let atEdge = -Infinity; for (let i = Math.round(s - 0.25 * p); i <= Math.round(s + 0.25 * p); i++) if (i >= 0 && i < n && r[i] > atEdge) atEdge = r[i];
    const firstGap = Math.abs(inner - s) / p;
    const stepHere = edgeArr ? edgeArr[Math.max(0, Math.min(n - 1, s))] : 0;
    return { outMax, atEdge, firstGap, stepHere, rmed };
  }

  function reviewCore(b, r, pAtI, rmedRef) {
    // b: サンプル位置の配列 [s, ...lines, e]
    const gaps = [], loc = [];
    for (let k = 1; k < b.length; k++) { gaps.push(b[k] - b[k - 1]); loc.push(pAtI(Math.round((b[k] + b[k - 1]) / 2))); }
    const rel = gaps.map((g, k) => g / loc[k]);
    const medRel = median(rel) || 1;
    const sheetFlags = rel.map((g) => g / medRel < THIN_REL || g / medRel > THICK_REL);
    const resp = []; for (let k = 1; k < b.length - 1; k++) resp.push(r ? r[b[k]] : 1);
    const rmed = rmedRef || median(resp) || 1;
    const lineFlags = resp.map((v) => v < WEAK_REL * rmed);
    // UX 用の詳細（位置はサンプル番号 i。呼び出し側で t に変換）
    const items = [];
    rel.forEach((g, k) => {
      const q = g / medRel;
      if (q > THICK_REL) items.push({ kind: 'thick', i: (b[k] + b[k + 1]) / 2, action: 'add', severity: q > 1.6 ? 'high' : 'mid', sheet: k, val: +q.toFixed(3) });
      else if (q < THIN_REL) {
        // 薄すぎる区間：両端の線のうち応答の弱い方を消す候補（端は消せないので内側の線）
        let li = k + 1 < b.length - 1 && k > 0 ? (r && r[b[k]] < r[b[k + 1]] ? k : k + 1) : (k === 0 ? 1 : k);
        items.push({ kind: 'thin', i: b[li], action: 'remove', severity: q < 0.5 ? 'high' : 'mid', sheet: k, val: +q.toFixed(3) });
      }
    });
    resp.forEach((v, k) => { if (v < WEAK_REL * rmed) items.push({ kind: 'weak', i: b[k + 1], action: 'check', severity: v < 0 ? 'high' : 'mid', line: k, val: +(v / rmed).toFixed(3) }); });
    return { sheetFlags, lineFlags, medGap: median(gaps), items };
  }
  const itemsToT = (items, toT) => items.map((x) => { const o = Object.assign({}, x, { t: toT(x.i) }); delete o.i; return o; });

  // 帯の境界列と主の境界列の照合
  function matchBands(mainB, bandBs, pAtI) {
    // mainB: 主の [s, ...lines, e]; bandBs: 各帯の同形式
    const L = mainB.length - 2;
    const support = new Int32Array(L);
    const extras = []; // 主にない帯の線
    for (const bb of bandBs) {
      if (!bb) continue;
      const used = new Uint8Array(bb.length);
      for (let k = 0; k < L; k++) {
        const t = mainB[k + 1], tol = 0.35 * pAtI(t);
        // 二分探索の代わりに線形（本数は数百まで）
        let bestq = -1, bd = Infinity;
        for (let q = 1; q < bb.length - 1; q++) { const d = Math.abs(bb[q] - t); if (d < bd) { bd = d; bestq = q; } if (bb[q] > t + tol) break; }
        if (bestq >= 0 && bd <= tol && !used[bestq]) { support[k]++; used[bestq] = 1; }
      }
      const ex = [];
      for (let q = 1; q < bb.length - 1; q++) if (!used[q] && bb[q] > mainB[0] + 0.3 * pAtI(bb[q]) && bb[q] < mainB[mainB.length - 1] - 0.3 * pAtI(bb[q])) ex.push(bb[q]);
      extras.push(ex);
    }
    return { support, extras };
  }

  function count(prof, grid, opts = {}) {
    RESP_MODE = opts.respMode || 'edge'; RESP_MIX = opts.respMix == null ? 0.5 : opts.respMix;
    const R = prof.length, Hpx = grid.Hpx;
    const tMin = grid.tMin != null ? grid.tMin : 0, tMax = grid.tMax != null ? grid.tMax : 1;
    const dt = (tMax - tMin) / (R - 1);
    const i0 = (0 - tMin) / dt, i1 = (1 - tMin) / dt;
    const toT = (i) => tMin + i * dt;
    const a = Math.max(0, Math.round(i0)), b = Math.min(R - 1, Math.round(i1));
    const inner = prof.subarray(a, b + 1);
    const sp = spectrum(inner, Hpx, opts.minCount);
    if (!sp.peaks.length) throw new Error('縞模様を検出できませんでした');
    const span = i1 - i0;
    // 端を動かす同時最適化：M1 の photometry と組み合わせると dev で -2 だったため既定は off（opts.freeEdges=true で有効）
    const free = opts.freeEdges === true && (tMin < 0 || tMax > 1);
    const spp = (R - 1) / ((tMax - tMin) * Hpx); // 1画素あたりのサンプル数
    const ctx = { free, localP: opts.localPitch !== false, K: 6, wE: opts.wE, wP: opts.wP, wR: opts.wR, sig: (opts.tapSigmaPx || 4) * spp, edgeRange: opts.edgeRange };

    // 候補：スペクトルのピーク上位＋倍・半分
    const cands = [];
    const addC = (c, score, src) => { if (c < sp.minC * 0.9 || c > sp.maxC * 1.05) return; if (cands.some((x) => Math.abs(x.c - c) < Math.max(1, c * 0.06))) return; cands.push({ c, score, src }); };
    for (const pk of sp.peaks) { addC(pk.c, pk.score, 'peak'); if (cands.length >= 4) break; }
    const c0 = cands[0].c;
    addC(c0 * 2, sp.Hs(c0 * 2), 'double'); addC(c0 / 2, sp.Hs(c0 / 2), 'half');
    const top = cands[0].score;
    // Welch の山も候補に（全体スペクトルでは埋もれる、ばらつき・遠近のある積み）
    const spW = opts.welch === false ? null : spectrumWelch(inner, sp.minC, sp.maxC, opts.welchSeg || 7);
    if (spW && spW.peaks.length) {
      const wTop = spW.peaks[0].score;
      let nW = 0;
      for (const pk of spW.peaks) {
        if (pk.score < (opts.welchGate || 0.5) * wTop || nW >= 3) break;
        const before = cands.length; addC(pk.c, sp.Hs(pk.c), 'welch'); if (cands.length > before) { cands[cands.length - 1].wScore = pk.score / wTop; nW++; }
      }
      // Welch 上位の 2倍・半分（板の内部の層＝ply 線や色むらで片方だけ強く出る）
      for (const pk of spW.peaks.slice(0, 2)) { if (pk.score < 0.5 * wTop) break; for (const f of [2, 0.5]) { const b0 = cands.length; addC(pk.c * f, sp.Hs(pk.c * f), 'welch'); if (cands.length > b0) cands[cands.length - 1].wScore = spW.Hs(pk.c * f) / wTop; } }
      for (const x of cands) if (x.wScore == null) x.wScore = spW.Hs(x.c) / wTop;
    }

    // 選ばれる可能性のない候補は計算しない（選択条件と同じ門）
    const plausible = cands.filter((x, k) => k === 0 || x.src === 'welch' || (x.src === 'peak' ? x.score >= 0.5 * top : x.score >= 0.25 * top) || (x.wScore != null && x.wScore >= 0.5));

    // 極性は主候補で決めて全候補で共有
    const p0 = span / c0;
    const pr0 = response(prof, p0, { i0, i1 }); ctx.sign = pr0.sign; ctx.skew = pr0.skew;
    const ctx1 = Object.assign({}, ctx, { localP: false }); // 1パス目（局所周期なし）
    const pack = (rc, cd) => { const B = [rc.dp.s, ...rc.dp.idx, rc.dp.e]; return Object.assign(rc, { cand: cd, B, st: lineStats(rc.r, B), count: B.length - 1 }); };
    let first = null;
    // 歪度が弱い（ほぼ正弦波）ときは極性を DP の結果で決める（暗い境界を優先）
    ctx.polMode = 'skew';
    if (Math.abs(ctx.skew) < (opts.skewThr == null ? 0.3 : opts.skewThr)) {
      const sc = {}, cn = {}, rr = {};
      for (const sg of [-1, 1]) { const rc = runCandidate(prof, p0, i0, i1, Object.assign({}, ctx1, { sign: sg }), opts); rr[sg] = rc; sc[sg] = rc ? rc.dp.score : -Infinity; cn[sg] = rc ? rc.dp.idx.length + 1 : -1; }
      ctx.polScores = sc; ctx.polCounts = cn;
      // 暗い境界を優先。明るい線は DP の差が十分大きいか、差が正で歪度も明るい側のとき（dev で較正）
      const bias = opts.darkBias == null ? 3.5 : opts.darkBias, d = sc[1] - sc[-1];
      ctx.sign = d > bias || (d > 0 && ctx.skew > 0.1) ? 1 : -1; ctx.polMode = 'dp';
      if (rr[ctx.sign]) first = pack(rr[ctx.sign], cands[0]);
    }
    ctx1.sign = ctx.sign;
    const results = [];
    for (const cd of plausible) {
      if (cd === cands[0] && first) { results.push(first); continue; }
      const rc = runCandidate(prof, span / cd.c, i0, i1, ctx1, opts);
      if (rc) results.push(pack(rc, cd));
    }
    if (!results.length) throw new Error('境界を配置できませんでした');
    // 候補の選択：スペクトル1位を基本に、DP結果で明確に優る候補があれば入れ替える
    let main = results[0];
    // 候補の比較は共通の細かい尺度の応答で行う（自分の尺度の応答だと倍音候補の中点の線が見えない）
    if (results.length > 1 && opts.commonScale !== false) {
      let cMax = 0; for (const x of results) if (x.cand.c > cMax) cMax = x.cand.c;
      const pF = Math.max(4, span / cMax);
      const rF = response(prof, pF, { i0, i1, sign: ctx.sign, stepScore: opts.stepScore }).r;
      const mix = opts.scaleMix == null ? 0.5 : opts.scaleMix; // 0=自分の尺度のみ, 1=共通尺度のみ
      for (const x of results) { const c = lineStats(rF, x.B); x.stOwn = x.st; x.st = { on: mix * c.on + (1 - mix) * x.st.on, mid: mix * c.mid + (1 - mix) * x.st.mid }; }
    }
    const midK = opts.midK == null ? 0.5 : opts.midK;
    const mainScore = (x) => x.st.on - 0.8 * Math.max(0, x.st.mid - midK * Math.max(0, x.st.on));
    const bonus0 = opts.topBonus == null ? 0.6 : opts.topBonus;
    let bestS = mainScore(main) + bonus0;
    for (const x of results.slice(1)) {
      const sc = mainScore(x);
      if (sc > bestS && x.st.on > 0.8) { main = x; bestS = sc; }
    }
    // 深さの2階層：深い谷が規則的に並び浅い谷とはっきり分かれていれば、深い谷を境界とする（積層・木目を数えない）
    let tier = null, tierAmb = false;
    if (opts.tier !== false) {
      tier = deepTier(prof, ctx.sign, i0, i1, { maxScan: Math.max(60, Math.round(4 * main.p)) });
      if (tier && tier.regular && tier.count !== main.count) {
        const strong = tier.sep >= TIER_SEP && tier.contrast >= TIER_CON && tier.count >= 2;
        if (strong) {
          const pT = span / tier.count;
          const rT = response(prof, pT, { i0, i1, stepScore: opts.stepScore, sign: ctx.sign });
          const dpT = { idx: tier.B.slice(1, -1).map((x) => Math.round(x)), s: Math.round(tier.B[0]), e: Math.round(tier.B[tier.B.length - 1]), score: 0 };
          const pl = localPitch(dpT.idx, dpT.s, dpT.e, pT, R);
          const prev = main;
          main = pack({ dp: dpT, r: rT.r, resp: rT, pl, p: pT, edgeTop: null, edgeBot: null }, { c: tier.count, score: 0, src: 'tier' });
          main.skipLocal = true; main.prevCount = prev.count;
          results.push(main);
        }
        // 階層の選び方があいまい（DP と深い谷で枚数が違う）→ 必ず要確認
        tierAmb = true;
        if (strong && (tier.trimTop || tier.trimBot)) main.tierTrim = [tier.trimTop, tier.trimBot];
      }
    }

    // 周期の倍・半分の取り違えの点検（板の内部の層＝ply 線、枚数が少ないとき）
    //  下向き: 主の線を k 本おきに見て、間の線が弱ければ主は k 倍の取り違え → 間引く
    //  上向き: p/k で数え直し、増えた線も元の線と同じくらい強ければ細かい方が正しい
    const phaseRatio = (r, B, k) => {
      const v0 = [], vo = [];
      for (let j = 1; j < B.length - 1; j++) (j % k === 0 ? v0 : vo).push(r[B[j]]);
      if (v0.length < 2 || vo.length < 2) return null;
      const m0 = median(v0), mo = median(vo);
      return m0 > 0.3 ? mo / m0 : null;
    };
    // 切り替えは dev で純増がほぼ無かった（+1/-1）ので既定では行わず、要確認にだけ使う
    const PH_LO = opts.phLo == null ? -1 : opts.phLo, PH_HI = opts.phHi == null ? 99 : opts.phHi;
    const PF_DOWN = 0.7, PF_UP = 0.45, PF_MAXC = 40;
    let phaseAmb = false; const phaseLog = [];
    if (opts.phaseCheck !== false && !(main.cand && main.cand.src === 'tier')) {
      for (const k of [3, 2]) {
        if (main.count % k !== 0 || main.count / k < 2) continue;
        const pr = phaseRatio(main.r, main.B, k); phaseLog.push(['down', k, pr]);
        if (pr == null) continue;
        if (pr < PH_LO) {
          const B2 = main.B.filter((_, j) => j % k === 0 || j === main.B.length - 1);
          const rc = runCandidate(prof, main.p * k, i0, i1, ctx1, opts);
          if (rc) { const pk = pack(rc, { c: main.cand.c / k, score: 0, src: 'phase' }); if (Math.abs(pk.count - B2.length + 1) <= 1) { main = pk; results.push(pk); } }
          break;
        } else if (pr < PF_DOWN && main.count <= PF_MAXC) phaseAmb = true;
      }
      for (const k of [2, 3]) {
        const pk = main.p / k; if (pk < 3 * spp) continue;
        const rc = runCandidate(prof, pk, i0, i1, ctx1, opts); if (!rc) continue;
        const up = pack(rc, { c: main.cand.c * k, score: 0, src: 'phase' });
        if (Math.abs(up.count - k * main.count) > 1) continue;
        const pr = phaseRatio(up.r, up.B, k); phaseLog.push(['up', k, pr]);
        if (pr == null) continue;
        if (pr > PH_HI) { main = up; results.push(up); break; } else if (pr > PF_UP && main.count <= PF_MAXC) phaseAmb = true;
      }
    }
    // 2パス目：局所周期で DP をやり直す（選ばれた候補だけ）
    if (ctx.localP && !main.skipLocal) {
      const pl = localPitch(main.dp.idx, main.dp.s, main.dp.e, main.p, R);
      if (pl) {
        const dp2 = placeBoundaries(main.r, pl, i0, i1, { free, edgeTop: main.edgeTop, edgeBot: main.edgeBot, wE: ctx.wE, wP: ctx.wP, wR: ctx.wR, K: ctx.K, sigS: ctx.sig, sigE: ctx.sig, edgeRange: ctx.edgeRange });
        if (dp2) { const k = results.indexOf(main); main = pack(Object.assign({}, main, { dp: dp2, pl }), main.cand); results[k] = main; }
      }
    }
    const pAtI = (i) => (main.pl ? main.pl[Math.max(0, Math.min(R - 1, Math.round(i)))] : main.p);

    // ---------- 3帯の照合 ----------
    let bandInfo = null;
    const bandProfs = opts.bandProfs;
    if (opts.useBands !== false && opts.useBands !== 'dp' && bandProfs && bandProfs.length >= 2) {
      // 速い照合：各帯の応答を主の境界位置で調べる（線の支持）＋区間の中ほどの強い山（主にない線）
      const L = main.B.length - 2, support = new Int32Array(L), extras = [], counts = [];
      let nb = 0;
      for (const bp of bandProfs) {
        if (!bp || bp.length !== R) { extras.push(null); counts.push(null); continue; }
        nb++;
        const rb = response(bp, main.p, { i0, i1, sign: ctx.sign, stepScore: opts.stepScore }).r;
        const at = new Float64Array(L);
        for (let k = 0; k < L; k++) { const c = main.B[k + 1], h = Math.max(1, Math.round(0.3 * pAtI(c))); let mx = -Infinity; for (let i = c - h; i <= c + h; i++) if (i >= 0 && i < R && rb[i] > mx) mx = rb[i]; at[k] = mx; }
        const rm = median(Array.from(at)) || 1;
        let uns = 0; for (let k = 0; k < L; k++) if (at[k] > 0.25 * rm) support[k]++; else uns++;
        const ex = [];
        for (let k = 0; k + 1 < main.B.length; k++) {
          const A = main.B[k], C = main.B[k + 1], g = C - A, lo = Math.round(A + 0.3 * g), hi = Math.round(C - 0.3 * g);
          let mx = -Infinity, mi = -1; for (let i = lo; i <= hi; i++) if (rb[i] > mx) { mx = rb[i]; mi = i; }
          if (mx > 0.7 * rm) ex.push(mi);
        }
        extras.push(ex); counts.push(main.count - uns + ex.length);
      }
      bandInfo = { counts, support, extras, nb };
    } else if (opts.useBands === 'dp' && bandProfs && bandProfs.length >= 2) {
      const bandBs = bandProfs.map((bp) => {
        if (!bp || bp.length !== R) return null;
        const rr = response(bp, main.p, { i0, i1, sign: ctx.sign, stepScore: opts.stepScore });
        let et = null;
        if (free) { const amp = Math.sqrt(median(Array.from(rr.rms.subarray(a, b)))) || 1; et = stepStrength(rr.sm, main.p, amp); }
        const d = placeBoundaries(rr.r, main.pl || main.p, i0, i1, { free, edgeTop: et, edgeBot: et, K: 6, wE: ctx.wE, wP: ctx.wP, wR: ctx.wR, sigS: ctx.sig, sigE: ctx.sig, edgeRange: ctx.edgeRange });
        return d ? [d.s, ...d.idx, d.e] : null;
      });
      const m = matchBands(main.B, bandBs, pAtI);
      const counts = bandBs.map((x) => (x ? x.length - 1 : null));
      bandInfo = { counts, support: m.support, extras: m.extras, nb: bandBs.filter(Boolean).length };
    }

    // ---------- 要確認 ----------
    const rv = reviewCore(main.B, main.r, pAtI);
    const reasons = [];
    const nS = main.B.length - 1;
    // 端のあいまいさ
    const rmedLines = median(main.B.slice(1, -1).map((i) => main.r[i])) || 1;
    const edgeFlags = [false, false];
    for (const isTop of [true, false]) {
      const ea = edgeAmbiguity(main.r, main.B, pAtI, isTop ? main.edgeTop : main.edgeBot, isTop, rmedLines);
      (rv.edgeInfo || (rv.edgeInfo = [])).push({ out: ea.outMax / rmedLines, gap: ea.firstGap, step: ea.stepHere, at: ea.atEdge / rmedLines });
      // 外側に線がありそう かつ 端そのものも線に見える（積みが外へ続いている）／最初の区間の厚さが外れている
      // 端そのものが強い線（上面の奥の縁・別の面の輪郭に端を置いている疑い）も要確認
      const amb = (ea.outMax > EF_OUT * rmedLines && ea.atEdge > EF_AT * rmedLines) || ea.atEdge > EF_AT2 * rmedLines || ea.firstGap < EF_GLO || ea.firstGap > EF_GHI;
      if (amb) {
        edgeFlags[isTop ? 0 : 1] = true; rv.sheetFlags[isTop ? 0 : nS - 1] = true; reasons.push(isTop ? 'edge-top' : 'edge-bot');
        const sI = isTop ? main.B[0] : main.B[main.B.length - 1], inI = isTop ? main.B[1] : main.B[main.B.length - 2], dir = isTop ? -1 : 1, pp = pAtI(sI);
        // 推奨操作：外側にもう1枚ありそう→add（外側1枚分）、最初の区間が薄い→最初の線を remove、厚い→add（中間）、それ以外は check
        let action = 'check', at = sI;
        if (ea.outMax > EF_OUT * rmedLines) { action = 'add'; at = sI + dir * pp; }
        else if (ea.firstGap < EF_GLO) { action = 'remove'; at = inI; }
        else if (ea.firstGap > EF_GHI) { action = 'add'; at = (sI + inI) / 2; }
        rv.items.push({ kind: isTop ? 'edgeTop' : 'edgeBot', i: at, action, severity: 'high', sheet: isTop ? 0 : nS - 1 });
      }
    }
    // 帯の不一致
    let bandDisagree = 0;
    if (bandInfo && bandInfo.nb >= 2) {
      for (let k = 0; k < bandInfo.support.length; k++) {
        if (bandInfo.support[k] * 2 < bandInfo.nb) { rv.lineFlags[k] = true; bandDisagree++; rv.items.push({ kind: 'band', i: main.B[k + 1], action: 'remove', severity: bandInfo.support[k] === 0 ? 'high' : 'mid', line: k, val: bandInfo.support[k] }); }
      }
      // 帯の数え（主にない線が2帯以上で一致）
      const ex = bandInfo.extras.filter(Boolean);
      for (let q = 0; q < ex.length; q++) for (const t of ex[q]) {
        let agree = 1; for (let u = 0; u < ex.length; u++) if (u !== q && ex[u].some((v) => Math.abs(v - t) < 0.35 * pAtI(t))) agree++;
        if (agree * 2 > bandInfo.nb) {
          // その位置を含む区間に要確認
          let k = 0; while (k < main.B.length - 1 && main.B[k + 1] < t) k++;
          if (k < nS && !rv.sheetFlags[k]) { rv.sheetFlags[k] = true; bandDisagree++; rv.items.push({ kind: 'bandAdd', i: t, action: 'add', severity: 'mid', sheet: k, val: agree }); }
        }
      }
      if (bandDisagree) reasons.push('bands');
    }
    const ratio = main.cand.score / sp.median;
    const second = results.filter((x) => x !== main && x.cand.src === 'peak').reduce((m, x) => Math.max(m, x.cand.score / main.cand.score), 0);
    const agree = Math.abs(main.count - main.cand.c) <= Math.max(1, main.cand.c * 0.03);
    const harmonicRisk = main.st.mid > 0.6 * main.st.on; // 線の中間にも強い応答＝本当は2倍の枚数かも
    if (harmonicRisk) reasons.push('harmonic');
    const polAmb = ctx.polMode === 'dp' && ctx.polCounts[1] !== ctx.polCounts[-1] && ctx.polScores[-ctx.sign] > ctx.polScores[ctx.sign] - (opts.polAmb == null ? 6 : opts.polAmb);
    if (polAmb) reasons.push('polarity');
    const nFlag0 = rv.sheetFlags.filter(Boolean).length + rv.lineFlags.filter(Boolean).length;
    // 全体的な疑い（極性・倍音）は区間フラグとして出す（利用者に必ず伝わるように）
    if (polAmb) { rv.sheetFlags[0] = true; rv.sheetFlags[nS - 1] = true; rv.items.push({ kind: 'polarity', i: main.B[0], action: 'check', severity: 'high', sheet: 0 }, { kind: 'polarity', i: main.B[nS], action: 'check', severity: 'high', sheet: nS - 1 }); }
    // 積層（ply）・木目を数えている可能性：深い谷の階層と DP の枚数が違う／縞がほぼ正弦波（細い谷でない）で枚数が少ない
    // 粗い階層（板）の周期がスペクトルにも DP にも見える：粗い候補の線の間（中点）に細かい縞がはっきりある
    const coarse = nS <= COARSE_MAXN ? results.find((x) => x !== main && x.cand && x.cand.src === 'peak' && x.cand.c <= COARSE_RATIO * main.count && x.cand.score >= COARSE_SCORE * top && x.st.mid >= 0.5 * Math.max(0, x.st.on) && x.count >= 2) : null;
    const plyLike = !(main.cand && main.cand.src === 'tier') && ((Math.abs(ctx.skew) < PLY_SKEW && nS <= PLY_MAXN) || !!coarse);
    // 端の区間の「板らしさ」：内側の区間の平均明るさ（頑健な z）から大きく外れる端の区間は、上面・背景・パレットを1枚と数えている疑い
    const endZ = [null, null];
    if (nS >= 5) {
      const mean = (x0, x1) => { let t = 0, c = 0; for (let i = Math.round(x0) + 1; i < Math.round(x1); i++) { t += prof[i]; c++; } return c ? t / c : 0; };
      const sm = []; for (let k = 1; k + 1 < nS; k++) sm.push(mean(main.B[k], main.B[k + 1]));
      const med = median(sm), mad = median(sm.map((v) => Math.abs(v - med))) * 1.4826 + 1e-6;
      endZ[0] = (mean(main.B[0], main.B[1]) - med) / mad; endZ[1] = (mean(main.B[nS - 1], main.B[nS]) - med) / mad;
      for (const k of [0, 1]) if (Math.abs(endZ[k]) > END_Z) {
        reasons.push(k ? 'endface-bot' : 'endface-top'); rv.sheetFlags[k ? nS - 1 : 0] = true;
        rv.items.push({ kind: k ? 'edgeBot' : 'edgeTop', i: k ? main.B[nS - 1] : main.B[1], action: 'remove', severity: 'high', sheet: k ? nS - 1 : 0, val: +endZ[k].toFixed(2) });
      }
    }
    if (main.tierTrim) for (const [k, on] of [[0, main.tierTrim[0]], [1, main.tierTrim[1]]]) if (on) {
      // 縞のない面を帯から除いた：端の位置を確認してもらう
      reasons.push(k ? 'trim-bot' : 'trim-top'); rv.sheetFlags[k ? nS - 1 : 0] = true;
      rv.items.push({ kind: k ? 'edgeBot' : 'edgeTop', i: k ? main.B[nS] : main.B[0], action: 'check', severity: 'high', sheet: k ? nS - 1 : 0 });
    }
    if (tierAmb || plyLike) {
      reasons.push(tierAmb ? 'tier' : 'layers');
      const k = Math.floor(nS / 2); rv.sheetFlags[k] = true;
      rv.items.push({ kind: 'layers', i: (main.B[k] + main.B[k + 1]) / 2, action: 'check', severity: 'high', sheet: k, val: tier && tierAmb ? tier.count : coarse ? coarse.count : null });
    }
    if (phaseAmb) { reasons.push('phase'); rv.sheetFlags[Math.floor(nS / 2)] = true; rv.items.push({ kind: 'harmonic', i: (main.B[Math.floor(nS / 2)] + main.B[Math.floor(nS / 2) + 1]) / 2, action: 'check', severity: 'high', sheet: Math.floor(nS / 2) }); }
    if (harmonicRisk) { const k = Math.floor(nS / 2); rv.sheetFlags[k] = true; rv.items.push({ kind: 'harmonic', i: (main.B[k] + main.B[k + 1]) / 2, action: 'check', severity: 'high', sheet: k }); }
    rv.items = itemsToT(rv.items, toT);
    const nFlag = nFlag0;
    let confidence = 'low';
    if (polAmb) confidence = 'low';
    else if (ratio > 20 && second < 0.6 && nFlag === 0 && agree && !harmonicRisk) confidence = 'high';
    else if (ratio > 6 && second < 0.9 && nFlag <= Math.max(1, Math.round(main.count * 0.03)) && !harmonicRisk) confidence = 'mid';
    rv.edgeFlags = edgeFlags; rv.reasons = reasons;
    if (bandInfo) rv.bandCounts = bandInfo.counts;
    const T = main.B.map(toT);
    const lines = T.slice(1, -1);
    return {
      count: main.count, lines, polarity: main.resp.polarity, pitchPx: Hpx / main.cand.c,
      candidates: results.map((x) => ({ count: x.count, lines: x.B.slice(1, -1).map(toT), topT: toT(x.B[0]), botT: toT(x.B[x.B.length - 1]) })),
      review: rv, confidence, ratio, plot: sp.plot, minC: sp.minC, maxC: sp.maxC, _r: main.r, R, topT: T[0], botT: T[T.length - 1],
      _cands: results.map((x) => [+x.cand.c.toFixed(1), x.cand.src, x.count, +x.st.on.toFixed(2), +x.st.mid.toFixed(2), x.stOwn ? +x.stOwn.on.toFixed(2) : null, x.stOwn ? +x.stOwn.mid.toFixed(2) : null, x.cand.wScore != null ? +x.cand.wScore.toFixed(2) : null, +(x.cand.score / top).toFixed(2)]), _wpeaks: spW ? spW.peaks.slice(0, 5).map((x) => +x.c.toFixed(1)) : null, _peaks: sp.peaks.slice(0, 6).map((x) => [+x.c.toFixed(1), +(x.score / sp.median).toFixed(1)]), _edge: main.edgeTop, _tier: tier && { trim: [tier.trimTop, tier.trimBot], count: tier.count, sep: +tier.sep.toFixed(2), con: +tier.contrast.toFixed(2), reg: tier.regular, worst: +tier.worst.toFixed(2) }, _endZ: endZ, _phase: phaseLog, _skew: ctx.skew, _pol: [ctx.polMode, ctx.polScores], _pl: main.pl, _p: main.p, _tMin: tMin, _dt: dt,
    };
  }

  // 手動修正後の再点検（lines は t 座標。端は res.topT/botT）
  function review(res, lines) {
    const tMin = res._tMin != null ? res._tMin : 0, dt = res._dt != null ? res._dt : 1 / (res.R - 1);
    const toI = (t) => (t - tMin) / dt;
    const b = [toI(res.topT != null ? res.topT : 0), ...lines.map(toI), toI(res.botT != null ? res.botT : 1)].map((x) => Math.round(x));
    const pAtI = (i) => (res._pl ? res._pl[Math.max(0, Math.min(res.R - 1, i))] : res._p || 1);
    const rv = reviewCore(b, res._r, pAtI);
    rv.items = itemsToT(rv.items, (i) => tMin + i * dt);
    return rv;
  }

  // 連写の多数決。同票なら信頼度（high>mid>low）→要確認の少なさで選ぶ。
  // 返り値: 採用コマの結果 + votes, agreement, perFrame:[{count, confidence, flags}], frameIndex（入力配列内の番号）
  function vote(results) {
    const nf = (r) => { const v = r.review || {}; return (v.sheetFlags || []).filter(Boolean).length + (v.lineFlags || []).filter(Boolean).length; };
    const cr = { high: 2, mid: 1, low: 0 };
    const tally = new Map();
    for (const r of results) tally.set(r.count, (tally.get(r.count) || 0) + 1);
    const better = (a, b) => { const ca = cr[a.confidence] || 0, cb = cr[b.confidence] || 0; if (ca !== cb) return ca > cb; return nf(a) < nf(b); };
    let bestCount = null, bn = -1, bestRep = null;
    for (const [k, n] of tally) {
      let rep = null; for (const r of results) if (r.count === k && (!rep || better(r, rep))) rep = r;
      if (n > bn || (n === bn && better(rep, bestRep))) { bn = n; bestCount = k; bestRep = rep; }
    }
    const frameIndex = results.indexOf(bestRep);
    const out = Object.assign({}, bestRep, {
      votes: [...tally].map(([count, n]) => ({ count, n })), agreement: bn / results.length,
      perFrame: results.map((r) => ({ count: r.count, confidence: r.confidence, flags: nf(r) })), frameIndex,
    });
    // コマ間で枚数が割れたら要確認（採用コマの端に印）
    if (results.length > 1 && bn < results.length && out.review) {
      const rv = Object.assign({}, out.review, { sheetFlags: [...out.review.sheetFlags], items: [...(out.review.items || [])] });
      rv.sheetFlags[0] = true; rv.items.push({ kind: 'frames', t: out.topT != null ? out.topT : 0, action: 'check', severity: bn * 2 > results.length ? 'mid' : 'high', sheet: 0 });
      out.review = rv;
    }
    return out;
  }
  return { count, review, vote };
})();

// ===== index（統合担当）: 公開API。アプリとベンチはこれだけを使う =====
// Engine.detect(gray,w,h)                         -> 積みの自動検出 {ok, up, lo, rect, tilt, vertical, ...}
// Engine.analyze(gray,w,h,up,lo,opts)             -> 1枚の画像を数える
// Engine.analyzeStill(frames[{gray,w,h}], up?, lo?, opts) -> 連写を数えて多数決（up/lo 省略時は各コマで自動検出）
// Engine.analyzeLive(gray,w,h,opts)               -> カメラ用: 検出＋計数＋撮影状態 {ok, res?, det, light, status}
// Engine.reReview(res,lines) / Engine.edges(w,h,up,lo) / Engine.toGray
const Engine = (() => {
  const BANDS = 3;
  function analyze(gray, w, h, upper, lower, opts = {}) {
    const grid = Geometry.rectify(gray, w, h, upper, lower, opts);
    const pr = Photometry.profile(gray, w, h, grid, opts);
    let bandProfs = null;
    if (opts.bands !== false && grid.nc >= 24) {
      bandProfs = [];
      for (let b = 0; b < BANDS; b++) bandProfs.push(Photometry.profile(gray, w, h, grid, Object.assign({}, opts, { cols: [Math.floor((grid.nc * b) / BANDS), Math.floor((grid.nc * (b + 1)) / BANDS)] })).prof);
    }
    const res = Count.count(pr.prof, grid, Object.assign({}, opts, { stepScore: pr.stepScore, bandProfs }));
    res.band = { x0: grid.x0, x1: grid.x1 };
    res.Hpx = grid.Hpx; res.columns = grid.nc; res.grid = grid; res.photometry = pr.info;
    addGlobalFlags(res, grid);
    return res;
  }
  // 画像全体の警告（角度がきつい・1枚が細かすぎる）を要確認として返す
  function addGlobalFlags(res, grid) {
    const g = [];
    if (grid.angleWarn) g.push({ kind: 'angle', msg: '角度がきつい：もう少し正面から撮ってください' });
    if (grid.tooFine) g.push({ kind: 'tooFine', msg: '1枚が細かすぎます：近づいて撮ってください' });
    if (res.review) res.review.globalFlags = g;
    return res;
  }
  function analyzeStill(frames, upper, lower, opts = {}) {
    const results = [];
    for (const f of frames) {
      let up = upper, lo = lower;
      if (!up || !lo) { const d = Geometry.detect(f.gray, f.w, f.h); if (!d.ok) continue; up = d.up; lo = d.lo; }
      try { const r = analyze(f.gray, f.w, f.h, up, lo, opts); r.up = up; r.lo = lo; results.push(r); } catch (e) {}
    }
    if (!results.length) throw new Error('どのコマでも数えられませんでした');
    return Count.vote(results);
  }
  let lastBeta = null; // カメラ用: 前フレームの β を引き継いで探索を省く
  function analyzeLive(gray, w, h, opts = {}) {
    const det = Geometry.detect(gray, w, h, opts);
    const out = { ok: false, det };
    if (!det.ok) return out;
    try {
      const res = analyze(gray, w, h, det.up, det.lo, lastBeta !== null && opts.beta === undefined ? Object.assign({}, opts, { beta: lastBeta }) : opts);
      lastBeta = res.grid.beta;
      out.ok = true; out.res = res;
      out.light = Photometry.lighting(gray, w, h, res.grid);
      out.status = { tilt: det.tilt, tooFine: !!(res.grid.tooFine || det.tooFine), vertical: det.vertical, pitchPx: res.pitchPx, angleWarn: !!res.grid.angleWarn,
        cutTop: det.rect.y0 < h * 0.02, cutBot: det.rect.y1 > h * 0.98, small: (det.rect.y1 - det.rect.y0) < h * 0.25 };
    } catch (e) {}
    return out;
  }
  return {
    toGray: Core.toGray, detect: (gray, w, h, opts) => Geometry.detect(gray, w, h, opts), edges: Geometry.edges, analyze, analyzeStill, analyzeLive,
    reReview: (res, lines) => { const rv = Count.review(res, lines); if (res.review && res.review.globalFlags) rv.globalFlags = res.review.globalFlags; return rv; },
    fromDescription: Geometry.fromDescription,
  };
})();

if (typeof module !== 'undefined') module.exports = Engine;
