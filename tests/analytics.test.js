import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeDaily, normalizePost, enrichPosts, engagementRate, summarize, timeHeatmap, bestSlots,
  hashtagStats, periodBounds, slice, weeklyER, byType, generateInsights, groupByKey, normalizeType,
  formatJST, jstParts,
} from '../public/js/analytics.js';
import { importCSV, parseCSV, parseDateTime, toCSV } from '../public/js/data/csv.js';
import { generateDemo } from '../public/js/data/demo.js';
import { GraphClient } from '../public/js/data/graphApi.js';
import { mergeDaily, mergePosts } from '../public/js/storage.js';

const post = (o) => normalizePost({ id: 'x', timestamp: '2026-09-01T11:00:00Z', type: 'IMAGE', likes: 0, comments: 0, saves: 0, shares: 0, reach: 100, ...o });

test('normalizeDaily: 総数と純増から前後の総数を補完する', () => {
  const d = normalizeDaily([
    { date: '2026-09-01', netChange: 5 },
    { date: '2026-09-02', netChange: -2 },
    { date: '2026-09-04', followers: 110, netChange: 4 },
  ]);
  assert.deepEqual(d.map((r) => r.date), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  // 09-03 の純増が不明なので、それより前は逆算できない
  assert.equal(d[2].followers, 106);
  assert.equal(d[1].followers, null);
});

test('normalizeDaily: 総数だけの場合は差分から純増を算出する', () => {
  const d = normalizeDaily([
    { date: '2026-09-01', followers: 100 },
    { date: '2026-09-02', followers: 97 },
  ]);
  assert.equal(d[1].netChange, -3);
  assert.equal(d[0].netChange, null);
});

test('engagementRate: リーチ基準とフォロワー基準', () => {
  const p = post({ likes: 8, comments: 1, saves: 1, shares: 0, reach: 200 });
  assert.equal(engagementRate(p, 'reach', 1000), 5);
  assert.equal(engagementRate(p, 'followers', 1000), 1);
  assert.equal(engagementRate(post({ reach: null }), 'reach', 1000), null);
});

test('enrichPosts: 投稿時点のフォロワー数を使う', () => {
  const daily = normalizeDaily([
    { date: '2026-09-01', followers: 1000 },
    { date: '2026-09-10', followers: 2000 },
  ]);
  const [p] = enrichPosts([post({ timestamp: '2026-09-05T03:00:00Z', likes: 10 })], daily, 'followers', 2000);
  assert.equal(p.followersAt, 1000);
  assert.equal(p.er, 1);
});

test('timeHeatmap / bestSlots: 投稿数の少ない枠は全体平均に寄せて評価', () => {
  const mk = (iso, likes) => post({ timestamp: iso, likes, reach: 100 });
  const posts = enrichPosts(
    [
      // 1投稿だけの極端な高値
      mk('2026-09-07T09:00:00+09:00', 50),
      // 3投稿で安定して高い
      mk('2026-09-08T21:00:00+09:00', 12),
      mk('2026-09-15T20:00:00+09:00', 11),
      mk('2026-09-22T22:00:00+09:00', 13),
      mk('2026-09-09T15:00:00+09:00', 3),
      mk('2026-09-16T16:00:00+09:00', 4),
    ],
    [],
    'reach',
    1000,
  );
  const hm = timeHeatmap(posts, { blockHours: 3 });
  assert.equal(hm.cells.length, 56);
  const best = bestSlots(hm, { minPosts: 2 });
  assert.equal(best[0].weekday, 1); // 火曜
  assert.equal(best[0].startHour, 21);
  assert.equal(best[0].n, 2);
  assert.ok(!best.some((c) => c.n < 2));
});

test('hashtagStats: 重複タグは1投稿1回、全体平均比を計算', () => {
  const posts = enrichPosts(
    [
      post({ id: 'a', caption: '#A #a #B', likes: 10 }),
      post({ id: 'b', caption: '#a', likes: 20 }),
      post({ id: 'c', caption: '#b', likes: 0 }),
    ],
    [],
    'reach',
    0,
  );
  const stats = hashtagStats(posts);
  const a = stats.find((s) => s.tag === '#a');
  assert.equal(a.n, 2);
  assert.equal(a.er, 15);
  assert.equal(Math.round(a.lift), 50);
});

test('periodBounds / slice: 期間と前期間', () => {
  const daily = normalizeDaily(Array.from({ length: 20 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, followers: 100 + i })));
  const { startKey, endKey } = periodBounds(daily, [], 7);
  assert.equal(startKey, '2026-09-14');
  assert.equal(endKey, '2026-09-20');
  const s = summarize(slice(daily, [], startKey, endKey).daily, []);
  assert.equal(s.followerChange, 6);
  assert.equal(s.followers, 119);
});

