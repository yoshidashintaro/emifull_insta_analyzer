import {
  WEEKDAYS, TYPE_LABELS, TYPE_ORDER, METRICS,
  normalizeDaily, normalizePost, enrichPosts, periodBounds, slice, addDays,
  summarize, weeklyER, byType, topPosts, timeHeatmap, groupByKey, bestSlots,
  hashtagStats, generateInsights, parseDateKey, formatJST, jstParts,
  anchorFollowers, detectFollowerMode, funnel, audienceSummary, accountsOf, byAccount,
} from './analytics.js';
import * as charts from './charts.js';
import { fmtInt, fmtPct, fmtCompact } from './charts.js';
import { generateDemo } from './data/demo.js';
import { importCSV, toCSV, decodeCSV, describeImport, parseCSV, looksGarbled } from './data/csv.js';
import { readWorkbook, isXlsxName } from './data/xlsx.js';
import { importGA4Workbook, readGA4Table, mergeGA4, propertyFromFileName, primaryRows, campaignRows, isInstagram } from './data/ga4.js';
import {
  weeklyTraffic, weeklyInstagram, joinWeeks, correlationTable, laggedCorrelation,
  landingRate, trafficBreakdown, scatterData, trafficInsights, weekStart, hpSummary, describeEstimate, DRIVERS, TARGETS,
} from './traffic.js';
import { GraphClient, fetchFromGraph } from './data/graphApi.js';
import { buildReport, toMarkdown, readCorrelation } from './report.js';
import { toDocx, DOCX_MIME } from './docx.js';
import { TREND_METRICS, TREND_UNITS, trendMetric, trendSeries } from './trend.js';
import { sliceStories, summarizeStories, storiesByDate, storiesByHour } from './stories.js';
import {
  sliceByDate, surfaceBreakdown, clickBreakdown, accountTotals,
  hashtagSets, benchmarkSummary, taggedInPeriod,
} from './account.js';
import { readReachBreakdown, mergeReachBreakdown, applyNonFollowerEstimate, describeBreakdowns } from './data/reachMix.js';
import { readSocialInsight, mergeHashtags, mergeFollowed, mergeSummary, mergeStories, mergeTagged, describeSocialInsight } from './data/socialInsight.js';
import * as store from './storage.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DEFAULTS = {
  days: 90, basis: 'reach', topMetric: 'er', account: '',
  corrTarget: 'organic', scatterDriver: 'posts', trendUnit: 'week', hashtagSet: '',
  sort: { key: 'timestamp', dir: 'desc' },
};
const state = {
  dataset: store.loadDataset(),
  settings: { ...DEFAULTS, ...store.loadSettings() },
  search: '',
  tableViews: new Set(), // 「表で見る」状態のカード
  view: null, // 直近の集計結果
  // ?trend=指標 で開いたときは、その指標の推移ページを表示する
  trend: trendMetric(new URLSearchParams(location.search).get('trend'))?.key || null,
};

function persistSettings() {
  store.saveSettings(state.settings);
}

// ---------- ユーティリティ ----------

function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

const fmtDate = (key) => key.replaceAll('-', '/');
// 日時は日本時間で表示する（例: 2026-09-30T09:02:09.000Z → 2026/09/30 18:02）
const fmtDateTime = (iso) => formatJST(iso, 'short');
const firstLine = (caption) => caption.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'))?.trim() || '（キャプションなし）';

/** 増減表示。矢印とテキストでも方向がわかるようにする（色だけに頼らない） */
function deltaNode(value, { unit = '', suffix = '', digits = 0, goodWhenUp = true } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return el('span', { textContent: '比較データなし' });
  const up = value > 0;
  const flat = Math.abs(value) < 10 ** -digits / 2;
  const cls = flat ? '' : up === goodWhenUp ? 'up' : 'down';
  const sign = flat ? '±' : up ? '+' : '−';
  const arrow = flat ? '' : up ? '▲ ' : '▼ ';
  const abs = Math.abs(value);
  const body = digits ? abs.toFixed(digits) : Math.round(abs).toLocaleString('ja-JP');
  return el('span', {}, el('span', { className: cls, textContent: `${arrow}${sign}${body}${unit}` }), suffix ? ` ${suffix}` : '');
}

// ---------- テーマ ----------

const media = matchMedia('(prefers-color-scheme: dark)');
function resolveTheme() {
  const explicit = document.documentElement.dataset.theme;
  document.documentElement.dataset.resolvedTheme = explicit || (media.matches ? 'dark' : 'light');
}
function toggleTheme() {
  const next = document.documentElement.dataset.resolvedTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('iia.theme', next);
  } catch {}
  resolveTheme();
  render();
}

// ---------- 集計 ----------

/** 日次・投稿を分析できる形に整える（ダッシュボードと推移ページで共通） */
function baseData() {
  const ds = state.dataset;
  // フォロワー総数の日次データが無くても、オーディエンスの現在値から推移を逆算する
  const rawDaily = normalizeDaily(anchorFollowers(ds.daily || [], ds.audience));
  const current = ds.audience?.followersTotal ?? ds.account?.followersCount ?? rawDaily.findLast((d) => d.followers !== null)?.followers;
  const enriched = enrichPosts((ds.posts || []).map(normalizePost), rawDaily, state.settings.basis, current);

  // 1つのエクスポートに複数アカウントが入っていることがあるので絞り込めるようにする
  const accounts = accountsOf(enriched);
  // 非フォロワーへのリーチの実数が無い投稿・日は、取り込んだリーチ内訳の比率から推定する
  const mainAccount = ds.account?.username || accounts[0]?.username || '';
  const est = applyNonFollowerEstimate({ posts: enriched, daily: rawDaily }, ds.reachBreakdown, mainAccount);
  const all = est.posts;
  const daily = est.daily;
  const account = accounts.some((a) => a.username === state.settings.account) ? state.settings.account : '';
  const posts = account ? all.filter((p) => p.account === account) : all;
  return { ds, daily, all, accounts, account, posts, nonFollowerEstimated: est.estimated };
}

function compute() {
  const { days } = state.settings;
  const { ds, daily, all, accounts, account, posts, nonFollowerEstimated } = baseData();
  const followerMode = ds.followerMode || detectFollowerMode(daily);

  const { startKey, endKey } = periodBounds(daily, posts, days || null);
  const cur = slice(daily, posts, startKey, endKey);
  let prev = null;
  if (days) {
    const pEnd = addDays(startKey, -1);
    prev = slice(daily, posts, addDays(pEnd, -(days - 1)), pEnd);
  }

  const summary = summarize(cur.daily, cur.posts);
  const prevSummary = prev && (prev.posts.length || prev.daily.length) ? summarize(prev.daily, prev.posts) : null;
  const types = byType(cur.posts);
  const heatmap = timeHeatmap(cur.posts, { blockHours: 3 });
  const hours = groupByKey(cur.posts, (p) => p.hour, 24);
  const weekdays = groupByKey(cur.posts, (p) => p.weekday, 7);
  const hashtags = hashtagStats(cur.posts);
  const steps = funnel(summary);
  const audience = audienceSummary(ds.audience);
  const accountStats = byAccount(slice(daily, all, startKey, endKey).posts);

  // GA4（HPへの流入）。期間フィルタは投稿側と揃える
  const traffic = computeTraffic(ds, { startKey, endKey, daily, posts: all, accounts, account });
  // 上部の指標：Instagram から HP への流入（UU・セッション・新規・エンゲージメント率・CV・CVR）。前期間も同じ長さで比べる
  const hp = hpSummary(ds.ga4, startKey, endKey);
  const prevHp = days ? hpSummary(ds.ga4, addDays(startKey, -days), addDays(startKey, -1)) : null;

  // ソーシャルインサイトから取り込んだ追加データ（ストーリーズ・面別の内訳・他アカウント）
  const stories = sliceStories(ds.stories, startKey, endKey);
  const accountRows = sliceByDate(ds.accountDaily, startKey, endKey);
  const si = {
    stories,
    storiesSummary: summarizeStories(stories),
    storiesDaily: storiesByDate(stories),
    storiesHours: storiesByHour(stories),
    surfaces: surfaceBreakdown(accountRows),
    clicks: clickBreakdown(accountRows),
    totals: accountTotals(accountRows),
    hashtagSets: hashtagSets(ds.hashtags),
    followed: ds.followed || [],
    benchmark: benchmarkSummary(ds.followed),
    tagged: taggedInPeriod(ds.tagged, startKey, endKey),
  };

  const insights = generateInsights({
    summary, prevSummary, types, heatmap, hours, hashtags, posts: cur.posts,
    steps, audience, accounts: account ? [] : accountStats, si,
  });

  return {
    startKey, endKey, daily: cur.daily, posts: cur.posts, summary, prevSummary,
    types, heatmap, hours, weekdays, hashtags, insights,
    steps, audience, accounts, accountStats, account, followerMode, traffic, hp, prevHp, nonFollowerEstimated, si,
  };
}

/**
 * GA4 の流入を週単位で投稿データと突き合わせる。
 * 相関は週数がある程度ないと意味を持たないので、3週未満なら null を返して画面ごと隠す。
 */
function computeTraffic(ds, { startKey, endKey, daily, posts, accounts, account }) {
  // GA4 は週次で入ってくることがある。期間の端で週を切らないよう、週単位に丸めて絞り込む
  const from = weekStart(startKey);
  const to = addDays(weekStart(endKey), 6);
  const all = (ds.ga4 || []).filter((r) => r.date >= from && r.date <= to);
  if (!all.length) return null;
  // 参照元別とキャンペーン別が両方あると二重計上になるので、集計には粗いほうだけを使う
  const rows = primaryRows(all);

  // 参照元の振り分けで「どのルールにも当たらない Instagram 流入」を入れる先＝本アカウント
  const fallbackAccount = accounts[0]?.username || ds.account?.username || '(本アカウント)';
  const gaWeeks = weeklyTraffic(rows, { fallbackAccount });
  const igWeeks = weeklyInstagram(posts, daily);
  const joined = joinWeeks(igWeeks, gaWeeks);
  const breakdown = trafficBreakdown(gaWeeks, { fallbackAccount });
  if (!gaWeeks.length) return null;

  const target = TARGETS.some((t) => t.key === state.settings.corrTarget) ? state.settings.corrTarget : 'organic';
  const table = joined.length >= 3 ? correlationTable(joined, { target }) : [];
  const lagged = joined.length >= 4 ? laggedCorrelation(joined, { target }) : [];
  // リンククリックは本アカウントの数字なので、比べる相手もそのアカウント由来に絞る
  const landing = landingRate(joined, { account: account || fallbackAccount });
  const insights = trafficInsights({ table, lagged, breakdown, landing, joined });

  // UTM キャンペーン別（どの投稿・施策からの流入か）
  const campaigns = new Map();
  for (const r of campaignRows(all)) {
    if (!isInstagram(r.sourceMedium)) continue;
    const c = campaigns.get(r.campaign) || { name: r.campaign, sessions: 0, users: 0, taps: 0 };
    c.sessions += r.sessions || 0;
    c.users += r.users || 0;
    c.taps += r.reserveTaps || 0;
    campaigns.set(r.campaign, c);
  }

  const driverKey = DRIVERS.some((d) => d.key === state.settings.scatterDriver) ? state.settings.scatterDriver : 'posts';
  return {
    gaWeeks, igWeeks, joined, breakdown, table, lagged, landing, insights,
    target, driverKey, fallbackAccount,
    scatter: joined.length >= 3 ? scatterData(joined, driverKey, target) : null,
    properties: [...new Set(rows.map((r) => r.property).filter(Boolean))],
    campaigns: [...campaigns.values()].sort((a, b) => b.sessions - a.sessions),
  };
}

