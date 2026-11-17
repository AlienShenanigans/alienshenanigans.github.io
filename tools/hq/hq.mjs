#!/usr/bin/env node
// Creator HQ data tool. Every command reads and writes the encrypted hq/data.enc
// and needs HQ_PASSWORD in the environment.
//
//   node tools/hq/hq.mjs add-twitch-csv <file.csv> [--game "Name"] [--date YYYY-MM-DD]
//   node tools/hq/hq.mjs fetch          pulls YouTube + Twitch + trending (skips any source without keys)
//   node tools/hq/hq.mjs take           asks Claude for the daily take (needs ANTHROPIC_API_KEY)
//   node tools/hq/hq.mjs set-take <file.json>   stores a take written elsewhere
//   node tools/hq/hq.mjs note "<text>" [--from "YouTube Studio"]
//   node tools/hq/hq.mjs tiktok-connect <code>   one-time: swaps the TikTok sign-in code for a token
//   node tools/hq/hq.mjs desk-feed      writes hq/desk-feed.enc (encrypted summary for the Shorts desk)
//   node tools/hq/hq.mjs show           prints the decrypted data
//   node tools/hq/hq.mjs rekey          re-encrypts with NEW_HQ_PASSWORD
//   node tools/hq/hq.mjs short-link <youtubeId> <tiktokId|none|auto>   fixes a wrong Shorts match
//   node tools/hq/hq.mjs short-tag <youtubeId|tiktokId> [--game "Slender"] [--hook "said I felt safe"] [--grade A] [--desk <deskId>]
//   node tools/hq/hq.mjs goal <key> <target|off> [--by YYYY-MM-DD]   keys: twitch-followers, yt-subs, yt-views, tt-followers, tt-likes,
//                                     yt-longform (long videos posted from today), shorts-weekly (Shorts per week)
//   node tools/hq/hq.mjs inventory [--shorts DIR] [--posted FILE] [--desk FILE] [--moments FILE] [--no-push]
//                                       runs on the PC: reads finished Shorts + posted log + moment library (read-only),
//                                       saves data.inventory, commits and pushes hq/data.enc only
//   node tools/hq/hq.mjs set-plan <file.json> [--week YYYY-MM-DD]   stores a plan written elsewhere (same checks)
//   node tools/hq/hq.mjs plan           asks Claude for next week's 4 Shorts slots (needs ANTHROPIC_API_KEY)
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { load, save, seal, upsert, ROOT } from './vault.mjs';

const YT_CHANNEL = 'UCMmjDFOAr2v_bBuBjW8SvOA';
const TWITCH_LOGIN = 'alienshenanigans';
const TREND_REGION = process.env.HQ_TREND_REGION || 'US';
const CLAUDE_MODEL = process.env.HQ_CLAUDE_MODEL || 'claude-sonnet-5-5';

// ---------- slot planner config (change here) ----------
// Each schedule applies from its `from` date (SAST). Days: 0 = Sunday … 6 = Saturday.
export const PLANNER = {
  schedules: [
    { from: '2026-01-01', slots: [
      { category: 'random', day: 0, time: '18:00' }, { category: 'horror', day: 2, time: '16:30' },
      { category: 'current', day: 4, time: '18:00' }, { category: 'trending', day: 6, time: '18:00' }] },
    { from: '2026-12-06', slots: [
      { category: 'horror', day: 3, time: '18:00' }, { category: 'current', day: 4, time: '18:00' },
      { category: 'trending', day: 6, time: '18:00' }, { category: 'random', day: 0, time: '18:00' }] },
  ],
  horrorGames: ['Alien: Isolation', 'Alien Isolation', 'Dead Space', 'Deadspace', 'Phasmophobia', 'Slender'],
  currentGames: ['WoW: Forever', 'WoW Forever', 'World of Warcraft', 'WoW', 'The Witcher 3', 'Witcher 3', 'Witcher'],
  // Extra games watched on Twitch / YouTube for "rising this week" (besides the two lists above).
  watchGames: ['Fallout: New Vegas', 'World of Warcraft', 'Phasmophobia', 'Dead Space', 'Alien: Isolation', 'The Witcher 3: Wild Hunt'],
  minMomentScore: 7, maxMoments: 40, weeksKept: 8,
};
const CATS = ['random', 'horror', 'current', 'trending'];

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : undefined; };
const today = () => new Date().toISOString().slice(0, 10);

// ---------- Twitch "Stream Session" CSV export ----------
// Twitch exports "6:49 PM"; HQ keeps "18:49".
function to24h(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return t;
  const h = (+m[1] % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, h === 'Timestamp' ? to24h(cells[i].trim()) : Number(cells[i])]));
  });
}

function summariseSession(rows, { date, game }) {
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const max = (k) => rows.reduce((a, r) => Math.max(a, r[k] || 0), 0);
  const chatMins = rows.map((r, i) => (r['Chat Messages'] > 0 ? i : -1)).filter((i) => i >= 0);
  const r1 = (n) => Math.round(n * 10) / 10;
  return {
    id: `${date}T${rows[0].Timestamp}`,
    date, game: game || null,
    start: rows[0].Timestamp, end: rows[rows.length - 1].Timestamp,
    minutes: rows.length,
    avgViewers: r1(sum('Average Viewers') / rows.length),
    peakViewers: max('Average Viewers'),
    liveViews: sum('Live Views'),
    newFollowers: sum('New Followers'),
    newSubs: sum('New Subscriptions'),
    peakChatters: max('Chatters'),
    chatMessages: sum('Chat Messages'),
    chatActiveMinutes: chatMins.length,
    longestQuietChat: longestQuiet(rows),
    adBreaks: rows.flatMap((r, i) => (r['Ad Breaks'] > 0 ? [{ minute: i, seconds: r['Ad Breaks'] }] : [])),
    clips: sum('Clips Created'), clipViews: sum('Clip Views'),
    series: rows.map((r) => [r.Timestamp, r['Average Viewers'], r['Chat Messages'], r['Ad Breaks']]),
  };
}

// Longest run of minutes with no chat messages: {fromMinute, minutes}.
function longestQuiet(rows) {
  let best = { fromMinute: null, minutes: 0 }, run = 0;
  rows.forEach((r, i) => {
    run = r['Chat Messages'] > 0 ? 0 : run + 1;
    if (run > best.minutes) best = { fromMinute: i - run + 1, minutes: run };
  });
  return best;
}

