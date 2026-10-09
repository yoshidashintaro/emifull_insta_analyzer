// 画面の集計結果（compute() の戻り値）を、1ファイルのレポートにまとめる。
// 出力形式に依存しない「見出し・段落・箇条書き・表」の並びを作り、Markdown と Word はそこから組み立てる。
// DOM にも Chart.js にも依存しない（Node のテストからも読み込む）。
import { WEEKDAYS, TYPE_LABELS, METRICS, DAILY_FIELDS, DAILY_LABELS, weeklyER, topPosts, bestSlots, parseDateKey, formatJST } from './analytics.js';
import { DRIVERS, TARGETS, describeEstimate } from './traffic.js';

const fmtInt = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : Math.round(v).toLocaleString('ja-JP'));
const fmtPct = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v.toFixed(d)}%`);
const fmtNum = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d));
const fmtSigned = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '–' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d));
const fmtDate = (key) => (key ? key.replaceAll('-', '/') : '–');
// 日時は日本時間で表示する（例: 2026-09-30T09:02:09.000Z → 2026/09/30 18:02）
const fmtDateTime = (iso) => formatJST(iso, 'short');
const oneLine = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t || '（キャプションなし）';
};

/** 前期間との増減を「+12人（+3.4%）」の形に */
function change(cur, prev, { unit = '', digits = 0, pct = true } = {}) {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return '–';
  const diff = cur - prev;
  const body = `${diff >= 0 ? '+' : '−'}${digits ? Math.abs(diff).toFixed(digits) : Math.round(Math.abs(diff)).toLocaleString('ja-JP')}${unit}`;
  return pct && prev ? `${body}（${diff >= 0 ? '+' : '−'}${Math.abs((diff / prev) * 100).toFixed(1)}%）` : body;
}

/** 相関の読み方を一言で（画面の相関表と同じ文言） */
export function readCorrelation(c) {
  if (c.r === null) return 'データ不足';
  const dir = c.r > 0 ? '増えると増える' : '増えると減る';
  if (!c.significant) return `${c.strength}（偶然の範囲）`;
  const shrink = c.partial !== null && c.partial !== undefined && Math.abs(c.partial) < Math.abs(c.r) * 0.7;
  return shrink ? `${dir}が、時期の影響が大きい` : `${dir}（有意）`;
}

const LEVELS = { good: '好調', warn: '要注意', info: '参考' };
const SOURCES = { demo: 'デモデータ', csv: 'CSV 取り込み', api: 'Instagram API' };

/**
 * レポートの中身を組み立てる。
 * @param v        compute() の戻り値
 * @param ctx      { dataset, settings, warnings, generatedAt }
 * @returns        { title, fileBase, blocks: [{type:'h',level,text} | {type:'p',text} | {type:'list',items} | {type:'table',head,rows,align}] }
 */
export function buildReport(v, { dataset = {}, settings = {}, warnings = [], generatedAt = new Date() } = {}) {
  const blocks = [];
  const h = (level, text) => blocks.push({ type: 'h', level, text });
  const p = (text) => text && blocks.push({ type: 'p', text });
  const list = (items) => items.length && blocks.push({ type: 'list', items });
  /** align: 各列の 'l' / 'r'。省略時は1列目だけ左、残りは右 */
  const table = (head, rows, align) => {
    if (!rows.length) return;
    blocks.push({ type: 'table', head, rows: rows.map((r) => r.map((c) => (c === null || c === undefined ? '–' : String(c)))), align: align || head.map((_, i) => (i ? 'r' : 'l')) });
  };

  const s = v.summary;
  const prev = v.prevSummary;
  const days = Math.round((parseDateKey(v.endKey) - parseDateKey(v.startKey)) / 86400000) + 1;
  const names = dataset.account?.username ? [dataset.account.username] : v.accounts.map((a) => a.username);

  // ---------- 表紙情報 ----------
  h(1, 'Instagram インサイト分析レポート');
  table(
    ['項目', '内容'],
    [
      ['アカウント', names.length ? names.map((n) => `@${n}`).join(' / ') : '–'],
      ['絞り込み', v.account ? `@${v.account} の投稿のみ` : 'すべてのアカウント'],
      ['対象期間', `${fmtDate(v.startKey)} 〜 ${fmtDate(v.endKey)}（${days}日間）`],
      ['比較対象', prev ? '直前の同じ日数' : 'なし'],
      ['ER の計算基準', settings.basis === 'followers' ? 'フォロワー基準（反応数 ÷ 投稿時点のフォロワー数）' : 'リーチ基準（反応数 ÷ リーチ）'],
      ['データの出どころ', SOURCES[dataset.source] || '–'],
      ['データ更新日時', dataset.fetchedAt ? fmtDateTime(dataset.fetchedAt) : '–'],
      ['レポート作成日時', fmtDateTime(generatedAt.toISOString())],
    ],
    ['l', 'l'],
  );

  if (warnings.length) {
    h(2, 'データについての注意');
    list(warnings);
  }

  // ---------- 主要指標 ----------
  h(2, '主要指標');
  const pt = prev?.totals || {};
  const kpi = [
    ['フォロワー数（期間末）', fmtInt(s.followers), prev ? fmtInt(prev.followers) : '–', s.followerChange === null ? '–' : `期間中 ${change(s.followers, s.followers - s.followerChange, { unit: '人' })}`],
    ['平均エンゲージメント率', fmtPct(s.avgER), prev ? fmtPct(prev.avgER) : '–', prev ? change(s.avgER, prev.avgER, { unit: 'pt', digits: 2, pct: false }) : '–'],
    ['ER の中央値', fmtPct(s.medianER), prev ? fmtPct(prev.medianER) : '–', prev ? change(s.medianER, prev.medianER, { unit: 'pt', digits: 2, pct: false }) : '–'],
    ['投稿数', fmtInt(s.postCount), prev ? fmtInt(prev.postCount) : '–', prev ? change(s.postCount, prev.postCount, { unit: '件' }) : '–'],
    ['平均リーチ／投稿', fmtInt(s.avgReach), prev ? fmtInt(prev.avgReach) : '–', prev ? change(s.avgReach, prev.avgReach) : '–'],
    ...(s.avgNonFollowerReach === null ? [] : [[v.posts.some((x) => x.nonFollowerEstimated) ? '  うち非フォロワーの平均リーチ（推定）' : '  うち非フォロワーの平均リーチ', `${fmtInt(s.avgNonFollowerReach)}${s.nonFollowerShare === null ? '' : `（${s.nonFollowerShare.toFixed(0)}%）`}`, prev ? fmtInt(prev.avgNonFollowerReach) : '–', prev ? change(s.avgNonFollowerReach, prev.avgNonFollowerReach) : '–']]),
    ['平均反応数／投稿', fmtNum(s.avgInteractions), prev ? fmtNum(prev.avgInteractions) : '–', prev ? change(s.avgInteractions, prev.avgInteractions, { digits: 1 }) : '–'],
    ['反応数合計', fmtInt(s.totalInteractions), prev ? fmtInt(prev.totalInteractions) : '–', prev ? change(s.totalInteractions, prev.totalInteractions) : '–'],
    ['フォロワーが減った日数', s.lossDays ? `${s.lossDays}日` : '0日', prev ? `${prev.lossDays}日` : '–', '–'],
  ];
  for (const k of DAILY_FIELDS) {
    if (k === 'followers' || k === 'netChange' || s.totals[k] === null || s.totals[k] === undefined) continue;
    kpi.push([`${DAILY_LABELS[k]}（日次合計）`, fmtInt(s.totals[k]), prev ? fmtInt(pt[k]) : '–', prev ? change(s.totals[k], pt[k]) : '–']);
  }
  // Instagram から HP への流入（GA4）
  if (v.hp) {
    const hp = v.hp;
    const ph = v.prevHp;
    kpi.push(
      ['HP流入数（UU数）', fmtInt(hp.users), ph ? fmtInt(ph.users) : '–', ph ? change(hp.users, ph.users) : '–'],
      ['HPアクセス数（セッション数）', fmtInt(hp.sessions), ph ? fmtInt(ph.sessions) : '–', ph ? change(hp.sessions, ph.sessions) : '–'],
      ['HP新規ユーザー数', fmtInt(hp.newUsers), ph ? fmtInt(ph.newUsers) : '–', ph ? change(hp.newUsers, ph.newUsers) : '–'],
      ['HP新規率（新規 ÷ ユーザー）', fmtPct(hp.newUserRate), ph ? fmtPct(ph.newUserRate) : '–', ph ? change(hp.newUserRate, ph.newUserRate, { unit: 'pt', digits: 2, pct: false }) : '–'],
      ['HPエンゲージメント率', fmtPct(hp.engagementRate), ph ? fmtPct(ph.engagementRate) : '–', ph ? change(hp.engagementRate, ph.engagementRate, { unit: 'pt', digits: 2, pct: false }) : '–'],
      ['予約完了数（CV数）', fmtInt(hp.cv), ph ? fmtInt(ph.cv) : '–', ph ? change(hp.cv, ph.cv) : '–'],
      ['CVR（CV ÷ セッション）', fmtPct(hp.cvr), ph ? fmtPct(ph.cvr) : '–', ph ? change(hp.cvr, ph.cvr, { unit: 'pt', digits: 2, pct: false }) : '–'],
    );
  }
  table(['指標', 'この期間', '前期間', '増減'], kpi);

  // ---------- 自動分析 ----------
  h(2, '自動分析レポート');
  const insights = [...v.insights, ...(v.traffic?.insights || [])];
  if (insights.length) list(insights.map((i) => `【${LEVELS[i.level] || i.level}】${i.title}：${i.text}`));
  else p('データが少ないため分析できません。期間を広げてください。');

  // ---------- フォロワー・日次 ----------
  h(2, 'フォロワーの増減とアカウントの活動');
  const mode = v.followerMode;
  if (s.followerChange !== null) {
    p(
      `期間中のフォロワー数の変化は ${change(s.followers, s.followers - s.followerChange, { unit: '人' })} です。` +
        (mode === 'gains' ? '（純増減ではなく新規フォロー数からの推定値です）' : ''),
    );
  }
  if (v.steps.length >= 2) {
    h(3, '予約までの導線（期間合計）');
    table(
      ['段階', '期間合計', '通過率', '基準'],
      v.steps.map((st) => [st.label, fmtInt(st.value), st.rate === null ? '–' : fmtPct(st.rate, st.rate < 10 ? 2 : 1), st.from || '–']),
      ['l', 'r', 'r', 'l'],
    );
  }
  const dailyCols = DAILY_FIELDS.filter((k) => v.daily.some((d) => d[k] !== null && d[k] !== undefined));
  if (dailyCols.length) {
    h(3, '日次データ');
    table(
      ['日付', ...dailyCols.map((k) => (k === 'netChange' && mode === 'gains' ? '新規フォロー' : DAILY_LABELS[k]))],
      v.daily.map((d) => [fmtDate(d.date), ...dailyCols.map((k) => (k === 'netChange' && d[k] !== null ? fmtSigned(d[k], 0) : fmtInt(d[k])))]),
    );
  }

  // ---------- 面別の内訳（日次インサイトがあるとき） ----------
  const si = v.si || {};
  if (si.surfaces?.length) {
    h(3, 'どこで見られているか（面別・期間合計）');
    table(
      ['面', '閲覧数', 'リーチ', 'エンゲージメント'],
      si.surfaces.map((x) => [x.label, fmtInt(x.values.views), fmtInt(x.values.reach), fmtInt(x.values.interactions)]),
    );
    const ads = si.surfaces.find((x) => x.key === 'ads')?.values.views ?? 0;
    const all = si.surfaces.reduce((acc, x) => acc + (x.values.views ?? 0), 0);
    if (ads && all) p(`閲覧数のうち ${fmtPct((ads / all) * 100, 0)} は広告からの配信です。投稿そのものの実力はフィード・リールの数字で判断してください。`);
  }
  if (si.totals?.nonFollowerReach !== null && si.totals?.nonFollowerReach !== undefined) {
    h(3, 'リーチの内訳と転換率（実測値）');
    table(
      ['項目', '値'],
      [
        ['リーチ（期間合計）', fmtInt(si.totals.reach)],
        ['うちフォロワー', fmtInt(si.totals.followerReach)],
        ['うちフォロワー以外', fmtInt(si.totals.nonFollowerReach)],
        ['フォロワー以外の割合', fmtPct(si.totals.nonFollowerShare, 1)],
        ['プロフィールアクセス', fmtInt(si.totals.profileVisits)],
        ['新規フォロー', fmtInt(si.totals.follows)],
        ['フォロワー転換率', fmtPct(si.totals.conversionRate, 1)],
      ],
      ['l', 'r'],
    );
  }
  if (si.clicks?.length) {
    h(3, 'プロフィールからのアクション（期間合計）');
    table(['種類', '件数'], si.clicks.map((c) => [c.label, fmtInt(c.value)]), ['l', 'r']);
  }

  // ---------- ストーリーズ ----------
  if (si.stories?.length) {
    const st = si.storiesSummary;
    h(2, 'ストーリーズ');
    p(`${st.days}日間で ${fmtInt(st.n)}本（1日あたり ${fmtNum(st.perDay)}本）。投稿（フィード・リール）とは指標が違うため、閲覧率と離脱率で評価します。`);
    table(
      ['項目', '値'],
      [
        ['閲覧数（合計）', fmtInt(st.views)],
        ['平均閲覧数／本', fmtInt(st.viewsMean)],
        ['平均閲覧率（フォロワーに対する）', fmtPct(st.viewRate, 2)],
        ['リーチ（合計）', fmtInt(st.reach)],
        ['離脱率', fmtPct(st.exitRate, 1)],
        ['次へ送った率', fmtPct(st.nextRate, 1)],
        ['戻って見直した率', fmtPct(st.backRate, 1)],
        ['返信', fmtInt(st.replies)],
        ['フォロー（ストーリーズ経由）', fmtInt(st.follows)],
        ['プロフィール遷移', fmtInt(st.profileVisits)],
        ['リンククリック', fmtInt(st.linkClicks)],
      ],
      ['l', 'r'],
    );
    const hours = (si.storiesHours || []).filter((x) => x.n >= 2 && x.viewRate !== null).sort((a, b) => b.viewRate - a.viewRate);
    if (hours.length) {
      h(3, '投稿した時間帯別 平均閲覧率（2本以上ある時間帯）');
      table(['時間帯', '本数', '平均閲覧率'], hours.map((x) => [`${x.hour}時台`, fmtInt(x.n), fmtPct(x.viewRate, 2)]));
    }
    h(3, `ストーリーズ一覧（${si.stories.length}本・新しい順）`);
    table(
      ['投稿日時', '種別', '閲覧', '閲覧率', 'リーチ', '離脱', '次へ', '返信', 'フォロー', 'リンク'],
      [...si.stories].reverse().slice(0, 200).map((x) => [
        fmtDateTime(x.timestamp), x.type === 'VIDEO' ? '動画' : '画像',
        fmtInt(x.views), fmtPct(x.viewRate, 2), fmtInt(x.reach), fmtInt(x.exits), fmtInt(x.tapsForward),
        fmtInt(x.replies), fmtInt(x.follows), fmtInt(x.linkClicks),
      ]),
    );
  }

  // ---------- エンゲージメント ----------
  h(2, 'エンゲージメント率');
  p(
    settings.basis === 'followers'
      ? 'ER ＝（いいね＋コメント＋保存＋シェア）÷ 投稿時点のフォロワー数 × 100'
      : 'ER ＝（いいね＋コメント＋保存＋シェア）÷ リーチ × 100',
  );
  if (v.types.length) {
    h(3, '投稿タイプ別');
    table(
      ['タイプ', '投稿数', '平均ER', '平均リーチ', '平均反応数', '平均保存'],
      v.types.map((t) => [t.label, fmtInt(t.n), fmtPct(t.er), fmtInt(t.reach), fmtNum(t.interactions), fmtNum(t.saves)]),
    );
  }
  const weekly = weeklyER(v.posts);
  if (weekly.length) {
    h(3, '週ごとの平均ER（週の初日＝月曜）');
    table(['週', '投稿数', '平均ER'], weekly.map((w) => [fmtDate(w.week), fmtInt(w.n), fmtPct(w.er)]));
  }

  // ---------- アカウント別 ----------
  if (!v.account && v.accountStats.length > 1) {
    h(2, 'アカウント別の成績');
    table(
      ['アカウント', '投稿数', '平均ER', '平均リーチ', '平均ビュー', '平均反応数', 'フォロー'],
      v.accountStats.map((a) => [`@${a.username}`, fmtInt(a.n), fmtPct(a.er), fmtInt(a.reach), fmtInt(a.views), fmtNum(a.interactions), fmtInt(a.follows)]),
    );
  }

  // ---------- 投稿 ----------
  h(2, '投稿ごとの反応');
  const metricKey = METRICS[settings.topMetric] ? settings.topMetric : 'er';
  for (const key of [...new Set(['er', metricKey])]) {
    const m = METRICS[key];
    const top = topPosts(v.posts, key, 10);
    if (!top.length) continue;
    h(3, `上位10投稿（${m.label}順）`);
    table(
      ['順位', '投稿日時', 'タイプ', '内容', m.label, 'リーチ', '反応計', 'ER'],
      top.map((x, i) => [
        String(i + 1), fmtDateTime(x.timestamp), TYPE_LABELS[x.type], oneLine(x.caption, 40),
        m.unit === '%' ? fmtPct(m.get(x)) : fmtInt(m.get(x)), fmtInt(x.reach), fmtInt(x.interactions), fmtPct(x.er),
      ]),
      ['r', 'l', 'l', 'l', 'r', 'r', 'r', 'r'],
    );
  }
  if (v.posts.length) {
    h(3, `全投稿一覧（${v.posts.length}件・新しい順）`);
    const hasViews = v.posts.some((x) => x.views !== null);
    const hasNonF = v.posts.some((x) => x.nonFollowerReach !== null && x.nonFollowerReach !== undefined);
    const hasFollows = v.posts.some((x) => x.follows !== null);
    const multi = !v.account && v.accounts.length > 1;
    const head = ['投稿日時', ...(multi ? ['アカウント'] : []), 'タイプ', '内容', ...(hasViews ? ['ビュー'] : []), 'リーチ', ...(hasNonF ? [v.posts.some((x) => x.nonFollowerEstimated) ? '非フォロワー（≈は推定）' : '非フォロワー'] : []), 'いいね', 'コメント', '保存', 'シェア', ...(hasFollows ? ['フォロー'] : []), '反応計', 'ER', 'URL'];
    const sorted = [...v.posts].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    table(
      head,
      sorted.map((x) => [
        fmtDateTime(x.timestamp), ...(multi ? [x.account ? `@${x.account}` : '–'] : []), TYPE_LABELS[x.type], oneLine(x.caption, 60),
        ...(hasViews ? [fmtInt(x.views)] : []), fmtInt(x.reach), ...(hasNonF ? [x.nonFollowerEstimated ? `≈${fmtInt(x.nonFollowerReach)}` : fmtInt(x.nonFollowerReach)] : []), fmtInt(x.likes), fmtInt(x.comments), fmtInt(x.saves), fmtInt(x.shares),
        ...(hasFollows ? [fmtInt(x.follows)] : []), fmtInt(x.interactions), fmtPct(x.er), x.permalink || '–',
      ]),
      head.map((c) => (['投稿日時', 'アカウント', 'タイプ', '内容', 'URL'].includes(c) ? 'l' : 'r')),
    );
  }

  // ---------- 投稿時間帯 ----------
  h(2, '最適な投稿時間帯');
  p('投稿した曜日・時間帯（日本時間）ごとの平均 ER です。投稿数の少ない枠は全体平均に寄せた補正スコア（ベイズ平均）で評価しています。');
  const slots = bestSlots(v.heatmap, { top: 5 });
  h(3, 'おすすめの投稿枠（2投稿以上ある枠から算出）');
  if (slots.length) {
    table(
      ['順位', '曜日・時間帯', '投稿数', '平均ER', '全体平均比'],
      slots.map((c, i) => [String(i + 1), `${WEEKDAYS[c.weekday]}曜 ${c.startHour}:00〜${c.endHour}:00`, fmtInt(c.n), fmtPct(c.mean), v.heatmap.overall ? `${fmtSigned((c.mean / v.heatmap.overall - 1) * 100, 0)}%` : '–']),
      ['r', 'l', 'r', 'r', 'r'],
    );
  } else p('同じ曜日・時間帯に2件以上の投稿がまだありません。');
  const cells = v.heatmap.cells.filter((c) => c.n);
  if (cells.length) {
    h(3, '曜日 × 時間帯');
    table(
      ['曜日', '時間帯', '投稿数', '平均ER', '補正スコア'],
      cells.map((c) => [WEEKDAYS[c.weekday], `${c.startHour}〜${c.endHour}時`, fmtInt(c.n), fmtPct(c.mean), fmtPct(c.score)]),
      ['l', 'l', 'r', 'r', 'r'],
    );
  }
  if (v.hours.some((x) => x.n)) {
    h(3, '時間帯別 平均ER');
    table(['時間帯', '投稿数', '平均ER'], v.hours.filter((x) => x.n).map((x) => [`${x.key}:00〜${x.key}:59`, fmtInt(x.n), fmtPct(x.mean)]));
  }
  if (v.weekdays.some((x) => x.n)) {
    h(3, '曜日別 平均ER');
    table(['曜日', '投稿数', '平均ER'], v.weekdays.filter((x) => x.n).map((x) => [`${WEEKDAYS[x.key]}曜日`, fmtInt(x.n), fmtPct(x.mean)]));
  }

  // ---------- GA4 ----------
  const t = v.traffic;
  if (t) {
    const b = t.breakdown;
    const share = (a, bb) => (bb ? `${((a / bb) * 100).toFixed(1)}%` : '–');
    h(2, 'HPへの流入（GA4）');
    p(
      `Instagram から HP への流入を週単位で見ています。${t.properties.length ? `対象プロパティ: ${t.properties.join('・')}。` : ''}` +
        `GA4 側 ${t.gaWeeks.length}週、うち投稿データと突き合わせできたのは ${t.joined.length}週です。`,
    );
    h(3, '期間の合計（Instagram からの流入のみ）');
    table(
      ['項目', '値'],
      [
        ['Instagram 流入', `${fmtInt(b.totals.sessions)} セッション`],
        ['うちオーガニック', `${fmtInt(b.totals.organic)}（${share(b.totals.organic, b.totals.sessions)}）`],
        ['うち広告', `${fmtInt(b.totals.paid)}（${share(b.totals.paid, b.totals.sessions)}）`],
        ['ユーザー', fmtInt(b.totals.users)],
        ['新規ユーザー', `${fmtInt(b.totals.newUsers)}（${share(b.totals.newUsers, b.totals.users)}）`],
        ['予約タップ', fmtInt(b.totals.reserveTaps)],
        ['予約タップ率（オーガニック）', b.organicTapRate === null ? '–' : `${b.organicTapRate.toFixed(2)}%`],
        ['予約タップ率（広告）', b.paidTapRate === null ? '–' : `${b.paidTapRate.toFixed(2)}%`],
        ['CV', fmtInt(b.totals.cv)],
      ],
    );
    h(3, '週ごとの Instagram 流入');
    table(
      ['週', 'オーガニック', '広告', '合計', 'ユーザー', '予約タップ', 'CV'],
      t.gaWeeks.map((w) => [fmtDate(w.week), fmtInt(w.organic), fmtInt(w.paid), fmtInt(w.sessions), fmtInt(w.users), fmtInt(w.reserveTaps), fmtInt(w.cv)]),
    );

    const targetLabel = TARGETS.find((x) => x.key === t.target)?.label ?? '';
    h(3, `投稿と流入の相関（相手: ${targetLabel}・n=${t.joined.length}週）`);
    if (t.table.length) {
      table(
        ['投稿側の指標', '相関 r', '順位相関 ρ', 'p 値', '95% 信頼区間', '時期の影響を除いた r', '増減どうしの r', '見かた', '推定値（獲得数）'],
        [...t.table]
          .sort((a, b2) => Math.abs(b2.r) - Math.abs(a.r))
          .map((c) => [c.label, fmtSigned(c.r), fmtSigned(c.rho), c.p === null ? '–' : c.p.toFixed(3), c.ci ? `${fmtSigned(c.ci[0])} 〜 ${fmtSigned(c.ci[1])}` : '–', fmtSigned(c.partial), fmtSigned(c.deltaR), readCorrelation(c), describeEstimate(c, t.target)]),
        ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'l', 'r'],
      );
      p(
        'r は −1〜+1 の相関の強さ。p 値が 0.05 未満なら「偶然とは考えにくい」目安です。' +
          '「時期の影響を除いた r」は週の順番を差し引いた値、「増減どうしの r」は前の週からの変化どうしの相関で、' +
          'どちらも元の r より大きく下がる場合は、両方が同時期に伸びただけの見かけの相関を疑ってください。' +
      '「推定値」は週ごとの値から引いた回帰直線の傾きで、投稿側の指標が増えたときに増える流入（獲得数）の目安です。有意でない指標は（参考）としています。相関は因果ではありません。',
      );
    } else p('相関を出すには、投稿データと GA4 が重なる週が3週以上必要です。');
    if (t.lagged.length) {
      h(3, `1週遅れの相関（今週の投稿 → 翌週の${targetLabel}）`);
      table(
        ['投稿側の指標', '相関 r', '順位相関 ρ', 'p 値', '強さ'],
        [...t.lagged].sort((a, b2) => Math.abs(b2.r ?? 0) - Math.abs(a.r ?? 0)).map((c) => [c.label, fmtSigned(c.r), fmtSigned(c.rho), c.p === null ? '–' : c.p.toFixed(3), c.strength || '–']),
        ['l', 'r', 'r', 'r', 'l'],
      );
    }
    const weeksWithIG = t.joined.filter((r) => r.ig);
    if (weeksWithIG.length) {
      h(3, '相関に使った週ごとの値');
      const drivers = DRIVERS.filter((d) => t.table.some((c) => c.key === d.key));
      table(
        ['週', ...drivers.map((d) => d.label), targetLabel],
        weeksWithIG.map((r) => [fmtDate(r.week), ...drivers.map((d) => fmtInt(r.ig[d.key])), fmtInt(r.ga[t.target])]),
      );
    }
    const acc = b.accounts.filter((a) => a.name);
    if (acc.length) {
      h(3, '流入元アカウント別');
      table(['アカウント', 'セッション', '構成比'], acc.map((a) => [a.name, fmtInt(a.sessions), share(a.sessions, b.totals.sessions)]));
    }
    if (b.sources.length) {
      h(3, '参照元/メディア別');
      table(['参照元/メディア', 'セッション', '構成比'], b.sources.map((x) => [x.name, fmtInt(x.sessions), share(x.sessions, b.totals.sessions)]));
    }
    if (t.campaigns.length) {
      h(3, 'UTM キャンペーン別の流入');
      table(
        ['キャンペーン', 'セッション', 'ユーザー', '予約タップ', 'タップ率'],
        t.campaigns.map((c) => [c.name, fmtInt(c.sessions), fmtInt(c.users), fmtInt(c.taps), c.sessions ? `${((c.taps / c.sessions) * 100).toFixed(1)}%` : '–']),
      );
    }
    const land = t.landing;
    if (land) {
      h(3, 'リンククリックは HP に届いているか');
      table(
        ['週', 'リンククリック', 'GA4 の流入', '到達率'],
        [
          ...land.rows.map((r) => [fmtDate(r.week), fmtInt(r.clicks), fmtInt(r.sessions), r.clicks ? `${((r.sessions / r.clicks) * 100).toFixed(1)}%` : '–']),
          ['合計', fmtInt(land.clicks), fmtInt(land.sessions), land.rate === null ? '–' : `${land.rate.toFixed(1)}%`],
        ],
      );
      p(
        land.rate !== null && land.rate < 60
          ? `リンククリックの ${(100 - land.rate).toFixed(0)}% は GA4 で計測できていません。プロフィールのリンク先が LINE や外部予約システムなど計測対象外になっているか、UTM が付いていない可能性があります。`
          : 'Instagram 上のクリック数と GA4 の流入は概ね一致しています。',
      );
    }
  }

  // ---------- オーディエンス ----------
  const a = v.audience;
  if (a && (a.ageGender.length || a.countries.length || a.cities.length)) {
    h(2, 'フォロワーの内訳');
    const lead = ['現在のフォロワーの構成です（期間の切り替えには連動しません）。'];
    if (a.followersTotal) lead.unshift(`フォロワー ${fmtInt(a.followersTotal)}人。`);
    if (a.topGender && a.topAge) lead.push(`中心は ${a.topGender.label}・${a.topAge.age}歳（${fmtPct(a.topAge.value, 1)}）です。`);
    p(lead.join(''));
    if (a.genderTotals.length) {
      h(3, '性別');
      table(['性別', '割合'], a.genderTotals.map((g) => [g.label, fmtPct(g.value, 1)]));
    }
    if (a.ageGender.length) {
      h(3, '年齢層 × 性別（フォロワー全体に占める割合）');
      table(
        ['年齢層', ...a.series.map((x) => x.label), '合計'],
        a.ageGender.map((r) => [`${r.age}歳`, ...a.series.map((x) => fmtPct(r[x.key], 1)), fmtPct(a.series.reduce((sum, x) => sum + (r[x.key] ?? 0), 0), 1)]),
      );
    }
    if (a.countries.length) {
      h(3, '上位の国');
      table(['国', '割合'], a.countries.map((c) => [c.name, fmtPct(c.value, 1)]));
    }
    if (a.cities.length) {
      h(3, '上位の都市');
      table(['都市', '割合'], a.cities.map((c) => [c.name, fmtPct(c.value, 1)]));
    }
  }

  // ---------- ハッシュタグ ----------
  h(2, 'ハッシュタグ別の反応');
  if (v.hashtags.length) {
    p('2回以上使ったハッシュタグの平均 ER と、期間全体の平均 ER との比較です。');
    table(
      ['ハッシュタグ', '使用回数', '平均ER', '全体平均比', '平均リーチ'],
      v.hashtags.map((x) => [x.tag, fmtInt(x.n), fmtPct(x.er), x.lift === null ? '–' : `${fmtSigned(x.lift, 0)}%`, fmtInt(x.reach)]),
    );
  } else p('2回以上使われたハッシュタグがありません。');

  // ソーシャルインサイトのハッシュタグ分析（ツール側の集計。表示中の期間には連動しない）
  for (const set of si.hashtagSets || []) {
    const views = set.rows.some((r) => r.viewsMean !== null);
    h(3, `ソーシャルインサイトの集計（${set.label}）`);
    p(`エンゲージメント率は${set.erBasis === 'views' ? '閲覧数' : 'フォロワー数'}基準です。ツール側の集計値のため、上の期間設定には連動しません。`);
    table(
      views
        ? ['ハッシュタグ', '投稿件数', '平均閲覧数', '平均リーチ', '平均いいね', '平均保存', '平均ER', '中央値ER']
        : ['ハッシュタグ', '投稿件数', '平均いいね', '平均コメント', '平均ER', '中央値ER'],
      set.rows.slice(0, 60).map((r) => (views
        ? [r.tag, fmtInt(r.posts), fmtInt(r.viewsMean), fmtInt(r.reachMean), fmtNum(r.likesMean), fmtNum(r.savesMean), fmtPct(r.erMean, 2), fmtPct(r.erMedian, 2)]
        : [r.tag, fmtInt(r.posts), fmtNum(r.likesMean), fmtNum(r.commentsMean), fmtPct(r.erMean, 2), fmtPct(r.erMedian, 2)])),
    );
  }

  // ---------- 他アカウントとの関係 ----------
  if (si.followed?.length || si.tagged?.list?.length) {
    h(2, '他アカウントとの関係');
    if (si.followed?.length) {
      const b = si.benchmark;
      h(3, `フォロー中アカウント（${si.followed.length}件）`);
      p(`フォロワー数の中央値 ${fmtInt(b.followersMedian)}人・最大 ${fmtInt(b.followersMax)}人。投稿数の中央値は ${fmtInt(b.postsMedian)}件です。`);
      table(
        ['ユーザーネーム', 'フォロワー', '投稿数', 'フォロー数', 'プロフィール'],
        si.followed.slice(0, 60).map((f) => [`@${f.username}`, fmtInt(f.followers), fmtInt(f.posts), fmtInt(f.follows), oneLine(f.profile, 40)]),
        ['l', 'r', 'r', 'r', 'l'],
      );
      if (b.topHashtags.length) p(`フォロー先でよく使われるタグ: ${b.topHashtags.map((t) => `#${t.tag}（${t.n}）`).join('、')}`);
    }
    if (si.tagged?.list?.length) {
      h(3, `タグ付き投稿（${si.tagged.list.length}件）`);
      p(`内訳: ${si.tagged.accounts.map((a) => `@${a.account} ${a.n}件`).join(' / ')}`);
      table(
        ['投稿日時', 'アカウント', 'タイプ', 'いいね', 'コメント', '内容'],
        si.tagged.list.slice(0, 60).map((t) => [fmtDateTime(t.timestamp), `@${t.account}`, t.type, fmtInt(t.likes), fmtInt(t.comments), oneLine(t.caption, 40)]),
        ['l', 'l', 'l', 'r', 'r', 'l'],
      );
    }
  }

  const range = `${v.startKey.replaceAll('-', '')}-${v.endKey.replaceAll('-', '')}`;
  const who = v.account || (names.length === 1 ? names[0] : '');
  return { title: 'Instagram インサイト分析レポート', fileBase: `instagram_report_${who ? `${who}_` : ''}${range}`, blocks };
}

// ---------- Markdown ----------

/** 表のセルに入れられない文字（| と改行）を逃がす */
const mdCell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function toMarkdown(report) {
  const out = [];
  for (const b of report.blocks) {
    if (b.type === 'h') out.push(`${'#'.repeat(b.level)} ${b.text}`, '');
    else if (b.type === 'p') out.push(b.text, '');
    else if (b.type === 'list') out.push(...b.items.map((i) => `- ${i.replace(/\r?\n/g, ' ')}`), '');
    else if (b.type === 'table') {
      out.push(`| ${b.head.map(mdCell).join(' | ')} |`);
      out.push(`| ${b.align.map((x) => (x === 'r' ? '---:' : '---')).join(' | ')} |`);
      for (const r of b.rows) out.push(`| ${r.map(mdCell).join(' | ')} |`);
      out.push('');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}