// ---------- 描画 ----------

function render() {
  const hasData = !!state.dataset && ((state.dataset.posts?.length || 0) + (state.dataset.daily?.length || 0) + (state.dataset.ga4?.length || 0) > 0);
  renderAccountLine();
  if (state.trend && hasData) return renderTrendPage();
  $('#trend-view').hidden = true;
  $('#empty-state').hidden = hasData;
  $('#dashboard').hidden = !hasData;
  $('#export-menu').hidden = !hasData;
  if (!hasData) return;

  const v = (state.view = compute());
  syncFilterControls();
  renderPeriodNote(v);
  renderWarnings(v);
  renderKPIs(v);
  renderHpKPIs(v);
  renderInsights(v);
  renderFollowerCharts(v);
  renderActivity(v);
  renderBreakdown(v);
  renderStories(v);
  renderEngagementCharts(v);
  renderTopPosts(v);
  renderPostsTable();
  renderTiming(v);
  renderTraffic(v);
  renderAudience(v);
  renderHashtags(v);
  renderToolHashtags(v);
  renderBenchmark(v);
  refreshTableViews();
}

function renderAccountLine() {
  const ds = state.dataset;
  const line = $('#account-line');
  if (!ds) {
    line.textContent = 'データ未接続';
    return;
  }
  const src = { demo: 'デモデータ', csv: 'CSV 取り込み', api: 'Instagram API' }[ds.source] || '';
  // CSV 取り込みではアカウント名が投稿データ側にしか無いので、そちらから拾う
  const names = ds.account?.username ? [ds.account.username] : accountsOf(ds.posts || []).map((a) => a.username);
  const name = names.length ? names.slice(0, 2).map((u) => `@${u}`).join(' / ') + (names.length > 2 ? ` ほか${names.length - 2}件` : '') : '';
  line.textContent = [name, src, ds.fetchedAt ? `更新 ${fmtDateTime(ds.fetchedAt)}` : ''].filter(Boolean).join(' ・ ');
}

function syncFilterControls() {
  $$('#range button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.days) === state.settings.days)));
  $('#er-basis').value = state.settings.basis;

  // アカウントが複数あるときだけ絞り込みを出す
  const { accounts, account } = state.view;
  const wrap = $('#account-filter-wrap');
  wrap.hidden = accounts.length < 2;
  if (wrap.hidden) return;
  const select = $('#account-filter');
  const signature = accounts.map((a) => a.username).join('|');
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(
      el('option', { value: '', textContent: `すべて（${accounts.length}アカウント）` }),
      ...accounts.map((a) => el('option', { value: a.username, textContent: `@${a.username}（${a.n}投稿）` })),
    );
  }
  select.value = account;
}

function renderPeriodNote(v) {
  const n = Math.round((parseDateKey(v.endKey) - parseDateKey(v.startKey)) / 86400000) + 1;
  $('#period-note').textContent = `${fmtDate(v.startKey)} 〜 ${fmtDate(v.endKey)}（${n}日間）${v.prevSummary ? ' ・ 比較は直前の同じ日数' : ''}`;
}

/** データについての注意書き（画面上部の注意とレポートの両方で使う） */
function warningMessages(v) {
  const msgs = [...(state.dataset.warnings || [])];
  if (state.settings.basis === 'reach' && v.posts.length && v.posts.every((p) => p.reach === null)) {
    msgs.push('投稿のリーチが無いため ER を計算できません。「ER の計算基準」をフォロワー基準に切り替えてください。');
  }
  if (!v.daily.some((d) => d.followers !== null)) {
    msgs.push('フォロワー数の日次データがありません。日次データの CSV を追加するか API 連携してください。');
  } else if (v.followerMode === 'gains' && state.dataset.audience?.followersTotal) {
    msgs.push(
      `フォロワー数の推移は、現在のフォロワー数（${fmtInt(state.dataset.audience.followersTotal)}人）から日々のフォロー数をさかのぼって計算した推定値です。` +
        'フォロー解除数が CSV に含まれないため、過去の値は実際よりやや少なめに出ます。',
    );
  }
  if (v.nonFollowerEstimated) {
    msgs.push(`非フォロワーへのリーチは、取り込んだリーチ内訳の比率を投稿・日ごとのリーチに掛けた推定値です（${describeBreakdowns(state.dataset.reachBreakdown).join('、')}）。内訳の期間外の日は、いちばん近い期間の比率を使っています。`);
  }
  if (v.account) {
    msgs.push(`投稿の分析を @${v.account} に絞り込んでいます。アカウント全体の日次指標（リーチ・プロフィールアクセスなど）は絞り込みの対象外です。`);
  }
  return msgs;
}

function renderWarnings(v) {
  const msgs = warningMessages(v);
  const box = $('#warnings');
  box.hidden = !msgs.length;
  box.replaceChildren(el('ul', {}, ...msgs.map((m) => el('li', { textContent: m }))));
}

/**
 * 非フォロワーのリーチを出せない理由。リーチ内訳はアカウントごとなので、
 * 表示中の投稿のアカウントの内訳が無いと推定できない（別アカウントの比率は使わない）
 */
function nonFollowerMissingReason(posts) {
  const breakdowns = state.dataset.reachBreakdown || [];
  if (!posts.length) return { textContent: '非フォロワー：この期間の投稿なし' };
  if (!breakdowns.length) {
    return { textContent: '非フォロワー：リーチ内訳が未取り込み', title: '「フォロワー以外へのリーチ」の列か、リーチ内訳の CSV を取り込むと表示されます' };
  }
  const have = new Set(breakdowns.map((b) => b.account));
  const missing = [...new Set(posts.map((p) => p.account).filter((a) => a && !have.has(a)))];
  if (missing.length) {
    return {
      textContent: `非フォロワー：${missing.map((a) => `@${a}`).join('・')} の内訳なし`,
      title: `取り込み済みの内訳は ${[...have].map((a) => (a ? `@${a}` : '（アカウント指定なし）')).join('・')} の分です。このアカウントのリーチ内訳の CSV を取り込むと推定します`,
    };
  }
  return { textContent: '非フォロワー：データなし', title: '投稿にリーチの値が無いため推定できません' };
}

function renderKPIs({ summary: s, prevSummary: p, posts }) {
  // 期間内の投稿の非フォロワーのリーチに、リーチ内訳からの推定値が含まれるか
  const nonFEstimated = posts.some((x) => x.nonFollowerEstimated);
  $('#kpi-followers').textContent = fmtInt(s.followers);
  $('#kpi-followers-delta').replaceChildren(
    s.followerChange === null
      ? el('span', { textContent: '増減データなし' })
      : deltaNode(s.followerChange, { unit: '人', suffix: `（${s.followerChangePct >= 0 ? '+' : ''}${(s.followerChangePct ?? 0).toFixed(1)}%）この期間` }),
  );

  $('#kpi-er').textContent = fmtPct(s.avgER);
  $('#kpi-er-delta').replaceChildren(
    p?.avgER ? deltaNode(s.avgER - p.avgER, { unit: 'pt', digits: 2, suffix: '前期間比' }) : el('span', { textContent: `中央値 ${fmtPct(s.medianER)}` }),
  );

  $('#kpi-posts').textContent = fmtInt(s.postCount);
  $('#kpi-posts-delta').replaceChildren(p ? deltaNode(s.postCount - p.postCount, { unit: '件', suffix: '前期間比' }) : el('span', { textContent: '' }));

  const pct = (a, b) => (a !== null && b ? ((a - b) / b) * 100 : null);
  $('#kpi-reach').textContent = fmtCompact(s.avgReach);
  // 数値の下に小さく「非フォロワー」の平均リーチ（押すとその推移を別タブで開く）
  $('#kpi-reach-nonf').replaceChildren(
    s.avgNonFollowerReach === null
      ? el('span', nonFollowerMissingReason(posts))
      : el(
          'a',
          {
            href: '?trend=nonFollowerReach',
            target: '_blank',
            rel: 'noopener',
            title: nonFEstimated
              ? `リーチ × 非フォロワー比率で出した推定値です（${describeBreakdowns(state.dataset.reachBreakdown).join('、')}）。押すと推移を表示`
              : '非フォロワーの平均リーチの推移をみる',
          },
          nonFEstimated ? '非フォロワー（推定） ' : '非フォロワー ',
          el('strong', { textContent: fmtCompact(s.avgNonFollowerReach) }),
          s.nonFollowerShare === null ? '' : `（${s.nonFollowerShare.toFixed(0)}%）`,
        ),
  );
  $('#kpi-reach-delta').replaceChildren(
    p ? deltaNode(pct(s.avgReach, p.avgReach), { unit: '%', digits: 1, suffix: '前期間比' }) : el('span', { textContent: '' }),
  );
  $('#kpi-inter').textContent = fmtCompact(s.avgInteractions);
  $('#kpi-inter-delta').replaceChildren(
    p ? deltaNode(pct(s.avgInteractions, p.avgInteractions), { unit: '%', digits: 1, suffix: '前期間比' }) : el('span', { textContent: `合計 ${fmtInt(s.totalInteractions)}` }),
  );

  // 日次データにあるときだけ出す（API 連携では取れないことがある）
  const optional = (card, valueId, deltaId, value, prevValue, sub) => {
    $(card).hidden = value === null;
    if (value === null) return;
    $(valueId).textContent = fmtCompact(value);
    $(deltaId).replaceChildren(
      prevValue ? deltaNode(pct(value, prevValue), { unit: '%', digits: 1, suffix: '前期間比' }) : el('span', { textContent: sub }),
    );
  };
  optional('#kpi-visits-card', '#kpi-visits', '#kpi-visits-delta', s.totals.profileVisits, p?.totals?.profileVisits, `1日平均 ${fmtInt(s.avgVisits)}`);
  optional('#kpi-clicks-card', '#kpi-clicks', '#kpi-clicks-delta', s.totals.linkClicks, p?.totals?.linkClicks, `1日平均 ${fmtInt(s.avgClicks)}`);

  const shown = $$('.kpis:not(.kpis-hp) .kpi').filter((c) => !c.hidden).length;
  $('.kpis').classList.toggle('dense', shown > 6);
}

