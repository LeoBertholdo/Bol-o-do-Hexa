// O ROBÔ — football-data.org + overlay ESPN para o live da Copa.
// Acorda de minuto em minuto (via cron), olha o calendário no banco,
// decide se vale chamar a API, e se vale, chama UMA vez por competição
// num intervalo de 2 dias (cobre todos os jogos do dia da competição).
// Resultado vai pra live_scores.
//
// Endpoint usado: GET /v4/competitions/{id}/matches?dateFrom=X&dateTo=Y
// 1 chamada devolve TODOS os jogos da competição no intervalo (até ~10 numa rodada).
//
// Limite football-data free: 10 requests/minuto (sem teto diário).
// Cadência muito mais folgada que api-football.
//
// ESPN (scoreboard público, sem chave): o free tier da football-data atrasa
// minutos para refletir gol. Enquanto o jogo da Copa está em andamento, o
// placar/minuto/status vêm da ESPN (quase tempo real). O fechamento oficial
// do jogo (status final + gravação em `results`) continua EXCLUSIVO da
// football-data — a ESPN nunca grava resultado oficial.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const FD_BASE_URL = "https://api.football-data.org/v4";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bolao-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// Status em jogo (continuamos chamando rápido)
const LIVE_STATUSES = new Set(["IN_PLAY", "PAUSED", "LIVE"]);
const INTERNAL_LIVE_STATUSES = new Set(["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "IN_PLAY", "PAUSED"]);
// Status finalizado (ainda conferimos por uma janela curta para pegar correções da API)
const FINAL_STATUSES = new Set(["FINISHED", "AWARDED", "FT", "AET", "PEN", "AWD"]);

const CADENCE_NORMAL_SECONDS = 55;     // cron roda a cada minuto; 55s evita pular uma rodada por poucos segundos
const CADENCE_LATE_SECONDS = 45;       // 45s nos minutos finais
const CADENCE_FINAL_CORRECTION_SECONDS = 300; // depois do FT, confere mais devagar caso a API corrija placar
const CADENCE_STALE_UNFINISHED_SECONDS = 600; // se a API atrasar o FT, continua tentando sem gastar chamada por minuto
const CADENCE_DEEP_STALE_UNFINISHED_SECONDS = 1800;
const POLL_MATCH_DETAILS = true;       // usa /matches/{id} perto do jogo para reduzir atraso do endpoint agregado
const MAX_DETAIL_CALLS_PER_RUN = 8;    // 1 chamada da competição + até 8 detalhes fica dentro do free tier de 10/min
const MAX_MATCH_DETAIL_CALLS_PER_RUN = 8;
const POLL_FINAL_MATCH_DETAILS = true; // para jogo finalizado, usa /matches/{id} como fonte mais precisa de correção
const MAX_FINAL_MATCH_DETAIL_CALLS_PER_RUN = 8;
const LATE_GAME_FROM_MINUTE = 80;
const SECOND_HALF_FALLBACK_FROM_KICKOFF_MIN = 60;
const PRE_KICKOFF_WINDOW_MIN = 5;
const POST_KICKOFF_GIVEUP_MIN = 36 * 60;
const POST_FINAL_CORRECTION_WINDOW_MIN = 48 * 60;

const COPA_INTERNAL_GAME_ID_RE = /^(G[A-L]\d+|R32_\d{2}|R16_\d{2}|QF_\d{2}|SF_\d{2}|P3|FINAL)$/i;

const COPA_TEAM_ALIASES: Record<string, string> = {
  mexico: "México",
  southafrica: "África do Sul",
  korearepublic: "Coreia do Sul",
  southkorea: "Coreia do Sul",
  czechia: "Rep. Tcheca",
  czechrepublic: "Rep. Tcheca",
  canada: "Canadá",
  bosniaherzegovina: "Bósnia-Herzegovina",
  bosniaandherzegovina: "Bósnia-Herzegovina",
  qatar: "Catar",
  switzerland: "Suíça",
  brazil: "Brasil",
  morocco: "Marrocos",
  haiti: "Haiti",
  scotland: "Escócia",
  usa: "EUA",
  unitedstates: "EUA",
  unitedstatesofamerica: "EUA",
  paraguay: "Paraguai",
  australia: "Austrália",
  turkiye: "Turquia",
  turkey: "Turquia",
  germany: "Alemanha",
  curacao: "Curaçau",
  cotedivoire: "Costa do Marfim",
  ivorycoast: "Costa do Marfim",
  ecuador: "Equador",
  netherlands: "Holanda",
  japan: "Japão",
  sweden: "Suécia",
  tunisia: "Tunísia",
  belgium: "Bélgica",
  egypt: "Egito",
  iran: "Irã",
  newzealand: "Nova Zelândia",
  spain: "Espanha",
  caboverde: "Cabo Verde",
  capeverde: "Cabo Verde",
  capeverdeislands: "Cabo Verde",
  saudiarabia: "Arábia Saudita",
  uruguay: "Uruguai",
  france: "França",
  senegal: "Senegal",
  iraq: "Iraque",
  norway: "Noruega",
  argentina: "Argentina",
  algeria: "Argélia",
  austria: "Áustria",
  jordan: "Jordânia",
  portugal: "Portugal",
  drcongo: "Rep. D. do Congo",
  congodr: "Rep. D. do Congo",
  congodemocraticrepublic: "Rep. D. do Congo",
  democraticrepublicofthecongo: "Rep. D. do Congo",
  uzbekistan: "Uzbequistão",
  colombia: "Colômbia",
  england: "Inglaterra",
  croatia: "Croácia",
  ghana: "Gana",
  panama: "Panamá"
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
  });
}

// football-data status → o que a gente usa no banco
function mapStatus(fdStatus: string, minute: number | null, context: { isSecondHalf?: boolean } = {}): string {
  switch (fdStatus) {
    case "SCHEDULED":
    case "TIMED": return "NS";
    case "IN_PLAY":
    case "LIVE":
      return context.isSecondHalf || (minute ?? 0) > 45 ? "2H" : "1H";
    case "PAUSED": return "HT";
    case "FINISHED": return "FT";
    case "AWARDED": return "AWD";
    case "POSTPONED": return "PST";
    case "SUSPENDED": return "SUSP";
    case "CANCELLED": return "CANC";
    default: return fdStatus;
  }
}

function scoreSide(node: any, side: "home" | "away"): number | null {
  const legacyKey = side === "home" ? "homeTeam" : "awayTeam";
  return numberOrNull(node?.[side] ?? node?.[legacyKey]);
}

function scorePair(node: any): { home: number | null; away: number | null } {
  return {
    home: scoreSide(node, "home"),
    away: scoreSide(node, "away")
  };
}

function emptyScorePair(): { home: null; away: null } {
  return { home: null, away: null };
}

