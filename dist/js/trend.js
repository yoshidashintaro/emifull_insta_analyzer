// 上部の指標の「推移」。日・週・月に区切って、期間ごとの値を出す（DOM に依存しない。Node のテストからも読み込む）
import { addDays, parseDateKey, weekdayIndex } from './analytics.js';
import { isInstagram, primaryRows } from './data/ga4.js';

export const TREND_UNITS = [
  { key: 'day', label: '日' },
  { key: 'week', label: '週' },
  { key: 'month', label: '月' },
];

/**
 * 推移を出せる指標。上部のカードと同じ並び。
 * source: daily（アカウントの日次）/ posts（投稿）/ ga4（HP への流入）
 * agg   : last（期間の最終値）/ sum / mean / count / ratio（num ÷ den）
 * chart : 量は棒、率や水準は折れ線
 */
export const TREND_METRICS = [
  { key: 'followers', group: 'Instagram', label: 'フォロワー数', source: 'daily', agg: 'last', field: 'followers', chart: 'line', def: '各期間の最終日のフォロワー数' },
  { key: 'er', group: 'Instagram', label: '平均エンゲージメント率', source: 'posts', agg: 'mean', field: 'er', unit: '%', chart: 'line', def: 'その期間に投稿した投稿のエンゲージメント率の平均' },
  { key: 'posts', group: 'Instagram', label: '投稿数', source: 'posts', agg: 'count', chart: 'bar', def: 'その期間の投稿数' },
  { key: 'reach', group: 'Instagram', label: '平均リーチ／投稿', source: 'posts', agg: 'mean', field: 'reach', chart: 'line', def: 'その期間に投稿した投稿のリーチの平均' },
  { key: 'nonFollowerReach', group: 'Instagram', label: '非フォロワーの平均リーチ／投稿', source: 'posts', agg: 'mean', field: 'nonFollowerReach', chart: 'line', def: 'その期間に投稿した投稿の、フォロワー以外へのリーチの平均（実数が無い投稿は、リーチ内訳の比率による推定値）' },
  { key: 'interactions', group: 'Instagram', label: '平均反応数／投稿', source: 'posts', agg: 'mean', field: 'interactions', chart: 'line', def: 'その期間に投稿した投稿の反応数（いいね＋コメント＋保存＋シェア）の平均' },
  { key: 'profileVisits', group: 'Instagram', label: 'プロフィールアクセス', source: 'daily', agg: 'sum', field: 'profileVisits', chart: 'bar', def: '日次のプロフィールアクセスの合計' },
  { key: 'linkClicks', group: 'Instagram', label: 'リンククリック', source: 'daily', agg: 'sum', field: 'linkClicks', chart: 'bar', def: '日次のリンククリックの合計' },
  { key: 'hpUsers', group: 'HP流入（GA4）', label: '流入数（UU数）', source: 'ga4', agg: 'sum', field: 'users', chart: 'bar', def: 'Instagram からの流入のユーザー数の合計（日ごと・参照元ごとの合計）' },
  { key: 'hpSessions', group: 'HP流入（GA4）', label: 'アクセス数（セッション数）', source: 'ga4', agg: 'sum', field: 'sessions', chart: 'bar', def: 'Instagram からの流入のセッション数の合計（広告を含む）' },
  { key: 'hpNewUsers', group: 'HP流入（GA4）', label: '新規ユーザー数', source: 'ga4', agg: 'sum', field: 'newUsers', chart: 'bar', def: 'Instagram からの流入の新規ユーザー数の合計' },
  { key: 'hpNewRate', group: 'HP流入（GA4）', label: '新規率', source: 'ga4', agg: 'ratio', num: 'newUsers', den: 'users', numLabel: '新規ユーザー', denLabel: 'ユーザー', unit: '%', chart: 'line', def: '新規ユーザー数 ÷ ユーザー数' },
  { key: 'hpEngagement', group: 'HP流入（GA4）', label: 'エンゲージメント率（HP）', source: 'ga4', agg: 'ratio', num: 'engagedSessions', den: 'sessions', numLabel: 'エンゲージのあったセッション', denLabel: 'セッション', unit: '%', chart: 'line', def: 'エンゲージのあったセッション ÷ セッション（GA4 のエンゲージメント率）' },
  { key: 'hpCv', group: 'HP流入（GA4）', label: '予約完了数（CV数）', source: 'ga4', agg: 'sum', field: 'cv', chart: 'bar', def: 'Instagram からの流入の CV（予約完了）の合計' },
  { key: 'hpCvr', group: 'HP流入（GA4）', label: 'CVR', source: 'ga4', agg: 'ratio', num: 'cv', den: 'sessions', numLabel: 'CV', denLabel: 'セッション', unit: '%', chart: 'line', def: 'CV ÷ セッション' },
];