/** Instagram から HP への流入（GA4）。GA4 データや列が無いときは「–」と理由を出す */
function renderHpKPIs({ hp: h, prevHp: p }) {
  const pct = (a, b) => (a !== null && b ? ((a - b) / b) * 100 : null);
  const set = (id, text, delta) => {
    $(`#kpi-hp-${id}`).textContent = text;
    $(`#kpi-hp-${id}-delta`).replaceChildren(typeof delta === 'string' ? el('span', { textContent: delta }) : delta);
  };
  if (!h) {
    const why = state.dataset.ga4?.length ? 'この期間の Instagram 流入なし' : 'GA4 データ未取り込み';
    for (const id of ['users', 'sessions', 'new', 'newrate', 'engage', 'cv', 'cvr']) set(id, '–', why);
    return;
  }
  // 件数は前期間比（%）、率は前期間との差（pt）。前期間が無ければ補足を出す
  const count = (id, key, missing, sub, fmt = fmtCompact) => {
    const v = h[key];
    if (v === null) return set(id, '–', missing);
    set(id, fmt(v), p && p[key] !== null ? deltaNode(pct(v, p[key]), { unit: '%', digits: 1, suffix: '前期間比' }) : sub);
  };
  const rate = (id, key, missing, sub) => {
    const v = h[key];
    if (v === null) return set(id, '–', missing);
    set(id, fmtPct(v), p && p[key] !== null ? deltaNode(v - p[key], { unit: 'pt', digits: 2, suffix: '前期間比' }) : sub);
  };

  count('users', 'users', 'GA4 にユーザー数の列なし', '日ごとのユーザー数の合計');
  count('sessions', 'sessions', 'セッションなし', h.paidSessions ? `うち広告 ${fmtInt(h.paidSessions)}` : 'Instagram からの訪問');
  count('new', 'newUsers', 'GA4 に新規ユーザー数の列なし', '初めての訪問');
  rate('newrate', 'newUserRate', h.newUsers === null ? 'GA4 に新規ユーザー数の列なし' : 'ユーザーなし', '新規ユーザー ÷ ユーザー');
  rate('engage', 'engagementRate', h.engagedSessions === null ? 'GA4 にエンゲージのあったセッションの列なし' : 'セッションなし', 'エンゲージのあったセッション ÷ セッション');
  count('cv', 'cv', 'GA4 に CV の列なし', '予約完了', fmtInt);
  rate('cvr', 'cvr', h.cv === null ? 'GA4 に CV の列なし' : 'セッションなし', 'CV ÷ セッション');
}

// ---------- 指標の推移ページ（?trend=指標） ----------

/** 値の書式。率は %、平均は小数1桁、それ以外は整数 */
function trendFormat(m) {
  if (m.unit === '%') return (v) => fmtPct(v);
  if (m.agg === 'mean') return (v) => (v === null || v === undefined ? '–' : v.toLocaleString('ja-JP', { maximumFractionDigits: 1 }));
  return fmtInt;
}

function trendView() {
  const m = trendMetric(state.trend);
  const unit = TREND_UNITS.some((u) => u.key === state.settings.trendUnit) ? state.settings.trendUnit : 'week';
  const { ds, daily, posts, account } = baseData();
  return { m, unit, account, series: trendSeries(m.key, { daily, posts, ga4: ds.ga4 || [] }, unit) };
}

/** 表の列。率は分子・分母、投稿の指標は投稿数も並べて、値の根拠が分かるようにする */
function trendColumns(m) {
  const fmt = trendFormat(m);
  const cols = [
    { label: '期間', get: (r) => r.label },
    { label: m.label, get: (r) => (r.value === null ? '–' : fmt(r.value)), num: true },
    { label: m.unit === '%' ? '前の期間との差' : '前の期間比', get: (r) => (r.change === null ? '–' : `${r.change >= 0 ? '+' : '−'}${Math.abs(r.change).toFixed(m.unit === '%' ? 2 : 1)}${m.unit === '%' ? 'pt' : '%'}`), num: true },
  ];
  if (m.agg === 'ratio') {
    cols.push({ label: m.numLabel, get: (r) => fmtInt(r.num), num: true }, { label: m.denLabel, get: (r) => fmtInt(r.den), num: true });
  } else if (m.source === 'posts' && m.agg !== 'count') {
    cols.push({ label: '投稿数', get: (r) => fmtInt(r.n), num: true });
  }
  return cols;
}

