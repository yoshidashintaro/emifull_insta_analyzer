// 上部の指標の推移（日・週・月）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TREND_METRICS, bucketKey, bucketLabels, trendSeries } from '../public/js/trend.js';

test('bucketKey / bucketLabels: 週は月曜始まり、月は1日', () => {
  assert.equal(bucketKey('2026-10-01', 'week'), '2026-09-28'); // 木曜 → 月曜
  assert.equal(bucketKey('2026-10-01', 'month'), '2026-10-01');
  assert.equal(bucketKey('2026-10-15', 'day'), '2026-10-15');
  assert.deepEqual(bucketLabels('2026-09-28', 'week'), { label: '2026/9/28〜10/4', short: '9/28〜' });
  assert.deepEqual(bucketLabels('2026-12-01', 'month'), { label: '2026年12月', short: '2026/12' });
});

test('trendSeries: 投稿数は投稿の無い週も 0 件で並べ、平均は投稿の無い週を空ける', () => {
  const posts = [
    { dateKey: '2026-09-01', er: 4, reach: 100, interactions: 10 },
    { dateKey: '2026-09-02', er: 2, reach: 300, interactions: 20 },
    { dateKey: '2026-09-16', er: 6, reach: null, interactions: 30 },
  ];
  const count = trendSeries('posts', { posts }, 'week');
  assert.deepEqual(count.rows.map((r) => [r.key, r.value]), [['2026-08-31', 2], ['2026-09-07', 0], ['2026-09-14', 1]]);
  assert.equal(count.rows[1].change, -100);
  assert.equal(count.rows[2].change, null); // 0 件からの増減率は出さない

  const er = trendSeries('er', { posts }, 'week');
  assert.deepEqual(er.rows.map((r) => r.value), [3, null, 6]);
  assert.equal(er.rows[2].change, 3); // 率はポイント差（空いた週を飛ばして直前の値と比べる）

  const reach = trendSeries('reach', { posts }, 'week');
  assert.deepEqual(reach.rows.map((r) => r.value), [200]); // リーチの無い投稿は除く
});

test('trendSeries: フォロワー数は期間の最終日、日次の指標は合計（月別）', () => {
  const daily = [
    { date: '2026-08-30', followers: 100, profileVisits: 5 },
    { date: '2026-08-31', followers: 110, profileVisits: null },
    { date: '2026-09-01', followers: 120, profileVisits: 7 },
    { date: '2026-09-30', followers: 150, profileVisits: 3 },
  ];
  assert.deepEqual(trendSeries('followers', { daily }, 'month').rows.map((r) => [r.label, r.value]), [['2026年8月', 110], ['2026年9月', 150]]);
  assert.deepEqual(trendSeries('profileVisits', { daily }, 'month').rows.map((r) => r.value), [5, 10]);
});

test('trendSeries: GA4 は Instagram 流入だけ、率は分子・分母を合計してから割る', () => {
  const ga4 = [
    { date: '2026-09-01', sourceMedium: 'instagram / social', level: 'source', sessions: 100, users: 80, newUsers: 40, engagedSessions: 60, cv: 2 },
    { date: '2026-09-03', sourceMedium: 'instagram / paid', level: 'source', sessions: 50, users: 20, newUsers: 20, engagedSessions: 15, cv: 1 },
    { date: '2026-09-03', sourceMedium: 'google / organic', level: 'source', sessions: 999, users: 999, newUsers: 999, engagedSessions: 999, cv: 99 },
    // キャンペーン別は参照元別と二重になるので数えない
    { date: '2026-09-03', sourceMedium: 'instagram / social', level: 'campaign', campaign: 'x', sessions: 30, users: 30, newUsers: 30, engagedSessions: 30, cv: 3 },
  ];
  const s = trendSeries('hpSessions', { ga4 }, 'week').rows;
  assert.deepEqual(s.map((r) => r.value), [150]);
  const nr = trendSeries('hpNewRate', { ga4 }, 'week').rows[0];
  assert.equal(nr.num, 60);
  assert.equal(nr.den, 100);
  assert.equal(nr.value, 60);
  const eng = trendSeries('hpEngagement', { ga4 }, 'week').rows[0];
  assert.ok(Math.abs(eng.value - (75 / 150) * 100) < 1e-9);
  const cvr = trendSeries('hpCvr', { ga4 }, 'day').rows;
  assert.deepEqual(cvr.map((r) => r.key), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(cvr[1].value, null);
  assert.equal(cvr[2].value, 2);
});

test('trendSeries: 未知の指標は null、データが無ければ空', () => {
  assert.equal(trendSeries('nope', {}), null);
  assert.deepEqual(trendSeries('hpCv', { ga4: [] }).rows, []);
  // 上部の全カードに対応する指標がある
  assert.equal(TREND_METRICS.length, 15);
});
