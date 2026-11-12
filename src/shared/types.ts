// src/shared/types.ts — the view contract between server and every surface.
//
// The server builds a GameView from several ESPN feeds and stamps WHERE each
// volatile field came from and WHEN it last changed, so a surface can render
// the freshest truth and show a quiet degraded state instead of a blank.

export type Sport = 'football' | 'basketball';
export type League = 'nfl' | 'cfb' | 'nba' | 'wnba' | 'ncaam' | 'ncaaw';

export const sportOf = (l: League): Sport => (l === 'nfl' || l === 'cfb' ? 'football' : 'basketball');

export type Phase = 'pre' | 'in' | 'post';

/** Which upstream feed a field's current value came from. */
export type Source =
  | 'summary'     // site summary (header / drives / plays)
  | 'scoreboard'  // site scoreboard event (status + situation)
  | 'core'        // core API status / situation / plays
  | 'plays'       // derived from the newest play object
  | 'held';       // every feed stale: last known value, held

export interface Stamp {
  src: Source;
  /** ms epoch when this field's VALUE last changed (not when it was last fetched). */
  at: number;
}

export interface FeedHealth {
  /** ms epoch of the last successful fetch, 0 if never. */
  okAt: number;
  /** ms epoch of the last failure, 0 if never. */
  failAt: number;
  /** HTTP status or short reason of the last failure. */
  reason: string;
  /** Consecutive failures. */
  fails: number;
}

export interface Feeds {
  summary: FeedHealth;
  scoreboard: FeedHealth;
  coreStatus: FeedHealth;
  corePlays: FeedHealth;
  coreSituation: FeedHealth;
}

export interface TeamView {
  id: string;
  name: string;      // "Alabama Crimson Tide"
  nick: string;      // "Crimson Tide"
  short: string;     // "Alabama"
  abbr: string;      // "ALA"
  score: number;
  record: string;
  rank: number | null;   // AP rank (college), null otherwise
  logo: string;          // ESPN logo href (proxied by the client)
  logoDark: string;
  color: string;         // "#9e1b32"
  alt: string;           // alternate colour
  linescores: number[];
  timeouts: number | null;
}

export interface SituationView {
  down: number | null;
  distance: number | null;
  yardsToEndzone: number | null;
  ddText: string;          // "3rd & 7" (short form, no spot)
  possText: string;        // "ALA 34"
  possIsHome: boolean;
  possIsAway: boolean;
  isRedZone: boolean;
  lastPlayId: string;
  lastPlayText: string;
}

/**
 * The field engine consumes ESPN's drives/plays shape directly (geometry,
 * spot grammar and animation chains are grounded in those objects). The
 * server passes a trimmed copy: the current drive in full, plus the previous
 * drives' plays with the fields the engine reads. Nothing else from the
 * 1 MB summary crosses the wire.
 */
export interface PlayLite {
  id: string;
  text: string;
  type: { id?: string; text: string; abbreviation?: string };
  period: { number: number };
  clock: { displayValue: string };
  homeScore: number;
  awayScore: number;
  scoringPlay: boolean;
  isPenalty?: boolean;
  isTurnover?: boolean;
  statYardage?: number;
  start?: SpotLite;
  end?: SpotLite;
  scoringType?: { name?: string; abbreviation?: string };
  team?: { id: string };
  modified?: string;
}
export interface SpotLite {
  down?: number;
  distance?: number;
  yardLine?: number;
  yardsToEndzone?: number;
  team?: { id: string };
  downDistanceText?: string;
  shortDownDistanceText?: string;
  possessionText?: string;
}
export interface DriveLite {
  id: string;
  description: string;
  team: { id: string; abbreviation?: string };
  start?: { period?: { number: number }; clock?: { displayValue: string }; yardLine?: number; text?: string };
  end?: { period?: { number: number }; clock?: { displayValue: string }; yardLine?: number; text?: string };
  timeElapsed?: { displayValue: string };
  yards?: number;
  offensivePlays?: number;
  result?: string;
  displayResult?: string;
  isScore?: boolean;
  plays: PlayLite[];
}

export interface ScoringPlayView {
  id: string;
  period: number;
  clock: string;
  text: string;
  teamId: string;
  homeScore: number;
  awayScore: number;
  type: string;   // "TD" | "FG" | "SF" | ...
}

export interface FootballGameView {
  sport: 'football';
  league: 'nfl' | 'cfb';
  eventId: string;
  date: string;          // ISO kickoff
  seasonType: number;
  week: number | null;
  phase: Phase;
  statusName: string;    // STATUS_IN_PROGRESS, STATUS_HALFTIME, STATUS_END_PERIOD, STATUS_FINAL, STATUS_DELAYED ...
  statusDetail: string;  // ESPN's shortDetail ("Sat, 2:30 PM CT", "Final", "Halftime")
  completed: boolean;
  period: number;
  clock: string;         // displayClock "12:34"
  /** The status feeds' own reading (what `clock` is unless the plays took over a stuck one). */
  statusClock: string;
  statusPeriod: number;
  /** When statusClock last changed, and the newest real play id at that moment (carried across polls). */
  statusSince: number;
  playAtStatus: string;
  home: TeamView;
  away: TeamView;
  situation: SituationView | null;
  drives: { current: DriveLite | null; previous: DriveLite[] };
  scoringPlays: ScoringPlayView[];
  broadcasts: Array<{ market: string; name: string; isNational: boolean }>;
  venue: { name: string; city: string; state: string } | null;

  /** Per-field provenance for the volatile fields. */
  stamps: {
    score: Stamp;
    clock: Stamp;
    period: Stamp;
    situation: Stamp;
    plays: Stamp;
  };
  feeds: Feeds;
  /**
   * 'full'   every feed is answering
   * 'floor'  summary (gamecast) is down; score/clock/period/situation come
   *          from the scoreboard and/or core feeds, drives/plays are frozen
   * 'held'   nothing is answering; everything is last-known
   */
  mode: 'full' | 'floor' | 'held';
  /** ms epoch the server built this view. */
  built: number;
}

export type GameView = FootballGameView; // basketball joins when lifted

export interface SlateGame {
  eventId: string;
  league: League;
  date: string;
  phase: Phase;
  statusDetail: string;
  period: number;
  clock: string;
  home: Pick<TeamView, 'id' | 'abbr' | 'short' | 'score' | 'rank' | 'logo' | 'color'>;
  away: Pick<TeamView, 'id' | 'abbr' | 'short' | 'score' | 'rank' | 'logo' | 'color'>;
  possession: string | null;
  network: string;
}

export interface SlateView {
  league: League;
  date: string;         // YYYY-MM-DD
  games: SlateGame[];
  built: number;
}