function renderTrendPage() {
  $('#empty-state').hidden = true;
  $('#dashboard').hidden = true;
  $('#export-menu').hidden = true;
  $('#trend-view').hidden = false;
  // 戻り先は同じページの、クエリを外したもの（単一ファイル版でも動く）
  $('#trend-back').href = location.pathname;

  const { m, unit, account, series } = trendView();
  const rows = series.rows;
  document.title = `${m.label}の推移 | Instagram インサイト分析`;
  $('#trend-group').textContent = m.group;
  $('#trend-title').textContent = `${m.label}の推移`;
  $('#trend-def').textContent = m.def;

  $$('#trend-unit button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.unit === unit)));
  const select = $('#trend-metric');
  if (!select.options.length) {
    const groups = [...new Set(TREND_METRICS.map((x) => x.group))];
    select.replaceChildren(
      ...groups.map((g) => el('optgroup', { label: g }, ...TREND_METRICS.filter((x) => x.group === g).map((x) => el('option', { value: x.key, textContent: x.label })))),
    );
  }
  select.value = m.key;

  const unitLabel = TREND_UNITS.find((u) => u.key === unit).label;
  $('#trend-note').textContent = rows.length ? `${fmtDate(rows[0].key)} から ${rows.length}${unitLabel}分` : '';
  const warns = [];
  if (account && m.source === 'posts') warns.push(`投稿の指標は @${account} の投稿だけで集計しています。`);
  if (m.key === 'nonFollowerReach' && state.dataset.reachBreakdown?.length) {
    warns.push(`実数の無い投稿は、リーチ × 非フォロワー比率の推定値で集計しています（${describeBreakdowns(state.dataset.reachBreakdown).join('、')}）。`);
  }
  if (unit !== 'day' && rows.length) warns.push(`最初と最後の${unitLabel}は、データのある日だけの値です（${unitLabel}の途中までの場合があります）。`);
  if (m.source === 'ga4' && unit === 'day' && (state.dataset.ga4 || []).length && rows.some((r) => r.value === null)) {
    warns.push('GA4 のデータが週単位の場合、日別では週の初日にまとめて表示されます。週別か月別で見てください。');
  }
  $('#trend-warn').hidden = !warns.length;
  $('#trend-warn').replaceChildren(el('ul', {}, ...warns.map((w) => el('li', { textContent: w }))));

  const fmt = trendFormat(m);
  $('#trend-chart-sub').textContent = `${unitLabel}別・${m.chart === 'bar' ? '棒' : '折れ線'}グラフ（点にカーソルを合わせると値を表示）`;
  if (!setEmpty('c-trend', !rows.some((r) => r.value !== null), m.source === 'ga4' ? 'GA4 のデータがありません（データ接続・更新から取り込めます）' : 'この指標のデータがありません')) {
    charts.trendChart('c-trend', rows, { type: m.chart, unit: m.unit, name: m.label, format: fmt });
  }

  const cols = trendColumns(m);
  const table = $('#trend-table');
  table.tHead.replaceChildren(el('tr', {}, ...cols.map((c) => el('th', { textContent: c.label, className: c.num ? 'num' : '' }))));
  table.tBodies[0].replaceChildren(
    ...(rows.length
      ? [...rows].reverse().map((r) => el('tr', {}, ...cols.map((c) => el('td', { textContent: c.get(r), className: c.num ? 'num' : '' }))))
      : [el('tr', {}, el('td', { colSpan: cols.length, textContent: 'データがありません' }))]),
  );
}

function exportTrendCSV() {
  const { m, unit, series } = trendView();
  const cols = trendColumns(m);
  download(`trend_${m.key}_${unit}.csv`, toCSV([...series.rows].reverse(), cols), 'text/csv');
}

function renderInsights(v) {
  const icons = { good: '✓', warn: '!', info: 'i' };
  const levels = { good: '好調', warn: '要注意', info: '参考' };
  const list = $('#insights');
  // GA4 の所見も同じレポートにまとめる
  const insights = [...v.insights, ...(v.traffic?.insights || [])];
  if (!insights.length) {
    list.replaceChildren(el('li', { className: 'info' }, el('span', { className: 'ic', textContent: 'i' }), el('strong', { textContent: 'データが少ないため分析できません' }), el('span', { className: 'tx', textContent: '期間を広げてください。' })));
    return;
  }
  list.replaceChildren(
    ...insights.map((i) =>
      el(
        'li',
        { className: i.level },
        el('span', { className: 'ic', textContent: icons[i.level], ariaHidden: 'true' }),
        el('strong', {}, i.title, el('span', { className: 'lv', textContent: levels[i.level] })),
        el('span', { className: 'tx', textContent: i.text }),
      ),
    ),
  );
}

/** データが無いグラフにはメッセージを出す */
function setEmpty(canvasId, empty, msg = 'この期間のデータがありません') {
  const wrap = document.getElementById(canvasId).parentElement;
  let note = wrap.querySelector('.empty-note');
  if (empty) {
    charts.getChart(canvasId)?.destroy();
    if (!note) {
      note = el('p', { className: 'empty-note sub' });
      note.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;margin:0';
      wrap.append(note);
    }
    note.textContent = msg;
  } else note?.remove();
  return empty;
}

function renderFollowerCharts(v) {
  const mode = v.followerMode;
  $('#net-title').textContent = mode === 'gains' ? '日次の新規フォロー数' : '日次の純増減（フォロー − フォロー解除）';
  $('#followers-sub').textContent = mode === 'gains' ? '日次（新規フォロー数からの推定値）' : '日次の総フォロワー数';

  if (!setEmpty('c-followers', !v.daily.some((d) => d.followers !== null))) charts.followerLine('c-followers', v.daily);
  if (!setEmpty('c-net', !v.daily.some((d) => d.netChange !== null)))
    charts.netChangeBars('c-net', v.daily, mode === 'gains' ? '新規フォロー' : '純増減');
}

/** アカウント全体の日次指標（リーチ・ビュー・プロフィールアクセス・リンククリック）と導線 */
function renderActivity(v) {
  const has = (key) => v.daily.some((d) => d[key] !== null);
  const reachSeries = [
    { key: 'reach', label: 'リーチ' },
    { key: 'nonFollowerReach', label: v.daily.some((d) => d.nonFollowerEstimated) ? 'フォロワー以外へのリーチ（推定）' : 'フォロワー以外へのリーチ', sameAxis: true },
    { key: 'views', label: 'ビュー' },
  ].filter((s) => has(s.key));
  const trafficSeries = [
    { key: 'profileVisits', label: 'プロフィールアクセス' },
    { key: 'linkClicks', label: 'リンククリック' },
    { key: 'interactions', label: 'コンテンツインタラクション' },
  ].filter((s) => has(s.key));

  const show = reachSeries.length || trafficSeries.length || v.steps.length;
  $('#activity-block').hidden = !show;
  if (!show) return;

  $('#reach-card').hidden = !reachSeries.length;
  if (reachSeries.length) {
    $('#reach-sub').textContent = reachSeries.map((s) => s.label).join(' と ') + 'の日次推移';
    if (!setEmpty('c-reach', false)) charts.multiLine('c-reach', v.daily, reachSeries);
  }

  $('#traffic-card').hidden = !trafficSeries.length;
  if (trafficSeries.length && !setEmpty('c-traffic', false)) charts.multiLine('c-traffic', v.daily, trafficSeries);

  $('#funnel-card').hidden = v.steps.length < 2;
  if (v.steps.length >= 2) charts.renderFunnel($('#funnel'), v.steps);
}

const statRow = (label, value, title = '') => [el('dt', { textContent: label, title }), el('dd', { textContent: value })];

/** 日次インサイトの内訳：どの面で見られたか・プロフィールからのアクション・リーチの内訳 */
function renderBreakdown(v) {
  const { surfaces, clicks, totals } = v.si;
  const hasSurface = surfaces.length > 1;
  const hasTotals = totals.nonFollowerReach !== null || totals.conversionRate !== null;

  $('#surface-row').hidden = !hasSurface && !hasTotals;
  $('#surface-card').hidden = !hasSurface;
  if (hasSurface && !setEmpty('c-surface', false)) {
    const series = [
      { key: 'reach', label: 'リーチ' },
      { key: 'views', label: '閲覧数' },
    ].filter((s) => surfaces.some((row) => row.values[s.key] !== null));
    charts.groupedHBar('c-surface', surfaces, series);
  }

  $('#account-totals-card').hidden = !hasTotals;
  if (hasTotals) {
    const rows = [
      ['リーチ（期間合計）', totals.reach],
      ['うちフォロワー', totals.followerReach],
      ['うちフォロワー以外', totals.nonFollowerReach],
    ].filter(([, value]) => value !== null).map(([label, value]) => statRow(label, fmtInt(value)));
    if (totals.nonFollowerShare !== null) rows.push(statRow('フォロワー以外の割合', fmtPct(totals.nonFollowerShare, 1), 'フォロワー以外 ÷（フォロワー＋フォロワー以外）'));
    if (totals.profileVisits !== null) rows.push(statRow('プロフィールアクセス', fmtInt(totals.profileVisits)));
    if (totals.follows !== null) rows.push(statRow('新規フォロー', fmtInt(totals.follows)));
    if (totals.conversionRate !== null) rows.push(statRow('フォロワー転換率', fmtPct(totals.conversionRate, 1), 'プロフィールに来た人のうち、フォローした割合'));
    if (totals.saves !== null) rows.push(statRow('保存', fmtInt(totals.saves)));
    $('#account-totals').replaceChildren(...rows.flat());
  }

  $('#clicks-card').hidden = !clicks.length;
  if (clicks.length && !setEmpty('c-clicks', false)) {
    charts.hBar('c-clicks', clicks.map((c) => ({ label: c.label, value: c.value })), { name: '件' });
  }
}

/** ストーリーズ：日ごとの推移・時間帯別の閲覧率・見た人のその後・一覧 */
function renderStories(v) {
  const { stories, storiesSummary: s, storiesDaily, storiesHours } = v.si;
  $('#stories-block').hidden = !stories.length;
  if (!stories.length) return;

  // 日ごとの閲覧数・リーチ。本数は桁が違うので右軸に置くが、
  // 毎日1本だと目盛りが潰れて読めないため、2本以上の日があるときだけ出す
  const maxPerDay = Math.max(0, ...storiesDaily.map((d) => d.n));
  const series = [
    { key: 'views', label: '閲覧数' },
    { key: 'reach', label: 'リーチ', sameAxis: true },
    ...(maxPerDay >= 2 ? [{ key: 'n', label: '本数' }] : []),
  ].filter((x) => storiesDaily.some((d) => d[x.key] !== null));
  $('#stories-chart-sub').textContent = `${series.map((x) => x.label).join('・')}（${storiesDaily.length}日分）`;
  if (!setEmpty('c-stories', false)) charts.multiLine('c-stories', storiesDaily, series);

  // 期間のまとめ
  $('#stories-sum-sub').textContent = `${s.days}日間で${fmtInt(s.n)}本（1日あたり ${s.perDay ? s.perDay.toFixed(1) : '–'}本）`;
  const rows = [];
  if (s.views !== null) rows.push(statRow('閲覧数（合計）', fmtInt(s.views)));
  if (s.viewsMean !== null) rows.push(statRow('平均閲覧数／本', fmtInt(Math.round(s.viewsMean))));
  if (s.viewRate !== null) rows.push(statRow('平均閲覧率', fmtPct(s.viewRate, 2), 'フォロワー数のうち何％が見たか'));
  if (s.reach !== null) rows.push(statRow('リーチ（合計）', fmtInt(s.reach)));
  if (s.exitRate !== null) rows.push(statRow('離脱率', fmtPct(s.exitRate, 1), '見た人のうち、そこで見るのをやめた割合'));
  if (s.nextRate !== null) rows.push(statRow('次へ送った率', fmtPct(s.nextRate, 1)));
  if (s.replies !== null) rows.push(statRow('返信', fmtInt(s.replies)));
  if (s.follows !== null) rows.push(statRow('フォロー（ストーリーズ経由）', fmtInt(s.follows)));
  if (s.profileVisits !== null) rows.push(statRow('プロフィール遷移', fmtInt(s.profileVisits)));
  if (s.linkClicks !== null) rows.push(statRow('リンククリック', fmtInt(s.linkClicks)));
  $('#stories-summary').replaceChildren(...rows.flat());

  // 時間帯別の平均閲覧率（本数の少ない枠は目安にならないので2本以上に限る）
  const hourRows = storiesHours.filter((h) => h.n >= 2 && h.viewRate !== null);
  const top3 = [...hourRows].sort((a, b) => b.viewRate - a.viewRate).slice(0, 3).map((h) => h.hour);
  if (!setEmpty('c-stories-hour', !hourRows.length, '同じ時間帯に2本以上のストーリーズがありません')) {
    charts.vBar(
      'c-stories-hour',
      hourRows.map((h) => ({ label: `${h.hour}時`, value: h.viewRate, sub: `${h.n}本` })),
      { unit: '%', name: '平均閲覧率', highlight: hourRows.map((h, i) => (top3.includes(h.hour) ? i : -1)).filter((i) => i >= 0) },
    );
  }

  // 見た人のその後（閲覧数に対する割合）
  const after = [
    { label: '次へ送った', value: s.nextRate },
    { label: '戻って見直した', value: s.backRate },
    { label: '離脱した', value: s.exitRate },
    { label: '次のアカウントへ', value: s.skipRate },
  ].filter((r) => r.value !== null);
  if (!setEmpty('c-stories-funnel', !after.length)) charts.hBar('c-stories-funnel', after, { unit: '%', name: '閲覧数に対する割合' });

  renderStoriesTable(stories);
}

function renderStoriesTable(list) {
  const STORY_TYPES = { VIDEO: '動画', IMAGE: '画像' };
  $('#stories-count').textContent = `${fmtInt(list.length)}件（新しい順）`;
  const frag = document.createDocumentFragment();
  for (const s of [...list].reverse().slice(0, 500)) {
    const tr = document.createElement('tr');
    tr.insertCell().textContent = fmtDateTime(s.timestamp);
    tr.insertCell().append(el('span', { className: 'type-tag' }, el('i', { className: s.type === 'VIDEO' ? 'REELS' : 'IMAGE' }), STORY_TYPES[s.type] || s.type));

    const text = s.caption.replace(/\s+/g, ' ').trim();
    const cap = el('span', { className: 'cap', textContent: text || '（テキストなし）' });
    tr.insertCell().append(s.permalink ? el('a', { href: s.permalink, target: '_blank', rel: 'noopener noreferrer' }, cap) : cap);

    for (const k of ['views', 'viewRate', 'reach', 'exits', 'tapsForward', 'tapsBack', 'replies', 'follows', 'profileVisits', 'linkClicks']) {
      const td = tr.insertCell();
      td.className = 'num';
      td.textContent = s[k] === null || s[k] === undefined ? '–' : k === 'viewRate' ? fmtPct(s[k], 2) : fmtInt(s[k]);
    }
    frag.append(tr);
  }
  $('#stories-table tbody').replaceChildren(frag);
}

/** ソーシャルインサイトのハッシュタグ分析（書き出し・期間ごとに切り替えて表示） */
function renderToolHashtags(v) {
  const sets = v.si.hashtagSets;
  $('#tool-hashtag-card').hidden = !sets.length;
  if (!sets.length) return;

  const select = $('#tool-hashtag-set');
  const current = sets.find((s) => s.key === state.settings.hashtagSet) || sets[0];
  select.replaceChildren(...sets.map((s) => el('option', { value: s.key, textContent: s.label, selected: s.key === current.key })));
  // 書き出しが1つしかないときは切り替えるものが無いので隠す
  select.closest('label').hidden = sets.length < 2;

  const views = current.rows.some((r) => r.viewsMean !== null);
  $('#tool-hashtag-sub').textContent = [
    current.start && current.end ? `${fmtDate(current.start)}〜${fmtDate(current.end)}の集計` : '期間不明の集計',
    `エンゲージメント率は${current.erBasis === 'views' ? '閲覧数' : 'フォロワー数'}基準`,
    'ツール側の集計値（表示中の期間には連動しません）',
  ].join(' / ');

  // 書き出しによって指標が違うので、列も切り替える
  const cols = [
    { label: 'ハッシュタグ', get: (r) => r.tag },
    { label: '投稿件数', num: true, get: (r) => fmtInt(r.posts) },
    ...(views
      ? [
        { label: '平均閲覧数', num: true, get: (r) => fmtInt(r.viewsMean) },
        { label: '平均リーチ', num: true, get: (r) => fmtInt(r.reachMean) },
        { label: '平均いいね', num: true, get: (r) => fmtInt(r.likesMean) },
        { label: '平均保存', num: true, get: (r) => fmtInt(r.savesMean) },
      ]
      : [
        { label: '平均いいね', num: true, get: (r) => fmtInt(r.likesMean) },
        { label: '平均コメント', num: true, get: (r) => (r.commentsMean === null ? '–' : r.commentsMean.toFixed(1)) },
      ]),
    { label: '平均ER', num: true, get: (r) => fmtPct(r.erMean, 2) },
    { label: '中央値ER', num: true, get: (r) => fmtPct(r.erMedian, 2) },
  ];
  const table = $('#tool-hashtag-table');
  table.tHead.replaceChildren(el('tr', {}, ...cols.map((c) => el('th', { textContent: c.label, className: c.num ? 'num' : '' }))));
  table.tBodies[0].replaceChildren(
    ...current.rows.slice(0, 60).map((r) => el('tr', {}, ...cols.map((c) => el('td', { textContent: c.get(r), className: c.num ? 'num' : '' })))),
  );
}

/** フォロー中アカウント（ベンチマーク）とタグ付き投稿 */
function renderBenchmark(v) {
  const { followed, benchmark, tagged } = v.si;
  $('#benchmark-block').hidden = !followed.length && !tagged.list.length;

  $('#followed-row').hidden = !followed.length;
  if (followed.length) {
    $('#followed-count').textContent = `${fmtInt(benchmark.n)}件 / フォロワー数の中央値 ${fmtInt(benchmark.followersMedian)}人・最大 ${fmtInt(benchmark.followersMax)}人`;
    $('#followed-table tbody').replaceChildren(
      ...followed.slice(0, 200).map((f) => {
        const tr = document.createElement('tr');
        const name = el('span', { className: 'cap', textContent: `@${f.username}` });
        tr.insertCell().append(f.url ? el('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer' }, name) : name);
        tr.insertCell().append(el('span', { className: 'cap', textContent: f.profile || '–' }));
        for (const k of ['followers', 'posts', 'follows']) {
          const td = tr.insertCell();
          td.className = 'num';
          td.textContent = fmtInt(f[k]);
        }
        return tr;
      }),
    );
    $('#followed-tags').replaceChildren(
      ...(benchmark.topHashtags.length
        ? benchmark.topHashtags.map((t) => statRow(`#${t.tag}`, `${t.n}アカウント`)).flat()
        : statRow('ハッシュタグの情報がありません', '–')),
    );
  }

  $('#tagged-card').hidden = !tagged.list.length;
  if (tagged.list.length) {
    $('#tagged-count').textContent = `${fmtInt(tagged.list.length)}件（${tagged.accounts.map((a) => `@${a.account} ${a.n}件`).join(' / ')}）`;
    $('#tagged-table tbody').replaceChildren(
      ...tagged.list.slice(0, 200).map((t) => {
        const tr = document.createElement('tr');
        tr.insertCell().textContent = fmtDateTime(t.timestamp);
        tr.insertCell().textContent = `@${t.account}`;
        tr.insertCell().textContent = t.type;
        const cap = el('span', { className: 'cap', textContent: t.caption.replace(/\s+/g, ' ').slice(0, 120) || '（キャプションなし）' });
        tr.insertCell().append(t.permalink ? el('a', { href: t.permalink, target: '_blank', rel: 'noopener noreferrer' }, cap) : cap);
        for (const k of ['likes', 'comments']) {
          const td = tr.insertCell();
          td.className = 'num';
          td.textContent = fmtInt(t[k]);
        }
        return tr;
      }),
    );
  }
}

