// ソーシャルインサイトの書き出し CSV（投稿一覧・ハッシュタグ分析・フォロー中アカウント）の取り込み
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCSV, parseCSV, importCSV } from '../public/js/data/csv.js';
import {
  readSocialInsight, parseSIFileName, shortcodeOf, dailyFromSIPosts,
  mergeHashtags, mergeFollowed, mergeSummary, mergeStories, mergeTagged, describeSocialInsight,
} from '../public/js/data/socialInsight.js';
import { normalizePost, normalizeDaily, enrichPosts, formatJST, detectFollowerMode } from '../public/js/analytics.js';
import { mergePosts, mergeDaily } from '../public/js/storage.js';
import { applyNonFollowerEstimate } from '../public/js/data/reachMix.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const POSTS_FILE = 'si__accounts-posts_ミセルクリニック大阪_instagram_20251014-20261008_utf8.csv';
const HASHTAG_FILE = 'si__accounts-hashtag_analysis_ミセルクリニック大阪_20251014-20261008_utf8.csv';
const FOLLOWED_FILE = 'si__accounts-followed_ミセルクリニック大阪_instagram_261008173434_utf8.csv';
const SUMMARY_FILE = 'si__accounts-summary_ミセルクリニック大阪_instagram_20260701-20261008_utf8.csv';
const INSIGHT_POSTS_FILE = 'si__instagram_insights-posts_ミセルクリニック大阪_20260701-20261008_utf8.csv';
const INSIGHT_HASHTAG_FILE = 'si__instagram_insights-hashtag_ミセルクリニック大阪_20260701-20261008_utf8.csv';
const INSIGHT_DAILY_FILE = 'si__instagram_insights-summary_ミセルクリニック大阪_20260701-20261008_utf8.csv';
const STORIES_FILE = 'si__instagram_insights-stories_ミセルクリニック大阪_20260701-20261008_utf8.csv';
const TAGGED_FILE = 'si__instagram_insights-tagged_ミセルクリニック大阪_20260701-20261008_utf8.csv';

const read = async (name) => readSocialInsight(parseCSV(decodeCSV(await readFile(join(FIX, name)))), { fileName: name });

test('parseSIFileName: ファイル名から種類・アカウント名・期間を読む', () => {
  assert.deepEqual(parseSIFileName(POSTS_FILE), {
    kind: 'posts', label: 'ミセルクリニック大阪', start: '2025-10-14', end: '2026-10-08', fetchedAt: null,
  });
  assert.deepEqual(parseSIFileName(HASHTAG_FILE), {
    kind: 'hashtags', label: 'ミセルクリニック大阪', start: '2025-10-14', end: '2026-10-08', fetchedAt: null,
  });
  // 期間の無い書き出しは取得日時（YYMMDDHHMMSS）から取得日を読む
  assert.deepEqual(parseSIFileName(FOLLOWED_FILE), {
    kind: 'followed', label: 'ミセルクリニック大阪', start: null, end: null, fetchedAt: '2026-10-08',
  });
  // 名前を変えられていても落ちない
  assert.deepEqual(parseSIFileName('投稿データ.csv'), { kind: null, label: '投稿データ', start: null, end: null, fetchedAt: null });
});

test('shortcodeOf: リール・通常投稿のパーマリンクから短縮コードを取る', () => {
  assert.equal(shortcodeOf('https://www.instagram.com/reel/DeMGEkcBqm5/'), 'DeMGEkcBqm5');
  assert.equal(shortcodeOf('https://www.instagram.com/p/Dd6LYQnkr4e/'), 'Dd6LYQnkr4e');
  assert.equal(shortcodeOf('https://example.com/'), '');
});

