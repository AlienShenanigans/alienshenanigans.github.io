# Creator HQ (/hq)

A private, password-protected page at https://alienshenanigans.github.io/hq/.

All data lives in `hq/data.enc`, encrypted with AES-256-GCM using a key derived from
the password (PBKDF2-SHA256, 600k rounds). The repo is public, so nothing unencrypted
is ever committed. The page decrypts it in the browser.

## Keys (GitHub → Settings → Secrets and variables → Actions)

| Secret | What it switches on |
|---|---|
| `HQ_PASSWORD` | Required. Same password you use on the page. |
| `YT_API_KEY` | YouTube subs, views, latest videos, trending gaming videos |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | Twitch followers, VODs, top games |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | YouTube Analytics (watch time, % viewed, traffic sources) and Search Console |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | TikTok followers, likes, per-video stats. Connect once at /hq/tiktok.html, then run the workflow with the code it shows. |
| `ANTHROPIC_API_KEY` | Claude writes a new take every Monday |

The "Refresh Creator HQ" workflow runs twice a day (~05:17 and ~16:43 UTC; the second run catches
Shorts soon after they go out, so the Shorts tab can show views at about 24 hours and 7 days); run it by hand from the Actions tab
(tick "Also write a new take" to get a take straight away).

## Commands (need `HQ_PASSWORD` set)

    node tools/hq/hq.mjs add-twitch-csv Stream_Session_from_11_3_2026_to_11_3_2026.csv --game "Fallout"
    node tools/hq/hq.mjs note "Studio says retention dropped at 0:12" --from "YouTube Studio"
    node tools/hq/hq.mjs set-take take.json
    node tools/hq/hq.mjs show
    NEW_HQ_PASSWORD=... node tools/hq/hq.mjs rekey

Shorts tab and goals:

    node tools/hq/hq.mjs short-link <youtubeId> <tiktokId>   # pair two posts by hand
    node tools/hq/hq.mjs short-link <youtubeId> none         # "this one isn't on TikTok"
    node tools/hq/hq.mjs short-link <youtubeId> auto         # back to automatic matching
    node tools/hq/hq.mjs short-tag <youtubeId> --game "Slender" --hook "said I felt safe" --grade A
    node tools/hq/hq.mjs goal yt-subs 100 --by 2026-12-31     # keys: twitch-followers, yt-subs, yt-views, tt-followers, tt-likes
    node tools/hq/hq.mjs goal yt-subs off

Data added by these: `shorts.history` (a dated views/likes snapshot per Short per day, written by
`fetch`), `shorts.links` (manual pairings), `shorts.tags` (game / hook / grade / Shorts Desk id),
`goals`.

## Shorts desk feed

Every refresh also writes `hq/desk-feed.enc` (https://alienshenanigans.github.io/hq/desk-feed.enc): a small
summary for the Shorts desk, encrypted with the same password and box format as `data.enc`. Run it by hand with
`node tools/hq/hq.mjs desk-feed`. Decrypted, it is:

    {at, channel:{yt:[{date,subs,views}], tt:[{date,followers,likes}], twitch:[{date,followers}]}, goals,
     shorts:{<desk id or YouTube id>:{yt_id,title,published,yt_views,yt_likes,yt_comments,avg_pct,tt_views,tt_likes,subs}},
     trending:{youtube_gaming:[titles], twitch_top_games:[names]}, opinion, opinion_at}

`avg_pct` and `subs` come from YouTube Analytics' last 28 days (top 15 videos), so they are null for a Short that
isn't in that list yet. `opinion` is the last saved take, as plain text. The desk writes its own fresh opinion.

Decrypting in the browser:

    async function openFeed(password) {
      const box = await (await fetch('https://alienshenanigans.github.io/hq/desk-feed.enc', { cache: 'no-store' })).json();
      const u = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: u(box.salt), iterations: box.iter },
        base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u(box.iv) }, key, u(box.ct))));
    }