async function addTwitchCsv(file) {
  if (!file) throw new Error('Give the CSV path.');
  let date = flag('date');
  if (!date) {
    const m = path.basename(file).match(/from_(\d{1,2})_(\d{1,2})_(\d{4})/);
    if (!m) throw new Error('Could not read the date from the file name: pass --date YYYY-MM-DD');
    date = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const rows = parseCsv(await readFile(file, 'utf8'));
  const s = summariseSession(rows, { date, game: flag('game') });
  const data = await load();
  const old = data.twitch.sessions.find((x) => x.id === s.id);
  if (old && !s.game) s.game = old.game;
  data.twitch.sessions = upsert(data.twitch.sessions, s, (x) => x.id).sort((a, b) => a.id.localeCompare(b.id));
  await save(data);
  const { series, ...short } = s;
  console.log('Added stream session:', short);
}

// ---------- API pulls ----------
async function getJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function fetchYouTube(data) {
  const key = process.env.YT_API_KEY;
  if (!key) return console.log('YouTube: skipped (no YT_API_KEY)');
  const api = (p, q) => getJson(`https://www.googleapis.com/youtube/v3/${p}?${new URLSearchParams({ ...q, key })}`);
  const ch = (await api('channels', { part: 'statistics', id: YT_CHANNEL })).items[0].statistics;
  data.youtube.snapshots = upsert(data.youtube.snapshots,
    { date: today(), subs: +ch.subscriberCount, views: +ch.viewCount, videos: +ch.videoCount }, (x) => x.date, 400);
  const pl = await api('playlistItems', { part: 'contentDetails', playlistId: 'UU' + YT_CHANNEL.slice(2), maxResults: 25 });
  const ids = pl.items.map((i) => i.contentDetails.videoId).join(',');
  const vids = await api('videos', { part: 'snippet,statistics,contentDetails,status', id: ids });
  data.youtube.videos = vids.items.map((v) => ({
    id: v.id, title: v.snippet.title.replace(/\s*#\S+/g, '').trim(),
    published: v.status.publishAt && v.status.privacyStatus !== 'public' ? v.status.publishAt : v.snippet.publishedAt,
    scheduled: v.status.privacyStatus !== 'public',
    seconds: isoSeconds(v.contentDetails.duration),
    views: +(v.statistics.viewCount || 0), likes: +(v.statistics.likeCount || 0), comments: +(v.statistics.commentCount || 0),
  }));
  console.log(`YouTube: ${ch.subscriberCount} subs, ${data.youtube.videos.length} recent videos`);

  const trend = await api('videos', { part: 'snippet,statistics', chart: 'mostPopular', videoCategoryId: '20', regionCode: TREND_REGION, maxResults: 15 });
  data.trending ??= {};
  data.trending.youtubeGaming = {
    region: TREND_REGION, at: new Date().toISOString(),
    items: trend.items.map((v) => ({ id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle, views: +v.statistics.viewCount })),
  };
}

function isoSeconds(d) {
  const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

// ---------- YouTube Analytics + Search Console (one Google sign-in) ----------
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

async function fetchGoogleOAuth(data) {
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET, refresh = process.env.GOOGLE_REFRESH_TOKEN;
  if (!id || !secret || !refresh) return console.log('YouTube Analytics / Search Console: skipped (no GOOGLE_* secrets)');
  const tok = await getJson('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const auth = { Authorization: `Bearer ${tok.access_token}` };
  const parts = [['YouTube Analytics', () => ytAnalytics(data, auth)], ['Search Console', () => searchConsole(data, auth)]];
  for (const [name, run] of parts) {
    try { await run(); } catch (e) { console.error(`${name} failed:`, e.message); process.exitCode = 1; }
  }
}

async function ytAnalytics(data, auth) {
  const report = async (q) => {
    const r = await getJson(`https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({ ids: 'channel==MINE', ...q })}`, { headers: auth });
    const cols = r.columnHeaders.map((c) => c.name);
    return (r.rows || []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
  };
  const range = { startDate: daysAgo(30), endDate: daysAgo(0) };
  const last28 = { startDate: daysAgo(28), endDate: daysAgo(1) };

  const daily = await report({ ...range, dimensions: 'day', sort: 'day',
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost' });
  const yt = data.youtube;
  yt.daily ??= [];
  for (const d of daily) yt.daily = upsert(yt.daily, d, (x) => x.day, 400);
  yt.daily.sort((a, b) => a.day.localeCompare(b.day));

  const top = await report({ ...last28, dimensions: 'video', sort: '-views', maxResults: 15,
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes' });
  const known = Object.fromEntries((yt.videos || []).map((v) => [v.id, v]));
  const missing = top.map((t) => t.video).filter((v) => !known[v]);
  if (missing.length && process.env.YT_API_KEY) {
    const r = await getJson(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: 'snippet,contentDetails', id: missing.join(','), key: process.env.YT_API_KEY })}`);
    for (const v of r.items) known[v.id] = { title: v.snippet.title.replace(/\s*#\S+/g, '').trim(), seconds: isoSeconds(v.contentDetails.duration) };
  }
  const sources = await report({ ...last28, dimensions: 'insightTrafficSourceType', sort: '-views', metrics: 'views' });
  let formats = [];
  try { formats = await report({ ...last28, dimensions: 'creatorContentType', metrics: 'views,estimatedMinutesWatched,averageViewPercentage' }); }
  catch (e) { console.log('Shorts vs videos split not available:', e.message.slice(0, 120)); }

  yt.last28 = {
    from: last28.startDate, to: last28.endDate, at: new Date().toISOString(),
    topVideos: top.map((t) => ({ id: t.video, title: known[t.video]?.title || t.video, seconds: known[t.video]?.seconds ?? null,
      views: t.views, minutes: t.estimatedMinutesWatched, avgSeconds: t.averageViewDuration, avgPercent: t.averageViewPercentage,
      subs: t.subscribersGained, likes: t.likes })),
    sources: sources.map((s) => ({ source: s.insightTrafficSourceType, views: s.views })),
    formats: formats.map((f) => ({ type: f.creatorContentType, views: f.views, minutes: f.estimatedMinutesWatched, avgPercent: f.averageViewPercentage })),
  };
  console.log(`YouTube Analytics: ${daily.length} days, ${top.length} top videos, ${sources.length} traffic sources`);
}

async function searchConsole(data, auth) {
  const sites = (await getJson('https://www.googleapis.com/webmasters/v3/sites', { headers: auth })).siteEntry || [];
  const site = sites.find((s) => s.siteUrl.includes('alienshenanigans'))?.siteUrl;
  if (!site) return console.log('Search Console: no alienshenanigans property on this Google account. Sites seen:', sites.map((s) => s.siteUrl).join(', ') || 'none');
  const q = (body) => getJson(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ startDate: daysAgo(30), endDate: daysAgo(1), ...body }) });
  const [byDate, byQuery, byPage] = await Promise.all([
    q({ dimensions: ['date'] }), q({ dimensions: ['query'], rowLimit: 25 }), q({ dimensions: ['page'], rowLimit: 10 }),
  ]);
  const rows = (r, key) => (r.rows || []).map((x) => ({ [key]: x.keys[0], clicks: x.clicks, impressions: x.impressions, ctr: x.ctr, position: x.position }));
  data.search = { site, at: new Date().toISOString(), daily: rows(byDate, 'date'), queries: rows(byQuery, 'query'), pages: rows(byPage, 'page') };
  console.log(`Search Console: ${data.search.queries.length} search terms, ${data.search.daily.length} days`);
}

async function fetchTwitch(data) {
  const id = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) return console.log('Twitch: skipped (no TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET)');
  const tok = await getJson(`https://id.twitch.tv/oauth2/token?${new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' })}`, { method: 'POST' });
  const api = (p, q) => getJson(`https://api.twitch.tv/helix/${p}?${new URLSearchParams(q)}`,
    { headers: { 'Client-Id': id, Authorization: `Bearer ${tok.access_token}` } });
  const user = (await api('users', { login: TWITCH_LOGIN })).data[0];
  const followers = (await api('channels/followers', { broadcaster_id: user.id })).total;
  const live = (await api('streams', { user_id: user.id })).data[0];
  data.twitch.snapshots = upsert(data.twitch.snapshots,
    { date: today(), followers, live: !!live, viewers: live?.viewer_count ?? null, game: live?.game_name ?? null }, (x) => x.date, 400);
  const vods = (await api('videos', { user_id: user.id, type: 'archive', first: 10 })).data;
  data.twitch.vods = vods.map((v) => ({ id: v.id, title: v.title, created: v.created_at, duration: v.duration, views: v.view_count }));
  const top = (await api('games/top', { first: 20 })).data;
  data.trending ??= {};
  data.trending.twitchTopGames = { at: new Date().toISOString(), items: top.map((g) => g.name) };
  console.log(`Twitch: ${followers} followers, ${vods.length} VODs`);
}

// ---------- TikTok (Login Kit + Display API) ----------
const TIKTOK_REDIRECT = 'https://alienshenanigans.github.io/hq/tiktok.html';

async function tiktokToken(params) {
  const key = process.env.TIKTOK_CLIENT_KEY, secret = process.env.TIKTOK_CLIENT_SECRET;
  if (!key || !secret) throw new Error('TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET secrets are missing');
  const r = await getJson('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: key, client_secret: secret, ...params }),
  });
  if (!r.access_token) throw new Error(`TikTok token error: ${r.error || ''} ${r.error_description || JSON.stringify(r).slice(0, 200)}`);
  return r;
}

function keepTikTokAuth(data, r) {
  data.tiktok ??= { snapshots: [], videos: [] };
  data.tiktok.auth = {
    open_id: r.open_id, scope: r.scope, refresh_token: r.refresh_token,
    refresh_expires_at: new Date(Date.now() + (r.refresh_expires_in || 0) * 1000).toISOString(),
  };
}

async function tiktokConnect(code) {
  if (!code) throw new Error('Give the code from the TikTok sign-in page.');
  const data = await load();
  const r = await tiktokToken({ code: decodeURIComponent(code.trim()), grant_type: 'authorization_code', redirect_uri: TIKTOK_REDIRECT });
  keepTikTokAuth(data, r);
  await save(data);
  console.log(`TikTok connected (scopes: ${r.scope}).`);
}

async function fetchTikTok(data) {
  const refresh = data.tiktok?.auth?.refresh_token;
  if (!refresh) return console.log('TikTok: skipped (not connected yet)');
  const r = await tiktokToken({ grant_type: 'refresh_token', refresh_token: refresh });
  keepTikTokAuth(data, r);
  const auth = { Authorization: `Bearer ${r.access_token}` };
  const check = (j) => { if (j.error && j.error.code !== 'ok') throw new Error(`TikTok: ${j.error.code} ${j.error.message}`); return j.data; };
  const user = check(await getJson('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,follower_count,following_count,likes_count,video_count', { headers: auth })).user;
  data.tiktok.snapshots = upsert(data.tiktok.snapshots || [],
    { date: today(), followers: user.follower_count, likes: user.likes_count, videos: user.video_count }, (x) => x.date, 400);
  const fields = 'id,title,video_description,create_time,duration,view_count,like_count,comment_count,share_count,share_url';
  const list = check(await getJson(`https://open.tiktokapis.com/v2/video/list/?fields=${fields}`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ max_count: 20 }),
  }));
  data.tiktok.videos = (list.videos || []).map((v) => ({
    id: v.id, title: (v.title || v.video_description || '').replace(/\s*#\S+/g, '').trim() || '(no caption)',
    published: new Date(v.create_time * 1000).toISOString(), seconds: v.duration, url: v.share_url,
    views: v.view_count, likes: v.like_count, comments: v.comment_count, shares: v.share_count,
  }));
  console.log(`TikTok: ${user.follower_count} followers, ${data.tiktok.videos.length} recent videos`);
}

// ---------- per-video history (Shorts tab: views at ~24h and ~7 days; TikTok conversion) ----------
// data.shorts.history['yt:<id>' | 'tt:<id>'] = [[ 'YYYY-MM-DDTHH:MM' (UTC), views, likes ], ...]
// One entry per UTC day (a later run the same day replaces it). Videos older than 60 days only get a new
// entry when their views moved, so the file stays small.
function trackShorts(data, now = new Date()) {
  data.shorts ??= {};
  const sh = data.shorts;
  sh.history ??= {}; sh.links ??= {}; sh.tags ??= {};
  const at = now.toISOString().slice(0, 16), day = at.slice(0, 10);
  const add = (key, v) => {
    if (v.scheduled || new Date(v.published) > now) return;
    const h = (sh.history[key] ??= []);
    const last = h[h.length - 1];
    const entry = [at, v.views ?? 0, v.likes ?? 0];
    // First 48h: keep every hourly snapshot (for "first hour" numbers); after that, one per day.
    const young = now - new Date(v.published) < 48 * 3600e3;
    const lastYoung = last && new Date(last[0] + ':00Z') - new Date(v.published) < 48 * 3600e3;
    if (last && last[0].slice(0, 10) === day && !young && !lastYoung) { h[h.length - 1] = entry; return; }
    if (last && last[0].slice(0, 13) === at.slice(0, 13)) { h[h.length - 1] = entry; return; }
    const old = now - new Date(v.published) > 60 * 864e5;
    if (old && last && last[1] === entry[1]) return;
    h.push(entry);
    if (h.length > 100) h.splice(0, h.length - 100);
  };
  for (const v of data.youtube.videos || []) if (v.seconds <= 180) add('yt:' + v.id, v);
  // Permanent posting log (never trimmed), so weekly posting goals still count once videos fall out of the latest 25.
  sh.posted ??= {};
  for (const v of data.youtube.videos || []) {
    if (!v.scheduled && new Date(v.published) <= now) sh.posted[v.id] = [v.published.slice(0, 16), v.seconds <= 180 ? 's' : 'l'];
  }
  for (const v of data.tiktok?.videos || []) add('tt:' + v.id, v);
  // forget videos nobody has seen for 120 days
  const cutoff = new Date(now - 120 * 864e5).toISOString();
  for (const k of Object.keys(sh.history)) { const h = sh.history[k]; if (!h.length || h[h.length - 1][0] < cutoff) delete sh.history[k]; }
}

// ---------- Claude's take ----------
function briefFor(data) {
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  return {
    today: today(),
    twitchSessions: data.twitch.sessions.slice(-8).map(({ series, ...s }) => s),
    twitchFollowers: data.twitch.snapshots.filter((s) => s.date >= cutoff),
    twitchVods: data.twitch.vods,
    youtubeChannel: data.youtube.snapshots.filter((s) => s.date >= cutoff),
    youtubeRecentVideos: data.youtube.videos,
    youtubeLast28Days: data.youtube.last28,
    youtubeDaily: (data.youtube.daily || []).slice(-28),
    tiktok: data.tiktok ? { followers: (data.tiktok.snapshots || []).filter((x) => x.date >= cutoff), recentVideos: data.tiktok.videos } : null,
    googleSearch: data.search ? { queries: data.search.queries, pages: data.search.pages } : null,
    trending: data.trending,
    creatorNotes: data.notes.slice(-10),
    previousTake: data.take,
  };
}

const TAKE_PROMPT = `You are the performance coach for Ali ("Alien Shenanigans"), a small gaming VTuber.
She streams on Twitch (Tuesdays, soon Thursdays, 16:30 UTC; she is in South Africa, timestamps in stream CSVs are SAST),
posts edited long-form and Shorts on YouTube, and Shorts on TikTok. Her lane: fails, horror games and old games played badly.

Below is her latest data as JSON. Write a short, honest, specific take. Small numbers are normal for her size:
judge against her own history, not big creators. Never invent numbers that are not in the data; say when data is missing.
"creatorNotes" may include summaries she pasted from YouTube/TikTok Studio's own assistants: use them as extra evidence.

Reply with ONLY a JSON object, no prose around it:
{"headline": "one sentence",
 "wins": ["up to 3"], "worries": ["up to 3"], "next": ["up to 3 concrete things to do this week"],
 "trending": ["up to 3 trend notes relevant to her lane, from the trending data"]}`;

async function take() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return console.log('Take: skipped (no ANTHROPIC_API_KEY)');
  const data = await load();
  const r = await getJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 1500,
      messages: [{ role: 'user', content: `${TAKE_PROMPT}\n\n${JSON.stringify(briefFor(data))}` }],
    }),
  });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  data.take = { ...json, at: new Date().toISOString(), by: 'Claude (daily auto)' };
  await save(data);
  console.log('Take:', json.headline);
}

