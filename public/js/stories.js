// ストーリーズの集計（DOM に依存しない純粋関数のみ）。
// ソーシャルインサイトの「instagram_insights-stories」から取り込んだデータを使う。
// 投稿（フィード・リール）とは指標が違うため、エンゲージメント率ではなく
// 「閲覧率（フォロワーのうち何％が見たか）」と「離脱率」で評価する。
import { jstDateKey, jstParts, mean } from './analytics.js';

const values = (list, key) => list.map((s) => s[key]).filter((v) => v !== null && v !== undefined);

function total(list, key) {
  const v = values(list, key);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

/** a ÷ b の百分率。どちらかが無ければ null */
const rate = (a, b) => (a === null || !b ? null : (a / b) * 100);

/** 期間（日本時間の日付キー）で絞り込み、古い順に並べる */
export function sliceStories(stories = [], startKey = null, endKey = null) {
  return stories
    .filter((s) => {
      const key = jstDateKey(s.timestamp);
      return (!startKey || key >= startKey) && (!endKey || key <= endKey);
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * 期間のストーリーズをまとめる。
 * - viewRate は各ストーリーズの閲覧率の平均（フォロワー数が日々変わるため合計では出せない）
 * - exitRate / nextRate は期間合計から出す（本数の多い日に引っ張られないようにする）
 */
export function summarizeStories(list = []) {
  const views = total(list, 'views');
  const days = new Set(list.map((s) => jstDateKey(s.timestamp)));
  return {
    n: list.length,
    days: days.size,
    perDay: days.size ? list.length / days.size : null,
    views,
    viewsMean: mean(values(list, 'views')),
    viewRate: mean(values(list, 'viewRate')),
    reach: total(list, 'reach'),
    replies: total(list, 'replies'),
    shares: total(list, 'shares'),
    follows: total(list, 'follows'),
    profileVisits: total(list, 'profileVisits'),
    linkClicks: total(list, 'linkClicks'),
    exits: total(list, 'exits'),
    tapsForward: total(list, 'tapsForward'),
    tapsBack: total(list, 'tapsBack'),
    swipeForward: total(list, 'swipeForward'),
    exitRate: rate(total(list, 'exits'), views), // 離脱率：見た人のうち、そこで見るのをやめた割合
    nextRate: rate(total(list, 'tapsForward'), views), // 次へ送った割合
    backRate: rate(total(list, 'tapsBack'), views), // 戻って見直した割合
    skipRate: rate(total(list, 'swipeForward'), views), // 次のアカウントへ飛ばされた割合
  };
}

/** 日ごとの集計（グラフ用）。本数・閲覧数・リーチ・平均閲覧率 */
export function storiesByDate(list = []) {
  const map = new Map();
  for (const s of list) {
    const date = jstDateKey(s.timestamp);
    const row = map.get(date) || { date, n: 0, views: null, reach: null, rates: [] };
    row.n++;
    if (s.views !== null && s.views !== undefined) row.views = (row.views ?? 0) + s.views;
    if (s.reach !== null && s.reach !== undefined) row.reach = (row.reach ?? 0) + s.reach;
    if (s.viewRate !== null && s.viewRate !== undefined) row.rates.push(s.viewRate);
    map.set(date, row);
  }
  return [...map.values()]
    .map(({ rates, ...row }) => ({ ...row, viewRate: mean(rates) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 時間帯（日本時間）ごとの平均閲覧率。投稿する時間の目安に使う */
export function storiesByHour(list = []) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, n: 0, rates: [], views: [] }));
  for (const s of list) {
    const b = buckets[jstParts(s.timestamp).hour];
    b.n++;
    if (s.viewRate !== null && s.viewRate !== undefined) b.rates.push(s.viewRate);
    if (s.views !== null && s.views !== undefined) b.views.push(s.views);
  }
  return buckets.map((b) => ({ hour: b.hour, n: b.n, viewRate: mean(b.rates), views: mean(b.views) }));
}
