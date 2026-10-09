// サーバーアップロード用のファイル一式を dist/ に出力し、release/ に ZIP を作る。
// 実行: npm run build
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { bundle } from './bundle.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'docs'); // GitHub Pages がそのまま配信できるフォルダ名（設定: main / docs）
const RELEASE = join(ROOT, 'release');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

const chartSrc = join(ROOT, 'node_modules/chart.js/dist/chart.umd.min.js');
try {
  await stat(chartSrc);
} catch {
  console.error('Chart.js が見つかりません。先に npm install を実行してください。');
  process.exit(1);
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

// 画面本体・ライブラリ・サンプルCSV・Apache 用設定
await cp(join(ROOT, 'public'), DIST, { recursive: true });
await mkdir(join(DIST, 'vendor'), { recursive: true });
await cp(chartSrc, join(DIST, 'vendor/chart.umd.min.js'));
await cp(join(ROOT, 'samples'), join(DIST, 'samples'), { recursive: true });
await cp(join(ROOT, 'deploy/.htaccess'), join(DIST, '.htaccess'));

// 画面の下に版（ビルド日時・日本時間）を入れる。サーバーの版が最新かを画面で確かめられるようにする
const buildNow = new Date(Date.now() + 9 * 3600000);
const buildStamp = `${buildNow.getUTCFullYear()}/${String(buildNow.getUTCMonth() + 1).padStart(2, '0')}/${String(buildNow.getUTCDate()).padStart(2, '0')} ${String(buildNow.getUTCHours()).padStart(2, '0')}:${String(buildNow.getUTCMinutes()).padStart(2, '0')}`;
const stampHtml = (html) => html.replace('<span id="build-stamp">開発版</span>', `<span id="build-stamp">${buildStamp}</span>`);
await writeFile(join(DIST, 'index.html'), stampHtml(await readFile(join(DIST, 'index.html'), 'utf8')), 'utf8');

// サーバー不要でそのまま開ける単一ファイル版も同梱する
await writeFile(join(DIST, 'Instagram分析_単一ファイル版.html'), stampHtml(await bundle()), 'utf8');

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out.sort();
}

// ---------- ZIP（外部ツール不要の最小実装） ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 展開に必要なバージョン
    local.writeUInt16LE(0x0800, 6); // ファイル名は UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const files = await listFiles(DIST);
const entries = await Promise.all(
  files.map(async (f) => ({ name: relative(DIST, f).split(sep).join('/'), data: await readFile(f) })),
);
await mkdir(RELEASE, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const zipPath = join(RELEASE, `${pkg.name}_${stamp}.zip`);
await writeFile(zipPath, createZip(entries));

const total = entries.reduce((s, e) => s + e.data.length, 0);
console.log(`docs/ に ${entries.length} ファイルを出力しました（${(total / 1024).toFixed(0)} KB）`);
for (const e of entries) console.log(`  ${e.name}`);
console.log(`ZIP: ${relative(ROOT, zipPath)}`);