// ---------- Shorts desk feed (hq/desk-feed.enc) ----------
// Same pairing as the /hq page: manual links first, then posting time within 36h and similar length.
function matchShorts(data) {
  const yts = (data.youtube.videos || []).filter((v) => v.seconds <= 180);
  const tts = data.tiktok?.videos || [];
  const links = data.shorts?.links || {};
  const pair = {}, used = {}, cands = [];
  for (const y of yts) if (y.id in links) { pair[y.id] = links[y.id]; if (links[y.id]) used[links[y.id]] = true; }
  for (const y of yts) {
    if (y.id in links) continue;
    for (const t of tts) {
      if (used[t.id]) continue;
      const dh = Math.abs(Date.parse(y.published) - Date.parse(t.published)) / 3600e3, dd = Math.abs(y.seconds - t.seconds);
      const tol = Math.max(3, 0.15 * Math.max(y.seconds, t.seconds));
      if (dh <= 36 && dd <= tol) cands.push([dh / 36 + dd / tol, y.id, t.id]);
    }
  }
  cands.sort((a, b) => a[0] - b[0]);
  for (const [, y, t] of cands) if (!(y in pair) && !used[t]) { pair[y] = t; used[t] = true; }
  return { yts, pair, ttById: Object.fromEntries(tts.map((t) => [t.id, t])) };
}

