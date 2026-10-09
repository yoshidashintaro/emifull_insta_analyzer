// ソーシャルインサイト（Social Insight）の書き出し CSV の取り込み。
// 1ファイル1種類で、ファイル名に種類・アカウント・期間が入る（UTF-8）。
//   si__accounts-posts_<アカウント>_instagram_<開始>-<終了>_utf8.csv   … 投稿一覧
//   si__accounts-hashtag_analysis_<アカウント>_<開始>-<終了>_utf8.csv  … ハッシュタグ分析
//   si__accounts-followed_<アカウント>_instagram_<取得日時>_utf8.csv   … フォロー中アカウント一覧
// Meta のエクスポート（csv.js）とは列が違うため、取り込みはこちらで受ける。
import { norm, parseDateTime } from './csv.js';
import { emptyDailyRow, jstDateKey } from '../analytics.js';

// 投稿一覧。フォロワー数・エンゲージメント率・いいね偏差値は Meta の書き出しには無い列
const POST_COLS = {
  timestamp: ['投稿時間', '投稿日時', '投稿日'],
  permalink: ['詳細url', 'url', '投稿url'],
  type: ['タイプ', '種類'],
  caption: ['内容', '本文', 'キャプション'],
  thumbnail: ['画像url', 'サムネイルurl', 'サムネイル'],
  followers: ['フォロワー数'],
  likes: ['いいね数', 'いいね'],
  comments: ['コメント数', 'コメント'],
  views: ['動画再生回数', '再生回数', '動画視聴回数'],
  er: ['エンゲージメント率'],
  likeScore: ['いいね偏差値β', 'いいね偏差値'],
};

// ハッシュタグ分析。2種類の書き出しがあり、指標とエンゲージメント率の分母が違う。
//   accounts-hashtag_analysis … いいね・コメント／エンゲージメント率はフォロワー基準
//   instagram_insights-hashtag … 閲覧数・リーチ・いいね・保存／エンゲージメント率は閲覧数基準
const HASHTAG_COLS = {
  tag: ['ハッシュタグ', 'hashtag'],
  posts: ['投稿件数', '投稿数'],
  viewsTotal: ['閲覧数合計'],
  viewsMean: ['閲覧数平均'],
  viewsMedian: ['閲覧数中央値'],
  reachTotal: ['リーチ数合計', 'リーチ合計'],
  reachMean: ['リーチ数平均', 'リーチ平均'],
  reachMedian: ['リーチ数中央値', 'リーチ中央値'],
  likesTotal: ['いいね数合計'],
  likesMean: ['いいね数平均'],
  likesMedian: ['いいね数中央値'],
  commentsTotal: ['コメント数合計'],
  commentsMean: ['コメント数平均'],
  commentsMedian: ['コメント数中央値'],
  savesTotal: ['保存数合計'],
  savesMean: ['保存数平均'],
  savesMedian: ['保存数中央値'],
  erMean: ['エンゲージメント率平均%', 'エンゲージメント率平均'],
  erMedian: ['エンゲージメント率中央値%', 'エンゲージメント率中央値'],
};

const HASHTAG_METRICS = [
  'posts',
  'viewsTotal', 'viewsMean', 'viewsMedian',
  'reachTotal', 'reachMean', 'reachMedian',
  'likesTotal', 'likesMean', 'likesMedian',
  'commentsTotal', 'commentsMean', 'commentsMedian',
  'savesTotal', 'savesMean', 'savesMedian',
  'erMean', 'erMedian',
];

// 投稿インサイト（Instagram 連携版の書き出し）。リーチ・保存・シェア・直フォローまで入る、
// このツールでいちばん詳しい投稿データ。
const INSIGHT_POST_COLS = {
  accountName: ['アカウント名'],
  mediaId: ['投稿id', 'メディアid'],
  account: ['ユーザーネーム', 'ユーザー名', 'username'],
  caption: ['キャプション', '内容', '本文'],
  timestamp: ['投稿日時', '投稿時間', '投稿日'],
  type: ['タイプ', '種類'],
  permalink: ['投稿url', '詳細url', 'url'],
  thumbnail: ['サムネイルurl', '画像url'],
  views: ['閲覧数'],
  reach: ['リーチ', 'リーチ数'],
  likes: ['いいね', 'いいね数'],
  comments: ['コメント', 'コメント数'],
  reposts: ['再投稿'],
  saves: ['保存', '保存数'],
  saveRate: ['保存率'],
  shares: ['シェア数', 'シェア'],
  engagement: ['エンゲージメント'],
  er: ['エンゲージメント率'],
  follows: ['直フォロー'],
  profileVisits: ['プロフィール遷移'],
  avgWatch: ['平均再生時間秒', '平均再生時間'],
  totalWatch: ['合計再生時間秒', '合計再生時間'],
  skipRate: ['スキップ率'],
  viewsIgFb: ['閲覧数instagram&facebook'],
  viewsFb: ['閲覧数facebook'],
  viewsScore: ['閲覧数偏差値β', '閲覧数偏差値'],
};