test('投稿一覧：日時は日本時間・タイプ・いいね・再生回数・投稿時点のフォロワー数を読む', async () => {
  const res = await read(POSTS_FILE);
  assert.equal(res.kind, 'posts');
  assert.equal(res.label, 'ミセルクリニック大阪');
  assert.equal(res.posts.length, 4);

  const [first] = res.posts;
  assert.equal(first.id, 'si:DeMGEkcBqm5');
  assert.equal(formatJST(first.timestamp, 'short'), '2026/10/07 19:00'); // 2026/10/07 19:00:10 は日本時間
  assert.equal(first.likes, 10);
  assert.equal(first.comments, 0);
  assert.equal(first.views, 954);
  assert.equal(first.followersAtPost, 9271);
  assert.equal(first.erByFollowers, 0.11);
  assert.equal(first.likeScore, 39.5);
  assert.equal(first.accountName, 'ミセルクリニック大阪');
  // この書き出しに無い指標は null のまま（0 と区別する）
  assert.deepEqual([first.reach, first.saves, first.shares, first.follows], [null, null, null, null]);
  // 「-」「''」は値なしとして扱う
  assert.equal(first.thumbnail, '');
  assert.equal(res.posts[1].views, null);
  assert.equal(res.posts[1].thumbnail, 'https://scontent-nrt1-2.cdninstagram.com/v/t51.82787-15/827774190.jpg');
  assert.equal(res.posts[3].likeScore, null);
  assert.equal(res.posts[3].likes, 0); // いいね 0 は欠損ではない

  // タイプは画面の区分（リール／カルーセル／画像）に正規化できる
  assert.deepEqual(res.posts.map((p) => normalizePost(p).type), ['REELS', 'CAROUSEL', 'IMAGE', 'CAROUSEL']);
});

test('投稿一覧：投稿時点のフォロワー数を日次データにする（同じ日はその日の最後の投稿）', async () => {
  const res = await read(POSTS_FILE);
  assert.deepEqual(res.daily, [
    { date: '2026-06-28', followers: 9039, netChange: null, follows: null, unfollows: null, reach: null, nonFollowerReach: null, views: null, profileVisits: null, linkClicks: null, interactions: null, engagedAccounts: null },
    { date: '2026-09-30', followers: 9250, netChange: null, follows: null, unfollows: null, reach: null, nonFollowerReach: null, views: null, profileVisits: null, linkClicks: null, interactions: null, engagedAccounts: null },
    { date: '2026-10-07', followers: 9271, netChange: null, follows: null, unfollows: null, reach: null, nonFollowerReach: null, views: null, profileVisits: null, linkClicks: null, interactions: null, engagedAccounts: null },
  ]);
  // 9/30 は 10:00（9240人）と 20:00（9250人）の2件 → 当日最後の 9250 を採る
  assert.equal(dailyFromSIPosts([
    { timestamp: '2026-09-30T01:00:00.000Z', followersAtPost: 9240 },
    { timestamp: '2026-09-30T11:00:00.000Z', followersAtPost: 9250 },
    { timestamp: '2026-09-30T12:00:00.000Z', followersAtPost: null },
  ])[0].followers, 9250);

  // 投稿のあった日だけが分かるので、間の日は空のまま（勝手に補間しない）。
  // 連続した日が分かれば、純増減は前日との差から埋まる
  const filled = normalizeDaily([...res.daily, { date: '2026-10-06', followers: 9265 }]);
  assert.equal(filled.at(-1).date, '2026-10-07');
  assert.equal(filled.at(-1).netChange, 6); // 9271 − 9265
  assert.equal(filled.find((d) => d.date === '2026-10-01').followers, null);
});

test('自由文に半角カンマが入って列がずれた行も直して読む', () => {
  // この書き出しは「内容」「プロフィール」を引用符で囲まないため、本文のカンマで列が増える
  const posts = readSocialInsight(parseCSV(
    '投稿時間,詳細URL,タイプ,内容,フィルター,画像URL,フォロワー数,いいね数,コメント数,動画再生回数,エンゲージメント率,いいね偏差値(β)\n'
    + "2026/10/07 19:00:10,https://www.instagram.com/p/AAA/,画像,Hello, world, again,-,'',9271,10,2,-,0.13%,39.5\n",
  ));
  assert.equal(posts.posts[0].caption, 'Hello, world, again');
  assert.deepEqual([posts.posts[0].followers, posts.posts[0].likes, posts.posts[0].comments], [undefined, 10, 2]);
  assert.equal(posts.posts[0].followersAtPost, 9271);
  assert.equal(posts.posts[0].likeScore, 39.5);

  const followed = readSocialInsight(parseCSV(
    'ユーザーID,ユーザーID,ユーザーネーム,詳細URL,プロフィール,よく使用するハッシュタグ,フォロー数,フォロワー数,投稿数\n'
    + '1,ID:1,foo,https://www.instagram.com/foo,Nail salon, Osaka,#ネイル,364,3956,1511\n',
  ));
  assert.equal(followed.followed[0].profile, 'Nail salon, Osaka');
  assert.deepEqual([followed.followed[0].follows, followed.followed[0].followers, followed.followed[0].posts], [364, 3956, 1511]);
});

