# scorebug

Live football scoreboard engine and surfaces, off Reddit. One backend polls ESPN's
public feeds, builds a `GameView` with per-field provenance, and serves every surface
from it. First surface: an OBS browser-source overlay.

## Run locally

    npm install
    npm run build
    npm start                  # http://localhost:8080  (in-memory cache; set REDIS_URL for Redis)

    http://localhost:8080/overlay?league=cfb&team=ALA
    http://localhost:8080/overlay?league=nfl&event=401873272&pos=br&scale=0.8
    http://localhost:8080/health

Overlay knobs: `league=cfb|nfl|nba|wnba|ncaam|ncaaw`, `team=ABBR` (ESPN's abbreviation) or `event=ID`,
`pos=bl|br|tl|tr|bc|tc` (default `bl`), `scale=0.5..1.6`; basketball: `cam=half|full` (default `half`, follows possession).

In OBS: Sources → + → Browser, URL above, width 1920, height 1080, leave the custom
CSS empty (the page is transparent). "Shutdown source when not visible" is fine.

## Replay (no ESPN needed)

    npm run replay             # http://localhost:8090
    /overlay?league=nfl&event=401873272&start=70&speed=0            hold one snapshot
    /overlay?league=nfl&event=401873272&start=70&fail=floor         summary dies, scoreboard lives (the LSU case)
    /overlay?league=nfl&event=401873272&start=70&fail=held          everything dies
    /overlay?league=nfl&event=401873272&start=30&fail=stuckclock    status clock freezes, plays keep coming
    /overlay?league=nfl&event=401873272&start=30&fail=stuckscore    status score freezes

## Tests

    npm test                   # football + basketball engines against captured games and simulated failures

## Resilience model

Every poll fetches five feeds independently: site summary, site scoreboard event,
core status, core situation, core plays. The engine (`src/server/football/engine.ts`,
pure) picks the freshest truth per field and stamps where it came from:

- stuck clock: status clock unchanged ≥75 s while new plays arrive → plays run the clock
- stuck score: newest play's score ahead of every status score → play score wins
- summary down: score/period/clock/situation from scoreboard + core, drives held
  (core plays appended so the field keeps moving) → `mode: "floor"`, overlay says "scores only"
- nothing answers: previous view, `mode: "held"`, overlay says "reconnecting · Ns"

`/health` lists every game served in the last two hours with per-field sources and
per-feed ages, so a bad Saturday is visible at a glance.

## Deploy (Fly.io)

    fly launch --copy-config --no-deploy
    fly redis create                      # then: fly secrets set REDIS_URL=redis://...
    fly deploy --build-arg BUILD_ID=$(git rev-parse --short HEAD)

## Layout

    src/shared/types.ts            the GameView contract (server ↔ every surface)
    src/server/cache.ts            Redis (ioredis) with the Devvit call shapes; memory fallback
    src/server/football/engine.ts  feeds → GameView, pure, tested
    src/server/football/espn.ts    fetch layer, per-feed health, build lock, last-good view
    src/server/index.ts            HTTP: /api/game /api/slate /api/img /health + static
    src/client/football/field.ts   the field engine, lifted verbatim from cfb-scores
    src/client/overlay/main.ts     the OBS overlay surface
    public/overlay.html|css        the overlay shell
    captures/                      recorded ESPN sequences for tests and replay

## Basketball

Same server, same overlay: `/overlay?league=nba&team=NO`, `wnba`, `ncaam`, `ncaaw`.
`src/server/basketball/engine.ts` and `src/client/basketball/{court,court3d,live}.ts` are
lifted verbatim from nba-hub; `espn.ts` is ported onto the shared cache with the same
floor/held modes. Replay a captured final play by play:

    /overlay?league=nba&event=401909287&start=200&speed=2