// ストーリーズのインサイト。閲覧率・離脱・タップはストーリーズだけの指標
const STORY_COLS = {
  accountName: ['アカウント名'],
  storyId: ['ストーリーid', '投稿id'],
  account: ['ユーザーネーム', 'ユーザー名'],
  caption: ['キャプション', '内容'],
  timestamp: ['投稿日時', '投稿時間'],
  type: ['タイプ', '種類'],
  permalink: ['ストーリーurl', '投稿url', 'url'],
  thumbnail: ['サムネイルurl', '画像url'],
  views: ['閲覧数'],
  viewRate: ['閲覧率'],
  reach: ['リーチ'],
  replies: ['返信'],
  shares: ['シェア', 'シェア数'],
  engagement: ['エンゲージメント'],
  follows: ['直フォロー'],
  profileVisits: ['プロフィール遷移'],
  exits: ['離脱'],
  tapsForward: ['タップ進む'],
  tapsBack: ['タップ戻る'],
  swipeForward: ['スワイプ進む'],
  linkClicks: ['リンククリック数ハッシュタグ収集用連携のみ取得', 'リンククリック数'],
};

// タグ付けされた投稿（他アカウントの投稿）。自社の投稿ではないので posts には混ぜない
const TAGGED_COLS = {
  mediaId: ['投稿id', 'メディアid'],
  account: ['ユーザーネーム', 'ユーザー名'],
  caption: ['キャプション', '内容'],
  timestamp: ['投稿日時', '投稿時間'],
  type: ['タイプ', '種類'],
  permalink: ['投稿url', '詳細url', 'url'],
  thumbnail: ['サムネイルurl', '画像url'],
  likes: ['いいね', 'いいね数'],
  comments: ['コメント', 'コメント数'],
};

// 日次アカウントインサイト（Instagram 連携版）。アプリの日次指標をほぼすべて実測で埋められる。
// 「フォロワー増加数／減少数」が新規フォロー／フォロー解除で、「フォロー数」は自社がフォローしている数。
const INSIGHT_DAILY_COLS = {
  accountName: ['アカウント名'],
  date: ['日付', '日時'],
  followers: ['フォロワー数'],
  following: ['フォロー数'],
  follows: ['フォロワー増加数'],
  unfollows: ['フォロワー減少数フォローをやめた数', 'フォロワー減少数'],
  followerConversionRate: ['フォロワー転換率'],
  postsTotal: ['投稿数'],
  views: ['閲覧数'],
  viewsFeed: ['閲覧数フィード'],
  viewsReels: ['閲覧数リール'],
  viewsStories: ['閲覧数ストーリーズ'],
  viewsAds: ['閲覧数広告'],
  viewsOther: ['閲覧数その他'],
  viewsFollowers: ['閲覧数フォロワー'],
  viewsNonFollowers: ['閲覧数フォロワー以外'],
  viewsUnknown: ['閲覧数不明'],
  reach: ['リーチ'],
  reachFeed: ['リーチフィード'],
  reachReels: ['リーチリール'],
  reachStories: ['リーチストーリーズ'],
  reachAds: ['リーチ広告'],
  reachOther: ['リーチその他'],
  followerReach: ['リーチフォロワー'],
  nonFollowerReach: ['リーチフォロワー以外'],
  reachUnknown: ['リーチ不明'],
  interactions: ['エンゲージメント'],
  interactionsFeed: ['エンゲージメントフィード'],
  interactionsReels: ['エンゲージメントリール'],
  interactionsStories: ['エンゲージメントストーリーズ'],
  interactionsAds: ['エンゲージメント広告'],
  interactionsOther: ['エンゲージメントその他'],
  likes: ['いいね'],
  likesFeed: ['いいねフィード'],
  likesReels: ['いいねリール'],
  likesAds: ['いいね広告'],
  likesOther: ['いいねその他'],
  comments: ['コメント'],
  commentsFeed: ['コメントフィード'],
  commentsReels: ['コメントリール'],
  commentsAds: ['コメント広告'],
  commentsOther: ['コメントその他'],
  reposts: ['再投稿'],
  saves: ['保存'],
  savesFeed: ['保存フィード'],
  savesReels: ['保存リール'],
  savesAds: ['保存広告'],
  savesOther: ['保存その他'],
  shares: ['シェア'],
  sharesFeed: ['シェアフィード'],
  sharesReels: ['シェアリール'],
  sharesStories: ['シェアストーリーズ'],
  sharesAds: ['シェア広告'],
  sharesOther: ['シェアその他'],
  replies: ['返信'],
  engagedAccounts: ['エンゲージメントしたアカウント'],
  profileVisitRate: ['プロフィールアクセス率'],
  profileVisits: ['プロフィールアクセス'],
  linkClicks: ['ウェブサイトをクリック'],
  callClicks: ['電話をクリック'],
  emailClicks: ['メールをクリック'],
  messageClicks: ['メッセージをクリック'],
  directionClicks: ['道順をクリック'],
  otherClicks: ['その他のクリック'],
};