/** HPへの流入（GA4）と、投稿との相関 */
function renderTraffic(v) {
  const t = v.traffic;
  $('#traffic-block').hidden = !t;
  if (!t) return;

  const b = t.breakdown;
  const weeks = t.joined.length;
  $('#traffic-lead').textContent =
    `Instagram から HP への流入を週単位で見ています。${t.properties.length ? `対象プロパティ: ${t.properties.join('・')}。` : ''}` +
    `GA4 側 ${t.gaWeeks.length}週、うち投稿データと突き合わせできたのは ${weeks}週です。`;

  // 週ごとの積み上げ
  const rows = t.gaWeeks.map((w) => ({ label: w.week.slice(5).replace('-', '/'), values: w }));
  const series = [{ key: 'organic', label: 'オーガニック' }];
  if (b.totals.paid > 0) series.push({ key: 'paid', label: '広告' });
  if (!setEmpty('c-traffic-weeks', !rows.length)) charts.stackedBars('c-traffic-weeks', rows, series);

  // 合計
  const pct = (a, bb) => (bb ? `${((a / bb) * 100).toFixed(1)}%` : '–');
  const stats = [
    ['Instagram 流入', `${fmtInt(b.totals.sessions)} セッション`],
    ['　うちオーガニック', `${fmtInt(b.totals.organic)}（${pct(b.totals.organic, b.totals.sessions)}）`],
    ['　うち広告', `${fmtInt(b.totals.paid)}（${pct(b.totals.paid, b.totals.sessions)}）`],
    ['ユーザー', fmtInt(b.totals.users)],
    ['新規ユーザー', `${fmtInt(b.totals.newUsers)}（${pct(b.totals.newUsers, b.totals.users)}）`],
    ['予約タップ', fmtInt(b.totals.reserveTaps)],
    ['予約タップ率（オーガニック）', b.organicTapRate === null ? '–' : `${b.organicTapRate.toFixed(2)}%`],
    ['予約タップ率（広告）', b.paidTapRate === null ? '–' : `${b.paidTapRate.toFixed(2)}%`],
    ['CV', fmtInt(b.totals.cv)],
  ];
  $('#traffic-summary').replaceChildren(
    ...stats.flatMap(([k, val]) => [el('dt', { textContent: k }), el('dd', { textContent: val })]),
  );

  renderCorrelation(v);

  // アカウント別
  const accRows = b.accounts.filter((a) => a.name).slice(0, 8).map((a) => ({
    label: a.name,
    value: a.sessions,
    sub: `全体の ${pct(a.sessions, b.totals.sessions)}`,
  }));
  if (!setEmpty('c-traffic-account', !accRows.length)) charts.hBar('c-traffic-account', accRows, { name: 'セッション' });

  // UTM キャンペーン別
  $('#campaign-card').hidden = !t.campaigns.length;
  if (t.campaigns.length) {
    $('#campaign-table tbody').replaceChildren(
      ...t.campaigns.slice(0, 25).map((c) => {
        const tr = document.createElement('tr');
        tr.insertCell().textContent = c.name;
        [fmtInt(c.sessions), fmtInt(c.users), fmtInt(c.taps), c.sessions ? `${((c.taps / c.sessions) * 100).toFixed(1)}%` : '–'].forEach((x) => {
          const td = tr.insertCell();
          td.className = 'num';
          td.textContent = x;
        });
        return tr;
      }),
    );
  }

  // リンククリックの到達率
  const land = t.landing;
  $('#landing-card').hidden = !land;
  if (land) {
    const tbody = $('#landing-table tbody');
    tbody.replaceChildren(
      ...land.rows.map((r) => {
        const tr = document.createElement('tr');
        tr.insertCell().textContent = fmtDate(r.week);
        [fmtInt(r.clicks), fmtInt(r.sessions), r.clicks ? `${((r.sessions / r.clicks) * 100).toFixed(1)}%` : '–'].forEach((x) => {
          const td = tr.insertCell();
          td.className = 'num';
          td.textContent = x;
        });
        return tr;
      }),
      (() => {
        const tr = el('tr', { className: 'total-row' });
        tr.insertCell().textContent = '合計';
        [fmtInt(land.clicks), fmtInt(land.sessions), land.rate === null ? '–' : `${land.rate.toFixed(1)}%`].forEach((x) => {
          const td = tr.insertCell();
          td.className = 'num';
          td.textContent = x;
        });
        return tr;
      })(),
    );
    $('#landing-note').textContent =
      land.rate !== null && land.rate < 60
        ? `リンククリックの ${(100 - land.rate).toFixed(0)}% は GA4 で計測できていません。プロフィールのリンク先が LINE や外部予約システムなど計測対象外になっているか、UTM が付いていない可能性があります。`
        : 'Instagram 上のクリック数と GA4 の流入は概ね一致しています。';
  }
}

/** 相関表と散布図 */
function renderCorrelation(v) {
  const t = v.traffic;
  const targetSel = $('#corr-target');
  if (!targetSel.options.length) {
    for (const x of TARGETS) targetSel.append(el('option', { value: x.key, textContent: `${x.label} との相関` }));
  }
  targetSel.value = t.target;

  const driverSel = $('#scatter-driver');
  const usable = t.table.map((x) => x.key);
  const sig = usable.join('|');
  if (driverSel.dataset.sig !== sig) {
    driverSel.dataset.sig = sig;
    driverSel.replaceChildren(...DRIVERS.filter((d) => usable.includes(d.key)).map((d) => el('option', { value: d.key, textContent: d.label })));
  }
  if (usable.includes(t.driverKey)) driverSel.value = t.driverKey;

  const tbody = $('#corr-table tbody');
  const label = TARGETS.find((x) => x.key === t.target)?.label ?? '';
  $('#corr-sub').textContent = `週ごとの「投稿側の指標」と「${label}」の関係。n=${t.joined.length}週`;

  if (!t.table.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 9, textContent: '相関を出すには、投稿データと GA4 が重なる週が3週以上必要です。' })));
    $('#corr-note').textContent = '';
    setEmpty('c-scatter', true, 'データが足りません');
    return;
  }

  const num = (x, digits = 2) => (x === null || x === undefined || Number.isNaN(x) ? '–' : (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(digits));
  const sorted = [...t.table].sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  tbody.replaceChildren(
    ...sorted.map((c) => {
      const tr = document.createElement('tr');
      tr.insertCell().textContent = c.label;
      const cells = [
        { v: num(c.r), cls: Math.abs(c.r) >= 0.4 ? (c.r > 0 ? 'lift-up' : 'lift-down') : '' },
        { v: num(c.rho) },
        { v: c.p === null ? '–' : c.p.toFixed(3), cls: c.significant ? 'lift-up' : '' },
        { v: c.ci ? `${num(c.ci[0])} 〜 ${num(c.ci[1])}` : '–' },
        { v: num(c.partial) },
        { v: num(c.deltaR) },
      ];
      for (const cell of cells) {
        const td = tr.insertCell();
        td.className = `num ${cell.cls || ''}`.trim();
        td.textContent = cell.v;
      }
      tr.insertCell().textContent = readCorrelation(c);
      const est = tr.insertCell();
      est.className = 'num';
      est.textContent = describeEstimate(c, t.target);
      return tr;
    }),
  );
  $('#corr-note').textContent =
    'r は −1〜+1 の相関の強さ。p 値が 0.05 未満なら「偶然とは考えにくい」目安です。' +
    '「時期の影響を除いた r」は週の順番を差し引いた値、「増減どうしの r」は前の週からの変化どうしの相関で、' +
    'どちらも元の r より大きく下がる場合は、両方が同時期に伸びただけの見かけの相関を疑ってください。' +
      '「推定値」は週ごとの値から引いた回帰直線の傾きで、投稿側の指標が増えたときに増える流入（獲得数）の目安です。有意でない指標は（参考）としています。相関は因果ではありません。';

  if (t.scatter && !setEmpty('c-scatter', t.scatter.points.length < 3)) {
    const d = DRIVERS.find((x) => x.key === t.driverKey);
    charts.scatter('c-scatter', t.scatter.points, t.scatter.fit, { xLabel: d?.label ?? '', yLabel: label });
    const c = t.table.find((x) => x.key === t.driverKey);
    $('#scatter-sub').textContent = c
      ? `点＝1週間（n=${c.n}）・r=${num(c.r)}・p=${c.p.toFixed(3)}。直線は傾向を示すだけで、因果ではありません`
      : '点＝1週間。直線は傾向を示すだけで、因果ではありません';
  }
}

/** フォロワーの内訳（年齢×性別・国・都市）。期間ではなく「現在の構成」を表す */
function renderAudience(v) {
  const a = v.audience;
  const show = !!a && (a.ageGender.length || a.countries.length || a.cities.length);
  $('#audience-block').hidden = !show;
  if (!show) return;

  const lead = ['Meta の「オーディエンス」エクスポートから読み取った、現在のフォロワーの構成です（期間の切り替えには連動しません）。'];
  if (a.followersTotal) lead.unshift(`フォロワー ${fmtInt(a.followersTotal)}人。`);
  if (a.topGender && a.topAge) lead.push(`中心は ${a.topGender.label}・${a.topAge.age}歳（${fmtPct(a.topAge.value, 1)}）です。`);
  $('#audience-lead').textContent = lead.join('');

  $('#age-card').hidden = !a.ageGender.length;
  if (a.ageGender.length) {
    const rows = a.ageGender.map((r) => ({ label: `${r.age}歳`, values: r }));
    if (!setEmpty('c-age', false)) charts.groupedHBar('c-age', rows, a.series, { unit: '%' });
  }

  const pieces = [
    ['#country-card', 'c-country', a.countries, '国'],
    ['#city-card', 'c-city', a.cities, '都市'],
  ];
  for (const [card, canvas, rows, name] of pieces) {
    $(card).hidden = !rows.length;
    if (!rows.length) continue;
    const data = rows.slice(0, 10).map((r) => ({ label: r.name, value: +r.value.toFixed(2), sub: `フォロワー全体の ${fmtPct(r.value, 1)}` }));
    if (!setEmpty(canvas, false)) charts.hBar(canvas, data, { unit: '%', name: `${name}別の割合` });
  }
}