test('normalizeType: 各種表記を3タイプに集約', () => {
  assert.equal(normalizeType('VIDEO'), 'REELS');
  assert.equal(normalizeType('リール'), 'REELS');
  assert.equal(normalizeType('CAROUSEL_ALBUM'), 'CAROUSEL');
  assert.equal(normalizeType('IG image'), 'IMAGE');
});

test('デモデータ: 分析一式が例外なく動き、インサイトが出る', () => {
  const ds = generateDemo({ days: 180, endDate: new Date(2026, 8, 19) });
  const daily = normalizeDaily(ds.daily);
  const posts = enrichPosts(ds.posts.map(normalizePost), daily, 'reach', ds.account.followersCount);
  const summary = summarize(daily, posts);
  assert.ok(posts.length > 100);
  assert.equal(summary.followers, ds.account.followersCount);
  const heatmap = timeHeatmap(posts);
  const insights = generateInsights({
    summary,
    prevSummary: null,
    types: byType(posts),
    heatmap,
    hours: groupByKey(posts, (p) => p.hour, 24),
    hashtags: hashtagStats(posts),
    posts,
  });
  assert.ok(insights.length >= 3);
  assert.ok(insights.some((i) => i.title.startsWith('おすすめ投稿枠')));
  // デモは夜20〜22時が強くなるように作ってある
  assert.equal(bestSlots(heatmap)[0].startHour, 21);
  assert.ok(weeklyER(posts).length >= 25);
});

test('CSV: 引用符・改行・BOM を含むパース', () => {
  const rows = parseCSV('﻿a,b\n"x,1","y\n""z"""\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,1', 'y\n"z"']]);
});

test('CSV: 日時の各形式', () => {
  // タイムゾーン表記のない日時は日本時間として扱う
  assert.equal(parseDateTime('2026/09/01 20:15').toISOString(), '2026-09-01T11:15:00.000Z');
  // Meta Business Suite の書き出し（MM/DD/YYYY）は米国太平洋時間
  assert.equal(parseDateTime('09/15/2026 18:30').toISOString(), '2026-09-16T01:30:00.000Z');
  assert.equal(parseDateTime('2026年9月3日 8:05').toISOString(), '2026-09-02T23:05:00.000Z');
  assert.equal(parseDateTime('2026-09-01T11:00:00+0000').toISOString(), '2026-09-01T11:00:00.000Z');
  assert.equal(parseDateTime('abc'), null);
});

test('CSV: サンプルファイルを自動判別して取り込める', async () => {
  const posts = importCSV(await readFile(new URL('../samples/posts_sample.csv', import.meta.url), 'utf8'));
  assert.deepEqual(posts.kinds, ['posts']);
  assert.equal(posts.posts.length, 8);
  assert.equal(posts.posts[0].likes, 188);
  assert.equal(normalizeType(posts.posts[0].type), 'REELS');

  const daily = importCSV(await readFile(new URL('../samples/daily_sample.csv', import.meta.url), 'utf8'));
  assert.deepEqual(daily.kinds, ['daily']);
  assert.equal(daily.daily[0].follows, 32);
  assert.equal(daily.daily[0].unfollows, 6);
  assert.equal(daily.daily[0].followers, 5120);
  // 純増は normalizeDaily でフォロー − フォロー解除から算出する
  assert.equal(normalizeDaily(daily.daily)[0].netChange, 26);
});

test('CSV: 英語ヘッダー（Meta Business Suite 形式）', () => {
  const res = importCSV('Post ID,Publish time,Post type,Description,Reach,Likes,Comments,Saves,Shares\n1,09/15/2026 18:30,IG reel,hello,"1,200",50,3,4,1\n');
  assert.deepEqual(res.kinds, ['posts']);
  assert.equal(res.posts[0].reach, 1200);
});

test('CSV: 列名が判別できない場合はエラー', () => {
  assert.throws(() => importCSV('foo,bar\n1,2\n'), /列名を判別できません/);
});

test('toCSV: カンマや改行をエスケープ', () => {
  const out = toCSV([{ a: 'x,y', b: 'line\n2' }], [{ label: 'A', get: (r) => r.a }, { label: 'B', get: (r) => r.b }]);
  assert.equal(out, '﻿A,B\r\n"x,y","line\n2"');
});

test('mergeDaily / mergePosts: 新しい値で上書き、null は既存値を残す', () => {
  const d = mergeDaily([{ date: '2026-09-01', followers: 100, netChange: 2, reach: 5 }], [{ date: '2026-09-01', followers: null, netChange: 3, reach: null }]);
  assert.equal(d[0].followers, 100);
  assert.equal(d[0].netChange, 3);
  assert.equal(d[0].reach, 5);
  assert.equal(d[0].views, null);
  const p = mergePosts([{ id: '1', timestamp: 'b', likes: 1 }], [{ id: '1', timestamp: 'b', likes: 9 }, { id: '2', timestamp: 'a' }]);
  assert.deepEqual(p.map((x) => x.id), ['2', '1']);
  assert.equal(p[1].likes, 9);
});