const INSIGHT_DAILY_METRICS = Object.keys(INSIGHT_DAILY_COLS).filter((k) => k !== 'accountName' && k !== 'date');

// アカウント日次サマリー。「投稿数」は累計、「フォロー数」は自社がフォローしている数で、
// どちらも日々の増減ではない（Meta の書き出しの「フォロー数」＝新規フォロー数とは別物）
const SUMMARY_COLS = {
  date: ['日時', '日付', 'date', 'day'],
  postsTotal: ['投稿数', '投稿件数'],
  following: ['フォロー数', 'フォロー中'],
  followers: ['フォロワー数'],
};

const FOLLOWED_COLS = {
  userId: ['ユーザーid', 'userid'],
  username: ['ユーザーネーム', 'ユーザー名', 'username'],
  url: ['詳細url', 'url'],
  profile: ['プロフィール', 'bio'],
  hashtags: ['よく使用するハッシュタグ'],
  follows: ['フォロー数'],
  followers: ['フォロワー数'],
  posts: ['投稿数', '投稿件数'],
};

/** 値なしの表し方が「-」「''」「""」と揺れるため、まとめて空文字にする */
function clean(v) {
  const s = String(v ?? '').trim();
  return s === '-' || s === '–' || s === "''" || s === '""' ? '' : s;
}

const toNumber = (v) => {
  const s = clean(v).replace(/[,\s%％]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const PLATFORMS = /^(instagram|facebook|twitter|x|tiktok|youtube|line)$/i;
const ENCODINGS = /^(utf8|utf16|sjis|shiftjis)$/i;

/**
 * ファイル名から種類・アカウント名・期間を読む。
 * 例: si__accounts-posts_ミセルクリニック大阪_instagram_20251014-20261008_utf8.csv
 *     → { kind:'posts', label:'ミセルクリニック大阪', start:'2025-10-14', end:'2026-10-08' }
 * 名前を変えられていても読めるよう、分かった分だけ返す（種類の判定は列で行う）。
 */
export function parseSIFileName(fileName = '') {
  const base = String(fileName).replace(/\.[a-z0-9]+$/i, '');
  const out = { kind: null, label: '', start: null, end: null, fetchedAt: null };
  const kind = base.match(/(accounts|instagram_insights)-(posts|summary|hashtag_analysis|hashtag|followed|stories|tagged)/i);
  if (kind) {
    const insights = kind[1].toLowerCase() === 'instagram_insights';
    out.kind = {
      posts: insights ? 'insightPosts' : 'posts',
      summary: insights ? 'insightDaily' : 'summary',
      hashtag_analysis: 'hashtags',
      hashtag: 'hashtags',
      followed: 'followed',
      stories: 'stories',
      tagged: 'tagged',
    }[kind[2].toLowerCase()];
  }

  const period = base.match(/(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})/);
  if (period) {
    out.start = `${period[1]}-${period[2]}-${period[3]}`;
    out.end = `${period[4]}-${period[5]}-${period[6]}`;
  } else {
    // 取得日時（YYMMDDHHMMSS）。期間の無い書き出し（フォロー中アカウント一覧）に付く
    const stamp = base.match(/_(\d{2})(\d{2})(\d{2})\d{6}(?:_|$)/);
    if (stamp) out.fetchedAt = `20${stamp[1]}-${stamp[2]}-${stamp[3]}`;
  }

  const rest = kind ? base.slice(kind.index + kind[0].length) : base;
  out.label = rest
    .split('_')
    .filter((t) => t && !PLATFORMS.test(t) && !ENCODINGS.test(t) && !/^\d{4,}(-\d{4,})?$/.test(t))
    .join('_')
    .trim();
  return out;
}

function mapHeader(header, cols) {
  const map = {};
  (header || []).forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    for (const [key, list] of Object.entries(cols)) {
      if (map[key] === undefined && list.some((a) => norm(a) === n)) map[key] = i;
    }
  });
  return map;
}

/**
 * 先頭数行からヘッダー行を探す。required の列がそろった行を使う。
 * required の要素が配列なら「そのうち1つでもあればよい」の意味。
 */