test('投稿インサイト：リーチ・保存・シェア・直フォローまで読む', async () => {
  const res = await read(INSIGHT_POSTS_FILE);
  assert.equal(res.kind, 'insightPosts');
  assert.equal(res.posts.length, 3);

  const [first] = res.posts;
  // 投稿日時はタイムゾーン付き（+0900）。日本時間として読める
  assert.equal(formatJST(first.timestamp, 'short'), '2026/07/01 18:48');
  assert.equal(first.id, 'si:DaPuyFTj2gn'); // 投稿一覧と同じ付け方（短縮コード）
  assert.equal(first.mediaId, '17956645632169445');
  assert.equal(first.account, 'miselclinic_osaka');
  assert.equal(first.accountName, 'ミセルクリニック大阪梅田院｜美容皮膚科•外科');
  assert.deepEqual(
    [first.views, first.reach, first.likes, first.comments, first.saves, first.shares, first.follows, first.profileVisits],
    [2166, 982, 19, 0, 14, 0, 0, 7],
  );
  assert.equal(first.saveRate, 1.43); // リーチに対する保存率（%）
  assert.equal(first.erByViews, 1.48); // 閲覧数基準のエンゲージメント率（%）
  assert.equal(first.engagementReported, 32);
  assert.equal(first.viewsScore, 48.3);
  // 複数行にまたがる引用符付きキャプションも読める
  assert.ok(first.caption.includes('組み合わせ美肌治療'));
  assert.ok(first.caption.includes('#美肌治療'));

  // リールは再生時間・スキップ率が入る（画像・カルーセルは「-」なので null）
  const reel = res.posts.at(-1);
  assert.equal(normalizePost(reel).type, 'REELS');
  assert.deepEqual([reel.avgWatchSec, reel.totalWatchSec, reel.skipRate], [8.8, 5606, 65.4]);
  assert.deepEqual([first.avgWatchSec, first.totalWatchSec, first.skipRate], [null, null, null]);

  // リーチが入るので、リーチ基準のエンゲージメント率も出せる
  const enriched = enrichPosts(res.posts.map(normalizePost), [], 'reach', 9271);
  assert.ok(Math.abs(enriched[0].er - 3.36) < 0.01); // (19+0+14+0) / 982
});

test('投稿一覧と投稿インサイトは同じ投稿として統合され、足りない指標を補い合う', async () => {
  const accounts = await read(POSTS_FILE);
  const insights = await read(INSIGHT_POSTS_FILE);
  const merged = mergePosts(mergePosts([], insights.posts), accounts.posts);

  // 10/07 のリール（両方の書き出しにある）は1件にまとまる
  const same = merged.filter((p) => p.id === 'si:DeMGEkcBqm5');
  assert.equal(same.length, 1);
  // 後から読んだ投稿一覧の値（いいね・フォロワー数）と、
  // 先に読んだインサイトの値（リーチ・保存）が両方残る
  assert.deepEqual(
    [same[0].likes, same[0].followersAtPost, same[0].reach, same[0].saves, same[0].erByFollowers, same[0].erByViews],
    [10, 9271, 611, 1, 0.11, 1.16],
  );
  // 逆の順番で取り込んでも同じ
  const reverse = mergePosts(mergePosts([], accounts.posts), insights.posts).find((p) => p.id === 'si:DeMGEkcBqm5');
  assert.deepEqual([reverse.likes, reverse.followersAtPost, reverse.reach, reverse.saves], [10, 9271, 611, 1]);
});