function takeText(t) {
  if (!t) return null;
  const sec = [['Working', t.wins], ['Not working', t.worries], ['Do this week', t.next], ['Trends', t.trending]]
    .filter(([, l]) => l?.length).map(([h, l]) => `${h}:\n` + l.map((x) => `- ${x}`).join('\n'));
  return [t.headline, ...sec].filter(Boolean).join('\n\n');
}

export function deskFeed(data) {
  const cutoff = daysAgo(90);
  const recent = (l) => (l || []).filter((s) => s.date >= cutoff);
  const top = Object.fromEntries((data.youtube.last28?.topVideos || []).map((v) => [v.id, v]));
  const tags = data.shorts?.tags || {};
  const { yts, pair, ttById } = matchShorts(data);
  const shorts = {};
  for (const y of yts) {
    if (y.scheduled) continue;
    const tt = pair[y.id] ? ttById[pair[y.id]] : null, a = top[y.id];
    const key = tags[y.id]?.desk || (tt && tags[tt.id]?.desk) || y.id;
    shorts[key] = {
      yt_id: y.id, title: y.title, published: y.published,
      yt_views: y.views, yt_likes: y.likes, yt_comments: y.comments,
      avg_pct: a ? Math.round(a.avgPercent * 10) / 10 : null,
      tt_views: tt?.views ?? null, tt_likes: tt?.likes ?? null,
      subs: a ? a.subs : null,
    };
  }
  return {
    at: new Date().toISOString(),
    channel: {
      yt: recent(data.youtube.snapshots).map(({ date, subs, views }) => ({ date, subs, views })),
      tt: recent(data.tiktok?.snapshots).map(({ date, followers, likes }) => ({ date, followers, likes })),
      twitch: recent(data.twitch.snapshots).map(({ date, followers }) => ({ date, followers })),
    },
    goals: data.goals || [],
    shorts,
    trending: {
      youtube_gaming: (data.trending?.youtubeGaming?.items || []).map((i) => i.title),
      twitch_top_games: data.trending?.twitchTopGames?.items || [],
    },
    opinion: takeText(data.take),
    opinion_at: data.take?.at || null,
    plan: data.plan || null,
  };
}