function latestGoalScorePair(match: any): { home: number | null; away: number | null } {
  if (!Array.isArray(match?.goals)) return emptyScorePair();
  for (let i = match.goals.length - 1; i >= 0; i -= 1) {
    const pair = scorePair(match.goals[i]?.score);
    if (hasCompleteScorePair(pair)) return pair;
  }
  return emptyScorePair();
}

function bestScorePair(match: any, node: any): { home: number | null; away: number | null } {
  const direct = scorePair(node);
  if (hasCompleteScorePair(direct)) return direct;
  const goals = latestGoalScorePair(match);
  return hasCompleteScorePair(goals) ? goals : direct;
}

function hasNonZeroScore(pair: { home: number | null; away: number | null }): boolean {
  return (pair.home ?? 0) > 0 || (pair.away ?? 0) > 0;
}

function isDrawScore(pair: { home: number | null; away: number | null }): boolean {
  return pair.home != null && pair.away != null && pair.home === pair.away;
}

function hasCompleteScorePair(pair: { home: number | null; away: number | null }): boolean {
  return pair.home != null && pair.away != null;
}

function scoreIncreasedAfterHalfTime(match: any): boolean {
  const fullTime = scorePair(match?.score?.fullTime);
  const halfTime = scorePair(match?.score?.halfTime);
  return (
    (fullTime.home != null && halfTime.home != null && fullTime.home > halfTime.home) ||
    (fullTime.away != null && halfTime.away != null && fullTime.away > halfTime.away)
  );
}

function isSecondHalfSignal(match: any, live: any, minute: number | null, minutesAfterKickoff: number | null): boolean {
  if (minute != null && minute > 45) return true;
  if (["HT", "2H"].includes(String(live?.status_short || ""))) return true;
  const previousElapsed = numberOrNull(live?.elapsed);
  if (previousElapsed != null && previousElapsed > 45) return true;
  if (minutesAfterKickoff != null && minutesAfterKickoff >= SECOND_HALF_FALLBACK_FROM_KICKOFF_MIN) return true;
  return scoreIncreasedAfterHalfTime(match);
}

function isCopaKnockoutGame(tournament: unknown, gameId: unknown): boolean {
  if (String(tournament || "") !== "copa") return false;
  return !/^G[A-L]\d+$/i.test(String(gameId || ""));
}

function stabilizeLiveNumber(incoming: number | null, previous: unknown, shouldStabilize: boolean): number | null {
  if (!shouldStabilize) return incoming;
  const prev = numberOrNull(previous);
  if (incoming == null) return prev;
  return incoming;
}

function officialNumber(incoming: number | null, previous: unknown, isFinalStatus: boolean): number | null {
  if (!isFinalStatus || incoming != null) return incoming;
  return numberOrNull(previous);
}

function officialScorePair(
  incoming: { home: number | null; away: number | null },
  previous: { home: unknown; away: unknown },
  isFinalStatus: boolean
): { home: number | null; away: number | null } {
  return {
    home: officialNumber(incoming.home, previous.home, isFinalStatus),
    away: officialNumber(incoming.away, previous.away, isFinalStatus)
  };
}

function stabilizeLiveScorePair(
  incoming: { home: number | null; away: number | null },
  previous: { home: unknown; away: unknown },
  shouldStabilize: boolean
): { home: number | null; away: number | null } {
  return {
    home: stabilizeLiveNumber(incoming.home, previous.home, shouldStabilize),
    away: stabilizeLiveNumber(incoming.away, previous.away, shouldStabilize)
  };
}

function afterExtraScore(regular: number | null, extra: number | null, full: number | null, hasPenalties: boolean): number | null {
  if (regular != null && extra != null) return regular + extra;
  return hasPenalties ? null : full;
}