test('ハッシュタグ分析：インサイト版は閲覧数・リーチ・保存が入り、率の分母も違う', async () => {
  const res = await read(INSIGHT_HASHTAG_FILE);
  assert.equal(res.kind, 'hashtags');
  assert.equal(res.source, 'insights');
  const [first] = res.hashtags;
  assert.equal(first.tag, 'ミセルクリニック');
  assert.equal(first.source, 'insights');
  assert.equal(first.erBasis, 'views'); // 閲覧数基準（アカウント版はフォロワー基準）
  assert.deepEqual([first.posts, first.viewsTotal, first.reachTotal, first.likesTotal, first.savesTotal], [13, 35287, 13772, 171, 110]);
  assert.deepEqual([first.viewsMean, first.reachMean, first.savesMean, first.erMean], [2714.4, 1059.4, 8.5, 0.81]);
  assert.equal(first.commentsTotal, null); // インサイト版にコメントの列は無い

  // アカウント版は閲覧数・リーチ・保存が無く、率はフォロワー基準
  const accounts = await read(HASHTAG_FILE);
  assert.equal(accounts.source, 'accounts');
  assert.deepEqual([accounts.hashtags[0].erBasis, accounts.hashtags[0].viewsTotal, accounts.hashtags[0].commentsTotal], ['followers', null, 56]);

  // 同じタグ・同じ期間でも、分母が違うので別の行として残す
  const merged = mergeHashtags(accounts.hashtags, res.hashtags);
  const misel = merged.filter((h) => h.tag === 'ミセルクリニック');
  assert.deepEqual(misel.map((h) => [h.source, h.erMean]), [['insights', 0.81]]);
  const osaka = merged.filter((h) => h.tag === '大阪');
  assert.deepEqual(osaka.map((h) => h.source), ['accounts']);
  assert.equal(merged.filter((h) => h.tag === '美容皮膚科').length, 2);
});

test('アカウント日次：フォロワー数を日次データにし、累計投稿数とフォロー中の数は別に持つ', async () => {
  const res = await read(SUMMARY_FILE);
  assert.equal(res.kind, 'summary');
  assert.equal(res.summary.length, 5);
  assert.deepEqual(res.summary[0], {
    date: '2026-10-04', account: 'ミセルクリニック大阪', followers: 9262, postsTotal: 617, following: 729,
  });
  // 日次データに入るのはフォロワー数だけ。
  // 「フォロー数」は自社がフォローしている数なので、新規フォロー数（follows）には入れない
  assert.deepEqual(res.daily.map((d) => [d.date, d.followers, d.follows]), [
    ['2026-10-04', 9262, null], ['2026-10-05', 9267, null], ['2026-10-06', 9271, null],
    ['2026-10-07', 9271, null], ['2026-10-08', 9271, null],
  ]);

  // 連続した日付がそろうので、純増減が前日差から埋まる
  const filled = normalizeDaily(res.daily);
  assert.deepEqual(filled.map((d) => d.netChange), [null, 5, 4, 0, 0]);
  // フォロワー総数が分かるので、推移は推定ではなく実測として扱われる
  assert.equal(detectFollowerMode(filled), 'net');
});

test('アカウント日次：Meta 用リーダーに渡すと「フォロー数」を新規フォロー数と誤読するため、先にこちらで受ける', async () => {
  const text = decodeCSV(await readFile(join(FIX, SUMMARY_FILE)));
  // Meta 用リーダーは 733 のようなフォロー中の数を「その日の新規フォロー数」として読んでしまう
  const wrong = importCSV(text, { fileName: SUMMARY_FILE });
  assert.equal(wrong.daily[0].follows, 729);
  // ソーシャルインサイト用リーダーが先に受けるので、取り込み結果は正しい
  const right = readSocialInsight(parseCSV(text), { fileName: SUMMARY_FILE });
  assert.equal(right.kind, 'summary');
  assert.equal(right.daily[0].follows, null);
  assert.equal(right.summary[0].following, 729);

  // 自作の日次 CSV（4列そろわない）は従来どおり Meta 用リーダーが読む
  assert.equal(readSocialInsight(parseCSV('日付,フォロワー数,フォロー数,フォロー解除\n2026/09/01,5120,32,6\n')), null);
});

