#!/usr/bin/env node
// Creator HQ data tool. Every command reads and writes the encrypted hq/data.enc
// and needs HQ_PASSWORD in the environment.
//
//   node tools/hq/hq.mjs add-twitch-csv <file.csv> [--game "Name"] [--date YYYY-MM-DD]
//   node tools/hq/hq.mjs fetch          pulls YouTube + Twitch + trending (skips any source without keys)
//   node tools/hq/hq.mjs take           asks Claude for the weekly take (needs ANTHROPIC_API_KEY)
//   node tools/hq/hq.mjs set-take <file.json>   stores a take written elsewhere
//   node tools/hq/hq.mjs note "<text>" [--from "YouTube Studio"]
//   node tools/hq/hq.mjs tiktok-connect <code>   one-time: swaps the TikTok sign-in code for a token
//   node tools/hq/hq.mjs show           prints the decrypted data
//   node tools/hq/hq.mjs rekey          re-encrypts with NEW_HQ_PASSWORD
//   node tools/hq/hq.mjs short-link <youtubeId> <tiktokId|none|auto>   fixes a wrong Shorts match
//   node tools/hq/hq.mjs short-tag <youtubeId|tiktokId> [--game "Slender"] [--hook "said I felt safe"] [--grade A] [--desk <deskId>]
//   node tools/hq/hq.mjs goal <key> <target|off> [--by YYYY-MM-DD]   keys: twitch-followers, yt-subs, yt-views, tt-followers, tt-likes
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { load, save, upsert } from './vault.mjs';

const YT_CHANNEL = 'UCMmjDFOAr2v_bBuBjW8SvOA';
const TWITCH_LOGIN = 'alienshenanigans';
const TREND_REGION = process.env.HQ_TREND_REGION || 'US';
const CLAUDE_MODEL = process.env.HQ_CLAUDE_MODEL || 'claude-sonnet-5-5';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : undefined; };
const today = () => new Date().toISOString().slice(0, 10);

// ---------- Twitch "Stream Session" CSV export ----------
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, h === 'Timestamp' ? cells[i].trim() : Number(cells[i])]));
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
    if (last && last[0].slice(0, 10) === day) { h[h.length - 1] = entry; return; }
    const old = now - new Date(v.published) > 60 * 864e5;
    if (old && last && last[1] === entry[1]) return;
    h.push(entry);
    if (h.length > 40) h.splice(0, h.length - 40);
  };
  for (const v of data.youtube.videos || []) if (v.seconds <= 180) add('yt:' + v.id, v);
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
  data.take = { ...json, at: new Date().toISOString(), by: 'Claude (weekly auto)' };
  await save(data);
  console.log('Take:', json.headline);
}

// ---------- commands ----------
const commands = {
  'tiktok-connect': () => tiktokConnect(rest[0]),
  'add-twitch-csv': () => addTwitchCsv(rest[0]),
  async fetch() {
    const data = await load();
    const before = JSON.stringify(data);
    for (const f of [fetchYouTube, fetchGoogleOAuth, fetchTwitch, fetchTikTok]) {
      try { await f(data); } catch (e) { console.error(`${f.name} failed:`, e.message); process.exitCode = 1; }
    }
    trackShorts(data);
    if (JSON.stringify(data) === before) return console.log('Nothing new: data file left as is.');
    await save(data);
  },
  take,
  async 'set-take'() {
    const data = await load();
    data.take = { ...JSON.parse(await readFile(rest[0], 'utf8')), at: new Date().toISOString() };
    await save(data);
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
    const KEYS = ['twitch-followers', 'yt-subs', 'yt-views', 'tt-followers', 'tt-likes'];
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