// Detecta se o resultado teve prorrogação ou pênaltis.
// Campos 0x0 de extraTime/penalties podem aparecer como placeholder antes da hora,
// então só aceitamos 0x0 de prorrogação com contexto forte de mata-mata finalizado.
function detectDecision(score: any, context: { isFinalStatus: boolean; isKnockout: boolean }): { aet: boolean; pen: boolean } {
  const duration = String(score?.duration || "").toUpperCase();
  const fullTime = scorePair(score?.fullTime);
  const regular = scorePair(score?.regularTime);
  const extra = scorePair(score?.extraTime);
  const penalties = scorePair(score?.penalties);
  const durationHasAet = duration === "EXTRA_TIME" || duration === "PENALTY_SHOOTOUT";
  const durationHasPen = duration === "PENALTY_SHOOTOUT";
  const finalKnockoutDrawWithExtra =
    context.isFinalStatus &&
    context.isKnockout &&
    hasCompleteScorePair(extra) &&
    isDrawScore(fullTime) &&
    (isDrawScore(regular) || regular.home == null || regular.away == null);
  return {
    aet: durationHasAet || hasNonZeroScore(extra) || finalKnockoutDrawWithExtra,
    pen: durationHasPen || hasNonZeroScore(penalties)
  };
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTeamName(name: unknown): string {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function canonicalCopaTeamName(name: unknown): string {
  const normalized = normalizeTeamName(name);
  return COPA_TEAM_ALIASES[normalized] || String(name || "");
}

function matchTeamName(match: any, side: "home" | "away"): string {
  const team = side === "home" ? match?.homeTeam : match?.awayTeam;
  return canonicalCopaTeamName(team?.name || team?.shortName || team?.tla || "");
}

function winningSide(pair: { home: number | null; away: number | null }): "home" | "away" | null {
  if (pair.home == null || pair.away == null || pair.home === pair.away) return null;
  return pair.home > pair.away ? "home" : "away";
}

function isInternalCopaGameId(gameId: unknown): boolean {
  return COPA_INTERNAL_GAME_ID_RE.test(String(gameId || ""));
}

function isPlaceholderTeamName(name: unknown): boolean {
  const normalized = normalizeTeamName(name);
  if (!normalized) return true;
  return [
    "tbd",
    "tba",
    "adefinir",
    "tobeconfirmed",
    "tobedetermined",
    "tobedecided",
    "winner",
    "winnermatch",
    "vencedor",
    "loser",
    "perdedor",
    "qualifiedteam"
  ].some(token => normalized.includes(token));
}

function resolveScoreOrientation(
  match: any,
  bolaoHome: unknown,
  bolaoAway: unknown
): "same" | "reversed" | "unknown" {
  const home = normalizeTeamName(matchTeamName(match, "home"));
  const away = normalizeTeamName(matchTeamName(match, "away"));
  const expectedHome = normalizeTeamName(bolaoHome);
  const expectedAway = normalizeTeamName(bolaoAway);
  if (!home || !away || !expectedHome || !expectedAway || isPlaceholderTeamName(bolaoHome) || isPlaceholderTeamName(bolaoAway)) return "same";
  if (home === expectedHome && away === expectedAway) return "same";
  if (home === expectedAway && away === expectedHome) return "reversed";
  return "unknown";
}

function orientScorePair(
  pair: { home: number | null; away: number | null },
  orientation: "same" | "reversed" | "unknown"
): { home: number | null; away: number | null } {
  return orientation === "reversed" ? { home: pair.away, away: pair.home } : pair;
}

function orientCards(
  cards: ReturnType<typeof extractCardCounts>,
  orientation: "same" | "reversed" | "unknown"
): ReturnType<typeof extractCardCounts> {
  if (orientation !== "reversed") return cards;
  return {
    yellowHome: cards.yellowAway,
    yellowAway: cards.yellowHome,
    yellowRedHome: cards.yellowRedAway,
    yellowRedAway: cards.yellowRedHome,
    redHome: cards.redAway,
    redAway: cards.redHome,
    cornersHome: cards.cornersAway,
    cornersAway: cards.cornersHome
  };
}

function orientPenaltyShootout(
  events: Array<{ side: "home" | "away"; scored: boolean }> | null,
  orientation: "same" | "reversed" | "unknown"
): Array<{ side: "home" | "away"; scored: boolean }> | null {
  if (orientation !== "reversed" || !events?.length) return events;
  return events.map(event => ({
    ...event,
    side: event.side === "home" ? "away" : "home"
  }));
}

function orientedWinnerName(
  match: any,
  winnerSide: "home" | "away",
  bolaoHome: unknown,
  bolaoAway: unknown,
  orientation: "same" | "reversed" | "unknown"
): string {
  const expected = winnerSide === "home" ? canonicalCopaTeamName(bolaoHome) : canonicalCopaTeamName(bolaoAway);
  if (!isPlaceholderTeamName(expected)) return expected;
  if (orientation === "reversed") {
    return matchTeamName(match, winnerSide === "home" ? "away" : "home");
  }
  return matchTeamName(match, winnerSide);
}

function bookingSide(match: any, booking: any): "home" | "away" | null {
  const team = booking?.team || {};
  if (team.id != null) {
    if (String(team.id) === String(match?.homeTeam?.id)) return "home";
    if (String(team.id) === String(match?.awayTeam?.id)) return "away";
  }
  const name = normalizeTeamName(team.name);
  if (!name) return null;
  if (name === normalizeTeamName(match?.homeTeam?.name) || name === normalizeTeamName(match?.homeTeam?.shortName)) return "home";
  if (name === normalizeTeamName(match?.awayTeam?.name) || name === normalizeTeamName(match?.awayTeam?.shortName)) return "away";
  return null;
}

function extractPenaltyShootout(match: any): Array<{ side: "home" | "away"; scored: boolean }> | null {
  if (!Array.isArray(match?.penalties)) return null;
  const rows = match.penalties.map((penalty: any) => {
    const side = bookingSide(match, penalty);
    return side ? { side, scored: !!penalty?.scored } : null;
  }).filter(Boolean);
  return rows.length ? (rows as Array<{ side: "home" | "away"; scored: boolean }>) : null;
}

function normalizeMatchDetail(data: any): any {
  return data?.match || data;
}

function extractCardCounts(match: any): {
  yellowHome: number | null;
  yellowAway: number | null;
  yellowRedHome: number | null;
  yellowRedAway: number | null;
  redHome: number | null;
  redAway: number | null;
  cornersHome: number | null;
  cornersAway: number | null;
} {
  const homeStats = match?.homeTeam?.statistics;
  const awayStats = match?.awayTeam?.statistics;
  if (homeStats || awayStats) {
    const homeYellow = numberOrNull(homeStats?.yellow_cards);
    const awayYellow = numberOrNull(awayStats?.yellow_cards);
    const homeRed = numberOrNull(homeStats?.red_cards);
    const awayRed = numberOrNull(awayStats?.red_cards);
    const homeYellowRed = numberOrNull(homeStats?.yellow_red_cards);
    const awayYellowRed = numberOrNull(awayStats?.yellow_red_cards);
    return {
      yellowHome: homeYellow,
      yellowAway: awayYellow,
      yellowRedHome: homeYellowRed,
      yellowRedAway: awayYellowRed,
      redHome: homeRed,
      redAway: awayRed,
      cornersHome: numberOrNull(homeStats?.corner_kicks),
      cornersAway: numberOrNull(awayStats?.corner_kicks)
    };
  }

  if (!Array.isArray(match?.bookings)) {
    return { yellowHome: null, yellowAway: null, yellowRedHome: null, yellowRedAway: null, redHome: null, redAway: null, cornersHome: null, cornersAway: null };
  }

  const counts = { yellowHome: 0, yellowAway: 0, yellowRedHome: 0, yellowRedAway: 0, redHome: 0, redAway: 0, cornersHome: null, cornersAway: null };
  let found = false;
  for (const booking of match.bookings) {
    const side = bookingSide(match, booking);
    if (!side) continue;
    const card = String(booking.card || "").toUpperCase();
    found = true;
    if ((card.includes("YELLOW") && card.includes("RED")) || card.includes("SECOND_YELLOW") || card.includes("2ND_YELLOW")) {
      if (side === "home") counts.yellowRedHome += 1;
      else counts.yellowRedAway += 1;
    } else if (card.includes("RED")) {
      if (side === "home") counts.redHome += 1;
      else counts.redAway += 1;
    } else if (card.includes("YELLOW")) {
      if (side === "home") counts.yellowHome += 1;
      else counts.yellowAway += 1;
    }
  }

  return found ? counts : { yellowHome: null, yellowAway: null, yellowRedHome: null, yellowRedAway: null, redHome: null, redAway: null, cornersHome: null, cornersAway: null };
}

function hasCardCounts(cards: ReturnType<typeof extractCardCounts>): boolean {
  return [
    cards.yellowHome,
    cards.yellowAway,
    cards.yellowRedHome,
    cards.yellowRedAway,
    cards.redHome,
    cards.redAway
  ].some(v => v != null);
}

function toIsoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function footballDataHeaders(token: string): Record<string, string> {
  return {
    "X-Auth-Token": token,
    "X-Unfold-Goals": "true"
  };
}

// ─── ESPN: fonte live não-oficial da Copa (sem chave, quase tempo real) ────
const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

// Status em que o placar corrente ainda é o do tempo regulamentar.
const ESPN_REGULAR_TIME_STATUSES = new Set(["1H", "HT", "2H", "LIVE", "FT"]);

type EspnEvent = {
  state: string;
  statusName: string;
  period: number | null;
  minute: number | null;
  homeName: string;
  awayName: string;
  homeScore: number | null;
  awayScore: number | null;
};

function parseEspnScoreboard(data: any): EspnEvent[] {
  const events = Array.isArray(data?.events) ? data.events : [];
  const out: EspnEvent[] = [];
  for (const ev of events) {
    const comp = ev?.competitions?.[0];
    const st = comp?.status || ev?.status || {};
    const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
    const home = competitors.find((c: any) => c?.homeAway === "home");
    const away = competitors.find((c: any) => c?.homeAway === "away");
    if (!home || !away) continue;
    const clock = parseInt(String(st?.displayClock || ""), 10);
    out.push({
      state: String(st?.type?.state || ""),
      statusName: String(st?.type?.name || ""),
      period: numberOrNull(st?.period),
      minute: Number.isFinite(clock) ? clock : null,
      homeName: String(home?.team?.displayName || home?.team?.name || ""),
      awayName: String(away?.team?.displayName || away?.team?.name || ""),
      homeScore: numberOrNull(home?.score),
      awayScore: numberOrNull(away?.score)
    });
  }
  return out;
}

// Casa o evento ESPN com o jogo do bolão pelos nomes canônicos das seleções.
// Sem casamento → sem overlay (o jogo segue 100% na football-data).
function findEspnEvent(
  events: EspnEvent[],
  bolaoHome: unknown,
  bolaoAway: unknown
): { event: EspnEvent; reversed: boolean } | null {
  if (isPlaceholderTeamName(bolaoHome) || isPlaceholderTeamName(bolaoAway)) return null;
  const home = normalizeTeamName(canonicalCopaTeamName(bolaoHome));
  const away = normalizeTeamName(canonicalCopaTeamName(bolaoAway));
  if (!home || !away) return null;
  for (const event of events) {
    const eventHome = normalizeTeamName(canonicalCopaTeamName(event.homeName));
    const eventAway = normalizeTeamName(canonicalCopaTeamName(event.awayName));
    if (eventHome === home && eventAway === away) return { event, reversed: false };
    if (eventHome === away && eventAway === home) return { event, reversed: true };
  }
  return null;
}

// ESPN status → vocabulário interno. "pre" devolve null (não sobrescreve nada).
function espnStatusShort(event: EspnEvent): string | null {
  const name = event.statusName.toUpperCase();
  if (event.state === "pre") return null;
  if (name.includes("HALFTIME")) return "HT";
  if (name.includes("SHOOTOUT")) return "P";
  if (event.state === "post") {
    if (name.includes("PEN")) return "PEN";
    if ((event.period ?? 0) > 2 || name.includes("OVERTIME") || name.includes("EXTRA")) return "AET";
    return "FT";
  }
  if (name.includes("OVERTIME") || name.includes("EXTRA") || (event.period ?? 0) > 2) return "ET";
  if (event.period === 1) return "1H";
  if ((event.period ?? 0) >= 2) return "2H";
  if (event.minute != null) return event.minute > 45 ? "2H" : "1H";
  return "LIVE";
}

function espnOrientedScore(event: EspnEvent, reversed: boolean): { home: number | null; away: number | null } {
  return reversed
    ? { home: event.awayScore, away: event.homeScore }
    : { home: event.homeScore, away: event.awayScore };
}

// Se a chamada da football-data falhar, a ESPN segura o live sozinha nessa
// rodada (só live_scores + histórico; nunca grava em `results`).
async function espnFallbackUpsert(
  supa: any,
  group: any[],
  liveByGame: Map<string, any>,
  espnEvents: EspnEvent[] | null,
  errors: string[]
): Promise<number> {
  if (!espnEvents?.length) return 0;
  const nowIso = new Date().toISOString();
  const upserts: any[] = [];
  const historyRows: any[] = [];
  for (const candidate of group) {
    if (candidate.tournament !== "copa") continue;
    const live = liveByGame.get(candidate.gameId) || {};
    if (live.is_locked_by_admin) continue;
    if (FINAL_STATUSES.has(live.status_short || "")) continue;
    const found = findEspnEvent(espnEvents, candidate.bolaoHome, candidate.bolaoAway);
    if (!found) continue;
    const status = espnStatusShort(found.event);
    const score = espnOrientedScore(found.event, found.reversed);
    if (!status || score.home == null || score.away == null) continue;
    const row: any = {
      game_id: candidate.gameId,
      status_short: status,
      status_long: `ESPN ${found.event.statusName}`,
      elapsed: found.event.state === "in" && found.event.minute != null ? found.event.minute : (live.elapsed ?? null),
      goals_home: score.home,
      goals_away: score.away,
      last_synced_at: nowIso
    };
    if (ESPN_REGULAR_TIME_STATUSES.has(status)) {
      row.regular_goals_home = score.home;
      row.regular_goals_away = score.away;
    }
    upserts.push(row);
    const prevGoalsHome = numberOrNull(live.goals_home);
    const prevGoalsAway = numberOrNull(live.goals_away);
    if (prevGoalsHome !== score.home || prevGoalsAway !== score.away) {
      historyRows.push({
        game_id: candidate.gameId,
        status_short: status,
        elapsed: row.elapsed,
        goals_home: score.home,
        goals_away: score.away,
        recorded_at: nowIso,
        source: "robot"
      });
    }
  }
  if (!upserts.length) return 0;
  const { error: upErr, count } = await supa
    .from("live_scores")
    .upsert(upserts, { onConflict: "game_id", count: "exact" });
  if (upErr) {
    errors.push(`espn fallback: ${upErr.message}`);
    return 0;
  }
  if (historyRows.length) {
    const { error: histErr } = await supa.from("live_score_history").insert(historyRows);
    if (histErr) errors.push(`espn fallback history: ${histErr.message}`);
  }
  return count ?? upserts.length;
}

function buildCopaResultRow(
  row: any,
  match: any,
  context: {
    bolaoHome?: string | null;
    bolaoAway?: string | null;
    scoreOrientation: "same" | "reversed" | "unknown";
  }
): { row?: any; error?: string } {
  if (!isInternalCopaGameId(row?.game_id)) return {};
  if (!FINAL_STATUSES.has(row?.status_short || "")) return {};

  const isKnockout = isCopaKnockoutGame("copa", row.game_id);
  const baseHome = isKnockout && ["AET", "PEN"].includes(row.status_short)
    ? numberOrNull(row.regular_goals_home)
    : numberOrNull(row.goals_home);
  const baseAway = isKnockout && ["AET", "PEN"].includes(row.status_short)
    ? numberOrNull(row.regular_goals_away)
    : numberOrNull(row.goals_away);

  if (baseHome == null || baseAway == null) {
    return { error: `${row.game_id}: placar final sem gols suficientes para gravar em results.` };
  }

  const result: any = {
    game_id: row.game_id,
    s1: baseHome,
    s2: baseAway,
    yellow_cards_home: row.yellow_cards_home ?? null,
    yellow_cards_away: row.yellow_cards_away ?? null,
    yellow_red_cards_home: row.yellow_red_cards_home ?? null,
    yellow_red_cards_away: row.yellow_red_cards_away ?? null,
    red_cards_home: row.red_cards_home ?? null,
    red_cards_away: row.red_cards_away ?? null,
    updated_by: null
  };

  if (!isKnockout) return { row: result };

  const afterExtra = {
    home: numberOrNull(row.after_extra_goals_home),
    away: numberOrNull(row.after_extra_goals_away)
  };
  const penalties = {
    home: numberOrNull(row.pens_home),
    away: numberOrNull(row.pens_away)
  };

  if (hasCompleteScorePair(afterExtra)) {
    result.after_et_s1 = afterExtra.home;
    result.after_et_s2 = afterExtra.away;
  }
  if (hasCompleteScorePair(penalties)) {
    result.pens_s1 = penalties.home;
    result.pens_s2 = penalties.away;
  }
  if (Array.isArray(row.penalty_shootout) && row.penalty_shootout.length) {
    result.penalty_shootout = row.penalty_shootout;
  }

  if (baseHome !== baseAway) return { row: result };

  const winnerByPens = winningSide(penalties);
  const winnerByExtra = winningSide(afterExtra);
  const winnerSide = winnerByPens || winnerByExtra || winningSide({
    home: numberOrNull(row.goals_home),
    away: numberOrNull(row.goals_away)
  });
  if (!winnerSide) {
    return { error: `${row.game_id}: mata-mata empatado sem vencedor vindo da API.` };
  }

  const winnerName = orientedWinnerName(
    match,
    winnerSide,
    context.bolaoHome,
    context.bolaoAway,
    context.scoreOrientation
  );
  if (!winnerName) {
    return { error: `${row.game_id}: vencedor sem nome de seleção na API.` };
  }

  result.ko_winner = winnerName;
  result.ko_decision = (winnerByPens || row.status_short === "PEN") ? "penalties" : "extra_time";
  return { row: result };
}

async function upsertCopaResultsFromLive(
  supa: any,
  resultRows: any[]
): Promise<{ written: number; skippedManual: number; errors: string[] }> {
  const errors: string[] = [];
  if (!resultRows.length) return { written: 0, skippedManual: 0, errors };

  const ids = resultRows.map(row => row.game_id);
  const { data: existing, error: existingErr } = await supa
    .from("results")
    .select("game_id, updated_by")
    .in("game_id", ids);
  if (existingErr) {
    return { written: 0, skippedManual: 0, errors: [`results lookup: ${existingErr.message}`] };
  }

  const manualIds = new Set((existing || [])
    .filter((row: any) => row.updated_by)
    .map((row: any) => row.game_id));
  const writable = resultRows.filter(row => !manualIds.has(row.game_id));
  if (!writable.length) {
    return { written: 0, skippedManual: resultRows.length, errors };
  }

  const { error: upErr, count } = await supa
    .from("results")
    .upsert(writable, { onConflict: "game_id", count: "exact" });
  if (upErr) {
    return { written: 0, skippedManual: resultRows.length - writable.length, errors: [`results upsert: ${upErr.message}`] };
  }

  return {
    written: count ?? writable.length,
    skippedManual: resultRows.length - writable.length,
    errors
  };
}

function getSupabaseAdminKey(): string | null {
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyKey) return legacyKey;

  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!secretKeys) return null;

  try {
    const parsed = JSON.parse(secretKeys) as Record<string, string>;
    return parsed.default || Object.values(parsed)[0] || null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return json(405, { error: "Use POST." });

  const cronSecret = Deno.env.get("BOLAO_CRON_SECRET");
  if (!cronSecret) return json(500, { error: "BOLAO_CRON_SECRET não configurado." });

  const token = Deno.env.get("FOOTBALL_DATA_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = getSupabaseAdminKey();
  if (!token) return json(500, { error: "FOOTBALL_DATA_TOKEN não configurada." });
  if (!supabaseUrl || !serviceKey) return json(500, { error: "SUPABASE env vars ausentes." });

  // Autorização: ou o cron (secret no header), ou um admin do bolão logado.
  const isTrustedBackendCall = req.headers.get("x-bolao-cron-secret") === cronSecret;
  if (!isTrustedBackendCall) {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json(401, { error: "Não autorizado." });
    }
    const anonKey = Deno.env.get("BOLAO_PUBLISHABLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    if (!anonKey) return json(500, { error: "BOLAO_PUBLISHABLE_KEY ausente nos secrets." });
    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } }
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json(401, { error: "Sessão inválida ou expirada." });
    }
    const { data: profile, error: profErr } = await userClient
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profErr) return json(500, { error: "Falha lendo perfil.", detail: profErr.message });
    if (profile?.role !== "admin") {
      return json(403, { error: "Só o administrador do bolão pode acionar o robô manualmente." });
    }
  }

  const supa = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const now = Date.now();

  // 1. Lê o mapa
  const { data: mapRows, error: mapErr } = await supa
    .from("api_fixture_map")
    .select("game_id, api_fixture_id, tournament, league_id, kickoff_utc, home_team, away_team");
  if (mapErr) return json(500, { error: "Falha lendo api_fixture_map.", detail: mapErr.message });
  if (!mapRows?.length) return json(200, { skipped: "sem_jogos_mapeados" });

  // 2. Lê estado conhecido
  const { data: liveRows } = await supa
    .from("live_scores")
    .select("game_id, status_short, status_long, elapsed, goals_home, goals_away, regular_goals_home, regular_goals_away, extra_time_goals_home, extra_time_goals_away, after_extra_goals_home, after_extra_goals_away, pens_home, pens_away, last_synced_at, api_last_updated, is_locked_by_admin, yellow_cards_home, yellow_cards_away, yellow_red_cards_home, yellow_red_cards_away, red_cards_home, red_cards_away, corner_kicks_home, corner_kicks_away");
  const liveByGame = new Map((liveRows || []).map((r: any) => [r.game_id, r]));

  // 3. Filtra candidatos
  type Cand = {
    gameId: string;
    apiId: number;
    tournament: string;
    competitionId: number;
    bolaoHome: string | null;
    bolaoAway: string | null;
    cadenceSeconds: number;
    minutesSincePoll: number;
    minutesAfterKickoff: number;
  };
  const candidates: Cand[] = [];
  let skippedByCadence = 0;

  for (const row of mapRows) {
    const kickoff = new Date(row.kickoff_utc).getTime();
    const minutesUntilKickoff = (kickoff - now) / 60000;
    const minutesAfterKickoff = -minutesUntilKickoff;
    const live = liveByGame.get(row.game_id);
    const storedFinalStatus = FINAL_STATUSES.has(live?.status_short || "");

    if (live?.is_locked_by_admin) continue;
    if (minutesUntilKickoff > PRE_KICKOFF_WINDOW_MIN) continue;
    if (storedFinalStatus) {
      if (minutesAfterKickoff > POST_FINAL_CORRECTION_WINDOW_MIN) continue;
    } else if (minutesAfterKickoff > POST_KICKOFF_GIVEUP_MIN) {
      continue;
    }

    const cadenceSeconds = storedFinalStatus
      ? CADENCE_FINAL_CORRECTION_SECONDS
      : (minutesAfterKickoff > 12 * 60
        ? CADENCE_DEEP_STALE_UNFINISHED_SECONDS
        : (minutesAfterKickoff > 240
          ? CADENCE_STALE_UNFINISHED_SECONDS
          : ((live?.elapsed ?? 0) >= LATE_GAME_FROM_MINUTE
            ? CADENCE_LATE_SECONDS
            : CADENCE_NORMAL_SECONDS)));
    const minutesSincePoll = live?.last_synced_at
      ? (now - new Date(live.last_synced_at).getTime()) / 60000
      : Infinity;

    if (minutesSincePoll * 60 < cadenceSeconds) {
      skippedByCadence += 1;
      continue;
    }

    candidates.push({
      gameId: row.game_id,
      apiId: row.api_fixture_id,
      tournament: row.tournament,
      competitionId: row.league_id,
      bolaoHome: row.home_team || null,
      bolaoAway: row.away_team || null,
      cadenceSeconds,
      minutesSincePoll,
      minutesAfterKickoff
    });
  }

  if (!candidates.length) {
    return json(200, { skipped: "fora_da_janela", mapped: mapRows.length });
  }

  // 4. Agrupa por competição — 1 chamada por competição
  const byComp = new Map<number, Cand[]>();
  for (const c of candidates) {
    if (!byComp.has(c.competitionId)) byComp.set(c.competitionId, []);
    byComp.get(c.competitionId)!.push(c);
  }

  // Janela de datas pra a chamada (cobre overnight games)
  const dateFrom = toIsoDate(new Date(now - 86400000)); // ontem
  const dateTo = toIsoDate(new Date(now + 86400000));   // amanhã

  let totalUpdated = 0;
  let totalCopaResultsWritten = 0;
  let totalCopaResultsSkippedManual = 0;
  let totalCopaResultsHeldDivergence = 0;
  let lastRateMinute: string | null = null;
  let detailCalls = 0;
  let espnOverlays = 0;
  const calls: any[] = [];
  const errors: string[] = [];
  const fdHeaders = footballDataHeaders(token);

  // ESPN: 1 chamada por execução quando há jogo da Copa na janela.
  let espnEvents: EspnEvent[] | null = null;
  if (candidates.some(c => c.tournament === "copa")) {
    try {
      const espnResp = await fetch(ESPN_SCOREBOARD_URL);
      const espnData = await espnResp.json();
      if (espnResp.ok) espnEvents = parseEspnScoreboard(espnData);
      else errors.push(`espn: HTTP ${espnResp.status}`);
    } catch (e) {
      errors.push(`espn: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const [competitionId, group] of byComp) {
    const detailCallsBeforeCompetition = detailCalls;

    const url = new URL(`${FD_BASE_URL}/competitions/${competitionId}/matches`);
    url.searchParams.set("dateFrom", dateFrom);
    url.searchParams.set("dateTo", dateTo);

    let apiResp: Response;
    let apiData: any = null;
    try {
      apiResp = await fetch(url, { headers: fdHeaders });
      apiData = await apiResp.json();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`comp ${competitionId}: ${msg}`);
      await supa.from("api_sync_log").insert({
        endpoint: url.toString(),
        league_id: competitionId,
        ok: false,
        message: msg
      });
      totalUpdated += await espnFallbackUpsert(supa, group, liveByGame, espnEvents, errors);
      continue;
    }

    lastRateMinute = apiResp.headers.get("X-Requests-Available-Minute") || lastRateMinute;

    if (!apiResp.ok) {
      const msg = `HTTP ${apiResp.status} ${(apiData?.message || "").slice(0,200)}`;
      errors.push(`comp ${competitionId}: ${msg}`);
      await supa.from("api_sync_log").insert({
        endpoint: url.toString(),
        league_id: competitionId,
        requests_remaining_minute: lastRateMinute ? Number(lastRateMinute) : null,
        ok: false,
        message: msg
      });
      totalUpdated += await espnFallbackUpsert(supa, group, liveByGame, espnEvents, errors);
      continue;
    }

    const matches: any[] = Array.isArray(apiData?.matches) ? apiData.matches : [];
    const apiToCandidate = new Map(group.map(c => [c.apiId, c]));
    const upserts: any[] = [];
    const copaResultRows: any[] = [];
    const historyRows: any[] = [];

    for (const m of matches) {
      const candidate = apiToCandidate.get(m.id);
      if (!candidate) continue;
      const gameId = candidate.gameId;
      const live = liveByGame.get(gameId) || {};
      const storedFinalStatus = FINAL_STATUSES.has(live.status_short || "");
      let match = m;
      let detailMatch: any = null;
      const preliminaryMinute = numberOrNull(m.minute);
      const preliminaryStatus = mapStatus(m.status, preliminaryMinute, {
        isSecondHalf: isSecondHalfSignal(m, live, preliminaryMinute, candidate.minutesAfterKickoff)
      });
      const preliminaryFinalStatus = FINAL_STATUSES.has(preliminaryStatus);
      const shouldFetchFinalDetails =
        POLL_FINAL_MATCH_DETAILS &&
        (storedFinalStatus || preliminaryFinalStatus) &&
        detailCalls < MAX_FINAL_MATCH_DETAIL_CALLS_PER_RUN &&
        detailCalls < MAX_DETAIL_CALLS_PER_RUN;
      const shouldFetchLiveDetails =
        POLL_MATCH_DETAILS &&
        !shouldFetchFinalDetails &&
        detailCalls < MAX_MATCH_DETAIL_CALLS_PER_RUN &&
        detailCalls < MAX_DETAIL_CALLS_PER_RUN &&
        (
          candidate.minutesAfterKickoff >= 0 ||
          LIVE_STATUSES.has(m.status) ||
          INTERNAL_LIVE_STATUSES.has(preliminaryStatus) ||
          preliminaryFinalStatus
        );

      if (shouldFetchFinalDetails || shouldFetchLiveDetails) {
        const detailUrl = new URL(`${FD_BASE_URL}/matches/${m.id}`);
        try {
          const detailResp = await fetch(detailUrl, { headers: fdHeaders });
          lastRateMinute = detailResp.headers.get("X-Requests-Available-Minute") || lastRateMinute;
          detailCalls += 1;
          const detailData = await detailResp.json();
          if (detailResp.ok) {
            detailMatch = normalizeMatchDetail(detailData);
            if (detailMatch?.id != null) match = detailMatch;
          } else {
            errors.push(`match ${m.id}: HTTP ${detailResp.status} ${(detailData?.message || "").slice(0, 120)}`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`match ${m.id}: ${msg}`);
        }
      }

      const minute = numberOrNull(match.minute);
      const statusShort = mapStatus(match.status, minute, {
        isSecondHalf: isSecondHalfSignal(match, live, minute, candidate.minutesAfterKickoff)
      });
      const rawFinalStatus = FINAL_STATUSES.has(statusShort);
      const decision = detectDecision(match.score, {
        isFinalStatus: rawFinalStatus,
        isKnockout: isCopaKnockoutGame(candidate.tournament, gameId)
      });
      const finalStatus =
        statusShort === "FT" && decision.pen ? "PEN" :
        statusShort === "FT" && decision.aet ? "AET" :
        statusShort;
      const hadLiveStatus = INTERNAL_LIVE_STATUSES.has(live.status_short || "");
      const isFinalStatus = FINAL_STATUSES.has(finalStatus);
      const shouldStabilizeLiveScore = !isFinalStatus && (LIVE_STATUSES.has(match.status) || INTERNAL_LIVE_STATUSES.has(finalStatus) || hadLiveStatus);
      const shouldKeepPreviousStatus = shouldStabilizeLiveScore && hadLiveStatus && finalStatus === "NS";
      const storedStatus = shouldKeepPreviousStatus ? live.status_short : finalStatus;
      const storedStatusLong = shouldKeepPreviousStatus ? (live.status_long || match.status || null) : (match.status || null);
      const scoreOrientation = candidate.tournament === "copa"
        ? resolveScoreOrientation(match, candidate.bolaoHome, candidate.bolaoAway)
        : "same";
      let cardSource = detailMatch || match;
      let cards = extractCardCounts(cardSource);
      let penaltyShootout = extractPenaltyShootout(cardSource);
      const shouldFetchDetails =
        !detailMatch &&
        POLL_MATCH_DETAILS &&
        (!hasCardCounts(cards) || (decision.pen && !penaltyShootout)) &&
        (LIVE_STATUSES.has(match.status) || LIVE_STATUSES.has(finalStatus) || FINAL_STATUSES.has(finalStatus)) &&
        detailCalls < MAX_MATCH_DETAIL_CALLS_PER_RUN &&
        detailCalls < MAX_DETAIL_CALLS_PER_RUN;

      if (shouldFetchDetails) {
        const detailUrl = new URL(`${FD_BASE_URL}/matches/${m.id}`);
        try {
          const detailResp = await fetch(detailUrl, { headers: fdHeaders });
          lastRateMinute = detailResp.headers.get("X-Requests-Available-Minute") || lastRateMinute;
          detailCalls += 1;
          const detailData = await detailResp.json();
          if (detailResp.ok) {
            detailMatch = normalizeMatchDetail(detailData);
            cardSource = detailMatch;
            cards = extractCardCounts(cardSource);
            penaltyShootout = extractPenaltyShootout(cardSource) || penaltyShootout;
          } else {
            errors.push(`match ${m.id}: HTTP ${detailResp.status} ${(detailData?.message || "").slice(0, 120)}`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`match ${m.id}: ${msg}`);
        }
      }

      cards = orientCards(cards, scoreOrientation);
      penaltyShootout = orientPenaltyShootout(penaltyShootout, scoreOrientation);

      const fullTime = orientScorePair(bestScorePair(match, match.score?.fullTime), scoreOrientation);
      const regularTimeRaw = orientScorePair(scorePair(match.score?.regularTime), scoreOrientation);
      const extraTimeRaw = orientScorePair(scorePair(match.score?.extraTime), scoreOrientation);
      const penaltiesRaw = orientScorePair(scorePair(match.score?.penalties), scoreOrientation);
      const extraTime = decision.aet || decision.pen ? extraTimeRaw : emptyScorePair();
      const penalties = decision.pen ? penaltiesRaw : emptyScorePair();
      const incomingRegularTime = decision.aet || decision.pen ? regularTimeRaw : fullTime;
      const incomingFullTime = officialScorePair(fullTime, { home: live.goals_home, away: live.goals_away }, isFinalStatus);
      const incomingOfficialRegularTime = officialScorePair(
        incomingRegularTime,
        { home: live.regular_goals_home, away: live.regular_goals_away },
        isFinalStatus
      );
      const stableFullTime = stabilizeLiveScorePair(
        incomingFullTime,
        { home: live.goals_home, away: live.goals_away },
        shouldStabilizeLiveScore
      );
      const regularTime = stabilizeLiveScorePair(
        incomingOfficialRegularTime,
        { home: live.regular_goals_home, away: live.regular_goals_away },
        shouldStabilizeLiveScore
      );
      const afterExtra = {
        home: decision.aet || decision.pen ? afterExtraScore(regularTime.home, extraTime.home, stableFullTime.home, decision.pen) : null,
        away: decision.aet || decision.pen ? afterExtraScore(regularTime.away, extraTime.away, stableFullTime.away, decision.pen) : null
      };

      const liveRow = {
        game_id: gameId,
        api_fixture_id: m.id,
        status_short: storedStatus,
        status_long: storedStatusLong,
        elapsed: stabilizeLiveNumber(minute, live.elapsed, shouldStabilizeLiveScore),
        goals_home: stableFullTime.home,
        goals_away: stableFullTime.away,
        regular_goals_home: regularTime.home,
        regular_goals_away: regularTime.away,
        extra_time_goals_home: extraTime.home,
        extra_time_goals_away: extraTime.away,
        after_extra_goals_home: afterExtra.home,
        after_extra_goals_away: afterExtra.away,
        pens_home: penalties.home,
        pens_away: penalties.away,
        penalty_shootout: penaltyShootout,
        yellow_cards_home: cards.yellowHome ?? live.yellow_cards_home ?? null,
        yellow_cards_away: cards.yellowAway ?? live.yellow_cards_away ?? null,
        yellow_red_cards_home: cards.yellowRedHome ?? live.yellow_red_cards_home ?? null,
        yellow_red_cards_away: cards.yellowRedAway ?? live.yellow_red_cards_away ?? null,
        red_cards_home: cards.redHome ?? live.red_cards_home ?? null,
        red_cards_away: cards.redAway ?? live.red_cards_away ?? null,
        corner_kicks_home: cards.cornersHome ?? live.corner_kicks_home ?? null,
        corner_kicks_away: cards.cornersAway ?? live.corner_kicks_away ?? null,
        api_last_updated: match.lastUpdated || live.api_last_updated || null,
        last_synced_at: new Date().toISOString()
      };

      // Overlay ESPN: enquanto a football-data NÃO declarar o jogo final, o
      // placar/minuto/status ao vivo vêm da ESPN (quase tempo real). Quando a
      // football-data finalizar (isFinalStatus), ela reassume integralmente.
      if (candidate.tournament === "copa" && espnEvents?.length && !isFinalStatus) {
        const found = findEspnEvent(espnEvents, candidate.bolaoHome, candidate.bolaoAway);
        if (found) {
          const espnStatus = espnStatusShort(found.event);
          const espnScore = espnOrientedScore(found.event, found.reversed);
          if (espnStatus && espnScore.home != null && espnScore.away != null) {
            liveRow.goals_home = espnScore.home;
            liveRow.goals_away = espnScore.away;
            if (!decision.aet && !decision.pen && ESPN_REGULAR_TIME_STATUSES.has(espnStatus)) {
              liveRow.regular_goals_home = espnScore.home;
              liveRow.regular_goals_away = espnScore.away;
            }
            liveRow.status_short = espnStatus;
            liveRow.status_long = `ESPN ${found.event.statusName}`;
            if (found.event.state === "in" && found.event.minute != null) {
              liveRow.elapsed = found.event.minute;
            }
            espnOverlays += 1;
          }
        }
      }

      // Conferência cruzada ESPN × football-data no apito final (tempo normal).
      // Se a ESPN tiver placar final divergente da football-data, NÃO fecha sozinho:
      // segura como "a confirmar" (sem gravar em results) e mantém no placar ao vivo o
      // número da ESPN — fonte que reflete VAR/anulação mais rápido — pro admin apurar
      // no modo manual. Mata-mata em prorrogação/pênaltis (AET/PEN) segue 100% football-data.
      let heldByDivergence = false;
      if (candidate.tournament === "copa" && scoreOrientation !== "unknown" && isFinalStatus && finalStatus === "FT" && espnEvents?.length) {
        const espnFound = findEspnEvent(espnEvents, candidate.bolaoHome, candidate.bolaoAway);
        if (espnFound) {
          const espnScore = espnOrientedScore(espnFound.event, espnFound.reversed);
          const espnStatus = espnStatusShort(espnFound.event);
          const fdHome = numberOrNull(liveRow.goals_home);
          const fdAway = numberOrNull(liveRow.goals_away);
          if (
            espnStatus && ESPN_REGULAR_TIME_STATUSES.has(espnStatus) &&
            espnScore.home != null && espnScore.away != null &&
            fdHome != null && fdAway != null &&
            (espnScore.home !== fdHome || espnScore.away !== fdAway)
          ) {
            heldByDivergence = true;
            liveRow.goals_home = espnScore.home;
            liveRow.goals_away = espnScore.away;
            liveRow.regular_goals_home = espnScore.home;
            liveRow.regular_goals_away = espnScore.away;
            liveRow.status_long = `Conferir: ESPN ${espnScore.home}-${espnScore.away} x FD ${fdHome}-${fdAway}`;
            totalCopaResultsHeldDivergence += 1;
          }
        }
      }

      upserts.push(liveRow);

      // Histórico gol a gol: registra cada mudança de placar observada, com o
      // horário da observação (recorded_at), pra alimentar a evolução intra-jogo
      // do gráfico do ranking. O fechamento oficial continua vindo de `results`.
      const trackableStatus = INTERNAL_LIVE_STATUSES.has(liveRow.status_short || "") || FINAL_STATUSES.has(liveRow.status_short || "");
      const prevGoalsHome = numberOrNull(live.goals_home);
      const prevGoalsAway = numberOrNull(live.goals_away);
      if (
        trackableStatus &&
        liveRow.goals_home != null && liveRow.goals_away != null &&
        (prevGoalsHome !== liveRow.goals_home || prevGoalsAway !== liveRow.goals_away)
      ) {
        historyRows.push({
          game_id: gameId,
          status_short: liveRow.status_short,
          elapsed: liveRow.elapsed,
          goals_home: liveRow.goals_home,
          goals_away: liveRow.goals_away,
          recorded_at: liveRow.last_synced_at,
          source: "robot"
        });
      }

      // Resultado oficial só com final confirmado pela football-data — o
      // overlay ESPN pode marcar FT no live, mas nunca grava em `results`.
      if (candidate.tournament === "copa" && scoreOrientation !== "unknown" && isFinalStatus && !heldByDivergence) {
        const built = buildCopaResultRow(liveRow, match, {
          bolaoHome: candidate.bolaoHome,
          bolaoAway: candidate.bolaoAway,
          scoreOrientation
        });
        if (built.row) copaResultRows.push(built.row);
        if (built.error) errors.push(built.error);
      }
    }

    let updated = 0;
    if (upserts.length) {
      const { error: upErr, count } = await supa
        .from("live_scores")
        .upsert(upserts, { onConflict: "game_id", count: "exact" });
      if (upErr) errors.push(`upsert comp ${competitionId}: ${upErr.message}`);
      else updated = count ?? upserts.length;
    }

    // Histórico é melhor-esforço: erro aqui não derruba o placar ao vivo.
    if (updated && historyRows.length) {
      const { error: histErr } = await supa.from("live_score_history").insert(historyRows);
      if (histErr) errors.push(`history comp ${competitionId}: ${histErr.message}`);
    }

    if (updated && copaResultRows.length) {
      const resultSync = await upsertCopaResultsFromLive(supa, copaResultRows);
      totalCopaResultsWritten += resultSync.written;
      totalCopaResultsSkippedManual += resultSync.skippedManual;
      errors.push(...resultSync.errors);
    }

    totalUpdated += updated;
    const detailCallsUsed = detailCalls - detailCallsBeforeCompetition;
    calls.push({
      competition: competitionId,
      matches_returned: matches.length,
      fixtures_updated: updated,
      copa_results_written: copaResultRows.length ? totalCopaResultsWritten : 0,
      copa_results_skipped_manual: copaResultRows.length ? totalCopaResultsSkippedManual : 0,
      match_details_polled: detailCallsUsed
    });

    await supa.from("api_sync_log").insert({
      endpoint: url.toString(),
      league_id: competitionId,
      fixtures_polled: matches.length,
      fixtures_updated: updated,
      requests_remaining_minute: lastRateMinute ? Number(lastRateMinute) : null,
      ok: true
    });
  }

  return json(200, {
    ok: true,
    candidates: candidates.length,
    skipped_by_cadence: skippedByCadence,
    competitions_processed: byComp.size,
    fixtures_updated: totalUpdated,
    copa_results_written: totalCopaResultsWritten,
    copa_results_skipped_manual: totalCopaResultsSkippedManual,
    copa_results_held_divergence: totalCopaResultsHeldDivergence,
    requests_available_minute: lastRateMinute,
    espn_events: espnEvents ? espnEvents.length : 0,
    espn_overlays: espnOverlays,
    calls,
    errors: errors.length ? errors : undefined
  });
});