test('日次インサイト：日次指標をほぼすべて実測で埋める（非フォロワーリーチも実数）', async () => {
  const res = await read(INSIGHT_DAILY_FILE);
  assert.equal(res.kind, 'insightDaily');
  assert.equal(res.summary.length, 3);
  assert.equal(res.daily.length, 3);

  const [day] = res.daily;
  assert.deepEqual(
    [day.date, day.followers, day.follows, day.unfollows, day.reach, day.nonFollowerReach, day.views, day.profileVisits, day.linkClicks, day.interactions, day.engagedAccounts],
    ['2026-07-01', 9038, 6, 6, 4946, 3907, 19978, 160, 11, 20, 19],
  );
  // 「フォロー数(733)」は自社がフォローしている数なので日次指標には入れない
  assert.equal(day.follows, 6); // フォロワー増加数
  assert.equal(res.summary[0].following, 733);
  // 面別・クリック種別の内訳は日次指標とは別に保持する
  assert.deepEqual(
    [res.summary[0].reachFeed, res.summary[0].reachReels, res.summary[0].reachStories, res.summary[0].followerReach],
    [1042, 40, 369, 988],
  );
  assert.deepEqual([res.summary[0].saves, res.summary[0].shares, res.summary[0].likes, res.summary[0].postsTotal], [5, 1, 13, 577]);
  assert.equal(res.summary[0].followerConversionRate, 3.75);

  // フォロー解除が入るので推移は実測モード、純増減はフォロワー増加数−減少数
  const filled = normalizeDaily(res.daily);
  assert.equal(detectFollowerMode(filled), 'net');
  assert.equal(filled[0].netChange, 0); // 6 − 6
  // 非フォロワーリーチが実数で入るため、比率からの推定は行われない
  const est = applyNonFollowerEstimate({ posts: [], daily: res.daily }, [{ account: '', start: '2026-07-01', end: '2026-10-08', ratio: 93.2 }], '');
  assert.equal(est.estimated, false);
  assert.equal(est.daily[0].nonFollowerReach, 3907);
});

test('日次インサイト：アカウント日次サマリーと同じ日でも、片方だけの項目は残る', async () => {
  const insights = await read(INSIGHT_DAILY_FILE);
  const accounts = await read(SUMMARY_FILE);
  // 10/08 は両方の書き出しにある
  const merged = mergeSummary(mergeSummary([], accounts.summary), insights.summary);
  const day = merged.filter((r) => r.date === '2026-10-08');
  assert.equal(day.length, 1); // アカウント名が違っても、ファイル名のアカウントでそろえて1行にまとまる
  assert.equal(day[0].account, 'ミセルクリニック大阪');
  assert.deepEqual([day[0].followers, day[0].postsTotal, day[0].following, day[0].reach], [9271, 619, 729, 4340]);

  // 日次データとしても1本の時系列にまとまる
  const daily = mergeDaily(accounts.daily, insights.daily);
  const last = daily.find((d) => d.date === '2026-10-08');
  assert.deepEqual([last.followers, last.reach, last.nonFollowerReach], [9271, 4340, 3510]);
});

test('ストーリーズ：閲覧率・離脱・タップなどストーリーズ固有の指標を読む', async () => {
  const res = await read(STORIES_FILE);
  assert.equal(res.kind, 'stories');
  assert.equal(res.stories.length, 4);
  assert.equal(res.posts.length, 0); // 投稿には混ぜない

  const [first] = res.stories;
  assert.equal(first.id, 'si:story:18055774643784187');
  assert.equal(formatJST(first.timestamp, 'short'), '2026/07/01 09:54');
  assert.equal(first.type, 'VIDEO'); // 「動画」
  assert.equal(res.stories[1].type, 'IMAGE'); // 「画像」
  assert.deepEqual(
    [first.views, first.viewRate, first.reach, first.replies, first.profileVisits, first.exits, first.tapsForward, first.tapsBack, first.swipeForward],
    [394, 4.36, 328, 0, 1, 46, 266, 14, 43],
  );
  assert.equal(first.linkClicks, null); // 「-」は値なし
  assert.equal(res.stories[2].linkClicks, 31);
  // 直前に投稿されて数値がそろっていない行も、0 と「-」を取り違えずに読む
  assert.deepEqual(
    [res.stories[3].views, res.stories[3].exits, res.stories[3].shares, res.stories[3].swipeForward],
    [0, 0, null, null],
  );

  // 取り込みを繰り返しても重複しない
  assert.equal(mergeStories(mergeStories([], res.stories), res.stories).length, 4);
});