function renderEngagementCharts(v) {
  $('#er-def').textContent =
    state.settings.basis === 'reach'
      ? 'ER ＝（いいね＋コメント＋保存＋シェア）÷ リーチ × 100'
      : 'ER ＝（いいね＋コメント＋保存＋シェア）÷ 投稿時点のフォロワー数 × 100';
  const typeMeta = TYPE_ORDER.map((type) => ({ type, label: TYPE_LABELS[type] }));
  if (!setEmpty('c-er', !v.posts.some((p) => p.er !== null))) charts.erScatter('c-er', v.posts, weeklyER(v.posts), typeMeta);

  const rows = v.types
    .filter((t) => t.er !== null)
    .map((t) => ({
      label: t.label,
      value: +t.er.toFixed(3),
      sub: `${t.n}投稿 ・ 平均リーチ ${fmtInt(t.reach)} ・ 平均保存 ${t.saves.toFixed(1)}`,
    }));
  if (!setEmpty('c-type', !rows.length)) charts.hBar('c-type', rows, { unit: '%', name: '平均ER' });
}

function renderTopPosts(v) {
  const select = $('#top-metric');
  if (!select.options.length) {
    for (const [key, m] of Object.entries(METRICS)) select.append(el('option', { value: key, textContent: `${m.label}順` }));
  }
  // 以前選べた並べ替え（非フォロワーのリーチ順など）が保存されていたら ER 順に戻す
  if (!METRICS[state.settings.topMetric]) state.settings.topMetric = 'er';
  select.value = state.settings.topMetric;
  const metric = METRICS[state.settings.topMetric];
  const top = topPosts(v.posts, state.settings.topMetric, 10);
  const rows = top.map((p) => {
    const d = jstParts(p.timestamp);
    const text = firstLine(p.caption);
    return {
      label: `${d.month}/${d.day} ${text.length > 12 ? `${text.slice(0, 12)}…` : text}`,
      title: `${fmtDateTime(p.timestamp)} ・ ${TYPE_LABELS[p.type]}`,
      value: metric.unit === '%' ? +metric.get(p).toFixed(3) : metric.get(p),
      sub: [text.slice(0, 40), `ER ${fmtPct(p.er)} ・ リーチ ${fmtInt(p.reach)} ・ 反応 ${fmtInt(p.interactions)}`],
      permalink: p.permalink,
    };
  });
  if (!setEmpty('c-top', !rows.length))
    charts.hBar('c-top', rows, {
      unit: metric.unit,
      name: metric.label,
      onClick: (r) => r.permalink && window.open(r.permalink, '_blank', 'noopener'),
    });
}

function filteredPosts() {
  const q = state.search.trim().toLowerCase();
  const hit = (p) => `${p.caption} ${p.account} ${p.accountName}`.toLowerCase().includes(q);
  const list = q ? state.view.posts.filter(hit) : [...state.view.posts];
  const { key, dir } = state.settings.sort;
  const val = (p) => (key === 'type' ? TYPE_LABELS[p.type] : p[key]);
  list.sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return dir === 'asc' ? c : -c;
  });
  return list;
}

