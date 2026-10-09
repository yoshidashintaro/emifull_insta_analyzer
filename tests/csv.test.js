// Meta Business Suite のエクスポート（UTF-16LE / sep= 行 / 複数セクション / 1指標ファイル）の取り込み
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCSV, importCSV, parseCSV, splitSections, describeImport } from '../public/js/data/csv.js';
import {
  normalizeDaily, anchorFollowers, detectFollowerMode, normalizePost, enrichPosts,
  summarize, funnel, audienceSummary, accountsOf, byAccount, localizeCountry,
} from '../public/js/analytics.js';
import { mergeDaily, mergeAudience } from '../public/js/storage.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = async (name) => decodeCSV(await readFile(join(FIX, name)));
const importFile = async (name) => importCSV(await load(name), { fileName: name });

test('decodeCSV: UTF-16LE（BOM 付き）を読める', async () => {
  const text = await load('Reach.csv');
  assert.match(text, /^sep=,/);
  assert.ok(text.includes('"Reach"'));
  assert.ok(!text.includes('\u0000'));
});

test('decodeCSV: UTF-8 / BOM 付き UTF-8 / Shift_JIS', () => {
  assert.equal(decodeCSV(Buffer.from('日付,リーチ', 'utf8')), '日付,リーチ');
  assert.equal(decodeCSV(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b', 'utf8')])), 'a,b');
  // Shift_JIS の「日付」は UTF-8 として不正なので、フォールバックが効く
  assert.equal(decodeCSV(Buffer.from([0x93, 0xfa, 0x95, 0x74])), '日付');
});

test('parseCSV: sep= 行を区切り文字として解釈して取り除く', () => {
  const rows = parseCSV('sep=;\r\n"a";"b"\r\n1;2\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('splitSections: 空行でセクションに分かれる', () => {
  const rows = parseCSV('A\r\n1\r\n\r\nB\r\n2\r\n', { keepEmpty: true });
  const sections = splitSections(rows);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections[0], [['A'], ['1']]);
});

test('1指標エクスポート: 表題「Reach」から指標を判別する', async () => {
  const res = await importFile('Reach.csv');
  assert.deepEqual(res.kinds, ['reach']);
  assert.equal(res.daily.length, 7);
  assert.equal(res.daily[0].date, '2026-09-17');
  assert.equal(res.daily[0].reach, 4635);
  assert.equal(res.daily[0].views, null);
});

test('1指標エクスポート: 各ファイルが正しい指標に入る', async () => {
  const cases = [
    ['Views.csv', 'views', 16374],
    ['Follows.csv', 'follows', 2],
    ['Visits.csv', 'profileVisits', 146],
    ['Link clicks.csv', 'linkClicks', 120],
    ['Interactions.csv', 'interactions', 13],
  ];
  for (const [file, key, first] of cases) {
    const res = await importFile(file);
    assert.deepEqual(res.kinds, [key], file);
    assert.equal(res.daily[0][key], first, file);
  }
});

test('表題が無くてもファイル名から指標を判別できる', () => {
  const text = 'sep=,\r\n"Date","Primary"\r\n"2026-09-20T00:00:00","5"\r\n';
  assert.equal(importCSV(text, { fileName: 'Link clicks.csv' }).daily[0].linkClicks, 5);
  assert.throws(() => importCSV(text, { fileName: 'なぞのファイル.csv' }), /判別できません/);
});

test('Audience.csv: フォロワー総数・年齢×性別・都市・国を読む', async () => {
  const res = await importFile('Audience.csv');
  const a = res.audience;
  assert.equal(a.followersTotal, 9219);
  assert.equal(a.ageGender.length, 6);
  assert.deepEqual(a.ageGender[2], { age: '35-44', women: 33.5, men: 4.9 });
  assert.deepEqual(a.ageSeries.map((s) => s.key), ['women', 'men']);
  assert.deepEqual(a.countries[0], { name: 'Japan', value: 80 });
  assert.deepEqual(a.cities[0], { name: 'Osaka, Japan', value: 21 });
  assert.equal(res.daily.length, 0);
});

test('投稿エクスポート: 複数アカウント・ビュー・フォローまで読む', async () => {
  const res = await importFile('posts_meta.csv');
  assert.equal(res.posts.length, 3);
  const [first] = res.posts;
  assert.equal(first.id, '18096220198995158');
  assert.equal(first.account, 'miselclinic_osaka');
  assert.equal(first.views, 35306);
  assert.equal(first.reach, 36219);
  assert.equal(first.follows, 30);
  assert.equal(first.shares, 3);
  assert.equal(first.saves, 41);
  assert.equal(normalizePost(first).type, 'CAROUSEL');
  assert.equal(normalizePost(res.posts[1]).type, 'REELS');
  assert.equal(res.posts[1].duration, 87);
  // 改行を含む引用付きキャプションが壊れていない
  assert.ok(first.caption.includes('#ボツラックス'));
});

test('指標ごとに分かれたファイルが1本の時系列にマージされる', async () => {
  let daily = [];
  for (const f of ['Reach.csv', 'Views.csv', 'Visits.csv', 'Link clicks.csv', 'Interactions.csv', 'Follows.csv']) {
    daily = mergeDaily(daily, (await importFile(f)).daily);
  }
  const row = daily.find((d) => d.date === '2026-09-17');
  assert.equal(row.reach, 4635);
  assert.equal(row.views, 16374);
  assert.equal(row.profileVisits, 146);
  assert.equal(row.linkClicks, 120);
  assert.equal(row.interactions, 13);
  assert.equal(row.follows, 2);
});

test('フォロワー総数を期間末に置いて推移を逆算する', async () => {
  const follows = (await importFile('Follows.csv')).daily;
  const audience = (await importFile('Audience.csv')).audience;
  const daily = normalizeDaily(anchorFollowers(follows, audience));
  assert.equal(daily.at(-1).followers, 9219);
  // 最終日の直前は「総数 − その日のフォロー数」
  assert.equal(daily.at(-1).netChange, 6);
  assert.equal(daily.at(-2).followers, 9219 - 6);
  assert.equal(detectFollowerMode(daily), 'gains');
});

test('フォロー解除があれば純増モードになる', () => {
  const daily = normalizeDaily([
    { date: '2026-09-01', follows: 10, unfollows: 4 },
    { date: '2026-09-02', follows: 3, unfollows: 5 },
  ]);
  assert.equal(daily[0].netChange, 6);
  assert.equal(daily[1].netChange, -2);
  assert.equal(detectFollowerMode(daily), 'net');
});

test('funnel: リーチ → プロフィール → リンククリック → フォロー', async () => {
  let daily = [];
  for (const f of ['Reach.csv', 'Visits.csv', 'Link clicks.csv', 'Follows.csv']) {
    daily = mergeDaily(daily, (await importFile(f)).daily);
  }
  const steps = funnel(summarize(normalizeDaily(daily), []));
  assert.deepEqual(steps.map((s) => s.key), ['reach', 'profileVisits', 'linkClicks', 'follows']);
  assert.equal(steps[0].rate, null);
  assert.equal(steps[1].value, 959);
  // 959 / 34150 ≒ 2.81%
  assert.ok(Math.abs(steps[1].rate - (959 / 34150) * 100) < 1e-9);
});

test('audienceSummary: 中心層と性別比を出す', async () => {
  const a = audienceSummary((await importFile('Audience.csv')).audience);
  assert.equal(a.topAge.age, '35-44');
  assert.ok(Math.abs(a.topAge.value - 38.4) < 1e-9);
  assert.equal(a.topGender.label, '女性');
  assert.ok(Math.abs(a.topGender.value - 84.7) < 1e-9);
  assert.equal(a.countries.length, 3);
});

test('accountsOf / byAccount: アカウントごとに集計する', async () => {
  const posts = (await importFile('posts_meta.csv')).posts.map(normalizePost);
  const enriched = enrichPosts(posts, [], 'reach', 9219);
  const accounts = accountsOf(enriched);
  assert.deepEqual(accounts.map((a) => a.username), ['miselclinic_osaka', 'dr.okudate_miselclinic']);
  assert.equal(accounts[0].n, 2);
  const stats = byAccount(enriched);
  assert.equal(stats.find((a) => a.username === 'miselclinic_osaka').follows, 30);
});

test('1ファイルに投稿と日次が混在していても両方取り込む', () => {
  const text = [
    '日付,リーチ,フォロワー数',
    '2026-09-01,100,500',
    '',
    '公開日時,いいね,コメント,保存,リーチ',
    '2026-09-01 12:00,10,1,2,100',
  ].join('\r\n');
  const res = importCSV(text);
  assert.equal(res.daily.length, 1);
  assert.equal(res.posts.length, 1);
  assert.ok(describeImport(res).includes('投稿 1件'));
});

test('判別できないセクションは飛ばして、読めたものは取り込む', () => {
  const text = ['"なぞの表"', '"Date","Primary"', '"2026-09-01T00:00:00","3"', '', '"Reach"', '"Date","Primary"', '"2026-09-01T00:00:00","900"'].join('\r\n');
  const res = importCSV(text);
  assert.equal(res.daily.length, 1);
  assert.equal(res.daily[0].reach, 900);
  assert.equal(res.notes.length, 1);
});

test('mergeAudience: 後から来たファイルの項目を足しこむ', () => {
  const a = mergeAudience({ followersTotal: 100 }, { countries: [{ name: 'Japan', value: 80 }] });
  assert.equal(a.followersTotal, 100);
  assert.equal(a.countries.length, 1);
});

test('funnel: リンククリックとフォローはどちらもプロフィールが出発点', () => {
  const s = { totals: { reach: 10000, profileVisits: 500, linkClicks: 300, follows: 50 } };
  const steps = funnel(s);
  assert.deepEqual(steps.map((x) => x.from), [null, 'リーチ', 'プロフィールアクセス', 'プロフィールアクセス']);
  assert.equal(steps[2].rate, 60);
  assert.equal(steps[3].rate, 10);
});

test('funnel: 途中の段階が欠けていれば、さかのぼって出発点を選ぶ', () => {
  const steps = funnel({ totals: { reach: 10000, profileVisits: null, linkClicks: 200, follows: 40 } });
  assert.deepEqual(steps.map((x) => x.key), ['reach', 'linkClicks', 'follows']);
  assert.equal(steps[1].from, 'リーチ');
  assert.equal(steps[1].rate, 2);
  assert.equal(steps[2].from, 'リーチ');
});

test('funnel: リーチが無ければ先頭の段に通過率は出ない', () => {
  const steps = funnel({ totals: { reach: null, profileVisits: 500, linkClicks: 300, follows: null } });
  assert.deepEqual(steps.map((x) => x.key), ['profileVisits', 'linkClicks']);
  assert.equal(steps[0].rate, null);
  assert.equal(steps[1].rate, 60);
});

test('国名と都市名の末尾の国を日本語にする', async () => {
  const a = audienceSummary((await importFile('Audience.csv')).audience);
  assert.deepEqual(a.countries.map((c) => c.name), ['日本', '台湾', '中国']);
  assert.equal(a.cities[0].name, 'Osaka, 日本');
  assert.equal(a.cities[1].name, 'Xinbei, New Taipei City, 台湾');
  // 一覧にない国はそのまま
  assert.equal(localizeCountry('Narnia'), 'Narnia');
});
