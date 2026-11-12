// src/shared/types.ts — the contract between server and client.
//
// The server turns ESPN payloads into a GameView (src/server/engine.ts); the
// client only renders it. Everything that takes judgement (possession, runs,
// fouls, and-ones, event labels) is decided server-side.

export type League = 'nba' | 'wnba' | 'ncaam' | 'ncaaw';

/** Men's and women's Division I: halves vs quarters differ, the rest of the college handling is shared. */
export const isCollege = (league: League): boolean => league === 'ncaam' || league === 'ncaaw';
/** A player fouls out on the sixth personal in the NBA; on the fifth in the WNBA and college (men's and women's). */
export const foulLimit = (league: League): number => (league === 'nba' ? 6 : 5);
/**
 * Foul trouble for a player with `fouls` personals, in `period` of a game with `regPeriods`
 * regulation periods (overtime counts as the last one), the game live or final.
 */
export function foulTier(league: League, fouls: number, period: number, regPeriods: number, live: boolean): FoulTier {
  const limit = foulLimit(league);
  if (fouls >= limit) return 'out';
  if (!live || fouls <= 0) return '';
  if (fouls >= limit - 1) return 'danger';
  const p = Math.max(1, Math.min(period, regPeriods));
  // Ahead of the pace: one more foul than the period number. In the last quarter the one-away rule
  // covers it; a second half is twenty minutes, so three fouls there still reads as trouble.
  if (p < regPeriods) return fouls >= p + 1 ? 'watch' : '';
  return regPeriods === 2 && fouls >= 3 ? 'watch' : '';
}
/** Regulation periods: men's college plays halves; the NBA, WNBA and women's college play quarters. */
export const regulationPeriods = (league: League): number => (league === 'ncaam' ? 2 : 4);
/** ESPN's league slug under /sports/basketball/. */
export const ESPN_LEAGUE: Record<League, string> = { nba: 'nba', wnba: 'wnba', ncaam: 'mens-college-basketball', ncaaw: 'womens-college-basketball' };
/** The bundled logo folder: a school's logo is the school's, so the women's league reads the men's folder. */
export const logoLeague = (league: League): 'nba' | 'wnba' | 'ncaam' => (league === 'ncaaw' ? 'ncaam' : league);
/** "NBA", "WNBA", "NCAAM", "NCAAW". */
export const leagueTag = (league: League): string => league.toUpperCase();
/** "College Basketball" / "Women's College Basketball" / "NBA" / "WNBA". */
export const leagueName = (league: League): string => (league === 'ncaam' ? 'College Basketball' : league === 'ncaaw' ? "Women's College Basketball" : league.toUpperCase());

/** Bound to each post at creation (postData). Kept tiny: 2 KB limit. */
export interface PostBinding {
  league: League;
  eventId: string;
}

export type GameState = 'pre' | 'in' | 'post' | 'postponed';

/** 0 = away, 1 = home. Used everywhere a team is referenced. */
export type Side = 0 | 1;

export type BonusState = 'none' | 'bonus' | 'double';

export interface Last5Game {
  opp: string;           // opponent abbreviation
  oppId: string;         // opponent ESPN team id (bundled logo key)
  oppLogo: string;       // ESPN logo URL, proxied fallback
  home: boolean;         // this team was at home
  won: boolean;
  /** "126-104", this team's score first. */
  score: string;
  ot: boolean;
}

