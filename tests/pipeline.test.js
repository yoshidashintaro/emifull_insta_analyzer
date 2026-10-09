// 取り込みから画面表示の直前（compute 相当）までを、実データと同じ形で通しで確認する
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCSV, importCSV } from '../public/js/data/csv.js';
import {
  normalizeDaily, normalizePost, enrichPosts, anchorFollowers, detectFollowerMode,
  periodBounds, slice, summarize, funnel, audienceSummary, accountsOf, byAccount,
  byType, timeHeatmap, groupByKey, hashtagStats, weeklyER, generateInsights, addDays,
} from '../public/js/analytics.js';
import { mergeDaily, mergePosts, mergeAudience } from '../public/js/storage.js';
import { generateDemo } from '../public/js/data/demo.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FILES = ['Reach.csv', 'Views.csv', 'Follows.csv', 'Visits.csv', 'Link clicks.csv', 'Interactions.csv', 'Audience.csv', 'posts_meta.csv'];

/** 画面の「CSV をまとめて選択」と同じ手順でデータセットを作る */
async function buildDataset() {
  let posts = [];
  let daily = [];
  let audience = null;
  for (const name of FILES) {
    const res = importCSV(decodeCSV(await readFile(join(FIX, name))), { fileName: name });
    posts = mergePosts(posts, res.posts);
    daily = mergeDaily(daily, res.daily);
    audience = mergeAudience(audience, res.audience);
  }
  return { source: 'csv', daily, posts, audience, followerMode: detectFollowerMode(normalizeDaily(anchorFollowers(daily, audience))) };
}

/** app.js の compute() と同じ集計を行う */
function compute(ds, { days = 0, basis = 'reach', account = '' } = {}) {
  const daily = normalizeDaily(anchorFollowers(ds.daily, ds.audience));
  const current = ds.audience?.followersTotal;
  const all = enrichPosts(ds.posts.map(normalizePost), daily, basis, current);
  const accounts = accountsOf(all);
  const posts = account ? all.filter((p) => p.account === account) : all;
  const { startKey, endKey } = periodBounds(daily, posts, days || null);
  const cur = slice(daily, posts, startKey, endKey);
  const summary = summarize(cur.daily, cur.posts);
  const steps = funnel(summary);
  const audience = audienceSummary(ds.audience);
  const heatmap = timeHeatmap(cur.posts, { blockHours: 3 });
  const insights = generateInsights({
    summary, prevSummary: null, types: byType(cur.posts), heatmap,
    hours: groupByKey(cur.posts, (p) => p.hour, 24), hashtags: hashtagStats(cur.posts),
    posts: cur.posts, steps, audience, accounts: byAccount(cur.posts),
  });
  return { startKey, endKey, daily: cur.daily, posts: cur.posts, summary, steps, audience, accounts, insights, weekly: weeklyER(cur.posts) };
}

test('8ファイルをまとめて取り込むと1つのデータセットになる', async () => {
  const ds = await buildDataset();
  assert.equal(ds.posts.length, 3);
  assert.equal(ds.audience.followersTotal, 9219);
  assert.equal(ds.followerMode, 'gains');
  // 日次は 09-17 〜 09-23 の7日分（Follows.csv だけ 09-22 まで）
  assert.equal(ds.daily.length, 7);
  const last = ds.daily.at(-1);
  assert.equal(last.date, '2026-09-23');
  assert.equal(last.reach, 4382);
  assert.equal(last.follows, null);
});

test('通しで集計しても例外にならず、主要な数字がそろう', async () => {
  const v = compute(await buildDataset());
  assert.equal(v.summary.followers, 9219);
  assert.equal(v.summary.totals.reach, 34150);
  assert.equal(v.summary.totals.views, 129720);
  assert.equal(v.summary.totals.profileVisits, 959);
  assert.equal(v.summary.totals.linkClicks, 990);
  assert.equal(v.summary.totals.interactions, 100);
  assert.ok(v.summary.avgER > 0);
  assert.equal(v.accounts.length, 2);
  assert.equal(v.steps.length, 4);
  assert.ok(v.insights.length >= 3);
});