async function writeDeskFeed() {
  const feed = deskFeed(await load());
  await writeFile(path.join(ROOT, 'hq', 'desk-feed.enc'), await seal(feed));
  console.log(`Desk feed: ${Object.keys(feed.shorts).length} Shorts, opinion from ${feed.opinion_at || 'none'}`);
}

// ---------- slot planner: inventory (PC only, read-only on the folders) ----------
const norm = (s) => String(s || '').toLowerCase().replace(/\bshort\b/g, '').replace(/[^a-z0-9]/g, '');
const inList = (game, list) => list.some((g) => norm(game).startsWith(norm(g)) || norm(g) === norm(game));
export function categoryOf(game, lane) {
  const l = String(lane || '').toLowerCase();
  if (CATS.includes(l)) return l;
  if (inList(game, PLANNER.horrorGames)) return 'horror';
  if (inList(game, PLANNER.currentGames)) return 'current';
  return 'random'; // random/trending candidates
}

// "<Game> Short N vX - Title.mp4" / "Combo Short N vX - Title.mp4"
export function parseShortName(file) {
  const m = path.basename(file).match(/^(.+?) Short (\d+) v(\d+)\s*-\s*(.+?)\.(mp4|mov|mkv)$/i);
  if (!m) return null;
  return { key: `${m[1]} Short ${m[2]}`, game: m[1].trim(), n: +m[2], version: +m[3], title: m[4].trim() };
}

async function walk(dir, depth = 2) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...await walk(p, depth - 1));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// _posted.json: either {"<key>": {youtube_date, tiktok_date, scheduled}} or a list of such records with a name/file.
function postedMap(raw) {
  const map = {};
  const keyOf = (s) => norm(String(s).replace(/\s+v\d+\b.*$/i, '').replace(/\.(mp4|mov|mkv)$/i, ''));
  if (Array.isArray(raw)) for (const r of raw) map[keyOf(r.name || r.file || r.key || '')] = r;
  else for (const [k, v] of Object.entries(raw || {})) map[keyOf(k)] = v;
  return { map, keyOf };
}

// _desk-export.json: a list (or {shorts:[...]} or {id: {...}}) of {id, file?, grade, status, lane}.
function deskMap(raw) {
  let list = Array.isArray(raw) ? raw : Array.isArray(raw?.shorts) ? raw.shorts
    : Object.entries(raw?.shorts || raw || {}).map(([id, v]) => ({ id, ...v }));
  const map = {};
  for (const d of list) {
    const f = d.file || (d.pc_path ? String(d.pc_path).split(/[\\/]/).pop() : null);
    const base = f ? parseShortName(f)?.key : String(d.id || '').replace(/-v\d+$/i, '');
    if (base) map[norm(base)] = d;
  }
  return map;
}

export async function buildInventory({ shortsDir, postedFile, deskFile, momentsFile }) {
  const latest = {};
  for (const f of await walk(shortsDir)) {
    const p = parseShortName(f);
    if (!p) continue;
    const k = norm(p.key);
    if (!latest[k] || p.version > latest[k].version) latest[k] = { ...p, file: path.basename(f), folder: path.relative(shortsDir, path.dirname(f)) || '.', bytes: (await stat(f)).size };
  }
  const posted = existsSync(postedFile) ? postedMap(JSON.parse(await readFile(postedFile, 'utf8'))) : { map: {} };
  const desk = deskFile && existsSync(deskFile) ? deskMap(JSON.parse(await readFile(deskFile, 'utf8'))) : null;
  const shorts = Object.entries(latest).map(([k, s]) => {
    const p = posted.map[k], d = desk?.[k];
    const deskStatus = d?.status || null;
    let state = 'ready';
    if (p?.youtube_date || p?.tiktok_date || deskStatus === 'posted') state = 'posted';
    else if (p?.scheduled || deskStatus === 'scheduled') state = 'scheduled';
    else if (deskStatus === 'dropped') state = 'dropped';
    return {
      file: s.file, key: s.key, game: s.game, title: s.title, version: s.version, mb: Math.round(s.bytes / 1e5) / 10, folder: s.folder,
      state, posted: p ? { yt: p.youtube_date || null, tt: p.tiktok_date || null } : null,
      grade: d?.grade || null, desk_status: deskStatus, desk_id: d?.id || null, lane: d?.lane || null,
      category: categoryOf(s.game, d?.lane),
    };
  }).sort((a, b) => a.key.localeCompare(b.key));

  let moments = [];
  if (momentsFile && existsSync(momentsFile)) {
    const lines = (await readFile(momentsFile, 'utf8')).split(/\r?\n/).filter((l) => l.trim());
    for (const l of lines) {
      let m; try { m = JSON.parse(l); } catch { continue; }
      const used = m.used || m.used_in || ['used', 'rejected', 'retired', 'posted'].includes(String(m.status || '').toLowerCase());
      if (used || !((m.short_score ?? 0) >= PLANNER.minMomentScore)) continue;
      moments.push({ id: m.id, game: m.game || null, rec: m.rec || m.recording || null, start: m.start ?? m.timestamp ?? null,
        quote: String(m.quote || '').slice(0, 120), tags: m.tags || [], score: m.short_score, category: categoryOf(m.game) });
    }
    moments.sort((a, b) => b.score - a.score);
    moments = moments.slice(0, PLANNER.maxMoments);
  }
  const counts = Object.fromEntries(['horror', 'current', 'random'].map((c) => [c, {
    ready: shorts.filter((s) => s.category === c && s.state === 'ready').length,
    A: shorts.filter((s) => s.category === c && s.state === 'ready' && s.grade === 'A').length,
    moments: moments.filter((m) => m.category === c).length,
  }]));
  return { at: new Date().toISOString(), desk_export: !!desk, shorts, moments, counts };
}