test('タグ付き投稿：他アカウントの投稿として、自社の投稿とは分けて読む', async () => {
  const res = await read(TAGGED_FILE);
  assert.equal(res.kind, 'tagged');
  assert.equal(res.tagged.length, 3);
  assert.equal(res.posts.length, 0); // 自社の投稿ではないので posts には入れない

  const [first] = res.tagged;
  assert.equal(first.id, 'si:DaSiqa4JXf8');
  assert.equal(first.mediaId, '17944465263232658');
  assert.equal(first.account, 'dr.okudate_miselclinic'); // 投稿した側
  assert.equal(first.owner, 'ミセルクリニック大阪'); // タグ付けされた側
  assert.deepEqual([first.likes, first.comments], [27, 0]);
  assert.equal(res.tagged[1].account, 'emifull1122');
  assert.deepEqual([res.tagged.at(-1).likes, res.tagged.at(-1).comments], [53, 2]);
  assert.equal(mergeTagged(mergeTagged([], res.tagged), res.tagged).length, 3);
});

test('ハッシュタグ分析：タグごとの件数・いいね・コメント・エンゲージメント率を読む', async () => {
  const res = await read(HASHTAG_FILE);
  assert.equal(res.kind, 'hashtags');
  assert.equal(res.hashtags.length, 4);
  assert.deepEqual(res.hashtags[0], {
    tag: '大阪', account: 'ミセルクリニック大阪', source: 'accounts', erBasis: 'followers',
    start: '2025-10-14', end: '2026-10-08',
    posts: 74, likesTotal: 663, likesMean: 9.0, likesMedian: 9,
    commentsTotal: 56, commentsMean: 0.8, commentsMedian: 0,
    erMean: 0.11, erMedian: 0.11,
    // アカウント版の書き出しに無い指標は null
    viewsTotal: null, viewsMean: null, viewsMedian: null,
    reachTotal: null, reachMean: null, reachMedian: null,
    savesTotal: null, savesMean: null, savesMedian: null,
  });
  assert.equal(res.hashtags.at(-1).tag, '豊胸');
  assert.equal(res.hashtags.at(-1).erMean, 0.2);
});

test('フォロー中アカウント：ユーザー名・フォロワー数・よく使うハッシュタグを読む', async () => {
  const res = await read(FOLLOWED_FILE);
  assert.equal(res.kind, 'followed');
  assert.equal(res.followed.length, 4);
  assert.deepEqual(res.followed[0], {
    username: 'doctor_yuriko', userId: '34587404923',
    url: 'https://www.instagram.com/doctor_yuriko',
    profile: '~「あなたは美しい。」を証明する~',
    hashtags: ['鼻整形', '鼻', '美容整形'],
    follows: 884, followers: 87689, posts: 330,
    owner: 'ミセルクリニック大阪', fetchedAt: '2026-10-08',
  });
  // 「-」のプロフィール・ハッシュタグは空で持つ
  assert.deepEqual(res.followed[2].hashtags, []);
  assert.equal(res.followed[3].profile, '');
});