function locate(rows, cols, required) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const col = mapHeader(rows[i], cols);
    if (required.every((keys) => [keys].flat().some((k) => col[k] !== undefined))) return { headerIdx: i, col };
  }
  return null;
}

/**
 * 列がずれた行を直す。
 * この書き出しは自由文の列（投稿の「内容」・アカウントの「プロフィール」）を引用符で囲まないため、
 * 本文に半角カンマが入っているとその行だけ列が増え、以降の数値列がずれてしまう。
 * 増えた分は自由文の列に戻す（数値列は行の後ろ側にそろっているので、これで元に戻る）。
 */
function alignRow(row, width, textCol) {
  if (textCol === undefined || row.length <= width) return row;
  const extra = row.length - width;
  return [...row.slice(0, textCol), row.slice(textCol, textCol + extra + 1).join(','), ...row.slice(textCol + extra + 1)];
}

/** パーマリンクの短縮コード。投稿を一意に識別できるので ID に使う */
export function shortcodeOf(url) {
  const m = String(url ?? '').match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : '';
}

/**
 * 投稿一覧を読む。この形式でなければ null。
 * 保存・シェア・リーチの列は無いため null のまま（エンゲージメントはいいね＋コメントで出る）。
 * 「フォロワー数」はその投稿時点の値なので、投稿に持たせたうえで日次データにも使う。
 */
export function readSIPosts(rows, meta = {}) {
  const found = locate(rows, POST_COLS, ['timestamp', 'likes', ['followers', 'er', 'likeScore']]);
  if (!found) return null;
  const { headerIdx, col } = found;
  const width = rows[headerIdx].length;
  const get = (r, key) => (col[key] === undefined ? undefined : r[col[key]]);
  const posts = [];
  rows.slice(headerIdx + 1).forEach((raw, i) => {
    const r = alignRow(raw, width, col.caption);
    const ts = parseDateTime(clean(get(r, 'timestamp')));
    if (!ts) return;
    const permalink = clean(get(r, 'permalink'));
    const code = shortcodeOf(permalink);
    posts.push({
      id: code ? `si:${code}` : `si_${ts.getTime()}_${i}`,
      timestamp: ts.toISOString(),
      type: clean(get(r, 'type')) || 'IMAGE',
      caption: clean(get(r, 'caption')),
      permalink,
      thumbnail: clean(get(r, 'thumbnail')),
      account: '',
      accountName: meta.label || '',
      duration: null,
      likes: toNumber(get(r, 'likes')),
      comments: toNumber(get(r, 'comments')),
      saves: null,
      shares: null,
      reach: null,
      nonFollowerReach: null,
      views: toNumber(get(r, 'views')),
      follows: null,
      // ここから下はソーシャルインサイト固有（Meta の書き出しには無い）
      followersAtPost: toNumber(get(r, 'followers')),
      erByFollowers: toNumber(get(r, 'er')), // フォロワー数を分母にしたエンゲージメント率（%）
      likeScore: toNumber(get(r, 'likeScore')),
      source: 'socialInsight',
    });
  });
  if (!posts.length) return null;
  return { posts, daily: dailyFromSIPosts(posts) };
}

/**
 * 投稿インサイト（Instagram 連携版）を読む。この形式でなければ null。
 * 投稿一覧（accounts-posts）には無いリーチ・保存・シェア・直フォローが入るため、
 * 同じ投稿を両方から取り込んでも足りない指標を補えるよう ID の付け方をそろえる。
 */