// Same inventory, built only from Shorts desk records (no PC needed): a folder of desk JSON docs or one JSON list.
export function inventoryFromDesk(docs) {
  const STATE = { posted: 'posted', scheduled: 'scheduled', dropped: 'dropped', redo_requested: 'redo' };
  const latest = {};
  for (const d of docs) {
    const f = d.file || String(d.pc_path || '').split(/[\\/]/).pop();
    const p = parseShortName(f.replace(/^\d+ \w{3} - /, '')) || parseShortName(f.replace(/ - style \d+ v\d+/, '').replace(/^(.*?) - (.*)$/, '$1 v1 - $2'));
    if (!p) { console.log('  skipped (name not recognised):', f); continue; }
    const k = norm(p.key);
    if (latest[k] && latest[k].version > p.version) continue;
    latest[k] = { file: f, key: p.key, game: d.game || p.game, title: p.title, version: p.version, mb: null, folder: 'desk',
      state: STATE[d.status] || 'ready', posted: d.status === 'posted' ? { yt: d.slot || null, tt: null } : null,
      grade: ['A', 'B', 'C'].includes(d.grade) ? d.grade : null, desk_status: d.status || null, desk_id: d.id || null, lane: d.lane || null,
      category: categoryOf(d.game || p.game, d.lane) };
  }
  const shorts = Object.values(latest).sort((a, b) => a.key.localeCompare(b.key));
  const counts = Object.fromEntries(['horror', 'current', 'random'].map((c) => [c, {
    ready: shorts.filter((s) => s.category === c && s.state === 'ready').length,
    A: shorts.filter((s) => s.category === c && s.state === 'ready' && s.grade === 'A').length, moments: 0 }]));
  return { at: new Date().toISOString(), source: 'desk', desk_export: true, shorts, moments: [], counts };
}

async function inventory() {
  const fromDesk = flag('from-desk');
  if (fromDesk) {
    let docs;
    if ((await stat(fromDesk)).isDirectory()) docs = await Promise.all((await readdir(fromDesk)).filter((f) => f.endsWith('.json'))
      .map(async (f) => ({ id: f.replace(/\.json$/, ''), ...JSON.parse(await readFile(path.join(fromDesk, f), 'utf8')) })));
    else { const raw = JSON.parse(await readFile(fromDesk, 'utf8')); docs = Array.isArray(raw) ? raw : raw.shorts || []; }
    return saveInventory(inventoryFromDesk(docs));
  }
  const opt = {
    shortsDir: flag('shorts') || 'D:\\Content Creation Videos\\03 Edits\\Shorts',
    postedFile: flag('posted') || 'D:\\Ready for Claude\\_posted.json',
    deskFile: flag('desk') || 'D:\\Ready for Claude\\_desk-export.json',
    momentsFile: flag('moments') || 'D:\\Ready for Claude\\_moment-library.jsonl',
  };
  if (!existsSync(opt.shortsDir)) throw new Error(`Shorts folder not found: ${opt.shortsDir}`);
  return saveInventory(await buildInventory(opt));
}

async function saveInventory(inv) {
  const data = await load();
  data.inventory = inv;
  await save(data);
  console.log(`Inventory: ${inv.shorts.length} Shorts (newest version each), ${inv.moments.length} unused moments, desk export ${inv.desk_export ? 'used' : 'not found'}`);
  console.table(Object.fromEntries(Object.entries(inv.counts).map(([c, v]) => [c, { 'ready to post': v.ready, 'grade A': v.A, 'moments': v.moments }])));
  console.log('Posted:', inv.shorts.filter((s) => s.state === 'posted').length, '· scheduled:', inv.shorts.filter((s) => s.state === 'scheduled').length);
  if (rest.includes('--no-push')) return;
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, stdio: 'inherit' });
  git('pull', '--rebase', '--autostash');
  // The pull may have brought a newer data.enc from the cloud refresh: re-apply the inventory on top of it.
  const fresh = await load(); fresh.inventory = inv; await save(fresh);
  git('add', 'hq/data.enc');
  try { git('diff', '--cached', '--quiet'); return console.log('Nothing to commit.'); } catch { /* changes staged */ }
  git('-c', 'user.name=hq-bot', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', 'Update HQ inventory', '--', 'hq/data.enc');
  git('push');
}

// ---------- slot planner: trend data (part of `fetch`) ----------
// data.trending.weekly = [{week (Monday, UTC), at, twitchGames:{name:{viewers,channels}}, ytShorts:{game:[{id,title,views}]}, steam:{top,new}}], last 8
function trendWeek(data) {
  const t = new Date(); t.setUTCDate(t.getUTCDate() - (t.getUTCDay() + 6) % 7);
  const week = t.toISOString().slice(0, 10);
  data.trending ??= {};
  const w = (data.trending.weekly ??= []);
  let cur = w.find((x) => x.week === week);
  if (!cur) { cur = { week }; w.push(cur); w.sort((a, b) => a.week.localeCompare(b.week)); w.splice(0, Math.max(0, w.length - PLANNER.weeksKept)); }
  cur.at = new Date().toISOString();
  return cur;
}
const laneGames = () => [...new Set([...PLANNER.watchGames])];

async function fetchTwitchLanes(data) {
  const id = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) return console.log('Twitch lane games: skipped (no Twitch keys)');
  const tok = await getJson(`https://id.twitch.tv/oauth2/token?${new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' })}`, { method: 'POST' });
  const h = { headers: { 'Client-Id': id, Authorization: `Bearer ${tok.access_token}` } };
  const q = new URLSearchParams(); laneGames().forEach((g) => q.append('name', g));
  const games = (await getJson(`https://api.twitch.tv/helix/games?${q}`, h)).data;
  const out = {};
  for (const g of games) {
    // one page of the 100 biggest live channels: enough to see a game rise or fall week to week
    const s = (await getJson(`https://api.twitch.tv/helix/streams?${new URLSearchParams({ game_id: g.id, first: 100 })}`, h)).data;
    out[g.name] = { viewers: s.reduce((a, x) => a + x.viewer_count, 0), channels: s.length };
  }
  trendWeek(data).twitchGames = out;
  console.log(`Twitch lane games: ${Object.keys(out).length}`);
}