test('アカウントで絞り込むと投稿だけが減り、日次指標は変わらない', async () => {
  const ds = await buildDataset();
  const all = compute(ds);
  const one = compute(ds, { account: 'miselclinic_osaka' });
  assert.equal(all.posts.length, 3);
  assert.equal(one.posts.length, 2);
  assert.ok(one.posts.every((p) => p.account === 'miselclinic_osaka'));
  assert.equal(one.summary.totals.reach, all.summary.totals.reach);
});

test('期間を絞っても集計が壊れない', async () => {
  const ds = await buildDataset();
  for (const days of [7, 30, 90, 180, 0]) {
    const v = compute(ds, { days });
    assert.ok(v.startKey <= v.endKey, `days=${days}`);
    assert.ok(Number.isFinite(v.summary.days), `days=${days}`);
  }
});

test('ER の計算基準を切り替えても通る', async () => {
  const ds = await buildDataset();
  const reach = compute(ds, { basis: 'reach' });
  const follower = compute(ds, { basis: 'followers' });
  assert.ok(reach.summary.avgER > 0);
  assert.ok(follower.summary.avgER > 0);
  assert.notEqual(reach.summary.avgER, follower.summary.avgER);
});

test('日次データが一切なくても投稿だけで集計できる', async () => {
  const res = importCSV(decodeCSV(await readFile(join(FIX, 'posts_meta.csv'))), { fileName: 'posts_meta.csv' });
  const v = compute({ daily: [], posts: res.posts, audience: null });
  assert.equal(v.posts.length, 3);
  assert.equal(v.steps.length, 0);
  assert.equal(v.summary.followers, null);
});

test('オーディエンスだけのファイルでも落ちない', async () => {
  const res = importCSV(decodeCSV(await readFile(join(FIX, 'Audience.csv'))), { fileName: 'Audience.csv' });
  const v = compute({ daily: [], posts: [], audience: res.audience });
  assert.equal(v.audience.topAge.age, '35-44');
  assert.equal(v.posts.length, 0);
});

test('デモデータにも新しい指標とオーディエンスが入っている', () => {
  const ds = generateDemo();
  const v = compute(ds, { days: 90 });
  assert.ok(v.summary.totals.profileVisits > 0);
  assert.ok(v.summary.totals.linkClicks > 0);
  assert.equal(v.steps.length, 4);
  assert.ok(v.audience.ageGender.length > 0);
  assert.ok(ds.posts.every((p) => p.views !== null && p.follows !== null));
});

test('後から届いたファイルを追加取り込みしても既存の値が消えない', async () => {
  const first = importCSV(decodeCSV(await readFile(join(FIX, 'Reach.csv'))), { fileName: 'Reach.csv' });
  const second = importCSV(decodeCSV(await readFile(join(FIX, 'Views.csv'))), { fileName: 'Views.csv' });
  const merged = mergeDaily(first.daily, second.daily);
  assert.equal(merged[0].reach, 4635);
  assert.equal(merged[0].views, 16374);
  // 同じファイルをもう一度読んでも日数は増えない
  assert.equal(mergeDaily(merged, first.daily).length, merged.length);
});

test('取り込んだデータは JSON バックアップ／復元で同じ形に戻る', async () => {
  const ds = await buildDataset();
  const restored = JSON.parse(JSON.stringify(ds));
  assert.deepEqual(compute(restored).summary, compute(ds).summary);
});

test('フォロワー推移が期間末の総数から逆算される', async () => {
  const v = compute(await buildDataset());
  const withFollowers = v.daily.filter((d) => d.followers !== null);
  assert.ok(withFollowers.length >= 6);
  // フォロー数が分かっている最後の日（09-22）に現在値を置き、そこから過去へ逆算する
  assert.equal(withFollowers.at(-1).date, '2026-09-22');
  assert.equal(withFollowers.at(-1).followers, 9219);
  for (let i = 1; i < withFollowers.length; i++) {
    assert.ok(withFollowers[i].followers >= withFollowers[i - 1].followers);
  }
});
