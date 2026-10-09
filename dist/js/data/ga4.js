// GA4 の流入データ（参照元/メディア別の日次・週次）の取り込み。
// Meta のインサイトとは別系統のデータなので、独立した行として持つ。
import { toDateKey } from '../analytics.js';
import { excelSerialToDateKey } from './xlsx.js';

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s"'（）()・_-]/g, '');

const ALIASES = {
  date: ['日付', 'date', '週', 'week', '日', '年月日', 'デイ'],
  sourceMedium: [
    '参照元/メディア', 'セッションの参照元/メディア', 'sourcemedium', 'source/medium',
    'sessionsourcemedium', 'sessionsource/medium', '参照元メディア', 'ソース/メディア',
  ],
  campaign: ['キャンペーン', 'キャンペーン(utmcampaign)', 'campaign', 'utmcampaign', 'sessioncampaign', 'セッションのキャンペーン'],
  content: ['コンテンツ', 'コンテンツ(utmcontent)', 'content', 'utmcontent', 'adcontent'],
  sessions: ['セッション', 'セッション数', 'sessions'],
  engagedSessions: ['エンゲージのあったセッション', 'エンゲージメントのあったセッション', 'engagedsessions'],
  users: ['ユーザー', 'ユーザー数', 'totalusers', 'users', 'アクティブユーザー', 'activeusers'],
  newUsers: ['新規ユーザー', '新規ユーザー数', 'newusers'],
  pageViews: ['表示回数', 'ページビュー', 'ページビュー数', 'pv', 'pv数', 'views', 'pageviews', 'screenpageviews', '表示回数(ページビュー)'],
  reserveTaps: ['予約タップ', '予約タップ数', 'reservetap', 'reservetaps'],
  cv: ['cv', 'コンバージョン', 'コンバージョン数', 'conversions', 'keyevents', 'キーイベント', 'キーイベント数'],
};

// 明らかに Instagram 以外だと分かる行（ワークブックが集計済みの「その他」行を入れていることがある）
const NON_INSTAGRAM = ['（instagram以外の合計）', '(instagram以外の合計)', 'instagram以外', 'その他合計', 'other'];

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
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,\s%％]/g, '');
  if (s === '' || s === '-' || s === '–') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** 数値（Excel シリアル）でも文字列でも日付キーにする */
function toDate(v) {
  if (typeof v === 'number') return excelSerialToDateKey(v);
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/))) {
    return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  }
  if ((m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/))) {
    return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toDateKey(d);
}

/** Instagram からの流入か（参照元/メディアの文字列で判定） */
export function isInstagram(sourceMedium) {
  const s = String(sourceMedium ?? '').toLowerCase();
  if (NON_INSTAGRAM.some((x) => s.includes(x))) return false;
  return /instagram|(^|[^a-z])ig([^a-z]|$)|insta/.test(s);
}

/** 広告（有料）流入か。オーガニックと混ぜると投稿の効果が読めなくなる */
export function isPaid(sourceMedium) {
  const s = String(sourceMedium ?? '').toLowerCase();
  return /\/\s*(paid|cpc|ppc|cpm)\b/.test(s) || /\bpaid\b/.test(s.split('/')[1] || '');
}

/**
 * 参照元/メディアから Instagram アカウントを推定する既定ルール。
 * 利用者が画面で対応づけを上書きできるよう、ルールは配列で返す。
 */
export const DEFAULT_ACCOUNT_RULES = [
  { match: 'web_instagram_okudate', account: 'dr.okudate_miselclinic', label: '奥立医師' },
  { match: 'instagram_artmake', account: 'instagram_artmake', label: 'アートメイク' },
  { match: 'instagram_phimosis', account: 'instagram_phimosis', label: '包茎' },
  { match: 'tatto', account: 'tattoo', label: 'タトゥー' },
  { match: 'surgeryshourei', account: 'surgery', label: '症例' },
];

/**
 * 参照元/メディア → アカウント名。
 * どのルールにも当たらない Instagram 流入は既定アカウント（本アカウント）とみなす。
 */
export function accountOf(sourceMedium, { rules = DEFAULT_ACCOUNT_RULES, fallback = '' } = {}) {
  const s = String(sourceMedium ?? '').toLowerCase();
  if (isPaid(s)) return '(広告)';
  for (const r of rules) if (s.includes(String(r.match).toLowerCase())) return r.account;
  return fallback;
}

