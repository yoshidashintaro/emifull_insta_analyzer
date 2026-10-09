// 画面の配線チェック（ブラウザを起動せずに、よくある取り違えを防ぐ）。
// app.js が参照する id がすべて index.html にあるか、グラフの canvas がそろっているかを見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(ROOT, p), 'utf8');
const matchAll = (text, re) => [...text.matchAll(re)].map((m) => m[1]);

test('app.js が参照する id はすべて index.html にある', async () => {
  const html = await read('public/index.html');
  const app = await read('public/js/app.js');
  const ids = new Set(matchAll(html, /id="([^"]+)"/g));
  const refs = [...new Set(matchAll(app, /\$\$?\('#([A-Za-z0-9_-]+)/g))];
  assert.ok(refs.length > 100, '参照している id を取り出せていません');
  assert.deepEqual(refs.filter((r) => !ids.has(r)), []);
});

test('グラフを描く canvas はすべて index.html にある', async () => {
  const html = await read('public/index.html');
  const app = await read('public/js/app.js');
  const canvases = new Set(matchAll(html, /<canvas id="([^"]+)"/g));
  const used = [
    ...matchAll(app, /charts\.[a-zA-Z]+\('(c-[a-z0-9-]+)'/g),
    ...matchAll(app, /setEmpty\('(c-[a-z0-9-]+)'/g),
  ];
  assert.ok(used.length > 10);
  assert.deepEqual([...new Set(used)].filter((c) => !canvases.has(c)), []);
});

test('「表で見る」に対応するカードは data-chart の値と canvas の id が一致している', async () => {
  const html = await read('public/index.html');
  // <article class="card" data-chart="c-xxx" ...> ... <canvas id="c-xxx">
  const cards = [...html.matchAll(/data-chart="([^"]+)"([\s\S]*?)<\/article>/g)];
  assert.ok(cards.length > 10);
  for (const [, key, body] of cards) {
    assert.ok(body.includes(`<canvas id="${key}"`), `${key} のカードに同じ id の canvas がありません`);
  }
});

test('新しく追加した画面（ストーリーズ・内訳・ベンチマーク）が index.html にある', async () => {
  const html = await read('public/index.html');
  for (const id of ['stories-block', 'stories-table', 'surface-row', 'clicks-card', 'tool-hashtag-card', 'benchmark-block', 'followed-table', 'tagged-table']) {
    assert.ok(html.includes(`id="${id}"`), `${id} がありません`);
  }
});