export interface TeamView {
  id: string;
  abbr: string;
  name: string;          // "Seattle Storm"
  short: string;         // "Storm"
  color: string;         // "#2c5235"
  alt: string;           // "#fee11a"
  logo: string;
  logoDark: string;
  score: number;
  record: string;        // "8-36" or ""
  /** Venue-relevant split: the home team's home record, the away team's road record. "" if unknown. */
  split: string;
  /** College: the conference record, "11-7" (ESPN's vsconf record); '' elsewhere. */
  confRecord: string;
  rank: number | null;   // NCAAM poll rank, null when unranked
  /** Last five results, oldest first, from ESPN's lastFiveGames (last season during preseason). */
  last5: Last5Game[];
  /** "W3" / "L1" from the standings block; "" when unknown. */
  streak: string;
  linescores: number[];  // per period, as far as played
  /** Team fouls in the current period (half in NCAAM). Counted from plays. */
  fouls: number;
  /** This team is in the bonus: its opponent's fouls now send it to the line. */
  bonus: BonusState;
  /** Timeouts remaining from ESPN's situation feed; null when not available. */
  timeoutsLeft: number | null;
  /** Direction for the CURRENT period: true = attacks the right-hand basket. */
  attacksRight: boolean;
}

export type EventKind =
  | 'made2' | 'made3' | 'andone' | 'ft' | 'ftmiss' | 'miss' | 'block'
  | 'rebound' | 'turnover' | 'steal' | 'foul' | 'timeout' | 'jumpball'
  | 'period' | 'review' | 'other';

export interface PlayView {
  id: string;
  kind: EventKind;
  label: string;         // "+3", "AND-ONE", "TIMEOUT", ...
  text: string;          // ESPN play text
  side: Side | null;
  period: number;
  clock: string;
  score: [number, number]; // [away, home] after this play
  scoring: boolean;
  /** Elapsed game seconds at this play. */
  e: number;
  /** Home win probability after this play (0-100), when ESPN has it. */
  wp: number | null;
}

export interface ShotView {
  id: string;
  side: Side;
  player: string;        // athlete id ('' if unknown)
  made: boolean;
  pts: 2 | 3;
  andOne: boolean;
  /** ESPN half-court frame, feet: x 0..50 across, y = feet from the rim toward midcourt. */
  x: number;
  y: number;
  period: number;
  clock: string;
  text: string;
}

export interface PlayerRef {
  name: string;          // "D. Malonga"
  jersey: string;
  side: Side;
}

export interface RunView {
  side: Side;
  pts: number;           // run points for side
  opp: number;           // opponent points during the run (0 = unanswered)
  span: string;          // game time the run covers, "2:09"
}

export interface OddsView {
  provider: string;      // "DraftKings"
  line: string;          // "DAL -7.5"
  overUnder: number | null;
  moneyline: [string, string]; // [away, home] e.g. "+245", "-305"; "" when unknown
}

export interface InjuryView {
  id: string;            // athlete id ('' if unknown); opens the player card
  headshot: string;      // '' if unknown
  name: string;
  pos: string;
  status: string;        // "Out", "Day-To-Day", "Questionable"
  detail: string;        // "Knee", "Coach's Decision"
}

/**
 * Foul trouble, decided server-side (foulTier): '' nothing to say; 'watch' ahead of the pace that
 * fouls a player out (2 in the 1st quarter, 3 in the 2nd, 4 in the 3rd; 2 in the 1st half, 3 in the
 * 2nd); 'danger' one foul from the limit; 'out' fouled out. Live games only, except 'out', which a
 * final keeps.
 */
export type FoulTier = '' | 'watch' | 'danger' | 'out';

export interface BoxRow {
  id: string;
  name: string;          // "D. Malonga"
  jersey: string;
  pos: string;
  starter: boolean;
  dnp: string | null;    // reason when the player did not play
  headshot: string;
  /** Values in the order of BoxView.cols. */
  stats: string[];
  /** Personal fouls so far (the PF column as a number; 0 when the feed has none). */
  fouls: number;
  foul: FoulTier;
}

export interface BoxView {
  cols: string[];        // "MIN","PTS","REB","AST","FG","3PT","FT","OREB","DREB","STL","BLK","TO","PF","+/-"
  rows: [BoxRow[], BoxRow[]]; // by side
  totals: [string[], string[]];
}

export interface TeamStatView {
  label: string;         // "Field goals"
  vals: [string, string];
  /** Share of the stat for the away side (0-1) for the comparison bar; null = no bar. */
  awayShare: number | null;
}