// search.list costs 100 units each, so this runs at most once a week (~600 units).
async function fetchYtLaneShorts(data) {
  const key = process.env.YT_API_KEY;
  if (!key) return console.log('YouTube lane Shorts: skipped (no YT_API_KEY)');
  const cur = trendWeek(data);
  if (cur.ytShorts) return console.log('YouTube lane Shorts: already pulled this week');
  const out = {};
  for (const g of laneGames()) {
    const r = await getJson(`https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({ part: 'snippet', q: `${g} #shorts`, type: 'video', videoDuration: 'short', order: 'viewCount', publishedAfter: new Date(Date.now() - 7 * 864e5).toISOString(), maxResults: 5, key })}`);
    const ids = r.items.map((i) => i.id.videoId).join(',');
    const v = ids ? (await getJson(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: 'statistics', id: ids, key })}`)).items : [];
    const views = Object.fromEntries(v.map((x) => [x.id, +x.statistics.viewCount || 0]));
    out[g] = r.items.map((i) => ({ id: i.id.videoId, title: i.snippet.title, channel: i.snippet.channelTitle, views: views[i.id.videoId] ?? null }))
      .sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3);
  }
  cur.ytShorts = out;
  console.log(`YouTube lane Shorts: ${Object.keys(out).length} games`);
}

async function fetchSteam(data) {
  const r = await getJson('https://store.steampowered.com/api/featuredcategories?cc=us&l=english');
  const names = (x) => (x?.items || []).map((i) => i.name).filter(Boolean).slice(0, 15);
  trendWeek(data).steam = { top: names(r.top_sellers), new: names(r.new_releases) };
  console.log(`Steam: ${names(r.top_sellers).length} top sellers`);
}

// ---------- slot planner: Claude ----------
export function slotsFor(weekStart) { // weekStart = 'YYYY-MM-DD', a Sunday (SAST)
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.parse(weekStart + 'T12:00:00Z') + i * 864e5), iso = d.toISOString().slice(0, 10);
    const sched = PLANNER.schedules.filter((s) => s.from <= iso).pop();
    for (const s of sched.slots) if (s.day === d.getUTCDay()) out.push({ category: s.category, date: iso, day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.day], time_sast: s.time });
  }
  return out;
}
export function nextSunday(now = new Date()) {
  const t = new Date(now.getTime() + 2 * 3600e3 + 864e5); // SAST, from tomorrow
  t.setUTCDate(t.getUTCDate() + (7 - t.getUTCDay()) % 7);
  return t.toISOString().slice(0, 10);
}

const PLAN_PROMPT = `You plan next week's 4 Shorts for Ali ("Alien Shenanigans"), a small alien VTuber.
One Short per category: random (fun one-off or themed combo), horror (old horror), current (what she streams now),
trending (her best lane by recent numbers, or something hot online this week).

RULES
- Only pick Shorts from inventory.shorts with state "ready". Use the exact "file" value.
- Grade A before B. Skip C unless nothing else fits.
- Put the strongest picks on the weekend slots.
- No game twice in one week unless stock forces it.
- If a category has nothing good, set make_next to an unused moment from inventory.moments (its id) or a trend idea (moment_id null).
- Every "why" is under 10 words, plain words, no jargon.
- Trends must be real, from the last 10 days, with a source URL (from web search or the trending data). Never invent.
- low_stock: each category with under 2 weeks of ready Shorts (weeks_left = ready count, trending can use random stock).
- Small numbers are normal for her size: compare with her own history.

Reply with ONLY this JSON:
{"week_of":"YYYY-MM-DD","slots":[{"category":"","day":"","time_sast":"","pick":{"file":"","why":""}|null,"backup":{"file":"","why":""}|null,"make_next":{"moment_id":null,"idea":"","why":""}|null}],
 "take":{"headline":"","trend_to_try":{"what":"","how":"","source":""},"working":[],"not_working":[],"stop_doing":[]},
 "low_stock":[{"category":"","weeks_left":0}]}`;

function planBrief(data, weekOf) {
  const inv = data.inventory || null;
  const top = Object.fromEntries((data.youtube.last28?.topVideos || []).map((v) => [v.id, v]));
  const H = data.shorts?.history || {};
  const at = (id, pub, hrs) => { const h = H['yt:' + id] || [], t = Date.parse(pub) + hrs * 3600e3; const e = h.find((x) => Date.parse(x[0] + ':00Z') >= t); return e ? e[1] : null; };
  return {
    week_of: weekOf, slots: slotsFor(weekOf), today: today(),
    inventory: inv ? { at: inv.at, shorts: inv.shorts.filter((s) => s.state === 'ready').map(({ file, game, title, grade, category }) => ({ file, game, title, grade, category })), moments: inv.moments, counts: inv.counts } : 'missing: run inventory on the PC',
    shorts_numbers: (data.youtube.videos || []).filter((v) => v.seconds <= 180 && !v.scheduled).map((v) => ({
      title: v.title, published: v.published, views: v.views, views_24h: at(v.id, v.published, 24), views_7d: at(v.id, v.published, 168),
      avg_pct: top[v.id] ? Math.round(top[v.id].avgPercent) : null })),
    tiktok: (data.tiktok?.videos || []).map(({ title, published, views, likes }) => ({ title, published, views, likes })),
    trending: { youtubeGaming: data.trending?.youtubeGaming?.items?.slice(0, 10), twitchTop: data.trending?.twitchTopGames?.items, weekly: data.trending?.weekly?.slice(-3) },
    last_plans: (data.plans || []).slice(-2),
  };
}

// Drops anything that breaks the hard rules, so a bad answer can't put a posted Short on the page.
export function checkPlan(plan, data, weekOf) {
  const ready = new Set((data.inventory?.shorts || []).filter((s) => s.state === 'ready').map((s) => s.file));
  const slots = slotsFor(weekOf);
  const short = (s) => String(s || '').split(/\s+/).slice(0, 10).join(' ');
  const ok = (p) => (p && ready.has(p.file) ? { file: p.file, why: short(p.why) } : null);
  plan.week_of = weekOf;
  plan.slots = slots.map((s) => {
    const c = (plan.slots || []).find((x) => x.category === s.category) || {};
    const pick = ok(c.pick), backup = ok(c.backup);
    return { category: s.category, date: s.date, day: s.day, time_sast: s.time_sast, pick, backup: backup && backup.file !== pick?.file ? backup : null,
      make_next: c.make_next ? { moment_id: c.make_next.moment_id ?? null, idea: c.make_next.idea || '', why: short(c.make_next.why) } : (!pick ? { moment_id: null, idea: 'Nothing ready: make one', why: 'No ready Short in this category' } : null) };
  });
  plan.low_stock = (plan.low_stock || []).filter((l) => CATS.includes(l.category));
  return plan;
}

async function plan() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return console.log('Plan: skipped (no ANTHROPIC_API_KEY)');
  const data = await load();
  const weekOf = nextSunday();
  const body = {
    model: CLAUDE_MODEL, max_tokens: 4000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    messages: [{ role: 'user', content: `${PLAN_PROMPT}\n\nUse web search for this week's gaming news and meme formats in her lanes (last 10 days only).\n\n${JSON.stringify(planBrief(data, weekOf))}` }],
  };
  const call = (b) => getJson('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(b) });
  let r;
  try { r = await call(body); } catch (e) { console.log('Web search not available, planning without it:', e.message.slice(0, 120)); delete body.tools; r = await call(body); }
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  const json = checkPlan(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)), data, weekOf);
  json.at = new Date().toISOString();
  json.inventory_at = data.inventory?.at || null;
  data.plans = [...(data.plans || []).filter((p) => p.week_of !== json.week_of), json].slice(-PLANNER.weeksKept);
  data.plan = json;
  await save(data);
  console.log(JSON.stringify(json, null, 2));
}

