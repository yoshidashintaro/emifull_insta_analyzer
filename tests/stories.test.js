// ストーリーズの集計（画面に出す数値）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCSV, parseCSV } from '../public/js/data/csv.js';
import { readSocialInsight } from '../public/js/data/socialInsight.js';
import { sliceStories, summarizeStories, storiesByDate, storiesByHour } from '../public/js/stories.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FILE = 'si__instagram_insights-stories_ミセルクリニック大阪_20260701-20261008_utf8.csv';

const load = async () => {
  const rows = parseCSV(decodeCSV(await readFile(join(FIX, FILE))));
  return readSocialInsight(rows, { fileName: FILE }).stories;
};

test('sliceStories: 期間（日本時間の日付）で絞り込み、古い順に並べる', async () => {
  const all = await load();
  assert.equal(sliceStories(all).length, 4);
  assert.deepEqual(
    sliceStories(all).map((s) => s.timestamp.slice(0, 10)),
    ['2026-07-01', '2026-07-05', '2026-07-29', '2026-10-08'],
  );
  assert.equal(sliceStories(all, '2026-07-05', '2026-07-29').length, 2);
  assert.equal(sliceStories(all, '2026-10-08', '2026-10-08').length, 1);
  assert.equal(sliceStories([], '2026-07-01', '2026-07-31').length, 0);
});

test('summarizeStories: 閲覧率は本ごとの平均、離脱率などは期間合計から出す', async () => {
  const s = summarizeStories(await load());
  assert.equal(s.n, 4);
  assert.equal(s.days, 4);
  assert.equal(s.perDay, 1);
  assert.equal(s.views, 1553); // 394 + 488 + 671 + 0
  assert.equal(s.viewsMean, 1553 / 4);
  assert.ok(Math.abs(s.viewRate - 4.29) < 0.001); // (4.36 + 5.4 + 7.4 + 0) ÷ 4
  assert.equal(s.reach, 1187);
  assert.equal(s.profileVisits, 21);
  assert.equal(s.linkClicks, 31); // 「-」の行は合計に入れない
  assert.equal(s.exits, 241);
  assert.equal(s.tapsForward, 884);
  assert.equal(s.swipeForward, 168);
  // 率は 閲覧数を分母にした期間合計
  assert.ok(Math.abs(s.exitRate - (241 / 1553) * 100) < 1e-9);
  assert.ok(Math.abs(s.nextRate - (884 / 1553) * 100) < 1e-9);
  assert.ok(Math.abs(s.skipRate - (168 / 1553) * 100) < 1e-9);

  // 空のときは件数 0、率は null（0% と区別する）
  const empty = summarizeStories([]);
  assert.deepEqual([empty.n, empty.days, empty.views, empty.exitRate, empty.perDay], [0, 0, null, null, null]);
});

test('storiesByDate / storiesByHour: 日ごと・投稿した時間帯ごとにまとめる', async () => {
  const list = await load();
  const daily = storiesByDate(list);
  assert.deepEqual(daily.map((d) => [d.date, d.n, d.views]), [
    ['2026-07-01', 1, 394], ['2026-07-05', 1, 488], ['2026-07-29', 1, 671], ['2026-10-08', 1, 0],
  ]);
  // 同じ日に複数あれば合計し、閲覧率は平均にする
  const sameDay = storiesByDate([
    { timestamp: '2026-07-01T00:54:06.000Z', views: 100, reach: 90, viewRate: 1 },
    { timestamp: '2026-07-01T09:00:00.000Z', views: 300, reach: 250, viewRate: 3 },
  ]);
  assert.deepEqual(sameDay, [{ date: '2026-07-01', n: 2, views: 400, reach: 340, viewRate: 2 }]);

  const hours = storiesByHour(list);
  assert.equal(hours.length, 24);
  assert.deepEqual(hours.filter((h) => h.n).map((h) => [h.hour, h.n]), [[9, 1], [10, 1], [17, 1], [18, 1]]);
  assert.equal(hours[9].viewRate, 4.36); // 2026/07/01 09:54（日本時間）
  assert.equal(hours[0].viewRate, null);
});
