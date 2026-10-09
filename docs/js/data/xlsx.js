// Excel ブック（.xlsx）の最小読み取り。ライブラリなしで ZIP を展開してシートを行配列にする。
// 書き込みは行わない。数式セルは Excel が保存した計算結果の値を読む。

/** ZIP の解凍。deflate は標準の DecompressionStream を使う（対応ブラウザのみ） */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('このブラウザは Excel ファイルの展開に対応していません。CSV でお試しください。');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * ZIP のセントラルディレクトリを読んで {パス: バイト列} にする。
 * 末尾から End of Central Directory を探すので、コメント付きでも動く。
 */
export async function unzip(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 形式として読めません');

  let count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  // ZIP64（4GB 超・65535 ファイル超）は対象外だが、目印があれば素直に諦める
  if (offset === 0xffffffff) throw new Error('ZIP64 形式には対応していません');

  const files = new Map();
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(b.subarray(offset + 46, offset + 46 + nameLen));

    // ローカルヘッダーは可変長なので、そこからデータ開始位置を求める
    const lnLen = view.getUint16(localOffset + 26, true);
    const leLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lnLen + leLen;
    files.set(name, { method, bytes: b.subarray(start, start + compressedSize) });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  const out = new Map();
  for (const [name, f] of files) {
    if (f.method === 0) out.set(name, f.bytes);
    else if (f.method === 8) out.set(name, await inflateRaw(f.bytes));
    // それ以外の圧縮方式は Excel が使わないので無視する
  }
  return out;
}

const decode = (bytes) => new TextDecoder('utf-8').decode(bytes);

const unescapeXml = (s) =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function sharedStrings(files) {
  const f = files.get('xl/sharedStrings.xml');
  if (!f) return [];
  const xml = decode(f);
  const out = [];
  for (const chunk of xml.split('<si>').slice(1)) {
    const body = chunk.slice(0, chunk.indexOf('</si>'));
    let text = '';
    for (const m of body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(m[1]);
    out.push(text);
  }
  return out;
}

/** A1 形式の列記号を 0 始まりの番号にする */
function columnIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[2].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[2] || '';
      const body = cm[3] || '';
      const type = attrs.match(/ t="([^"]+)"/)?.[1];
      let value = null;
      if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');
      } else {
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (v !== undefined) {
          if (type === 's') value = shared[+v] ?? '';
          else if (type === 'str') value = unescapeXml(v);
          else if (type === 'b') value = v === '1';
          else value = Number(v);
        }
      }
      cells[columnIndex(cm[1])] = value;
    }
    rows[+rm[1] - 1] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

/**
 * Excel の日付シリアル値を YYYY-MM-DD にする。
 * 1900年うるう年バグを含む Excel の流儀に合わせる（1899-12-30 起点）。
 */
export function excelSerialToDateKey(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return null;
  const d = new Date(Math.round((n - 25569) * 86400000));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * .xlsx を読み、シート名 → 行配列（二次元配列）にする。
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<{name:string, rows:any[][]}[]>}
 */
export async function readWorkbook(buffer) {
  const files = await unzip(buffer);
  const wb = files.get('xl/workbook.xml');
  if (!wb) throw new Error('Excel ブックとして読めません');
  const shared = sharedStrings(files);

  const relsFile = files.get('xl/_rels/workbook.xml.rels');
  const rels = new Map();
  if (relsFile) {
    for (const m of decode(relsFile).matchAll(/<Relationship([^>]*)\/>/g)) {
      const id = m[1].match(/Id="([^"]+)"/)?.[1];
      const target = m[1].match(/Target="([^"]+)"/)?.[1];
      if (id && target) rels.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''));
    }
  }

  const sheets = [];
  for (const m of decode(wb).matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"[^>]*\/?>/g)) {
    const path = rels.get(m[2]);
    const file = path && (files.get(`xl/${path}`) || files.get(path));
    if (!file) continue;
    sheets.push({ name: unescapeXml(m[1]), rows: parseSheet(decode(file), shared) });
  }
  return sheets;
}

export const isXlsxName = (name) => /\.xlsx?$/i.test(String(name || ''));