// ---------- commands ----------
const commands = {
  'tiktok-connect': () => tiktokConnect(rest[0]),
  'add-twitch-csv': () => addTwitchCsv(rest[0]),
  async fetch() {
    const data = await load();
    const before = JSON.stringify(data);
    for (const f of [fetchYouTube, fetchGoogleOAuth, fetchTwitch, fetchTikTok, fetchTwitchLanes, fetchYtLaneShorts, fetchSteam]) {
      try { await f(data); } catch (e) { console.error(`${f.name} failed:`, e.message); process.exitCode = 1; }
    }
    trackShorts(data);
    if (JSON.stringify(data) === before) return console.log('Nothing new: data file left as is.');
    await save(data);
  },
  take,
  plan,
  inventory,
  'desk-feed': writeDeskFeed,
  async 'set-take'() {
    const data = await load();
    data.take = { ...JSON.parse(await readFile(rest[0], 'utf8')), at: new Date().toISOString() };
    await save(data);
  },
  async 'set-plan'() {
    const data = await load();
    const weekOf = flag('week') || nextSunday();
    const json = checkPlan(JSON.parse(await readFile(rest[0], 'utf8')), data, weekOf);
    json.at = new Date().toISOString(); json.inventory_at = data.inventory?.at || null; json.by = flag('by') || 'Claude (by hand)';
    data.plans = [...(data.plans || []).filter((p) => p.week_of !== json.week_of), json].slice(-PLANNER.weeksKept);
    data.plan = json;
    await save(data);
    console.log(JSON.stringify(json, null, 2));
  },
  async note() {
    const data = await load();
    data.notes.push({ at: new Date().toISOString(), from: flag('from') || null, text: rest[0] });
    await save(data);
  },
  async 'short-link'() {
    const [yt, tt] = rest;
    if (!yt || !tt) throw new Error('Usage: short-link <youtubeId> <tiktokId|none|auto>');
    const data = await load();
    data.shorts ??= {}; data.shorts.links ??= {};
    if (tt === 'auto') delete data.shorts.links[yt];
    else data.shorts.links[yt] = tt === 'none' ? null : tt;
    await save(data);
    console.log(tt === 'auto' ? `${yt}: back to automatic matching` : `${yt} -> ${tt === 'none' ? 'no TikTok' : 'TikTok ' + tt}`);
  },
  async 'short-tag'() {
    const id = rest[0];
    if (!id || id.startsWith('--')) throw new Error('Usage: short-tag <youtubeId|tiktokId> [--game ..] [--hook ..] [--grade ..] [--desk ..]');
    const data = await load();
    data.shorts ??= {}; data.shorts.tags ??= {};
    const t = { ...(data.shorts.tags[id] || {}) };
    for (const k of ['game', 'hook', 'grade', 'desk']) { const v = flag(k); if (v !== undefined) { if (v === '') delete t[k]; else t[k] = v; } }
    if (Object.keys(t).length) data.shorts.tags[id] = t; else delete data.shorts.tags[id];
    await save(data);
    console.log(id, t);
  },
  async goal() {
    const KEYS = ['twitch-followers', 'yt-subs', 'yt-views', 'tt-followers', 'tt-likes', 'yt-longform', 'shorts-weekly'];
    const [key, target] = rest;
    if (!KEYS.includes(key) || !target) throw new Error(`Usage: goal <${KEYS.join('|')}> <target|off> [--by YYYY-MM-DD]`);
    const data = await load();
    data.goals = (data.goals || []).filter((g) => g.key !== key);
    if (target !== 'off') {
      const n = Number(String(target).replace(/[ ,_]/g, ''));
      if (!Number.isFinite(n) || n <= 0) throw new Error('Target must be a number.');
      data.goals.push({ key, target: n, by: flag('by') || null, set: today() });
      data.goals.sort((a, b) => KEYS.indexOf(a.key) - KEYS.indexOf(b.key));
    }
    await save(data);
    console.log('Goals:', data.goals);
  },
  async show() { console.log(JSON.stringify(await load(), null, 2)); },
  async rekey() {
    const next = process.env.NEW_HQ_PASSWORD;
    if (!next) throw new Error('Set NEW_HQ_PASSWORD.');
    await save(await load(), next);
    await load(next); // proves the new password opens it
    console.log('Re-encrypted. Update the HQ_PASSWORD secret on GitHub to the new password.');
  },
};

if (!commands[cmd]) { console.log('Commands:', Object.keys(commands).join(', ')); process.exit(1); }
await commands[cmd]();