export interface PerformerView {
  id: string;            // ESPN athlete id
  side: Side;
  name: string;
  headshot: string;
  line: string;          // "24 PTS · 8 REB · 5 AST"
}

export interface GameView {
  v: 1;
  league: League;
  eventId: string;
  state: GameState;
  detail: string;        // "Final", "Final/2OT", "Q3 4:12", "Halftime"
  period: number;
  periodLabel: string;   // "Q3", "2nd Half", "OT", "2OT"
  clock: string;
  regPeriods: number;    // 4 or 2
  teams: [TeamView, TeamView];
  /** Side with the ball after the last play, derived from play-by-play. */
  possession: Side | null;
  /** Most recent meaningful play, for the event banner. */
  last: PlayView | null;
  recent: PlayView[];    // newest first
  shots: ShotView[];     // every field-goal attempt, oldest first
  players: Record<string, PlayerRef>;
  run: RunView | null;
  /** Lead tracker: [elapsed game seconds, home minus away] at every score. */
  lead: Array<[number, number]>;
  /** Total game seconds so far (regulation plus any overtime started). */
  length: number;
  /** Home win probability (0-100) after the last play. */
  wp: number | null;
  venue: string;
  /** Neutral-site game (college tournaments, showcases): the matchup reads "vs" rather than "at". */
  neutral: boolean;
  city: string;
  broadcast: string;
  /** Every listed feed, national first. Empty when ESPN lists none. */
  broadcasts: Array<{ name: string; type: string }>;
  tipoff: number;        // epoch ms
  /** Full series/season note for titles and the info sheet, e.g. "Semifinals · Game 2 of 5 · LV leads 1-0". */
  note: string;
  /** Playoff round only ("SEMIFINALS", "FIRST ROUND"); empty in the regular season. */
  seriesRound: string;
  /** ESPN's competition notes headline as sent ("East Finals - Game 3", a college tournament round), '' when none. */
  headline: string;
  /** Who leads or "Series tied 1-1"; empty before Game 1 is decided. Regular season: "DAL leads 2-1". */
  seriesStatus: string;
  odds: OddsView | null;
  /** By side; null when the feed has no injuries block (NCAAM). */
  injuries: [InjuryView[], InjuryView[]] | null;
  /** Player box score. Omitted from the light poll payload. */
  box: BoxView | null;
  teamStats: TeamStatView[];
  performers: PerformerView[];
  /**
   * Every non-substitution play, oldest first (Plays tab; the Win % chart reads
   * the wp field). Omitted from the light poll payload — see /api/game?full=1.
   */
  plays: PlayView[] | null;
  /** Lead changes so far (ESPN team stat), null when unknown. */
  leadChanges: number | null;
  /** Late and close: 4th quarter or OT, under five minutes, margin of five or fewer. */
  clutch: boolean;
  /**
   * Seconds of GAME time the play-by-play trails the clock (0 when current). ESPN's
   * play feed for a game can stall while its clock keeps running (LAL@SAC 2026-10-05:
   * plays ended at Q1 5:16 with the clock at Q2 10:55); the court and banner then
   * show the last play ESPN has, and the viewer deserves to know why.
   */
  feedLag: number;
  /**
   * The clock ESPN's status block reports, untouched, with its period and the id of the latest
   * play; getGameView compares these across polls. When the status clock stops moving while
   * plays keep arriving (HOU@PHX 2026-11-07: status stuck on "0.0 3rd" through the whole
   * quarter, plays ticking at 5:44), `clock`/`period`/`detail` are taken from the latest play
   * and clockSource says so. The viewer sees a running clock either way.
   */
  statusClock: string;
  statusPeriod: number;
  lastPlayId: string;
  /** When statusClock last changed, and the latest play id at that moment (carried across polls). */
  statusSince: number;
  playAtStatus: string;
  clockSource: 'status' | 'plays';
  attendance: number | null;
  /** ESPN season for this game: year (NBA 2026 = 2025-26) and type (1 pre, 2 regular, 3 post). */
  season: { year: number; type: number };
  officials: string[];
  updated: number;       // epoch ms the view was built
}

