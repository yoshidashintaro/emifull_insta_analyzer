// ソーシャルインサイトの9種類をまとめて取り込み、画面に出す数値まで通して確かめる。
// app.js の取り込み処理（handleCSVFiles）と同じ順番・同じマージ関数を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCSV, parseCSV } from '../public/js/data/csv.js';
import {
  readSocialInsight, mergeHashtags, mergeFollowed, mergeSummary, mergeStories, mergeTagged, describeSocialInsight,
} from '../public/js/data/socialInsight.js';
import { mergePosts, mergeDaily } from '../public/js/storage.js';
import { normalizeDaily, normalizePost, enrichPosts, detectFollowerMode, summarize, periodBounds, slice } from '../public/js/analytics.js';
import { applyNonFollowerEstimate } from '../public/js/data/reachMix.js';
import { sliceStories, summarizeStories, storiesByDate } from '../public/js/stories.js';
import { sliceByDate, surfaceBreakdown, clickBreakdown, accountTotals, hashtagSets, benchmarkSummary, taggedInPeriod } from '../public/js/account.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** fixtures の si__*.csv をすべて取り込んで dataset を作る */
async function importAll() {
  const names = (await readdir(FIX)).filter((n) => n.startsWith('si__')).sort();
  const ds = { posts: [], daily: [], accountDaily: [], hashtags: [], followed: [], stories: [], tagged: [] };
  const notes = [];
  for (const name of names) {
    const res = readSocialInsight(parseCSV(decodeCSV(await readFile(join(FIX, name)))), { fileName: name });
    assert.ok(res, `${name} を判別できませんでした`);
    if (res.posts.length) ds.posts = mergePosts(ds.posts, res.posts);
    if (res.daily.length) ds.daily = mergeDaily(ds.daily, res.daily);
    if (res.summary.length) ds.accountDaily = mergeSummary(ds.accountDaily, res.summary);
    if (res.hashtags.length) ds.hashtags = mergeHashtags(ds.hashtags, res.hashtags);
    if (res.followed.length) ds.followed = mergeFollowed(ds.followed, res.followed);
    if (res.stories.length) ds.stories = mergeStories(ds.stories, res.stories);
    if (res.tagged.length) ds.tagged = mergeTagged(ds.tagged, res.tagged);
    notes.push(`${res.kind}: ${describeSocialInsight(res)}`);
  }
  return { ds, names, notes };
}

test('9種類の書き出しをまとめて取り込める（どれも取りこぼさない）', async () => {
  const { ds, names, notes } = await importAll();
  assert.equal(names.length, 9);
  assert.deepEqual(
    notes.map((n) => n.split(':')[0]).sort(),
    ['followed', 'hashtags', 'hashtags', 'insightDaily', 'insightPosts', 'posts', 'stories', 'summary', 'tagged'],
  );
  // 投稿一覧と投稿インサイトは1つにまとまる（10/07 のリールは両方にある）
  assert.equal(ds.posts.length, 6);
  const reel = ds.posts.find((p) => p.id === 'si:DeMGEkcBqm5');
  assert.deepEqual([reel.likes, reel.reach, reel.saves, reel.followersAtPost], [10, 611, 1, 9271]);
  assert.equal(ds.stories.length, 4);
  assert.equal(ds.tagged.length, 3);
  assert.equal(ds.followed.length, 4);
  assert.equal(ds.hashtags.length, 7); // アカウント版4件 ＋ インサイト版3件
  assert.equal(ds.accountDaily.length, 7); // アカウント日次5日分 ＋ 日次インサイト3日分（10/08 が重複）
});

test('取り込んだデータが、そのまま画面の集計に通る', async () => {
  const { ds } = await importAll();

  // --- 日次・投稿（既存の画面） ---
  const daily = normalizeDaily(ds.daily);
  const posts = enrichPosts(ds.posts.map(normalizePost), daily, 'reach', 9271);
  const { startKey, endKey } = periodBounds(daily, posts, null);
  const cur = slice(daily, posts, startKey, endKey);
  const s = summarize(cur.daily, cur.posts);
  assert.equal(detectFollowerMode(daily), 'net'); // 日次インサイトにフォロー解除が入る
  assert.equal(s.postCount, 6);
  assert.ok(s.totalReach > 0 && s.avgReach > 0);
  // リーチが入ったのでリーチ基準の ER が出る
  assert.ok(posts.some((p) => p.er !== null));

  // 非フォロワーリーチは実測が入っている日は推定しない
  const est = applyNonFollowerEstimate({ posts: cur.posts, daily: cur.daily }, [{ account: '', start: startKey, end: endKey, ratio: 93.2 }], '');
  assert.equal(est.daily.find((d) => d.date === '2026-07-01').nonFollowerReach, 3907);
  assert.equal(est.daily.find((d) => d.date === '2026-07-01').nonFollowerEstimated, undefined);

  // --- ストーリーズ（新しい画面） ---
  const stories = sliceStories(ds.stories, startKey, endKey);
  const ss = summarizeStories(stories);
  assert.equal(ss.n, 4);
  assert.equal(ss.views, 1553);
  assert.ok(ss.exitRate > 0 && ss.viewRate > 0);
  assert.equal(storiesByDate(stories).length, 4);

  // --- アカウント全体の内訳（新しい画面） ---
  const rows = sliceByDate(ds.accountDaily, startKey, endKey);
  const surfaces = surfaceBreakdown(rows);
  assert.deepEqual(surfaces.map((x) => x.label), ['フィード', 'リール', 'ストーリーズ', '広告']);
  assert.equal(clickBreakdown(rows)[0].label, 'ウェブサイト');
  const totals = accountTotals(rows);
  assert.equal(totals.nonFollowerReach, 10851);
  assert.ok(totals.conversionRate > 0);

  // --- ハッシュタグ・ベンチマーク（新しい画面） ---
  const sets = hashtagSets(ds.hashtags);
  assert.equal(sets.length, 2);
  assert.deepEqual(sets.map((x) => x.erBasis), ['views', 'followers']);
  assert.equal(benchmarkSummary(ds.followed).n, 4);
  assert.equal(taggedInPeriod(ds.tagged, startKey, endKey).list.length, 3);
});
