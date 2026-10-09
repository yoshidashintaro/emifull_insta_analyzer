// 単一 HTML へのバンドルが、元のモジュールと同じ動きをするか確認する
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { bundle } from '../scripts/bundle.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests/fixtures');

let cached = null;
const html = async () => (cached ??= await bundle());

/** バンドルから「モジュール定義部分だけ」を取り出して Node 上で評価する */
async function evalModules() {
  const out = await html();
  const start = out.lastIndexOf('const __mod = {};');
  const appAt = out.indexOf('__mod["js/app.js"]', start);
  assert.ok(start > 0 && appAt > start, 'モジュール定義が見つからない');
  // app.js は DOM を触るので手前まで（データ処理のモジュールだけ）を評価する
  const code = `${out.slice(start, appAt)}\n__result = __mod;`;
  // charts.js は読み込み時に window.Chart を参照するので、最低限の受け皿を用意する
  const sandbox = {
    __result: null,
    TextDecoder,
    console,
    Blob,
    Response,
    window: {},
    document: { documentElement: { dataset: {} } },
  };
  vm.createContext(sandbox);
  new vm.Script(code).runInContext(sandbox);
  return sandbox.__result;
}

test('バンドルが文法エラーなく組み立てられる', async () => {
  const out = await html();
  assert.ok(out.includes('<!doctype html>'));
  assert.ok(out.length > 200_000, 'Chart.js が埋め込まれている');
  // 外部ファイルへの参照が残っていないこと
  assert.ok(!out.includes('src="js/app.js"'));
  assert.ok(!out.includes('href="css/style.css"'));
  assert.ok(!out.includes('src="vendor/chart.umd.min.js"'));
  assert.ok(!/<script[^>]*\bsrc=/.test(out), '外部スクリプト参照が残っている');
});

test('$$ などの記号が置換で壊れていない', async () => {
  const out = await html();
  // app.js の $$ は「すべて選択」のヘルパー。$ に潰れると別物になる
  assert.ok(out.includes('const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];'));
  assert.ok(out.includes('const $ = (sel, root = document) => root.querySelector(sel);'));
  // 正規表現の置換で使う $1 / $& も原文のまま残っていること
  assert.ok(out.includes("'$1:$2'"), 'csv.js のタイムゾーン置換が壊れている');
});

test('元のモジュールの中身がそのまま入っている', async () => {
  const out = await html();
  const samples = [
    ['js/analytics.js', 'export function normalizeDaily(rows) {'],
    ['js/stats.js', 'export function pearson(x, y) {'],
    ['js/traffic.js', 'export function weeklyTraffic(ga4Rows'],
    ['js/data/csv.js', 'export function decodeCSV(buffer) {'],
    ['js/data/xlsx.js', 'export async function readWorkbook(buffer) {'],
    ['js/data/ga4.js', 'export function readGA4Table(rows) {'],
  ];
  for (const [path, line] of samples) {
    const source = await readFile(join(ROOT, 'public', path), 'utf8');
    assert.ok(source.includes(line), `元ファイルに ${line} が無い`);
    // export を外した形で入っている
    assert.ok(out.includes(line.replace(/^export /, '')), `${path} の ${line} がバンドルに無い`);
  }
});

test('バンドルしたモジュールが実データを取り込める', async () => {
  const mod = await evalModules();
  const csv = mod['js/data/csv.js'];
  const analytics = mod['js/analytics.js'];
  const storage = mod['js/storage.js'];

  let daily = [];
  let audience = null;
  for (const name of ['Reach.csv', 'Views.csv', 'Follows.csv', 'Visits.csv', 'Link clicks.csv', 'Interactions.csv', 'Audience.csv']) {
    const res = csv.importCSV(csv.decodeCSV(await readFile(join(FIX, name))), { fileName: name });
    daily = storage.mergeDaily(daily, res.daily);
    audience = storage.mergeAudience(audience, res.audience);
  }
  assert.equal(audience.followersTotal, 9219);
  const nd = analytics.normalizeDaily(analytics.anchorFollowers(daily, audience));
  assert.equal(nd.find((d) => d.date === '2026-09-17').reach, 4635);
  assert.equal(analytics.detectFollowerMode(nd), 'gains');

  const posts = csv.importCSV(await readFile(join(FIX, 'posts_meta.csv'), 'utf8'), { fileName: 'posts_meta.csv' }).posts;
  assert.equal(posts.length, 3);
  assert.equal(posts[0].follows, 30);
});

test('バンドルした統計・GA4 モジュールが同じ値を返す', async () => {
  const mod = await evalModules();
  const stats = mod['js/stats.js'];
  const ga4 = mod['js/data/ga4.js'];
  const traffic = mod['js/traffic.js'];

  assert.equal(stats.pearson([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]), 0.8);
  assert.ok(Math.abs(stats.pValue(0.58, 12) - 0.048055918209227284) < 1e-12);
  assert.ok(ga4.isInstagram('instagram / instaprofile'));
  assert.ok(ga4.isPaid('ig / paid'));
  assert.equal(traffic.weekStart('2026-09-24'), '2026-09-21');

  const table = ga4.readGA4Table([
    ['日付', '参照元/メディア', 'セッション', '予約タップ'],
    ['2026-09-21', 'instagram / instaprofile', 100, 6],
    ['2026-09-21', 'ig / paid', 200, 1],
  ]);
  const weeks = traffic.weeklyTraffic(table.rows, { fallbackAccount: 'main' });
  assert.equal(weeks[0].organic, 100);
  assert.equal(weeks[0].paid, 200);
});