/** Season card for one player (GET /api/player). */
export interface PlayerCard {
  id: string;
  name: string;
  jersey: string;
  pos: string;           // "F"
  posName: string;       // "Forward"
  height: string;        // "6' 11\""
  weight: string;        // "243 lbs"
  age: number | null;
  exp: number | null;    // seasons
  headshot: string;
  teamId: string;
  /** "2025-26" / "2026" / "2026 Playoffs"; "" when no season stats were found. */
  seasonLabel: string;
  /** Season stats in display order; key stats (PTS, REB, AST) flagged. */
  stats: Array<{ k: string; v: string; key?: boolean }>;
  espnUrl: string;
}

// ── daily megathread ─────────────────────────────────────────────────────

/** A megathread post is bound to a league and an ET date instead of one event. */
export interface MegaBinding {
  league: League;
  mega: string;          // YYYYMMDD (ET)
  /** Team-focused megathread (the sub's daily discussion): ESPN team id, bound at creation. */
  team?: string;
}

export interface SlateTeam {
  id: string;
  abbr: string;
  name: string;          // "Lakers"
  color: string;         // '#rrggbb'
  alt: string;
  logo: string;          // ESPN logo URL (fallback when the bundled file is missing)
  logoDark: string;
  record: string;        // "27-17"
  score: number | null;  // null before tipoff
  winner: boolean;
  /** AP rank 1-25 (college), 0 when unranked. */
  rank: number;
}

/** One game box on the megathread slate. */
export interface SlateCard {
  id: string;
  state: 'pre' | 'in' | 'post' | 'postponed';
  tipoff: number;
  /** "Q3 4:12", "Half", "End Q1", "Final", "Final/OT", "7:30 PM" is formatted on the client from tipoff. */
  status: string;
  period: number;
  clock: string;
  network: string;       // first national broadcast, '' if none
  /** On a national TV network (not streaming-only); the college slate marks these. */
  tv: boolean;
  /** Neutral-site game (college): the card says "vs" rather than "@". */
  neutral: boolean;
  note: string;          // ESPN headline, e.g. "Semifinals - Game 2"; '' in the regular season
  teams: [SlateTeam, SlateTeam];   // [away, home]
  /** Final or live: the top scorer per side, "M. Fauthoux 14". */
  leaders: [string, string];
  /**
   * The sub's own team's game inside its daily discussion: the score, clock and leaders are kept
   * out of that post (the game thread is the live one), so the card is the matchup and tipoff
   * only, whatever the real state, and it opens nothing once the game has tipped off.
   */
  quiet?: boolean;
  /** The game thread's URL when this app posted one (a quiet card links there). */
  thread?: string;
}

export interface MegaView {
  league: League;
  ymd: string;
  title: string;         // "NBA Megathread"
  dateLabel: string;     // "Tuesday, October 7"
  seasonType: number;    // 1 pre, 2 regular, 3 post
  games: SlateCard[];
  updated: number;
  /** Present on a team-focused megathread (a sub's daily discussion). */
  team?: TeamDay;
}

// ── team-focused megathread ──────────────────────────────────────────────

export interface TeamRef {
  id: string;
  abbr: string;
  name: string;          // "Minnesota Timberwolves"
  short: string;         // "Timberwolves"
  logo: string;
  logoDark: string;
}

/** One row of a conference table. */
export interface StandingRow extends TeamRef {
  seed: number;          // 1-based position in the conference as ESPN orders it
  w: number;
  l: number;
  pct: string;           // ".750"
  gb: string;            // "-" for the leader
  streak: string;        // "W3"
  l10: string;           // "7-3", '' when the feed has none
  /** Conference record "15-5" (college standings lead with it); '' for the pro leagues. */
  conf: string;
  me: boolean;           // the sub's team
}

export interface StandingGroup {
  name: string;          // "Western Conference"
  short: string;         // "West"
  rows: StandingRow[];
}

