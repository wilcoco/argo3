# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**BACTERIA WAR (argo3)** — a GPS-based territory game with two interlocking layers:

- **Macro** (persistent world): real OSM map, 200m grid cells, claim/defend/contest, server ticks every 5s drive ecosystem (income, natural death, rebirth, tribe rock-paper-scissors).
- **Micro** (real-time battle): when challenged, both sides drop into a 1:1 arena fight over a center "yolk" zone for that one cell's ownership.

Single Node server (Express + Socket.IO) serves both REST and realtime; PostgreSQL is the only persistence; client is plain JS/Canvas (no framework, no build step).

## Commands

```bash
npm install
npm start                # production mode
npm run dev              # node --watch (auto-restart on file change)
npm run initdb           # manual schema apply (also runs auto on server boot)
node --check <file.js>   # syntax check (no test runner in this repo)
```

There are **no unit tests or linter**. Verification is done by:
1. `node --check` on every changed `.js` file
2. Booting the server against a local Postgres and exercising via `curl` or headless puppeteer

For headless E2E (when needed): puppeteer is installed; chromium lives at `~/.cache/puppeteer`. Launch with `args: ['--no-sandbox']`. The sandbox blocks OSM tiles (`tile.openstreetmap.org`) — treat those console errors as expected noise, not failures.

Local Postgres for testing:
```bash
service postgresql start
sudo -u postgres psql -c "CREATE USER bw WITH PASSWORD 'bw' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE bw_test OWNER bw;"
DATABASE_URL=postgres://bw:bw@localhost:5432/bw_test PORT=3030 node server/index.js
```

## Deployment

Railway, single service + PostgreSQL plugin. `DATABASE_URL` is auto-injected via the plugin reference; no other env vars required. **DB schema applies itself on boot** (`server/db/init.js` is idempotent: `CREATE TABLE IF NOT EXISTS` + `ON CONFLICT`). The healthcheck is `/healthz` (per `railway.json`).

If `DATABASE_URL` is missing, server still starts but the ecosystem tick is disabled (warning only) — never crashes the container.

## Architecture (the parts that span files)

### A challenge traverses every layer

When a player taps an enemy cell, this is the actual path — touching it in one place without understanding the rest will break it:

```
client app.js  -POST /api/challenge->  routes/api.js  ->  macro.js:startChallenge
                                                          ├─ cell busy or resting? -> insert into cell_queue, return {queued}
                                                          └─ else -> insert into battles (status='active'), return {battle, proximity}
                            socket.emit('challenge:initiate', ...)
                                                          v
                                       index.js socket handler  ->  if defender online: notify them, 15s timer
                                                                    if offline: emit 'challenge:fallback_ai'
                            user clicks 직접 방어 / timeout fires
                                                          v
                            client battle.js .start({mySide, pvp, proximity, socket})
                                                          ... real-time fight runs in browser ...
                            client POST /api/challenge/:id/resolve {pvpWinner}
                                                          v
                            macro.js:resolveChallenge  ->  if pvpWinner given: trust it (PvP)
                                                          else: simulateBattle (server-authoritative for AI)
                                                          -> ownership transfer + rest_until set + fatigue counters
```

Every tick (5s), `processQueueTick` finds cells whose rest expired and randomly pops a queued challenger, emitting `challenge:turn` to them. The random selection is intentional anti-collusion: friends can't queue-stuff to gatekeep a position. Don't change to FIFO without re-thinking this.

### The macro/micro split

`server/game/config.js` holds **all tunable numbers** in one object. It is imported by the server AND served as-is to clients via `GET /api/config` (note: it leaks `BETTING.CAP_THRESHOLD`, exemption values, etc. — that's intentional, all balance variables are open). The client also gets `window.BW_CONFIG` for legacy access at the bottom of the file.

The same physical engine pattern (towers, ranges, overlap damage, projectiles) appears in two places:
- `server/game/battle.js` — headless server-authoritative simulator. Used to resolve AI battles and to estimate win probability before a challenge.
- `public/js/battle.js` — real-time renderable engine the user actually interacts with.

These two are **deliberately not shared code** because one runs headless deterministically and the other needs raf loop, input, network sync. Keep parameter changes (CONFIG.MICRO) in sync mentally; they read from the same config but execute independently.

### Time model

- Server tick = 5s wall clock, but represents "1 game hour" in lifespan/exempt math. `cells.rest_until`, `players.lifespan`, `cells.exempt_until` are all **tick counts** stored as BIGINT.
- All "ticks" arithmetic must be integer. Floats hitting BIGINT columns → `invalid input syntax for type bigint` and the tick loop silently fails forever. We hit this twice (`INCOME_PER_CELL=0.6`, `KARMA_SURVIVAL=0.3 * 0.1`). Fix by **explicit cast in SQL**: `$1::real` for any float parameter that postgres might infer as bigint due to `COUNT(*)` or other bigint context.

### GPS as a hard gate (recent design choice)

`MACRO.CLAIM_RADIUS_M = 1000`. The server (`claimCell`) rejects claims more than 1km from `playerLat/playerLng` sent by the client. The client also pre-blocks the claim button. **This is by design** — physical presence is the game's defining mechanic. The 1km circle is drawn on the map. Don't soften this without a design discussion.

### Micro "supply line" bonus

When a challenge starts, `startChallenge` counts how many other cells each side owns within `MICRO.PROXIMITY_RADIUS_M` (800m) of the contested cell. That count is returned in `proximity: {atk, def}` and the client's `battle.start({...proximity})` scales the starting tower radius by `1 + count * 0.10` (capped at +60%). This is what makes "fighting near your home turf" stronger than long-range expeditions.

## Things that look like bugs but aren't

- **OSM tile 403/cert errors in headless puppeteer**: sandbox blocks the tile CDN. The map falls back to procedurally-generated streets so the game stays interactive. Real browsers load tiles fine.
- **Sheet/modal not responsive on mobile**: it's almost always the cache. `public/index.html` uses `?v=N` query strings on css/js. **Bump this number on every release that touches client JS/CSS** — currently `?v=8`. Browser cache will pin the old version otherwise.
- **Server logs "DATABASE_URL 미설정" warning then keeps running**: intentional graceful degradation, not a startup failure.
- **`createPlayer` rejects 1-char usernames**: validation is `username.length < 2`.

## Conventions

- **Branch**: development happens on `claude/pensive-heisenberg-tRUUE`. Don't push to `main` without coordination.
- **Korean for everything**: commit messages, comments, error strings, UI text. Code identifiers are English.
- **Commit message format**: prefix with `feat:`, `fix:`, `feat(scope):` etc. Korean body OK. End with `https://claude.ai/code/session_<id>` trailer.
- **Server is authoritative**: never trust client values for energy, ownership, tick, or bet validation. Always re-clamp on the server side (see `claimCell` value clamp pattern).
- **Socket.IO client is self-hosted**: `<script src="/socket.io/socket.io.js">` — provided automatically by the socket.io server module. Do NOT switch to `cdn.socket.io`; that broke production once (CORS/cert in some networks).

## Reference docs

- `README.md` — onboarding, deploy steps, game overview
- `docs/UPGRADE_BACKLOG.md` — deferred features (tournament, JWT auth, Redis adapter for horizontal scaling, hero summon visuals, etc.) — read this before starting any "new big feature" so you don't reinvent something already designed