export function readSIInsightPosts(rows, meta = {}) {
  const found = locate(rows, INSIGHT_POST_COLS, ['timestamp', 'likes', ['reach', 'saveRate', 'follows', 'profileVisits', 'viewsScore']]);
  if (!found) return null;
  const { headerIdx, col } = found;
  const width = rows[headerIdx].length;
  const get = (r, key) => (col[key] === undefined ? undefined : r[col[key]]);
  const num = (r, key) => toNumber(get(r, key));
  const posts = [];
  rows.slice(headerIdx + 1).forEach((raw, i) => {
    const r = alignRow(raw, width, col.caption);
    const ts = parseDateTime(clean(get(r, 'timestamp')));
    if (!ts) return;
    const permalink = clean(get(r, 'permalink'));
    const code = shortcodeOf(permalink);
    const mediaId = clean(get(r, 'mediaId')).replace(/^ID:/i, '');
    posts.push({
      // 投稿一覧（accounts-posts）と同じ付け方にして、重複せずマージされるようにする
      id: code ? `si:${code}` : mediaId ? `si:${mediaId}` : `si_${ts.getTime()}_${i}`,
      mediaId,
      timestamp: ts.toISOString(),
      type: clean(get(r, 'type')) || 'IMAGE',
      caption: clean(get(r, 'caption')),
      permalink,
      thumbnail: clean(get(r, 'thumbnail')),
      account: clean(get(r, 'account')).replace(/^@/, ''),
      accountName: clean(get(r, 'accountName')) || meta.label || '',
      duration: null,
      likes: num(r, 'likes'),
      comments: num(r, 'comments'),
      saves: num(r, 'saves'),
      shares: num(r, 'shares'),
      reach: num(r, 'reach'),
      nonFollowerReach: null, // フォロワー／非フォロワーの内訳はこの書き出しには無い
      views: num(r, 'views'),
      follows: num(r, 'follows'), // 直フォロー（その投稿がきっかけのフォロー）
      // ここから下はソーシャルインサイト固有
      profileVisits: num(r, 'profileVisits'),
      reposts: num(r, 'reposts'),
      saveRate: num(r, 'saveRate'), // リーチに対する保存率（%）
      engagementReported: num(r, 'engagement'),
      erByViews: num(r, 'er'), // 閲覧数を分母にしたエンゲージメント率（%）
      avgWatchSec: num(r, 'avgWatch'),
      totalWatchSec: num(r, 'totalWatch'),
      skipRate: num(r, 'skipRate'),
      viewsIgFb: num(r, 'viewsIgFb'),
      viewsFb: num(r, 'viewsFb'),
      viewsScore: num(r, 'viewsScore'),
      source: 'socialInsight',
    });
  });
  return posts.length ? { posts, daily: [] } : null;
}

/**
 * 投稿時点のフォロワー数から日次データを作る。
 * 同じ日に複数の投稿があれば、その日の最後の投稿の値を使う。
 */