/** One game on the team's schedule, from the team's point of view. */
export interface SchedGame {
  id: string;
  tipoff: number;        // epoch ms
  /** ESPN marks a date with no set time (TBD) with timeValid false. */
  timeValid: boolean;
  home: boolean;         // the team is at home
  opp: TeamRef;
  state: 'pre' | 'in' | 'post' | 'postponed';
  /** Final: 'W' or 'L' for the team; '' otherwise. */
  result: '' | 'W' | 'L';
  /** The team's score first, "118-104"; '' before tipoff. */
  score: string;
  tv: string;            // national network first, '' when none listed
  /** Live or final status text, "Q3 4:12" / "Final/OT"; '' before tipoff. */
  status: string;
  /** ESPN note, e.g. "NBA Cup" or a playoff game note. */
  note: string;
}

/** Pregame detail for the team's next game (from the full game view when ESPN has it). */
export interface TeamPreview {
  eventId: string;
  venue: string;
  tv: string;            // every listed network, national first
  /** Networks with their market: "ESPN (National) · Spectrum SportsNet (LAL)". */
  watch: string;
  officials: string[];
  note: string;          // series / season-series note
  /** [away, home]: record, venue split, streak, last five as "W L W W L". */
  teams: [PreviewSide, PreviewSide];
  /** Players listed Out / Doubtful / Questionable, by side. */
  injuries: [Array<{ name: string; status: string }>, Array<{ name: string; status: string }>];
}

export interface PreviewSide {
  abbr: string;
  record: string;
  split: string;
  streak: string;
  form: string;
  /** College: conference record and AP rank (0 = unranked); '' / 0 elsewhere. */
  conf: string;
  rank: number;
}

/** GET /api/standings: every conference, with the current game's teams flagged. */
export interface StandingsView {
  league: League;
  groups: StandingGroup[];
  /** Team ids flagged `me` in the rows (the game's two teams), in [away, home] order when known. */
  mark: string[];
  updated: number;
  /**
   * College: the national polls, AP first. On a megathread's slate (no game, so no conference to
   * show) they are the whole sheet; on a game they are tabs after the game's conference tables.
   * Absent in the NBA and WNBA.
   */
  polls?: Poll[];
}

/** One national poll (AP Top 25, the coaches' poll). */
export interface Poll {
  id: string;
  name: string;        // "AP Top 25"
  short: string;       // "AP"
  /** "Week 2" / the poll's date line, '' when ESPN gives neither. */
  week: string;
  rows: PollRow[];
  /** Others receiving votes, "Team 45, Team 12". */
  others: string;
}
export interface PollRow {
  rank: number;
  /** Last week's rank, 0 when unranked or new. */
  prev: number;
  id: string;
  abbr: string;
  name: string;        // "Duke"
  record: string;      // "2-0"
  points: number;
  firstPlace: number;
}

/** GET /api/schedule: both teams of the current game, each with what's next and what just happened. */
export interface ScheduleView {
  league: League;
  sides: Array<{ team: TeamRef & { tz: string; tzLabel: string; record: string }; upcoming: SchedGame[]; recent: SchedGame[] }>;
  updated: number;
}

export interface TeamDay {
  team: TeamRef & {
    color: string;
    alt: string;
    record: string;      // "3-1", '' before the season
    /** "4th in Western Conference" (computed from the table), '' when unknown. */
    standing: string;
    streak: string;
    /** IANA zone of the team's market; times on a team thread read in it. */
    tz: string;
    tzLabel: string;     // "CT"
  };
  /** The team's game on this megathread's date, from the slate (null on an off day); always quiet. */
  game: SlateCard | null;
  /** The real phase of that game, for the lock and the card's footer; never its score or clock. */
  gamePhase: '' | 'pre' | 'in' | 'post' | 'postponed';
  /** Today's opponent, full names (the slate only carries short ones). */
  opp: TeamRef | null;
  /** The next game after today's (or the next game at all on an off day). */
  next: SchedGame | null;
  /** Preview for today's game before tipoff, else for the next game. */
  preview: TeamPreview | null;
  /** Up to five games after today, soonest first. */
  upcoming: SchedGame[];
  /** Up to five finished games, newest first. */
  recent: SchedGame[];
  conference: StandingGroup | null;
  /** True when every team in the table is 0-0 (preseason): the client says so instead of showing zeros. */
  standingsEmpty: boolean;
  /** Off days only, when the sub keeps the wiki pages: the day's featured article and history event. */
  extras?: OffdayExtras;
  /** Off days only: the team's season in numbers (teamstats.ts); null when every feed failed. */
  profile?: TeamProfile | null;
}