function renderPostsTable() {
  const list = filteredPosts();
  const maxER = Math.max(0, ...list.map((p) => p.er ?? 0));
  const multiAccount = !state.view.account && state.view.accounts.length > 1;
  // データに無い列は見出しごと隠す
  const hasCol = {
    views: list.some((p) => p.views !== null),
    nonFollowerReach: list.some((p) => p.nonFollowerReach !== null && p.nonFollowerReach !== undefined),
    follows: list.some((p) => p.follows !== null),
    // ソーシャルインサイトの投稿インサイトにだけある指標
    profileVisits: list.some((p) => p.profileVisits !== null && p.profileVisits !== undefined),
    avgWatchSec: list.some((p) => p.avgWatchSec !== null && p.avgWatchSec !== undefined),
  };
  for (const [key, on] of Object.entries(hasCol)) {
    $$(`#posts-table .col-${key}`).forEach((th) => (th.hidden = !on));
  }
  $('#posts-count').textContent = `${list.length}件${state.search ? `（「${state.search}」で絞り込み）` : ''}`;
  $$('#posts-table th[data-sort]').forEach((th) => {
    th.setAttribute('aria-sort', th.dataset.sort === state.settings.sort.key ? (state.settings.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  const tbody = $('#posts-table tbody');
  const frag = document.createDocumentFragment();
  for (const p of list.slice(0, 500)) {
    const tr = document.createElement('tr');
    tr.insertCell().textContent = fmtDateTime(p.timestamp);
    tr.insertCell().append(el('span', { className: 'type-tag' }, el('i', { className: p.type }), TYPE_LABELS[p.type]));

    const thumb = p.thumbnail
      ? el('img', { className: 'thumb', src: p.thumbnail, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
      : el('span', { className: 'thumb', textContent: TYPE_LABELS[p.type].slice(0, 2) });
    if (p.thumbnail) thumb.addEventListener('error', () => thumb.replaceWith(el('span', { className: 'thumb', textContent: TYPE_LABELS[p.type].slice(0, 2) })));
    const cap = el('span', { className: 'cap', textContent: p.caption.replace(/\s+/g, ' ').slice(0, 120) || '（キャプションなし）' });
    const content = p.permalink ? el('a', { href: p.permalink, target: '_blank', rel: 'noopener noreferrer' }, cap) : cap;
    const body = el('div', { className: 'post-body' }, content);
    // 複数アカウントを一度に見ているときは、どちらの投稿か分かるようにする
    if (multiAccount && p.account) body.prepend(el('span', { className: 'acct-tag', textContent: `@${p.account}` }));
    tr.insertCell().append(el('div', { className: 'post-cell' }, thumb, body));

    for (const k of ['views', 'reach', 'nonFollowerReach', 'likes', 'comments', 'saves', 'shares', 'follows', 'profileVisits', 'avgWatchSec', 'interactions']) {
      const td = tr.insertCell();
      td.className = `num${k in hasCol ? ` col-${k}` : ''}`;
      td.hidden = k in hasCol && !hasCol[k];
      // 推定値には ≈ を付けて実数と区別する
      if (k === 'nonFollowerReach' && p.nonFollowerEstimated) {
        td.textContent = `≈${fmtInt(p[k])}`;
        td.title = 'リーチ × 非フォロワー比率による推定値';
      } else if (k === 'avgWatchSec') {
        td.textContent = p[k] === null || p[k] === undefined ? '–' : `${p[k].toFixed(1)}秒`;
      } else td.textContent = fmtInt(p[k]);
    }
    const erTd = tr.insertCell();
    erTd.className = 'num';
    if (p.er !== null) {
      const bar = el('span', { className: 'er-bar' });
      bar.style.width = `${Math.max(2, (p.er / maxER) * 48)}px`;
      erTd.append(bar, fmtPct(p.er));
    } else erTd.textContent = '–';
    frag.append(tr);
  }
  tbody.replaceChildren(frag);
}

function renderTiming(v) {
  const best = bestSlots(v.heatmap, { top: 3 });
  const cont = $('#heatmap');
  if (v.posts.some((p) => p.er !== null)) charts.renderHeatmap(cont, v.heatmap, best, WEEKDAYS, $('#tooltip'));
  else cont.replaceChildren(el('p', { className: 'sub', textContent: 'この期間の投稿データがありません' }));

  const list = $('#best-slots');
  const slots = bestSlots(v.heatmap, { top: 5 });
  if (!slots.length) {
    list.replaceChildren(el('li', { className: 'none', textContent: '同じ曜日・時間帯に2件以上の投稿がまだありません。期間を広げてください。' }));
  } else {
    list.replaceChildren(
      ...slots.map((c, i) =>
        el(
          'li',
          {},
          el('span', { className: 'rank', textContent: String(i + 1) }),
          el('div', {}, el('div', { className: 'when', textContent: `${WEEKDAYS[c.weekday]}曜 ${c.startHour}:00〜${c.endHour}:00` }), el('div', { className: 'meta', textContent: `${c.n}投稿 ・ 全体平均比 ${c.mean >= v.heatmap.overall ? '+' : '−'}${Math.abs((c.mean / v.heatmap.overall - 1) * 100).toFixed(0)}%` })),
          el('span', { className: 'val', textContent: fmtPct(c.mean) }),
        ),
      ),
    );
  }

  const topIdx = (rows, n) =>
    rows
      .map((r, i) => ({ i, r }))
      .filter(({ r }) => r.n >= 2 && r.mean !== null)
      .sort((a, b) => b.r.mean - a.r.mean)
      .slice(0, n)
      .map(({ i }) => i);

  const hourRows = v.hours.map((h) => ({ label: `${h.key}`, title: `${h.key}:00〜${h.key}:59`, value: h.mean === null ? null : +h.mean.toFixed(3), sub: h.n ? `${h.n}投稿` : '' }));
  if (!setEmpty('c-hour', !v.hours.some((h) => h.n))) charts.vBar('c-hour', hourRows, { unit: '%', name: '平均ER', highlight: topIdx(v.hours, 3) });

  const wdRows = v.weekdays.map((w) => ({ label: WEEKDAYS[w.key], title: `${WEEKDAYS[w.key]}曜日`, value: w.mean === null ? null : +w.mean.toFixed(3), sub: w.n ? `${w.n}投稿` : '' }));
  if (!setEmpty('c-weekday', !v.weekdays.some((w) => w.n))) charts.vBar('c-weekday', wdRows, { unit: '%', name: '平均ER', highlight: topIdx(v.weekdays, 2) });
}

function renderHashtags(v) {
  const tbody = $('#hashtag-table tbody');
  if (!v.hashtags.length) {
    tbody.replaceChildren(el('tr', {}, el('td', { colSpan: 5, textContent: '2回以上使われたハッシュタグがありません' })));
    return;
  }
  tbody.replaceChildren(
    ...v.hashtags.slice(0, 40).map((h) => {
      const tr = document.createElement('tr');
      tr.insertCell().textContent = h.tag;
      const cells = [fmtInt(h.n), fmtPct(h.er), null, fmtInt(h.reach)];
      cells.forEach((c, i) => {
        const td = tr.insertCell();
        td.className = 'num';
        if (i === 2) {
          if (h.lift === null) td.textContent = '–';
          else {
            td.className = `num ${h.lift >= 0 ? 'lift-up' : 'lift-down'}`;
            td.textContent = `${h.lift >= 0 ? '▲ +' : '▼ −'}${Math.abs(h.lift).toFixed(0)}%`;
          }
        } else td.textContent = c;
      });
      return tr;
    }),
  );
}

// ---------- 「表で見る」切り替え ----------

function setupTableToggles() {
  for (const card of $$('.card[data-chart], .card[data-heatmap]')) {
    const header = card.querySelector('header');
    let actions = header.querySelector('.card-actions');
    if (!actions) {
      actions = el('div', { className: 'card-actions' });
      // 既存のコントロール（指標選択など）もアクション領域へまとめる
      [...header.children].slice(1).forEach((c) => actions.append(c));
      header.append(actions);
    }
    const btn = el('button', { type: 'button', className: 'btn ghost view-toggle', textContent: '表で見る' });
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      const key = card.dataset.chart || 'heatmap';
      if (state.tableViews.has(key)) state.tableViews.delete(key);
      else state.tableViews.add(key);
      refreshTableViews();
    });
    actions.append(btn);
  }
}

function heatmapTable() {
  const t = el('table', { className: 'data-table' });
  const head = t.createTHead().insertRow();
  ['曜日', '時間帯', '投稿数', '平均ER', '補正スコア'].forEach((h) => head.append(el('th', { textContent: h })));
  const body = t.createTBody();
  for (const c of state.view.heatmap.cells) {
    if (!c.n) continue;
    const r = body.insertRow();
    [WEEKDAYS[c.weekday], `${c.startHour}〜${c.endHour}時`, c.n, fmtPct(c.mean), fmtPct(c.score)].forEach((v) => (r.insertCell().textContent = v));
  }
  return t;
}

function refreshTableViews() {
  for (const card of $$('.card[data-chart], .card[data-heatmap]')) {
    const key = card.dataset.chart || 'heatmap';
    const on = state.tableViews.has(key);
    const btn = card.querySelector('.view-toggle');
    btn.textContent = on ? 'グラフで見る' : '表で見る';
    btn.setAttribute('aria-pressed', String(on));
    const visual = key === 'heatmap' ? [$('#heatmap'), card.querySelector('.scale')] : [card.querySelector('.chart')];
    visual.forEach((n) => (n.hidden = on));
    card.querySelector('.chart-table')?.remove();
    if (!on) continue;
    let table;
    if (key === 'heatmap') table = heatmapTable();
    else {
      const chart = charts.getChart(key);
      table = chart ? charts.chartTable(chart) : el('p', { className: 'sub', textContent: 'データがありません' });
    }
    card.append(el('div', { className: 'chart-table' }, table));
  }
}

// ---------- データ読み込み ----------

function setDataset(ds, message) {
  state.dataset = ds;
  if (!store.saveDataset(ds)) toast('ブラウザの保存容量が不足しているため、データは再読み込みで消えます');
  render();
  if (message) toast(message);
}

/**
 * 複数ファイルをまとめて取り込む。1ファイルが読めなくても残りは取り込み、最後にまとめて報告する。
 * Meta のエクスポートは指標ごとにファイルが分かれているため、日次データは日付単位でマージする。
 */
async function handleCSVFiles(files) {
  const status = $('#csv-status');
  status.className = 'status';
  const merge = $('#csv-merge').checked && state.dataset && state.dataset.source !== 'demo';
  let posts = merge ? state.dataset.posts || [] : [];
  let daily = merge ? state.dataset.daily || [] : [];
  let audience = merge ? state.dataset.audience || null : null;
  let ga4 = merge ? state.dataset.ga4 || [] : [];
  let reachBreakdown = merge ? state.dataset.reachBreakdown || [] : [];
  let hashtags = merge ? state.dataset.hashtags || [] : [];
  let followed = merge ? state.dataset.followed || [] : [];
  let accountDaily = merge ? state.dataset.accountDaily || [] : [];
  let stories = merge ? state.dataset.stories || [] : [];
  let tagged = merge ? state.dataset.tagged || [] : [];
  // 投稿・日次を含まない補助データ（リーチ内訳・ハッシュタグ分析・フォロー中アカウント）だけの取り込みか
  let sideFiles = 0;
  const done = [];
  const failed = [];
  const notes = [];

  for (const f of files) {
    try {
      const buffer = await f.arrayBuffer();
      if (isXlsxName(f.name)) {
        // Excel は GA4 の流入データとして読む
        const sheets = await readWorkbook(buffer);
        const res = importGA4Workbook(sheets, { property: propertyFromFileName(f.name) });
        if (!res) throw new Error('「日付・参照元/メディア・セッション」の列がある表が見つかりませんでした');
        ga4 = mergeGA4(ga4, res.rows);
        done.push(`${f.name}: GA4 流入 ${res.rows.length}行（${res.sheets.join('・')}）`);
        continue;
      }

      const text = decodeCSV(buffer);
      if (looksGarbled(text)) {
        throw new Error(
          '文字化けしているため読み込めません。BOM の無い UTF-8 の CSV を Excel で開いて保存すると、日本語やカンマが壊れます。' +
            '元のファイルを読み込み直すか、メモ帳などで「UTF-8（BOM 付き）」として保存し直してください。',
        );
      }
      // リーチのフォロワー／非フォロワー内訳（期間の集計）
      const mix = readReachBreakdown(parseCSV(text));
      if (mix) {
        reachBreakdown = mergeReachBreakdown(reachBreakdown, mix);
        sideFiles++;
        done.push(`${f.name}: リーチ内訳 ${mix.length}件（${describeBreakdowns(mix).join('・')}）`);
        continue;
      }
      // ソーシャルインサイトの書き出し（投稿一覧・ハッシュタグ分析・フォロー中アカウント一覧）
      const si = readSocialInsight(parseCSV(text), { fileName: f.name });
      if (si) {
        if (si.posts.length) posts = store.mergePosts(posts, si.posts);
        if (si.daily.length) daily = store.mergeDaily(daily, si.daily);
        if (si.summary.length) accountDaily = mergeSummary(accountDaily, si.summary);
        if (si.stories.length) stories = mergeStories(stories, si.stories);
        if (si.tagged.length) tagged = mergeTagged(tagged, si.tagged);
        if (si.hashtags.length) hashtags = mergeHashtags(hashtags, si.hashtags);
        if (si.followed.length) followed = mergeFollowed(followed, si.followed);
        if (!si.posts.length && !si.daily.length) sideFiles++;
        done.push(`${f.name}: ${describeSocialInsight(si)}`);
        continue;
      }
      // まず GA4 の CSV かどうかを見る（Instagram の CSV とは列が違う）
      const ga = readGA4Table(parseCSV(text));
      if (ga) {
        const rows = ga.rows.map((r) => ({ ...r, property: propertyFromFileName(f.name) }));
        ga4 = mergeGA4(ga4, rows);
        done.push(`${f.name}: GA4 流入 ${rows.length}行`);
        continue;
      }

      const res = importCSV(text, { fileName: f.name });
      if (res.posts.length) posts = store.mergePosts(posts, res.posts);
      if (res.daily.length) daily = store.mergeDaily(daily, res.daily);
      if (res.audience) audience = store.mergeAudience(audience, res.audience);
      notes.push(...res.notes);
      done.push(`${f.name}: ${describeImport(res)}`);
    } catch (e) {
      failed.push(`${f.name}: ${e.message}`);
    }
  }

  if (!done.length) {
    status.className = 'status error';
    status.textContent = `読み込みに失敗しました。${failed.join(' / ')}`;
    return;
  }

  // 補助データだけを読み込んだときは、表示中のデータ（デモを含む）に追加する
  if (sideFiles === done.length && state.dataset) {
    setDataset(
      {
        ...state.dataset,
        reachBreakdown: mergeReachBreakdown(state.dataset.reachBreakdown || [], reachBreakdown),
        hashtags: mergeHashtags(state.dataset.hashtags || [], hashtags),
        followed: mergeFollowed(state.dataset.followed || [], followed),
        accountDaily: mergeSummary(state.dataset.accountDaily || [], accountDaily),
        stories: mergeStories(state.dataset.stories || [], stories),
        tagged: mergeTagged(state.dataset.tagged || [], tagged),
      },
      '補助データ（リーチ内訳・ハッシュタグ分析など）を取り込みました',
    );
    status.replaceChildren(el('span', { textContent: done.join(' / ') }), ...failed.map((x) => el('span', { className: 'note error', textContent: `読めませんでした → ${x}` })));
    return;
  }

  const normalized = normalizeDaily(anchorFollowers(daily, audience));
  const lastF = audience?.followersTotal ?? normalized.findLast((d) => d.followers !== null)?.followers ?? null;
  setDataset(
    {
      source: merge && state.dataset.source !== 'demo' ? state.dataset.source : 'csv',
      account: { ...(merge ? state.dataset.account : {}), username: merge ? state.dataset.account?.username : '', followersCount: lastF },
      daily,
      posts,
      audience,
      ga4,
      reachBreakdown,
      hashtags,
      followed,
      accountDaily,
      stories,
      tagged,
      followerMode: detectFollowerMode(normalized),
      fetchedAt: new Date().toISOString(),
    },
    failed.length ? `${done.length}件を取り込み、${failed.length}件は読めませんでした` : '取り込みが完了しました',
  );
  if (failed.length) status.className = 'status warn';
  status.replaceChildren(
    el('span', { textContent: done.join(' / ') }),
    ...[...new Set(notes)].map((n) => el('span', { className: 'note', textContent: n })),
    ...failed.map((f) => el('span', { className: 'note error', textContent: `読めませんでした → ${f}` })),
  );
}

async function handleAPISubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const f = Object.fromEntries(new FormData(form));
  const status = $('#api-status');
  const submit = form.querySelector('[type=submit]');
  status.className = 'status';
  submit.disabled = true;
  const opts = {
    token: f.token,
    host: f.host,
    userId: f.userId || 'me',
    version: f.version || 'v23.0',
    postLimit: Math.max(5, Math.min(500, Number(f.postLimit) || 50)),
  };
  state.settings.api = { host: opts.host, userId: opts.userId, version: opts.version, postLimit: opts.postLimit, token: f.remember ? opts.token : undefined, remember: !!f.remember };
  persistSettings();
  try {
    const { dataset, warnings } = await fetchFromGraph(opts, (msg) => (status.textContent = msg));
    // 同じアカウントなら過去の取得分とマージして履歴を積み上げる（API は日次データを30日分しか返さないため）
    const prev = state.dataset;
    if (prev?.source === 'api' && prev.account?.username === dataset.account.username) {
      dataset.daily = store.mergeDaily(prev.daily, dataset.daily);
      dataset.posts = store.mergePosts(prev.posts, dataset.posts);
    }
    // CSV で取り込んだ GA4・リーチ内訳・ソーシャルインサイトの補助データは、API で取り直しても残す
    if (prev?.ga4?.length) dataset.ga4 = prev.ga4;
    if (prev?.reachBreakdown?.length) dataset.reachBreakdown = prev.reachBreakdown;
    if (prev?.hashtags?.length) dataset.hashtags = prev.hashtags;
    if (prev?.followed?.length) dataset.followed = prev.followed;
    if (prev?.accountDaily?.length) dataset.accountDaily = prev.accountDaily;
    if (prev?.stories?.length) dataset.stories = prev.stories;
    if (prev?.tagged?.length) dataset.tagged = prev.tagged;
    dataset.warnings = warnings;
    setDataset(dataset, `@${dataset.account.username} のデータを取得しました`);
    status.textContent = `完了：投稿 ${dataset.posts.length}件 ・ 日次 ${dataset.daily.length}日分`;
    $('#data-dialog').close();
  } catch (err) {
    status.className = 'status error';
    status.textContent = `取得に失敗しました: ${err.message}`;
  } finally {
    submit.disabled = false;
  }
}

async function handleFindIG() {
  const form = $('#api-form');
  const status = $('#api-status');
  status.className = 'status';
  try {
    if (form.host.value !== 'facebook') {
      form.userId.value = 'me';
      status.textContent = 'Instagram ログインでは「me」で自分のアカウントを指定できます。';
      return;
    }
    status.textContent = 'ビジネスアカウントを検索中…';
    const client = new GraphClient({ token: form.token.value, host: 'facebook', version: form.version.value || 'v23.0' });
    const accounts = await client.findInstagramAccounts();
    if (!accounts.length) throw new Error('Facebook ページに接続された Instagram ビジネスアカウントが見つかりません');
    form.userId.value = accounts[0].id;
    status.textContent = accounts.map((a) => `@${a.username}（${a.page}）: ${a.id}`).join(' / ');
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  }
}

// ---------- レポート出力 ----------

/** 表示中の期間・絞り込みの内容を、すべての数値と分析を含む1ファイルに書き出す */
function exportReport(format) {
  if (!state.view) return toast('出力するデータがありません');
  const generatedAt = new Date();
  const report = buildReport(state.view, {
    dataset: state.dataset,
    settings: state.settings,
    warnings: warningMessages(state.view),
    generatedAt,
  });
  if (format === 'docx') download(`${report.fileBase}.docx`, toDocx(report, generatedAt), DOCX_MIME);
  else download(`${report.fileBase}.md`, toMarkdown(report), 'text/markdown;charset=utf-8');
  toast('レポートを出力しました');
}

function setExportMenu(open) {
  $('#export-list').hidden = !open;
  $('#export-toggle').setAttribute('aria-expanded', String(open));
}

// ---------- ダイアログ ----------

function openDialog(tab = 'api') {
  const dlg = $('#data-dialog');
  selectTab(tab);
  const api = state.settings.api || {};
  const form = $('#api-form');
  form.host.value = api.host || 'instagram';
  form.userId.value = api.userId || '';
  form.version.value = api.version || 'v23.0';
  form.postLimit.value = api.postLimit || 50;
  form.remember.checked = !!api.remember;
  if (api.token) form.token.value = api.token;
  dlg.showModal();
}

function selectTab(name) {
  $$('#data-dialog [role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('#data-dialog .tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
}

// ---------- イベント ----------

function bindEvents() {
  $('#theme-toggle').addEventListener('click', toggleTheme);
  media.addEventListener('change', () => {
    resolveTheme();
    render();
  });
  $('#export-toggle').addEventListener('click', () => setExportMenu($('#export-list').hidden));
  $('#export-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-export]');
    if (!b) return;
    setExportMenu(false);
    try {
      exportReport(b.dataset.export);
    } catch (err) {
      toast(`レポートを出力できませんでした: ${err.message}`);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#export-menu')) setExportMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#export-list').hidden) {
      setExportMenu(false);
      $('#export-toggle').focus();
    }
  });
  $('#open-data').addEventListener('click', () => openDialog(state.dataset?.source === 'csv' ? 'csv' : 'api'));
  $$('[data-open-tab]').forEach((b) => b.addEventListener('click', () => openDialog(b.dataset.openTab)));
  $$('#data-dialog [role=tab]').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  // 推移ページ
  $('#trend-unit').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-unit]');
    if (!b) return;
    state.settings.trendUnit = b.dataset.unit;
    persistSettings();
    render();
  });
  $('#trend-metric').addEventListener('change', (e) => {
    state.trend = e.target.value;
    history.replaceState(null, '', `?trend=${encodeURIComponent(state.trend)}`);
    render();
  });
  $('#trend-csv').addEventListener('click', exportTrendCSV);
  // 元のタブでデータや設定（ER の基準・アカウント）が変わったら、推移ページにも反映する
  window.addEventListener('storage', () => {
    if (!state.trend) return;
    state.dataset = store.loadDataset();
    state.settings = { ...DEFAULTS, ...store.loadSettings() };
    render();
  });

  const loadDemo = () => {
    setDataset(generateDemo(), 'デモデータを読み込みました');
    $('#data-dialog').close();
  };
  $('#empty-demo').addEventListener('click', loadDemo);
  $('#load-demo').addEventListener('click', loadDemo);

  $('#range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    state.settings.days = Number(b.dataset.days);
    persistSettings();
    render();
  });
  $('#er-basis').addEventListener('change', (e) => {
    state.settings.basis = e.target.value;
    persistSettings();
    render();
  });
  $('#account-filter').addEventListener('change', (e) => {
    state.settings.account = e.target.value;
    persistSettings();
    render();
  });
  $('#corr-target').addEventListener('change', (e) => {
    state.settings.corrTarget = e.target.value;
    persistSettings();
    render();
  });
  $('#scatter-driver').addEventListener('change', (e) => {
    state.settings.scatterDriver = e.target.value;
    persistSettings();
    render();
  });
  $('#top-metric').addEventListener('change', (e) => {
    state.settings.topMetric = e.target.value;
    persistSettings();
    renderTopPosts(state.view);
    refreshTableViews();
  });

  $('#post-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderPostsTable();
  });
  $$('#posts-table th[data-sort]').forEach((th) =>
    th.addEventListener('click', () => {
      const s = state.settings.sort;
      state.settings.sort = s.key === th.dataset.sort ? { key: s.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: th.dataset.sort, dir: 'desc' };
      persistSettings();
      renderPostsTable();
    }),
  );
  $('#export-posts').addEventListener('click', () => {
    const cols = [
      { label: '投稿日時', get: (p) => fmtDateTime(p.timestamp) },
      { label: 'アカウント', get: (p) => p.account },
      { label: 'タイプ', get: (p) => TYPE_LABELS[p.type] },
      { label: 'キャプション', get: (p) => p.caption },
      { label: 'ビュー', get: (p) => p.views },
      { label: 'リーチ', get: (p) => p.reach },
      { label: 'フォロワー以外へのリーチ', get: (p) => p.nonFollowerReach },
      { label: 'フォロワー以外へのリーチは推定', get: (p) => (p.nonFollowerEstimated ? '推定' : '') },
      { label: 'いいね', get: (p) => p.likes },
      { label: 'コメント', get: (p) => p.comments },
      { label: '保存', get: (p) => p.saves },
      { label: 'シェア', get: (p) => p.shares },
      { label: 'この投稿からのフォロー', get: (p) => p.follows },
      { label: '反応数合計', get: (p) => p.interactions },
      { label: 'エンゲージメント率(%)', get: (p) => (p.er === null ? '' : p.er.toFixed(2)) },
      { label: 'URL', get: (p) => p.permalink },
    ];
    download(`instagram_posts_${state.view.startKey}_${state.view.endKey}.csv`, toCSV(filteredPosts(), cols), 'text/csv');
  });

  // ソーシャルインサイトのハッシュタグ分析：見る書き出し・期間の切り替え
  $('#tool-hashtag-set').addEventListener('change', (e) => {
    state.settings.hashtagSet = e.target.value;
    persistSettings();
    render();
  });

  $('#export-stories').addEventListener('click', () => {
    const cols = [
      { label: '投稿日時', get: (s) => fmtDateTime(s.timestamp) },
      { label: '種別', get: (s) => (s.type === 'VIDEO' ? '動画' : '画像') },
      { label: 'テキスト', get: (s) => s.caption },
      { label: '閲覧数', get: (s) => s.views },
      { label: '閲覧率(%)', get: (s) => s.viewRate },
      { label: 'リーチ', get: (s) => s.reach },
      { label: '離脱', get: (s) => s.exits },
      { label: '次へ', get: (s) => s.tapsForward },
      { label: '戻る', get: (s) => s.tapsBack },
      { label: '次のアカウントへ', get: (s) => s.swipeForward },
      { label: '返信', get: (s) => s.replies },
      { label: 'フォロー', get: (s) => s.follows },
      { label: 'プロフィール遷移', get: (s) => s.profileVisits },
      { label: 'リンククリック', get: (s) => s.linkClicks },
      { label: 'URL', get: (s) => s.permalink },
    ];
    download(`instagram_stories_${state.view.startKey}_${state.view.endKey}.csv`, toCSV(state.view.si.stories, cols), 'text/csv');
  });

  $('#export-followed').addEventListener('click', () => {
    const cols = [
      { label: 'ユーザーネーム', get: (f) => f.username },
      { label: 'ユーザーID', get: (f) => f.userId },
      { label: 'プロフィール', get: (f) => f.profile },
      { label: 'フォロワー数', get: (f) => f.followers },
      { label: '投稿数', get: (f) => f.posts },
      { label: 'フォロー数', get: (f) => f.follows },
      { label: 'よく使うハッシュタグ', get: (f) => (f.hashtags || []).map((t) => `#${t}`).join(' ') },
      { label: 'URL', get: (f) => f.url },
    ];
    download('instagram_followed_accounts.csv', toCSV(state.view.si.followed, cols), 'text/csv');
  });

  $('#export-tagged').addEventListener('click', () => {
    const cols = [
      { label: '投稿日時', get: (t) => fmtDateTime(t.timestamp) },
      { label: 'アカウント', get: (t) => t.account },
      { label: 'タイプ', get: (t) => t.type },
      { label: 'キャプション', get: (t) => t.caption },
      { label: 'いいね', get: (t) => t.likes },
      { label: 'コメント', get: (t) => t.comments },
      { label: 'URL', get: (t) => t.permalink },
    ];
    download(`instagram_tagged_${state.view.startKey}_${state.view.endKey}.csv`, toCSV(state.view.si.tagged.list, cols), 'text/csv');
  });

  $('#api-form').addEventListener('submit', handleAPISubmit);
  $('#find-ig').addEventListener('click', handleFindIG);

  const input = $('#csv-input');
  input.addEventListener('change', () => input.files.length && handleCSVFiles([...input.files]).finally(() => (input.value = '')));
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files.length) handleCSVFiles([...e.dataTransfer.files]);
  });

  $('#export-json').addEventListener('click', () => {
    if (!state.dataset) return toast('バックアップするデータがありません');
    download(`instagram_insights_backup_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state.dataset), 'application/json');
  });
  $('#import-json').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const ds = JSON.parse(await file.text());
      if (!Array.isArray(ds.posts) || !Array.isArray(ds.daily)) throw new Error('形式が正しくありません');
      setDataset(ds, 'バックアップから復元しました');
      $('#data-dialog').close();
    } catch (err) {
      toast(`復元に失敗しました: ${err.message}`);
    }
    e.target.value = '';
  });
  $('#clear-data').addEventListener('click', () => {
    if (!confirm('保存されているデータとアクセストークンを削除します。よろしいですか？')) return;
    store.clearDataset();
    delete state.settings.api;
    persistSettings();
    $('#api-form').reset();
    state.dataset = null;
    $('#data-dialog').close();
    render();
    toast('削除しました');
  });
}

resolveTheme();
setupTableToggles();
bindEvents();
// ?demo を付けて開くとデモデータを読み込む（動作確認用）
if (new URLSearchParams(location.search).has('demo')) state.dataset = generateDemo();
render();