export function dailyFromSIPosts(posts = []) {
  const byDate = new Map();
  for (const p of posts) {
    if (p.followersAtPost === null || p.followersAtPost === undefined) continue;
    const date = jstDateKey(p.timestamp);
    const prev = byDate.get(date);
    if (!prev || prev.timestamp <= p.timestamp) byDate.set(date, { timestamp: p.timestamp, followers: p.followersAtPost });
  }
  return [...byDate.entries()]
    .map(([date, v]) => ({ ...emptyDailyRow(date), followers: v.followers }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * アカウント日次サマリー（日時・投稿数・フォロー数・フォロワー数）。この形式でなければ null。
 * フォロワー数だけが日次データの指標（followers）になる。
 * 「投稿数」は累計の投稿数、「フォロー数」は自社がフォローしている数なので、
 * Meta の書き出しの「フォロー数（＝その日の新規フォロー数）」と混同しないよう別に持つ。
 * 日々の純増減は、フォロワー数の前日差から自動で出る（analytics.normalizeDaily）。
 */
export function readSISummary(rows, meta = {}) {
  // 4列そろって初めてこの形式と見なす（自作の日次 CSV を取り違えないため）
  const found = locate(rows, SUMMARY_COLS, ['date', 'followers', 'postsTotal', 'following']);
  if (!found) return null;
  const { headerIdx, col } = found;
  const summary = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const d = parseDateTime(clean(r[col.date]));
    if (!d) continue;
    const followers = toNumber(r[col.followers]);
    if (followers === null) continue;
    summary.push({
      date: jstDateKey(d),
      account: meta.label || '',
      followers,
      postsTotal: toNumber(r[col.postsTotal]), // 累計の投稿数
      following: toNumber(r[col.following]), // 自社がフォローしている数
    });
  }
  if (!summary.length) return null;
  const daily = summary.map((s) => ({ ...emptyDailyRow(s.date), followers: s.followers }));
  return { summary, daily };
}

/**
 * 日次アカウントインサイト（Instagram 連携版）を読む。この形式でなければ null。
 * 日次データの指標をほぼすべて実測で埋められる（リーチのフォロワー以外の内訳も実数で入るため、
 * 比率からの推定が不要になる）。面（フィード／リール／ストーリーズ）別の内訳は別に保持する。
 */
export function readSIInsightDaily(rows, meta = {}) {
  // 「フォロワー増加数」はこの書き出しだけの列。アカウント日次サマリーと取り違えないよう必須にする
  const found = locate(rows, INSIGHT_DAILY_COLS, ['date', 'followers', ['follows', 'nonFollowerReach', 'engagedAccounts']]);
  if (!found) return null;
  const { headerIdx, col } = found;
  const num = (r, key) => (col[key] === undefined ? null : toNumber(r[col[key]]));
  const summary = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const d = parseDateTime(clean(r[col.date]));
    if (!d) continue;
    const accountName = clean(col.accountName === undefined ? '' : r[col.accountName]);
    const row = { date: jstDateKey(d), account: meta.label || accountName, accountName, source: 'insights' };
    for (const key of INSIGHT_DAILY_METRICS) row[key] = num(r, key);
    summary.push(row);
  }
  if (!summary.length) return null;

  // アプリの日次指標に移す（純増減は フォロワー増加数 − 減少数 から後で計算される）
  const daily = summary.map((s) => ({
    ...emptyDailyRow(s.date),
    followers: s.followers,
    follows: s.follows,
    unfollows: s.unfollows,
    reach: s.reach,
    nonFollowerReach: s.nonFollowerReach, // 実測値。比率からの推定は不要になる
    views: s.views,
    profileVisits: s.profileVisits,
    linkClicks: s.linkClicks,
    interactions: s.interactions,
    engagedAccounts: s.engagedAccounts,
  }));
  return { summary, daily };
}

/**
 * ストーリーズのインサイトを読む。この形式でなければ null。
 * 投稿（フィード・リール）とは指標が違うため、posts には混ぜず別に保持する。
 */
export function readSIStories(rows, meta = {}) {
  const found = locate(rows, STORY_COLS, ['timestamp', ['viewRate', 'exits', 'tapsForward', 'swipeForward']]);
  if (!found) return null;
  const { headerIdx, col } = found;
  const width = rows[headerIdx].length;
  const get = (r, key) => (col[key] === undefined ? undefined : r[col[key]]);
  const num = (r, key) => toNumber(get(r, key));
  const out = [];
  rows.slice(headerIdx + 1).forEach((raw, i) => {
    const r = alignRow(raw, width, col.caption);
    const ts = parseDateTime(clean(get(r, 'timestamp')));
    if (!ts) return;
    const storyId = clean(get(r, 'storyId')).replace(/^ID:/i, '');
    const rawType = clean(get(r, 'type'));
    out.push({
      id: storyId ? `si:story:${storyId}` : `si_story_${ts.getTime()}_${i}`,
      storyId,
      timestamp: ts.toISOString(),
      type: /動画|video|reel/i.test(rawType) ? 'VIDEO' : 'IMAGE',
      caption: clean(get(r, 'caption')),
      permalink: clean(get(r, 'permalink')),
      thumbnail: clean(get(r, 'thumbnail')),
      account: clean(get(r, 'account')).replace(/^@/, ''),
      accountName: clean(get(r, 'accountName')) || meta.label || '',
      views: num(r, 'views'),
      viewRate: num(r, 'viewRate'), // フォロワー数に対する閲覧率（%）
      reach: num(r, 'reach'),
      replies: num(r, 'replies'),
      shares: num(r, 'shares'),
      engagement: num(r, 'engagement'),
      follows: num(r, 'follows'),
      profileVisits: num(r, 'profileVisits'),
      exits: num(r, 'exits'),
      tapsForward: num(r, 'tapsForward'),
      tapsBack: num(r, 'tapsBack'),
      swipeForward: num(r, 'swipeForward'),
      linkClicks: num(r, 'linkClicks'),
      source: 'socialInsight',
    });
  });
  return out.length ? out : null;
}

/**
 * タグ付けされた投稿（他アカウントの投稿）を読む。この形式でなければ null。
 * 自社の投稿ではないので posts には入れず、別に保持する。
 */
export function readSITagged(rows, meta = {}) {
  const found = locate(rows, TAGGED_COLS, ['timestamp', 'likes', 'account', ['mediaId', 'permalink']]);
  if (!found) return null;
  const { headerIdx, col } = found;
  const width = rows[headerIdx].length;
  const get = (r, key) => (col[key] === undefined ? undefined : r[col[key]]);
  const out = [];
  rows.slice(headerIdx + 1).forEach((raw, i) => {
    const r = alignRow(raw, width, col.caption);
    const ts = parseDateTime(clean(get(r, 'timestamp')));
    if (!ts) return;
    const permalink = clean(get(r, 'permalink'));
    const code = shortcodeOf(permalink);
    const mediaId = clean(get(r, 'mediaId')).replace(/^ID:/i, '');
    out.push({
      id: code ? `si:${code}` : mediaId ? `si:${mediaId}` : `si_tagged_${ts.getTime()}_${i}`,
      mediaId,
      timestamp: ts.toISOString(),
      type: clean(get(r, 'type')) || 'IMAGE',
      caption: clean(get(r, 'caption')),
      permalink,
      thumbnail: clean(get(r, 'thumbnail')),
      account: clean(get(r, 'account')).replace(/^@/, ''), // 投稿した側のアカウント
      likes: toNumber(get(r, 'likes')),
      comments: toNumber(get(r, 'comments')),
      owner: meta.label || '', // タグ付けされた側（自社）
      source: 'socialInsight',
    });
  });
  return out.length ? out : null;
}

/**
 * ハッシュタグ分析（タグごとの集計）。この形式でなければ null。
 * 閲覧数・リーチの列があればインサイト版（エンゲージメント率は閲覧数基準）、
 * 無ければアカウント版（フォロワー基準）として、分母の違いを erBasis に残す。
 */
export function readSIHashtags(rows, meta = {}) {
  const found = locate(rows, HASHTAG_COLS, ['tag', ['posts', 'likesTotal']]);
  if (!found) return null;
  const { headerIdx, col } = found;
  const insights = col.viewsTotal !== undefined || col.reachTotal !== undefined;
  const num = (r, key) => (col[key] === undefined ? null : toNumber(r[col[key]]));
  const out = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const tag = clean(r[col.tag]).replace(/^#/, '');
    if (!tag) continue;
    const row = {
      tag,
      account: meta.label || '',
      source: insights ? 'insights' : 'accounts',
      erBasis: insights ? 'views' : 'followers',
      start: meta.start || null,
      end: meta.end || null,
    };
    for (const key of HASHTAG_METRICS) row[key] = num(r, key);
    out.push(row);
  }
  return out.length ? out : null;
}

/** フォロー中アカウント一覧（自社アカウントがフォローしている先）。この形式でなければ null */
export function readSIFollowed(rows, meta = {}) {
  const found = locate(rows, FOLLOWED_COLS, ['username', ['followers', 'follows'], ['userId', 'url']]);
  if (!found) return null;
  const { headerIdx, col } = found;
  const width = rows[headerIdx].length;
  const str = (r, key) => clean(col[key] === undefined ? '' : r[col[key]]);
  const num = (r, key) => (col[key] === undefined ? null : toNumber(r[col[key]]));
  const out = [];
  for (const raw of rows.slice(headerIdx + 1)) {
    const r = alignRow(raw, width, col.profile);
    const username = str(r, 'username').replace(/^@/, '');
    if (!username) continue;
    out.push({
      username,
      userId: str(r, 'userId').replace(/^ID:/i, ''),
      url: str(r, 'url'),
      profile: str(r, 'profile'),
      hashtags: str(r, 'hashtags')
        .split(/\s+/)
        .filter((t) => t.startsWith('#'))
        .map((t) => t.slice(1)),
      follows: num(r, 'follows'),
      followers: num(r, 'followers'),
      posts: num(r, 'posts'),
      owner: meta.label || '',
      fetchedAt: meta.fetchedAt || meta.end || null,
    });
  }
  return out.length ? out : null;
}

/**
 * ソーシャルインサイトの CSV を読む。他のツールの書き出しなら null を返すので、
 * 取り込みでは Meta の CSV（importCSV）より先に試す。
 * @param {string[][]} rows parseCSV の結果
 * @param {{fileName?: string}} [opts] ファイル名からアカウント名・期間を読む
 * @returns {null|{kind:'posts'|'hashtags'|'followed', label:string, start:?string, end:?string, posts:object[], daily:object[], hashtags:object[], followed:object[]}}
 */
export function readSocialInsight(rows, { fileName = '' } = {}) {
  if (!rows?.length) return null;
  const meta = parseSIFileName(fileName);
  const base = {
    label: meta.label, start: meta.start, end: meta.end, fetchedAt: meta.fetchedAt,
    posts: [], daily: [], summary: [], hashtags: [], followed: [], stories: [], tagged: [],
  };

  // 日次インサイト（フォロワー増加数などの列がある）を、アカウント日次サマリーより先に見る
  const insightDaily = readSIInsightDaily(rows, meta);
  if (insightDaily) return { ...base, kind: 'insightDaily', summary: insightDaily.summary, daily: insightDaily.daily };

  // 投稿インサイト（リーチ・保存などの列がある）を、投稿一覧より先に見る
  const insightPosts = readSIInsightPosts(rows, meta);
  if (insightPosts) return { ...base, kind: 'insightPosts', posts: insightPosts.posts };

  const stories = readSIStories(rows, meta);
  if (stories) return { ...base, kind: 'stories', stories };

  const posts = readSIPosts(rows, meta);
  if (posts) return { ...base, kind: 'posts', posts: posts.posts, daily: posts.daily };

  const summary = readSISummary(rows, meta);
  if (summary) return { ...base, kind: 'summary', summary: summary.summary, daily: summary.daily };

  const hashtags = readSIHashtags(rows, meta);
  if (hashtags) return { ...base, kind: 'hashtags', source: hashtags[0].source, hashtags };

  const followed = readSIFollowed(rows, meta);
  if (followed) return { ...base, kind: 'followed', followed };

  // 列の少ないタグ付き投稿は最後に見る（指標の多い書き出しを先に判定させる）
  const tagged = readSITagged(rows, meta);
  if (tagged) return { ...base, kind: 'tagged', tagged };

  return null;
}

const blank = (v) => v === null || v === undefined || v === '';

/**
 * 同じものを指標の違うファイルから取り込んでもデータが欠けないよう、
 * キーが同じ行は項目単位でマージする（新しい方に値が無い項目は前の値を残す）。
 */
function mergeRows(oldRows, newRows, keyOf, compare) {
  const map = new Map((oldRows || []).map((r) => [keyOf(r), r]));
  for (const r of newRows || []) {
    const key = keyOf(r);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, r);
      continue;
    }
    const merged = { ...prev, ...r };
    for (const [k, v] of Object.entries(r)) if (blank(v) && !blank(prev[k])) merged[k] = prev[k];
    map.set(key, merged);
  }
  return [...map.values()].sort(compare);
}

