// アカウント全体の内訳（面別・クリック種別・転換率）とベンチマークの集計
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCSV, parseCSV } from '../public/js/data/csv.js';
import { readSocialInsight, mergeHashtags } from '../public/js/data/socialInsight.js';
import {
  sliceByDate, surfaceBreakdown, clickBreakdown, accountTotals,
  hashtagSets, benchmarkSummary, taggedInPeriod,
} from '../public/js/account.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const DAILY_FILE = 'si__instagram_insights-summary_ミセルクリニック大阪_20260701-20261008_utf8.csv';
const TAGGED_FILE = 'si__instagram_insights-tagged_ミセルクリニック大阪_20260701-20261008_utf8.csv';
const FOLLOWED_FILE = 'si__accounts-followed_ミセルクリニック大阪_instagram_261008173434_utf8.csv';
const HASHTAG_FILE = 'si__accounts-hashtag_analysis_ミセルクリニック大阪_20251014-20261008_utf8.csv';
const INSIGHT_HASHTAG_FILE = 'si__instagram_insights-hashtag_ミセルクリニック大阪_20260701-20261008_utf8.csv';

const read = async (name) => readSocialInsight(parseCSV(decodeCSV(await readFile(join(FIX, name)))), { fileName: name });

test('sliceByDate: 日付キーで絞り込み、日付順に並べる', async () => {
  const rows = (await read(DAILY_FILE)).summary;
  assert.equal(sliceByDate(rows).length, 3);
  assert.equal(sliceByDate(rows, '2026-07-02', '2026-10-08').length, 2);
  assert.equal(sliceByDate(rows, '2026-08-01', '2026-09-30').length, 0);
  assert.deepEqual(sliceByDate(rows).map((r) => r.date), ['2026-07-01', '2026-07-02', '2026-10-08']);
});

test('surfaceBreakdown: 面（フィード・リール・ストーリーズ・広告）ごとの期間合計', async () => {
  const rows = (await read(DAILY_FILE)).summary;
  const surfaces = surfaceBreakdown(rows);
  assert.deepEqual(surfaces.map((s) => s.key), ['feed', 'reels', 'stories', 'ads']); // 内訳が無い「その他」は出さない
  assert.deepEqual(surfaces.find((s) => s.key === 'feed').values, { views: 6684, reach: 2061, interactions: 45 });
  assert.deepEqual(surfaces.find((s) => s.key === 'reels').values, { views: 1774, reach: 779, interactions: 22 });
  assert.deepEqual(surfaces.find((s) => s.key === 'stories').values, { views: 3016, reach: 913, interactions: 0 });
  // この期間は広告がいちばん見られている面（＝広告配信があることが分かる）
  assert.deepEqual(surfaces.find((s) => s.key === 'ads').values, { views: 42889, reach: 11240, interactions: 14 });
  assert.deepEqual(surfaceBreakdown([]), []);
});

test('clickBreakdown: プロフィールからのアクションを多い順に、0 件の種類は出さない', async () => {
  const rows = (await read(DAILY_FILE)).summary;
  assert.deepEqual(clickBreakdown(rows), [
    { key: 'linkClicks', label: 'ウェブサイト', value: 33 }, // 11 + 17 + 5
    { key: 'callClicks', label: '電話', value: 2 },
  ]);
  assert.deepEqual(clickBreakdown([]), []);
});

test('accountTotals: リーチの内訳とフォロワー転換率を期間合計から出す', async () => {
  const rows = (await read(DAILY_FILE)).summary;
  const t = accountTotals(rows);
  assert.equal(t.days, 3);
  assert.equal(t.reach, 13553);
  assert.equal(t.followerReach, 2644);
  assert.equal(t.nonFollowerReach, 10851);
  assert.ok(Math.abs(t.nonFollowerShare - (10851 / 13495) * 100) < 1e-9); // 分母は内訳の合計
  assert.equal(t.views, 54363);
  assert.equal(t.profileVisits, 441);
  assert.equal(t.follows, 9);
  // 転換率：プロフィールに来た人のうちフォローした割合（書き出しの「フォロワー転換率」と同じ定義）
  assert.ok(Math.abs(t.conversionRate - (9 / 441) * 100) < 1e-9);
  const empty = accountTotals([]);
  assert.deepEqual([empty.days, empty.reach, empty.conversionRate], [0, null, null]);
});

test('hashtagSets: 分母の違う集計を混ぜず、書き出し・期間ごとに分けて新しい順に並べる', async () => {
  const accounts = await read(HASHTAG_FILE);
  const insights = await read(INSIGHT_HASHTAG_FILE);
  const sets = hashtagSets(mergeHashtags(accounts.hashtags, insights.hashtags));
  assert.equal(sets.length, 2);
  assert.deepEqual(sets.map((s) => [s.source, s.erBasis, s.start]), [
    ['insights', 'views', '2026-07-01'],
    ['accounts', 'followers', '2025-10-14'],
  ]);
  assert.equal(sets[0].label, 'インサイト／2026/07/01〜2026/10/08');
  assert.equal(sets[1].label, 'アカウント／2025/10/14〜2026/10/08');
  // 件数の多い順
  assert.deepEqual(sets[0].rows.map((r) => r.tag), ['ミセルクリニック', '美容皮膚科', 'ボトックス']);
  assert.deepEqual(sets[1].rows[0].tag, '大阪');
  assert.deepEqual(hashtagSets([]), []);
});

test('benchmarkSummary: フォロー中アカウントのフォロワー規模と、よく使われるタグを数える', async () => {
  const followed = (await read(FOLLOWED_FILE)).followed;
  const b = benchmarkSummary(followed);
  assert.equal(b.n, 4);
  assert.equal(b.followersMax, 87689);
  assert.equal(b.followersMedian, (8361 + 3716) / 2); // 87689 / 8361 / 3716 / 71 の中央値
  assert.equal(b.postsMedian, (330 + 241) / 2);
  // 複数のアカウントが使っているタグは件数が増える
  assert.deepEqual(b.topHashtags.find((t) => t.tag === '美容皮膚科'), { tag: '美容皮膚科', n: 1 });
  assert.deepEqual(b.topHashtags.find((t) => t.tag === '大阪'), { tag: '大阪', n: 1 });
  assert.equal(benchmarkSummary([]).n, 0);
});

test('taggedInPeriod: 期間で絞り込み新しい順、投稿したアカウント別の件数も返す', async () => {
  const tagged = (await read(TAGGED_FILE)).tagged;
  const all = taggedInPeriod(tagged);
  assert.deepEqual(all.list.map((t) => t.timestamp.slice(0, 10)), ['2026-09-25', '2026-07-09', '2026-07-02']);
  assert.deepEqual(all.accounts, [
    { account: 'dr.okudate_miselclinic', n: 2, likes: 80, comments: 2 },
    { account: 'emifull1122', n: 1, likes: 7, comments: 0 },
  ]);
  const july = taggedInPeriod(tagged, '2026-07-01', '2026-07-31');
  assert.equal(july.list.length, 2);
  assert.deepEqual(taggedInPeriod([]).accounts, []);
});