test('マージ：同じタグ・同じアカウントは新しい方で上書きし、多い順に並べる', () => {
  const tags = mergeHashtags(
    [{ account: 'A', tag: '大阪', posts: 70 }, { account: 'A', tag: '豊胸', posts: 7 }],
    [{ account: 'A', tag: '大阪', posts: 74 }, { account: 'A', tag: '医療脱毛', posts: 31 }],
  );
  assert.deepEqual(tags.map((t) => [t.tag, t.posts]), [['大阪', 74], ['医療脱毛', 31], ['豊胸', 7]]);
  // アカウントが違えば別の行として残す
  assert.equal(mergeHashtags(tags, [{ account: 'B', tag: '大阪', posts: 5 }]).length, 4);
  // 集計期間ごとの値なので、期間が違えば上書きせず両方残す（期間の新しい順）
  const periods = mergeHashtags(
    [{ account: 'A', tag: '大阪', start: '2025-10-14', end: '2026-10-08', posts: 74 }],
    [{ account: 'A', tag: '大阪', start: '2026-07-01', end: '2026-10-08', posts: 4 }],
  );
  assert.deepEqual(periods.map((t) => [t.start, t.posts]), [['2026-07-01', 4], ['2025-10-14', 74]]);

  // アカウント日次は日付単位で上書き・日付順
  const summary = mergeSummary(
    [{ account: 'A', date: '2026-10-07', followers: 9270 }],
    [{ account: 'A', date: '2026-10-07', followers: 9271 }, { account: 'A', date: '2026-10-06', followers: 9271 }],
  );
  assert.deepEqual(summary.map((s) => [s.date, s.followers]), [['2026-10-06', 9271], ['2026-10-07', 9271]]);

  const followed = mergeFollowed(
    [{ userId: '1', username: 'a', followers: 100 }],
    [{ userId: '1', username: 'a', followers: 120 }, { userId: '2', username: 'b', followers: 9000 }],
  );
  assert.deepEqual(followed.map((f) => [f.username, f.followers]), [['b', 9000], ['a', 120]]);
});

test('投稿・日次は既存データとマージできる（取り込みを繰り返しても重複しない）', async () => {
  const res = await read(POSTS_FILE);
  const posts = mergePosts(mergePosts([], res.posts), res.posts);
  assert.equal(posts.length, res.posts.length);
  assert.equal(mergeDaily(mergeDaily([], res.daily), res.daily).length, res.daily.length);

  // Meta の日次データ（リーチ）と同じ日付でもフォロワー数は失われない
  const merged = mergeDaily([{ date: '2026-10-07', reach: 4000 }], res.daily);
  const day = merged.find((d) => d.date === '2026-10-07');
  assert.equal(day.followers, 9271);
  assert.equal(day.reach, 4000);

  // 分析側（エンゲージメント率など）に渡せる形になっている
  const enriched = enrichPosts(posts.map(normalizePost), normalizeDaily(res.daily), 'followers', 9271);
  assert.equal(enriched.at(-1).interactions, 10); // いいね 10 ＋ コメント 0
  assert.equal(enriched.at(-1).followersAt, 9271);
  assert.ok(Math.abs(enriched.at(-1).er - 0.1078) < 0.001); // 書き出しの 0.11% とほぼ一致
});

test('他のツールの CSV は受け取らない（Meta の書き出しは importCSV のまま）', async () => {
  // 日次（日付・フォロワー数）
  assert.equal(readSocialInsight(parseCSV('日付,フォロワー数,新規フォロワー\n2026/09/01,5120,32\n')), null);
  // Meta の投稿データ（投稿時点のフォロワー数・エンゲージメント率の列が無い）
  const meta = '投稿ID,公開日時,投稿タイプ,説明,リーチ,いいね！,コメント,保存数,シェア,パーマリンク\n1001,2026/09/01 20:15,リール,本文,4210,188,12,41,17,\n';
  assert.equal(readSocialInsight(parseCSV(meta)), null);
  assert.equal(importCSV(meta).posts.length, 1);
  assert.equal(readSocialInsight([]), null);
  assert.equal(readSocialInsight(parseCSV('a,b\n1,2\n')), null);
});

test('describeSocialInsight: 取り込み結果を1行で説明する', async () => {
  assert.equal(
    describeSocialInsight(await read(POSTS_FILE)),
    'ソーシャルインサイト／投稿一覧 投稿 4件 / フォロワー数 3日分 （2025/10/14〜2026/10/08）',
  );
  assert.equal(
    describeSocialInsight(await read(FOLLOWED_FILE)),
    'ソーシャルインサイト／フォロー中アカウント フォロー中 4件',
  );
  assert.equal(
    describeSocialInsight(await read(SUMMARY_FILE)),
    'ソーシャルインサイト／アカウント日次 フォロワー数 5日分 （2026/07/01〜2026/10/08）',
  );
  assert.equal(describeSocialInsight(null), '');
});