/**
 * 同じアカウント・同じ書き出し・同じ期間・同じタグは新しい方で上書き。
 * 集計期間ごとの値で、書き出しによってエンゲージメント率の分母も違うため、
 * 期間や書き出しの種類が違えば別の行として残す（期間の新しい順・件数の多い順）。
 */
export function mergeHashtags(oldRows = [], newRows = []) {
  // 期間（終了日→開始日）の新しい順に集計期間をまとめ、その中では件数の多い順
  return mergeRows(
    oldRows,
    newRows,
    (r) => `${r.account || ''}|${r.source || 'accounts'}|${r.start || ''}|${r.end || ''}|${r.tag}`,
    (a, b) => String(b.end || '').localeCompare(String(a.end || ''))
      || String(b.start || '').localeCompare(String(a.start || ''))
      || (b.posts ?? 0) - (a.posts ?? 0)
      || a.tag.localeCompare(b.tag),
  );
}

/**
 * アカウント日次を日付単位でマージ。
 * 同じ日をアカウント日次サマリーと日次インサイトの両方から取り込んでも、
 * 片方にしか無い項目（累計投稿数・面別の内訳など）は残る。
 */
export function mergeSummary(oldRows = [], newRows = []) {
  return mergeRows(
    oldRows,
    newRows,
    (r) => `${r.account || ''}|${r.date}`,
    (a, b) => a.date.localeCompare(b.date) || String(a.account).localeCompare(String(b.account)),
  );
}

