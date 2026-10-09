// リーチのフォロワー／フォロワー以外の内訳（期間の集計）の取り込みと、それを使った非フォロワー数の推定。
// 例: 取得日,アカウント,期間,Instagramリーチ合計,From followers,From non-followers,非フォロワー比率,…
//     2026-10-02,miselclinic_osaka,2026-09-04～2026-10-01（直近28日）,38400,2656,36541,93.2%,…
import { norm } from './csv.js';

const ALIASES = {
  fetchedAt: ['取得日', 'fetchedat', 'fetcheddate'],
  account: ['アカウント', 'account', 'username', 'accountusername', 'ユーザーネーム'],
  period: ['期間', 'period', '対象期間'],
  start: ['開始日', 'start', 'startdate', 'since', '期間開始'],
  end: ['終了日', 'end', 'enddate', 'until', '期間終了'],
  total: ['instagramリーチ合計', 'リーチ合計', 'リーチ', 'totalreach', 'reach', 'instagramreach'],
  followers: ['fromfollowers', 'followers', 'フォロワー', 'フォロワーから', 'フォロワーへのリーチ', 'followerreach'],
  nonFollowers: ['fromnonfollowers', 'nonfollowers', '非フォロワー', 'フォロワー以外', 'フォロワー以外から', 'フォロワー以外へのリーチ', 'nonfollowerreach'],
  ratio: ['非フォロワー比率', 'フォロワー以外の割合', 'nonfollowerratio', 'nonfollowershare', 'nonfollowers%', '非フォロワー率'],
};

function mapHeader(header) {
  const map = {};
  header.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    for (const [key, list] of Object.entries(ALIASES)) {
      if (map[key] === undefined && list.some((a) => norm(a) === n)) map[key] = i;
    }
  });
  return map;
}

const toNumber = (v) => {
  const s = String(v ?? '').replace(/[,\s%％]/g, '');
  if (s === '' || s === '-' || s === '–') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const DATE = String.raw`(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?`;

/** 「2026-09-04～2026-10-01（直近28日）」→ { start, end } */
export function parsePeriod(s) {
  const m = String(s ?? '').match(new RegExp(`${DATE}\\s*[～〜~\\-–—]\\s*${DATE}`));
  return m ? { start: dateKey(+m[1], +m[2], +m[3]), end: dateKey(+m[4], +m[5], +m[6]) } : null;
}

function oneDate(s) {
  const m = String(s ?? '').match(new RegExp(DATE));
  return m ? dateKey(+m[1], +m[2], +m[3]) : null;
}

/**
 * 行配列（parseCSV の結果）からリーチ内訳を読む。この形式でなければ null。
 * 非フォロワー比率は、ファイルの比率列を優先し、無ければ 非フォロワー ÷（フォロワー＋非フォロワー）で出す。
 * （Meta はフォロワー・非フォロワーの両方に届いた人を両方に数えるため、合計とは一致しない）
 */
export function readReachBreakdown(rows) {
  if (!rows?.length) return null;
  for (let h = 0; h < Math.min(rows.length, 5); h++) {
    const col = mapHeader(rows[h] || []);
    const hasPeriod = col.period !== undefined || (col.start !== undefined && col.end !== undefined);
    if (col.nonFollowers === undefined || !hasPeriod) continue;
    const out = [];
    for (const r of rows.slice(h + 1)) {
      const period = col.period !== undefined ? parsePeriod(r[col.period]) : { start: oneDate(r[col.start]), end: oneDate(r[col.end]) };
      if (!period?.start || !period?.end) continue;
      const nonFollowers = toNumber(r[col.nonFollowers]);
      if (nonFollowers === null) continue;
      const followers = col.followers === undefined ? null : toNumber(r[col.followers]);
      const total = col.total === undefined ? null : toNumber(r[col.total]);
      const fileRatio = col.ratio === undefined ? null : toNumber(r[col.ratio]);
      const ratio =
        fileRatio !== null ? fileRatio
          : followers !== null && followers + nonFollowers > 0 ? (nonFollowers / (followers + nonFollowers)) * 100
            : total ? (nonFollowers / total) * 100
              : null;
      if (ratio === null) continue;
      out.push({
        account: String(col.account === undefined ? '' : r[col.account] ?? '').trim().replace(/^@/, ''),
        start: period.start <= period.end ? period.start : period.end,
        end: period.start <= period.end ? period.end : period.start,
        total,
        followers,
        nonFollowers,
        ratio, // %（0〜100）
        fetchedAt: col.fetchedAt === undefined ? null : oneDate(r[col.fetchedAt]),
      });
    }
    return out.length ? out : null;
  }
  return null;
}

/** 同じアカウント・同じ期間は新しい方で上書き */
export function mergeReachBreakdown(oldRows = [], newRows = []) {
  const key = (r) => `${r.account}|${r.start}|${r.end}`;
  const map = new Map(oldRows.map((r) => [key(r), r]));
  for (const r of newRows) map.set(key(r), r);
  return [...map.values()].sort((a, b) => a.account.localeCompare(b.account) || a.start.localeCompare(b.start));
}

const DAY = 86400000;
const toTime = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));

/**
 * その日・そのアカウントに使う内訳。期間に含まれるものを優先（短い期間ほど優先）し、
 * 無ければいちばん近い期間を使う。アカウントが分かっていて一致する内訳が無ければ null（別アカウントの比率は使わない）
 */
export function breakdownFor(breakdowns, account, date) {
  if (!breakdowns?.length || !date) return null;
  const list = breakdowns.filter((b) => !account || !b.account || b.account === account);
  if (!list.length) return null;
  const covering = list.filter((b) => b.start <= date && date <= b.end).sort((a, b) => toTime(a.end) - toTime(a.start) - (toTime(b.end) - toTime(b.start)));
  if (covering.length) return { ...covering[0], exact: true };
  const t = toTime(date);
  const dist = (b) => (t < toTime(b.start) ? toTime(b.start) - t : t - toTime(b.end)) / DAY;
  const nearest = [...list].sort((a, b) => dist(a) - dist(b))[0];
  return { ...nearest, exact: false };
}

/**
 * 非フォロワーへのリーチの実数が無い投稿・日に、内訳の比率から推定値を入れる。
 * 推定した行には nonFollowerEstimated: true を付ける（実数はそのまま）。
 * @param mainAccount 日次データ（アカウント全体）に使うアカウント
 */
export function applyNonFollowerEstimate({ posts = [], daily = [] }, breakdowns, mainAccount = '') {
  if (!breakdowns?.length) return { posts, daily, estimated: false };
  let estimated = false;
  const fill = (row, account, date) => {
    if (row.nonFollowerReach !== null && row.nonFollowerReach !== undefined) return row;
    if (row.reach === null || row.reach === undefined) return row;
    const b = breakdownFor(breakdowns, account, date);
    if (!b) return row;
    estimated = true;
    return { ...row, nonFollowerReach: Math.round((row.reach * b.ratio) / 100), nonFollowerEstimated: true };
  };
  const outPosts = posts.map((p) => fill(p, p.account || mainAccount, p.dateKey));
  const outDaily = daily.map((d) => fill(d, mainAccount, d.date));
  return { posts: outPosts, daily: outDaily, estimated };
}

/** 画面の注意書き用：どの期間の比率を使ったか */
export function describeBreakdowns(breakdowns) {
  return (breakdowns || []).map((b) => `${b.account ? `@${b.account} ` : ''}${b.start.replaceAll('-', '/')}〜${b.end.replaceAll('-', '/')} の非フォロワー比率 ${b.ratio.toFixed(1)}%`);
}
