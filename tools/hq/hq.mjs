#!/usr/bin/env node
// Creator HQ data tool. Every command reads and writes the encrypted hq/data.enc
// and needs HQ_PASSWORD in the environment.
//
//   node tools/hq/hq.mjs add-twitch-csv <file.csv> [--game "Name"] [--date YYYY-MM-DD]
//   node tools/hq/hq.mjs fetch          pulls YouTube + Twitch + trending (skips any source without keys)
//   node tools/hq/hq.mjs take           asks Claude for the weekly take (needs ANTHROPIC_API_KEY)
//   node tools/hq/hq.mjs set-take <file.json>   stores a take written elsewhere
//   node tools/hq/hq.mjs note "<text>" [--from "YouTube Studio"]
//   node tools/hq/hq.mjs show           prints the decrypted data
//   node tools/hq/hq.mjs rekey          re-encrypts with NEW_HQ_PASSWORD
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
  'add-twitch-csv': () => addTwitchCsv(rest[0]),
  async fetch() {
    const data = await load();
    const before = JSON.stringify(data);
    for (const f of [fetchYouTube, fetchTwitch]) {
      try { await f(data); } catch (e) { console.error(`${f.name} failed:`, e.message); process.exitCode = 1; }
    }
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
  async show() { console.log(JSON.stringify(await load(), null, 2)); },
  async rekey() {
    const next = process.env.NEW_HQ_PASSWORD;
    if (!next) throw new Error('Set NEW_HQ_PASSWORD.');
    await save(await load(), next);
    console.log('Re-encrypted. Update the HQ_PASSWORD secret on GitHub to the new password.');
  },
};

if (!commands[cmd]) { console.log('Commands:', Object.keys(commands).join(', ')); process.exit(1); }
await commands[cmd]();