export const trendMetric = (key) => TREND_METRICS.find((m) => m.key === key) || null;

/** その日が属する期間の初日（週は月曜始まり） */
export function bucketKey(dateKey, unit) {
  if (unit === 'week') return addDays(dateKey, -weekdayIndex(parseDateKey(dateKey)));
  if (unit === 'month') return `${dateKey.slice(0, 7)}-01`;
  return dateKey;
}

function nextBucket(key, unit) {
  if (unit === 'week') return addDays(key, 7);
  if (unit === 'month') {
    const [y, m] = key.split('-').map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return addDays(key, 1);
}

/** 表用（長い）とグラフの軸用（短い）の期間名 */
export function bucketLabels(key, unit) {
  const [y, m, d] = key.split('-').map(Number);
  if (unit === 'month') return { label: `${y}年${m}月`, short: `${y}/${m}` };
  if (unit === 'week') {
    const end = addDays(key, 6).split('-').map(Number);
    return { label: `${y}/${m}/${d}〜${end[1]}/${end[2]}`, short: `${m}/${d}〜` };
  }
  return { label: `${y}/${m}/${d}`, short: `${m}/${d}` };
}

const present = (v) => v !== null && v !== undefined;

/**
 * 指標の推移。
 * @param metricKey TREND_METRICS の key
 * @param ctx       { daily: normalizeDaily 済み, posts: enrichPosts 済み（dateKey・er 付き）, ga4: 取り込んだ GA4 の行 }
 * @param unit      'day' | 'week' | 'month'
 * @returns {{metric:object, unit:string, rows:{key,label,short,value,n,num,den,change}[]}|null}
 *          rows は古い順。データの無い期間も間を空けずに並べる（value は null、投稿数だけは 0）
 */
export function trendSeries(metricKey, { daily = [], posts = [], ga4 = [] } = {}, unit = 'week') {
  const m = trendMetric(metricKey);
  if (!m) return null;
  const items =
    m.source === 'daily'
      ? daily.map((d) => ({ date: d.date, row: d }))
      : m.source === 'posts'
        ? posts.map((p) => ({ date: p.dateKey, row: p }))
        : primaryRows((ga4 || []).filter((r) => isInstagram(r.sourceMedium))).map((r) => ({ date: r.date, row: r }));
  const has = (r) => (m.agg === 'count' ? true : m.agg === 'ratio' ? present(r[m.num]) && present(r[m.den]) : present(r[m.field]));
  const valid = items.filter((i) => i.date && has(i.row));
  if (!valid.length) return { metric: m, unit, rows: [] };

  const groups = new Map();
  for (const i of valid) {
    const k = bucketKey(i.date, unit);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const keys = [...groups.keys()].sort();
  const sum = (g, f) => g.reduce((s, i) => s + i.row[f], 0);

  const rows = [];
  let prev = null;
  for (let k = keys[0]; k <= keys.at(-1); k = nextBucket(k, unit)) {
    const g = (groups.get(k) || []).sort((a, b) => a.date.localeCompare(b.date));
    const r = { key: k, ...bucketLabels(k, unit), n: g.length, value: null, num: null, den: null, change: null };
    if (g.length) {
      if (m.agg === 'count') r.value = g.length;
      else if (m.agg === 'sum') r.value = sum(g, m.field);
      else if (m.agg === 'mean') r.value = sum(g, m.field) / g.length;
      else if (m.agg === 'last') r.value = g.at(-1).row[m.field];
      else {
        r.num = sum(g, m.num);
        r.den = sum(g, m.den);
        r.value = r.den ? (r.num / r.den) * 100 : null;
      }
    } else if (m.agg === 'count') r.value = 0; // 投稿の無い期間は 0 件
    // 前の期間比：率はポイント差、それ以外は増減率（%）
    if (r.value !== null && prev !== null) r.change = m.unit === '%' ? r.value - prev : prev ? ((r.value - prev) / prev) * 100 : null;
    if (r.value !== null) prev = r.value;
    rows.push(r);
  }
  return { metric: m, unit, rows };
}
