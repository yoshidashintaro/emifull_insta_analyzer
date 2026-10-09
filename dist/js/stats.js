// 相関などの統計。DOM に依存しない純粋関数のみ（Node のテストからも読み込む）

export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

export function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

/** ピアソンの積率相関係数。分散が 0 の系列（ずっと同じ値）は null */
export function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    sxy += a * b;
    sxx += a * a;
    syy += b * b;
  }
  if (!sxx || !syy) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** 同順位は平均順位にする */
export function ranks(a) {
  const sorted = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const out = new Array(a.length);
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[sorted[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

/** スピアマンの順位相関。外れ値（バズった1週など）に強い */
export function spearman(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  return pearson(ranks(x.slice(0, n)), ranks(y.slice(0, n)));
}

// ---------- 有意性 ----------

function gammaln(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = z;
  let tmp = z + 5.5;
  tmp -= (z + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / z);
}

function betacf(a, b, x) {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-7) break;
  }
  return h;
}

/** 正則化不完全ベータ関数 */
function ibeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/**
 * 相関係数の両側 p 値（t 分布）。
 * 「偶然このくらいの相関が出てしまう確率」。小さいほど偶然とは考えにくい。
 */
export function pValue(r, n) {
  if (r === null || n < 3) return null;
  if (Math.abs(r) >= 0.999999) return 0;
  const df = n - 2;
  const t = Math.abs(r) * Math.sqrt(df / (1 - r * r));
  return ibeta(df / 2, 0.5, df / (df + t * t));
}

/** フィッシャーの z 変換による 95% 信頼区間。データが少ないほど広くなる */
export function confidence95(r, n) {
  if (r === null || n < 4 || Math.abs(r) >= 0.999999) return null;
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1 / Math.sqrt(n - 3);
  return [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)];
}

/** z を制御した偏相関。時間トレンドによる見かけの相関を切り分けるのに使う */
export function partialCorrelation(x, y, z) {
  const rxy = pearson(x, y);
  const rxz = pearson(x, z);
  const ryz = pearson(y, z);
  if (rxy === null || rxz === null || ryz === null) return null;
  const denom = Math.sqrt((1 - rxz ** 2) * (1 - ryz ** 2));
  return denom ? (rxy - rxz * ryz) / denom : null;
}

/** 前の期間との差（増減）。増え続けているだけの2系列が相関して見えるのを防ぐ */
export const differences = (a) => a.slice(1).map((v, i) => v - a[i]);

/** 最小二乗法の回帰直線 y = slope * x + intercept */
export function linearRegression(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  if (!sxx) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/** 相関の強さの日本語ラベル（|r| の目安） */
export function strengthLabel(r) {
  const a = Math.abs(r);
  if (a >= 0.7) return '強い';
  if (a >= 0.4) return 'ややある';
  if (a >= 0.2) return '弱い';
  return 'ほぼ無い';
}

/**
 * 2系列の関係をひととおり計算する。
 * trend に週番号などを渡すと、トレンドを除いた偏相関・差分相関も返す。
 */
export function correlate(x, y, { trend = null } = {}) {
  const n = Math.min(x.length, y.length);
  const r = pearson(x, y);
  const p = pValue(r, n);
  const out = {
    n,
    r,
    rho: spearman(x, y),
    p,
    ci: confidence95(r, n),
    r2: r === null ? null : r * r,
    strength: r === null ? null : strengthLabel(r),
    significant: p !== null && p < 0.05,
  };
  if (trend) {
    out.partial = partialCorrelation(x, y, trend);
    out.partialP = pValue(out.partial, n - 1);
  }
  const dx = differences(x);
  const dy = differences(y);
  if (dx.length >= 3) {
    out.deltaR = pearson(dx, dy);
    out.deltaP = pValue(out.deltaR, dx.length);
  }
  return out;
}