/** 同じアカウントは新しい方で上書き。フォロワーの多い順に並べる */
export function mergeFollowed(oldRows = [], newRows = []) {
  return mergeRows(
    oldRows,
    newRows,
    (r) => r.userId || r.username,
    (a, b) => (b.followers ?? 0) - (a.followers ?? 0) || a.username.localeCompare(b.username),
  );
}

/** ストーリーズを ID 単位でマージ（投稿日時の順に並べる） */
export function mergeStories(oldRows = [], newRows = []) {
  return mergeRows(oldRows, newRows, (r) => r.id, (a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** タグ付き投稿を ID 単位でマージ（投稿日時の順に並べる） */
export function mergeTagged(oldRows = [], newRows = []) {
  return mergeRows(oldRows, newRows, (r) => r.id, (a, b) => a.timestamp.localeCompare(b.timestamp));
}

const KIND_LABELS = {
  posts: '投稿一覧',
  insightPosts: '投稿インサイト',
  summary: 'アカウント日次',
  insightDaily: '日次インサイト',
  stories: 'ストーリーズ',
  tagged: 'タグ付き投稿',
  hashtags: 'ハッシュタグ分析',
  followed: 'フォロー中アカウント',
};

/** 取り込み結果を日本語1行で説明する（画面の状態表示用） */
export function describeSocialInsight(res) {
  if (!res) return '';
  const counts = [];
  if (res.posts.length) counts.push(`投稿 ${res.posts.length}件`);
  if (res.stories?.length) counts.push(`ストーリーズ ${res.stories.length}件`);
  if (res.tagged?.length) counts.push(`タグ付き投稿 ${res.tagged.length}件`);
  if (res.daily.length) counts.push(res.kind === 'insightDaily' ? `日次 ${res.daily.length}日分` : `フォロワー数 ${res.daily.length}日分`);
  if (res.hashtags.length) counts.push(`ハッシュタグ ${res.hashtags.length}件`);
  if (res.followed.length) counts.push(`フォロー中 ${res.followed.length}件`);
  const period = res.start && res.end ? `（${res.start.replaceAll('-', '/')}〜${res.end.replaceAll('-', '/')}）` : '';
  const kindLabel = KIND_LABELS[res.kind] ? `／${KIND_LABELS[res.kind]}${res.kind === 'hashtags' && res.source === 'insights' ? '（インサイト）' : ''}` : '';
  const head = `ソーシャルインサイト${kindLabel}`;
  return [head, counts.join(' / '), period].filter(Boolean).join(' ');
}