test('GraphClient.mediaInsights: 使えない指標があれば減らして再試行', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const metric = new URL(url).searchParams.get('metric');
    calls.push(metric);
    if (metric.includes('views')) {
      return { ok: false, status: 400, json: async () => ({ error: { message: 'unsupported metric', code: 100 } }) };
    }
    return { ok: true, json: async () => ({ data: metric.split(',').map((name) => ({ name, values: [{ value: 7 }] })) }) };
  };
  const c = new GraphClient({ token: 't' });
  const res = await c.mediaInsights('123');
  assert.deepEqual(res, { reach: 7, saved: 7, shares: 7 });
  assert.equal(calls.length, 3);
});

test('GraphClient: トークン無効エラーは再試行せずに中断', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return { ok: false, status: 400, json: async () => ({ error: { message: 'Invalid OAuth access token', code: 190 } }) };
  };
  await assert.rejects(new GraphClient({ token: 't' }).mediaInsights('1'), /Invalid OAuth/);
  assert.equal(n, 1);
});

test('日本時間: UTC（末尾 Z）の投稿日時を UTC+9 で曜日・時間帯に振り分ける', () => {
  const iso = '2026-09-30T09:02:09.000Z';
  assert.equal(formatJST(iso), '2026年9月30日（水）18:02:09（日本時間）');
  assert.equal(formatJST(iso, 'short'), '2026/09/30 18:02');
  assert.deepEqual(jstParts(iso), { year: 2026, month: 9, day: 30, hour: 18, minute: 2, second: 9, weekday: 2 });

  const [p] = enrichPosts([post({ timestamp: iso })], [], 'reach', 1000);
  assert.equal(p.hour, 18);
  assert.equal(p.weekday, 2); // 水曜
  assert.equal(p.dateKey, '2026-09-30');

  // UTC では前日でも日本時間では翌日になるケース（UTC 20:30 → JST 翌 5:30）
  const [q] = enrichPosts([post({ timestamp: '2026-09-29T20:30:00Z' })], [], 'reach', 1000);
  assert.equal(q.dateKey, '2026-09-30');
  assert.equal(q.hour, 5);
  assert.equal(q.weekday, 2);
});

test('Meta の書き出し時刻（太平洋時間）を日本時間に直す', () => {
  // 夏時間（UTC−7）: 02:02 → 09:02Z → 日本時間 18:02
  assert.equal(formatJST(parseDateTime('09/30/2026 02:02')), '2026年9月30日（水）18:02:00（日本時間）');
  // 標準時間（UTC−8）
  assert.equal(parseDateTime('01/15/2026 02:02').toISOString(), '2026-01-15T10:02:00.000Z');
  // 夏時間の切り替わり（2026年は 3/8 と 11/1）
  assert.equal(parseDateTime('03/08/2026 01:59').toISOString(), '2026-03-08T09:59:00.000Z');
  assert.equal(parseDateTime('03/08/2026 03:00').toISOString(), '2026-03-08T10:00:00.000Z');
  assert.equal(parseDateTime('11/01/2026 01:30').toISOString(), '2026-11-01T08:30:00.000Z');
  assert.equal(parseDateTime('11/01/2026 02:00').toISOString(), '2026-11-01T10:00:00.000Z');
  // 実際の書き出し（tests/fixtures/posts_meta.csv）の 07/16/2026 02:00 は日本時間 18時台の枠に入る
  const [p] = enrichPosts([post({ timestamp: parseDateTime('07/16/2026 02:00').toISOString() })], [], 'reach', 1000);
  assert.equal(p.hour, 18);
  assert.equal(p.weekday, 3); // 木曜
});

test('非フォロワーへのリーチ：CSV の列、または「リーチ − フォロワーへのリーチ」から読む', () => {
  const direct = importCSV('投稿日時,リーチ,フォロワー以外へのリーチ,いいね\n2026/09/01 20:00,1000,600,10\n2026/09/02 20:00,500,,5\n');
  assert.deepEqual(direct.posts.map((p) => p.nonFollowerReach), [600, null]);
  const derived = importCSV('Publish time,Reach,Follower reach,Likes\n09/01/2026 04:00,1000,250,10\n');
  assert.equal(derived.posts[0].nonFollowerReach, 750);
  const daily = importCSV('日付,リーチ,非フォロワーへのリーチ\n2026/09/01,4000,1500\n');
  assert.equal(daily.daily[0].nonFollowerReach, 1500);

  // 平均とリーチに占める割合は、データのある投稿だけで出す
  const posts = enrichPosts(direct.posts.map(normalizePost), [], 'reach', 1000);
  const s = summarize([], posts);
  assert.equal(s.avgNonFollowerReach, 600);
  assert.equal(s.nonFollowerShare, 60);
  assert.equal(summarize([], []).avgNonFollowerReach, null);
});