/**
 * 行配列から GA4 の流入行を取り出す。CSV でも Excel のシートでも同じ関数を使う。
 * @returns {{rows:object[], headerIdx:number}|null} GA4 の表でなければ null
 */
export function readGA4Table(rows) {
  if (!rows?.length) return null;
  let headerIdx = -1;
  let col = null;
  // 先頭に説明行があるので、少し下まで見てヘッダーを探す
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const m = mapHeader(rows[i] || []);
    if (m.date !== undefined && m.sourceMedium !== undefined && m.sessions !== undefined) {
      headerIdx = i;
      col = m;
      break;
    }
  }
  if (headerIdx < 0) return null;

  const get = (r, key) => (col[key] === undefined ? undefined : r[col[key]]);
  // キャンペーン列があれば、同じ流入をさらに細かく割った表。合計すると二重計上になるので区別する
  const level = col.campaign !== undefined || col.content !== undefined ? 'campaign' : 'source';
  const out = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const date = toDate(r[col.date]);
    const sourceMedium = String(get(r, 'sourceMedium') ?? '').trim();
    if (!date || !sourceMedium) continue;
    const sessions = toNumber(get(r, 'sessions'));
    if (sessions === null) continue;
    out.push({
      date,
      sourceMedium,
      level,
      campaign: String(get(r, 'campaign') ?? '').trim() || null,
      content: String(get(r, 'content') ?? '').trim() || null,
      sessions,
      engagedSessions: toNumber(get(r, 'engagedSessions')),
      users: toNumber(get(r, 'users')),
      newUsers: toNumber(get(r, 'newUsers')),
      pageViews: toNumber(get(r, 'pageViews')),
      reserveTaps: toNumber(get(r, 'reserveTaps')),
      cv: toNumber(get(r, 'cv')),
    });
  }
  return out.length ? { rows: out, headerIdx, level } : null;
}

/**
 * Excel ブックの全シートから GA4 の表を探して取り込む。
 * @param {{name:string, rows:any[][]}[]} sheets
 * @param {{property?: string}} [opts] プロパティ名（HP のアカウント）
 */
export function importGA4Workbook(sheets, { property = '' } = {}) {
  const rows = [];
  const found = [];
  for (const sheet of sheets) {
    const table = readGA4Table(sheet.rows);
    if (!table) continue;
    for (const r of table.rows) rows.push({ ...r, property, sheet: sheet.name });
    found.push(`${sheet.name}（${table.rows.length}行・${table.level === 'campaign' ? 'キャンペーン別' : '参照元別'}）`);
  }
  if (!rows.length) return null;
  return { rows, sheets: found };
}

/**
 * 集計に使う行だけを返す。
 * 参照元別（粗い）とキャンペーン別（細かい）が両方あると、同じ流入を二重に数えてしまうため、
 * 粗いほうがあればそちらを使う。
 */
export function primaryRows(rows) {
  const source = rows.filter((r) => r.level !== 'campaign');
  return source.length ? source : rows;
}

/** キャンペーン別（UTM）の行だけ。どの投稿・施策からの流入かを見るのに使う */
export function campaignRows(rows) {
  return rows.filter((r) => r.level === 'campaign' && r.campaign);
}

/** ファイル名からプロパティ名を推定する（Instagram流入分析_miselcl_過去90日.xlsx → miselcl） */
export function propertyFromFileName(name) {
  const base = String(name || '').replace(/\.[a-z0-9]+$/i, '');
  const m = base.match(/[_＿]([A-Za-z0-9.\-]+)/);
  return m ? m[1] : base;
}

/** 同じ日・同じ参照元/メディア・同じキャンペーンの行をひとつにまとめる */
export function mergeGA4(oldRows = [], newRows = []) {
  const key = (r) => `${r.property || ''}|${r.date}|${r.sourceMedium}|${r.campaign || ''}|${r.content || ''}`;
  const map = new Map(oldRows.map((r) => [key(r), r]));
  for (const r of newRows) map.set(key(r), r);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.sourceMedium.localeCompare(b.sourceMedium));
}