/** One Wikipedia article from the sub's featured-article wiki page. */
export interface OffdayArticle {
  title: string;
  url: string;
  blurb: string;
  /** The '## ' heading it sits under on the page ('' when none). */
  section: string;
}
export interface OffdayVideo {
  /** Footage of the game itself, or related context (a series retrospective, a playlist). */
  kind: 'game' | 'related';
  label: string;
  url: string;
  by: string;
}
/** One event from the sub's this-day-in-history wiki page. */
export interface OffdayEvent {
  date: string;        // YYYY-MM-DD
  /** Box score (Basketball Reference). */
  url: string;
  text: string;
  videos: OffdayVideo[];
  section: string;
  /** The page's "Search YouTube" link, for an event with no footage of its own. */
  search?: string;
}
/** A season leader for one category: "PTS 24.2, D. Avdija". */
export interface TeamLeader {
  key: string;        // PTS, REB, AST, STL, BLK, 3PM
  value: string;      // "24.2"
  id: string;
  name: string;       // "D. Avdija"
  pos: string;
  jersey: string;
  headshot: string;
}
/** One season team stat with its league rank where ESPN gives one. */
export interface TeamStat {
  key: string;        // PPG, APG, RPG, FG%, 3P%, FT%, SPG, BPG, TOPG
  label: string;      // "Points"
  value: string;      // "115.5"
  rank: number;       // 0 when unranked
  rankText: string;   // "8th", "T-5th", ''
}
/** The team's season in numbers, for the off-day daily discussion. */
export interface TeamProfile {
  at: number;
  season: string;     // "2026-27"
  record: {
    overall: string; home: string; road: string;
    /** College: the conference record; '' elsewhere. */
    conference: string;
    streak: string; gamesBehind: number; seed: number;
    ppg: number; oppPpg: number;
    /** ESPN's "3rd in Northwest Division" / "1st in ACC"; '' when unknown. */
    standing: string;
  } | null;
  leaders: TeamLeader[];
  stats: TeamStat[];
  /**
   * What the ranks are out of: the whole league (NBA, WNBA) or the school's conference (college,
   * where ranking 360 schools would take 360 fetches), and how many teams were ranked. 0 when the
   * stats carry no ranks.
   */
  rankOf?: number;
  rankScope?: 'league' | 'conference';
  /** The conference's short name when rankScope is 'conference' ("ACC"). */
  rankGroup?: string;
}

export interface OffdayExtras {
  article: OffdayArticle | null;
  history: OffdayEvent | null;
  /** How the event was chosen: today's date, the nearest within a week, or a rotating pick from the whole list. */
  historyMode?: 'day' | 'week' | 'archive';
  /** The format of this record; older stored picks are made again. */
  v?: number;
}

// ── scorebug additions (not in nba-hub) ──────────────────────────────────
import type { Feeds, Stamp } from './types.ts';
/** The basketball GameView as the scorebug server serves it: nba-hub's view plus provenance. */
export interface BasketballGameView extends GameView {
  sport: 'basketball';
  stamps: { score: Stamp; clock: Stamp; period: Stamp; plays: Stamp };
  feeds: Feeds;
  mode: 'full' | 'floor' | 'held';
  built: number;
  /** A lower score waiting to be believed: when it first appeared and what it was ("" = none). */
  scoreDropSince: number;
  scoreDropTo: string;
}
