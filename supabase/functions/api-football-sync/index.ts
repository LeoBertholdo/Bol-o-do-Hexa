// O ROBÔ — versão football-data.org.
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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const FD_BASE_URL = "https://api.football-data.org/v4";

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
    headers: { "Content-Type": "application/json; charset=utf-8" }
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

function resolveScoreOrientation(
  match: any,
  bolaoHome: unknown,
  bolaoAway: unknown
): "same" | "reversed" | "unknown" {
  const home = normalizeTeamName(matchTeamName(match, "home"));
  const away = normalizeTeamName(matchTeamName(match, "away"));
  const expectedHome = normalizeTeamName(bolaoHome);
  const expectedAway = normalizeTeamName(bolaoAway);
  if (!home || !away || !expectedHome || !expectedAway) return "same";
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
      redHome: homeRed == null && homeYellowRed == null ? null : (homeRed || 0) + (homeYellowRed || 0),
      redAway: awayRed == null && awayYellowRed == null ? null : (awayRed || 0) + (awayYellowRed || 0),
      cornersHome: numberOrNull(homeStats?.corner_kicks),
      cornersAway: numberOrNull(awayStats?.corner_kicks)
    };
  }

  if (!Array.isArray(match?.bookings)) {
    return { yellowHome: null, yellowAway: null, redHome: null, redAway: null, cornersHome: null, cornersAway: null };
  }

  const counts = { yellowHome: 0, yellowAway: 0, redHome: 0, redAway: 0, cornersHome: null, cornersAway: null };
  let found = false;
  for (const booking of match.bookings) {
    const side = bookingSide(match, booking);
    if (!side) continue;
    const card = String(booking.card || "").toUpperCase();
    found = true;
    if (card.includes("RED")) {
      if (side === "home") counts.redHome += 1;
      else counts.redAway += 1;
    } else if (card.includes("YELLOW")) {
      if (side === "home") counts.yellowHome += 1;
      else counts.yellowAway += 1;
    }
  }

  return found ? counts : { yellowHome: null, yellowAway: null, redHome: null, redAway: null, cornersHome: null, cornersAway: null };
}

function hasCardCounts(cards: ReturnType<typeof extractCardCounts>): boolean {
  return Object.values(cards).some(v => v != null);
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

function buildCopaResultRow(row: any, match: any): { row?: any; error?: string } {
  if (!isInternalCopaGameId(row?.game_id)) return {};
  if (!FINAL_STATUSES.has(row?.status_short || "")) return {};

  const isKnockout = isCopaKnockoutGame("copa", row.game_id);
  if (isKnockout) return {};

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

  const winnerName = matchTeamName(match, winnerSide);
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
  if (req.method !== "POST") return json(405, { error: "Use POST." });

  const cronSecret = Deno.env.get("BOLAO_CRON_SECRET");
  if (!cronSecret) return json(500, { error: "BOLAO_CRON_SECRET não configurado." });
  if (req.headers.get("x-bolao-cron-secret") !== cronSecret) {
    return json(401, { error: "Não autorizado." });
  }

  const token = Deno.env.get("FOOTBALL_DATA_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = getSupabaseAdminKey();
  if (!token) return json(500, { error: "FOOTBALL_DATA_TOKEN não configurada." });
  if (!supabaseUrl || !serviceKey) return json(500, { error: "SUPABASE env vars ausentes." });

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
    .select("game_id, status_short, status_long, elapsed, goals_home, goals_away, regular_goals_home, regular_goals_away, extra_time_goals_home, extra_time_goals_away, after_extra_goals_home, after_extra_goals_away, pens_home, pens_away, last_synced_at, api_last_updated, is_locked_by_admin, yellow_cards_home, yellow_cards_away, red_cards_home, red_cards_away, corner_kicks_home, corner_kicks_away");
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
  let lastRateMinute: string | null = null;
  let detailCalls = 0;
  const calls: any[] = [];
  const errors: string[] = [];
  const fdHeaders = footballDataHeaders(token);

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
      continue;
    }

    const matches: any[] = Array.isArray(apiData?.matches) ? apiData.matches : [];
    const apiToCandidate = new Map(group.map(c => [c.apiId, c]));
    const upserts: any[] = [];
    const copaResultRows: any[] = [];

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
        red_cards_home: cards.redHome ?? live.red_cards_home ?? null,
        red_cards_away: cards.redAway ?? live.red_cards_away ?? null,
        corner_kicks_home: cards.cornersHome ?? live.corner_kicks_home ?? null,
        corner_kicks_away: cards.cornersAway ?? live.corner_kicks_away ?? null,
        api_last_updated: match.lastUpdated || live.api_last_updated || null,
        last_synced_at: new Date().toISOString()
      };

      upserts.push(liveRow);

      if (candidate.tournament === "copa" && scoreOrientation !== "unknown") {
        const built = buildCopaResultRow(liveRow, match);
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
    requests_available_minute: lastRateMinute,
    calls,
    errors: errors.length ? errors : undefined
  });
});
