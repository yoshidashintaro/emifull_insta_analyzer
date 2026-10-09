// ES モジュール構成の画面を、1枚の HTML にまとめる。
// ファイルサーバーを用意しなくてもダブルクリックで開けるようにするための出力。
// 実行: npm run bundle（npm run build からも呼ばれる）
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

/** モジュール内の import 文を洗い出す。複数行にまたがる形にも対応する */
function findImports(code) {
  const out = [];
  const re = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const m of code.matchAll(re)) {
    out.push({ statement: m[0], clause: m[1].trim(), from: m[2] });
  }
  return out;
}

/** export 文を通常の宣言に戻し、公開する名前を集める */
function stripExports(code) {
  const names = new Set();
  let out = code;

  // export { a, b };
  out = out.replace(/^export\s*\{([^}]*)\}\s*;?/gm, (_, inner) => {
    for (const part of inner.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
    return '';
  });

  // export function / async function / class / const / let / var
  out = out.replace(/^export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => {
    names.add(name);
    return `${kind} ${name}`;
  });

  if (/^export\s/m.test(out)) {
    const leftover = out.match(/^export\s.*/m)[0];
    throw new Error(`未対応の export があります: ${leftover}`);
  }
  return { code: out, names: [...names] };
}

/** app.js を起点に依存を辿り、読み込む順（依存が先）に並べる */
async function collect(entry) {
  const modules = new Map();
  const order = [];

  async function visit(path) {
    if (modules.has(path)) return;
    modules.set(path, null); // 循環参照の保険
    const code = await readFile(join(PUBLIC, path), 'utf8');
    const imports = findImports(code);
    for (const imp of imports) {
      const resolved = posix.normalize(posix.join(posix.dirname(path), imp.from));
      await visit(resolved);
    }
    const { code: body, names } = stripExports(imports.reduce((c, i) => c.replace(i.statement, ''), code));
    modules.set(path, { path, body, names, imports });
    order.push(path);
  }

  await visit(entry);
  return order.map((p) => modules.get(p));
}

/** import 文を、組み立て済みモジュールからの取り出しに書き換える */
function importPrelude(mod) {
  const lines = [];
  for (const imp of mod.imports) {
    const from = posix.normalize(posix.join(posix.dirname(mod.path), imp.from));
    if (imp.clause.startsWith('*')) {
      const ns = imp.clause.replace(/^\*\s*as\s+/, '').trim();
      lines.push(`  const ${ns} = __mod[${JSON.stringify(from)}];`);
    } else {
      const inner = imp.clause.replace(/^\{|\}$/g, '').trim();
      const parts = inner
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s.includes(' as ') ? s.replace(/\s+as\s+/, ': ') : s));
      if (parts.length) lines.push(`  const { ${parts.join(', ')} } = __mod[${JSON.stringify(from)}];`);
    }
  }
  return lines.join('\n');
}

const indent = (code) => code.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');

export async function bundle() {
  const modules = await collect('js/app.js');
  const parts = [];
  for (const m of modules) {
    parts.push(
      `__mod[${JSON.stringify(m.path)}] = (function () {\n` +
        `${importPrelude(m)}\n${indent(m.body)}\n` +
        `  return { ${m.names.join(', ')} };\n})();`,
    );
  }

  const html = await readFile(join(PUBLIC, 'index.html'), 'utf8');
  const css = await readFile(join(PUBLIC, 'css/style.css'), 'utf8');
  const chart = await readFile(join(ROOT, 'node_modules/chart.js/dist/chart.umd.min.js'), 'utf8');

  const script =
    `<script>\n(function () {\n"use strict";\nconst __mod = {};\n${parts.join('\n\n')}\n})();\n<\/script>`;

  // 置換文字列に $$ や $& が含まれると壊れるので、必ず関数形式で差し込む
  const put = (text, find, value) => text.replace(find, () => value);

  let out = html;
  out = put(out, '<link rel="stylesheet" href="css/style.css" />', `<style>\n${css}\n</style>`);
  out = put(out, '<script src="vendor/chart.umd.min.js"></script>', `<script>${chart}<\/script>`);
  // CDN フォールバックはオフラインで使えないので落とす
  out = put(out, /<script>\s*window\.Chart \|\|[\s\S]*?<\/script>/, '');
  out = put(out, '<script type="module" src="js/app.js"></script>', '');
  // 画面本体は DOM ができてから動かす必要があるので body の最後に置く
  out = put(out, '</body>', `${script}\n</body>`);

  // 単一ファイルではサンプル CSV を同梱できないのでリンクを外す
  out = put(out, /<p class="help small">サンプル:[\s\S]*?<\/p>/, '');
  return out;
}

// 直接実行されたときだけ出力する（build.js から import されたときは何もしない）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await bundle();
  const dest = join(ROOT, 'dist-single');
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, 'Instagram分析.html'), out, 'utf8');
  console.log(`単一ファイルを出力しました: dist-single/Instagram分析.html（${(Buffer.byteLength(out) / 1024).toFixed(0)} KB）`);
}
