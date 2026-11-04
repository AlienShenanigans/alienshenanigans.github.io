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
| `ANTHROPIC_API_KEY` | Claude writes a new take every Monday |

The "Refresh Creator HQ" workflow runs daily; run it by hand from the Actions tab
(tick "Also write a new take" to get a take straight away).

## Commands (need `HQ_PASSWORD` set)

    node tools/hq/hq.mjs add-twitch-csv Stream_Session_from_11_3_2026_to_11_3_2026.csv --game "Fallout"
    node tools/hq/hq.mjs note "Studio says retention dropped at 0:12" --from "YouTube Studio"
    node tools/hq/hq.mjs set-take take.json
    node tools/hq/hq.mjs show
    NEW_HQ_PASSWORD=... node tools/hq/hq.mjs rekey
