// localStorage への保存（すべてこのブラウザ内のみ。例外が出ても動作は継続する）
import { DAILY_FIELDS, emptyDailyRow } from './analytics.js';

const KEY_DATA = 'iia.dataset.v1';
const KEY_SETTINGS = 'iia.settings.v1';

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const loadDataset = () => read(KEY_DATA);
export const saveDataset = (ds) => write(KEY_DATA, ds);
export const clearDataset = () => write(KEY_DATA, null);

export const loadSettings = () => read(KEY_SETTINGS) || {};
export const saveSettings = (s) => write(KEY_SETTINGS, s);

/**
 * 日次データを日付単位でマージ（新しい方の非 null 値を優先）。
 * 指標ごとに別ファイルで届く Meta のエクスポートを1本の時系列にまとめるためにも使う。
 */
export function mergeDaily(oldRows = [], newRows = []) {
  const map = new Map(oldRows.map((r) => [r.date, { ...emptyDailyRow(r.date), ...r }]));
  for (const r of newRows) {
    const prev = map.get(r.date) || emptyDailyRow(r.date);
    const merged = { date: r.date };
    for (const k of DAILY_FIELDS) merged[k] = r[k] ?? prev[k] ?? null;
    map.set(r.date, merged);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** オーディエンス情報のマージ（新しい方を優先、欠けている項目は残す） */
export function mergeAudience(oldAud, newAud) {
  if (!newAud) return oldAud || null;
  if (!oldAud) return newAud;
  return { ...oldAud, ...newAud };
}

const blank = (v) => v === null || v === undefined || v === '';

/**
 * 投稿を ID 単位でマージ（新しい取得結果で上書き）。
 * ただし新しい方に値が無い項目は、前に取り込んだ値を残す。
 * 同じ投稿を指標の違うファイルから取り込む（例: ソーシャルインサイトの
 * 投稿一覧＋投稿インサイト）場合に、先に入っていたリーチや保存を消さないため。
 */
export function mergePosts(oldPosts = [], newPosts = []) {
  const map = new Map(oldPosts.map((p) => [p.id, p]));
  for (const p of newPosts) {
    const prev = map.get(p.id);
    if (!prev) {
      map.set(p.id, p);
      continue;
    }
    const merged = { ...prev, ...p };
    for (const [k, v] of Object.entries(p)) if (blank(v) && !blank(prev[k])) merged[k] = prev[k];
    map.set(p.id, merged);
  }
  return [...map.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
