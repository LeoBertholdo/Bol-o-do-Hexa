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
// Status finalizado (paramos de chamar)
const FINAL_STATUSES = new Set(["FINISHED", "AWARDED", "FT", "AET", "PEN", "AWD"]);

const CADENCE_NORMAL_SECONDS = 90;     // 90s na maior parte do jogo (10/min é o limite, sobra muito)
const CADENCE_LATE_SECONDS = 45;       // 45s nos minutos finais
const MAX_MATCH_DETAIL_CALLS_PER_RUN = 6; // deixa folga no limite de 10 chamadas/min da football-data
const LATE_GAME_FROM_MINUTE = 80;
const PRE_KICKOFF_WINDOW_MIN = 2;
const POST_KICKOFF_GIVEUP_MIN = 240;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

// football-data status → o que a gente usa no banco
function mapStatus(fdStatus: string, minute: number | null): string {
  switch (fdStatus) {
    case "SCHEDULED":
    case "TIMED": return "NS";
    case "IN_PLAY":
    case "LIVE":
      return (minute ?? 0) > 45 ? "2H" : "1H";
    case "PAUSED": return "HT";
    case "FINISHED": return "FT";
    case "AWARDED": return "AWD";
    case "POSTPONED": return "PST";
    case "SUSPENDED": return "SUSP";
    case "CANCELLED": return "CANC";
    default: return fdStatus;
  }
}

// Detecta se o resultado teve prorrogação ou pênaltis
function detectDecision(score: any): { aet: boolean; pen: boolean } {
  return {
    aet: !!score?.extraTime?.home || !!score?.extraTime?.away,
    pen: score?.penalties?.home != null || score?.penalties?.away != null
  };
}

function numberOrNull(value: unknown): number | null {
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
    .select("game_id, api_fixture_id, league_id, kickoff_utc");
  if (mapErr) return json(500, { error: "Falha lendo api_fixture_map.", detail: mapErr.message });
  if (!mapRows?.length) return json(200, { skipped: "sem_jogos_mapeados" });

  // 2. Lê estado conhecido
  const { data: liveRows } = await supa
    .from("live_scores")
    .select("game_id, status_short, elapsed, last_synced_at, is_locked_by_admin, yellow_cards_home, yellow_cards_away, red_cards_home, red_cards_away, corner_kicks_home, corner_kicks_away");
  const liveByGame = new Map((liveRows || []).map((r: any) => [r.game_id, r]));

  // 3. Filtra candidatos
  type Cand = {
    gameId: string;
    apiId: number;
    competitionId: number;
    cadenceSeconds: number;
    minutesSincePoll: number;
  };
  const candidates: Cand[] = [];

  for (const row of mapRows) {
    const kickoff = new Date(row.kickoff_utc).getTime();
    const minutesUntilKickoff = (kickoff - now) / 60000;
    const minutesAfterKickoff = -minutesUntilKickoff;
    const live = liveByGame.get(row.game_id);

    if (live?.is_locked_by_admin) continue;
    if (FINAL_STATUSES.has(live?.status_short || "")) continue;
    if (minutesUntilKickoff > PRE_KICKOFF_WINDOW_MIN) continue;
    if (minutesAfterKickoff > POST_KICKOFF_GIVEUP_MIN) continue;

    const cadenceSeconds = (live?.elapsed ?? 0) >= LATE_GAME_FROM_MINUTE
      ? CADENCE_LATE_SECONDS
      : CADENCE_NORMAL_SECONDS;
    const minutesSincePoll = live?.last_synced_at
      ? (now - new Date(live.last_synced_at).getTime()) / 60000
      : Infinity;

    candidates.push({
      gameId: row.game_id,
      apiId: row.api_fixture_id,
      competitionId: row.league_id,
      cadenceSeconds,
      minutesSincePoll
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
  let lastRateMinute: string | null = null;
  let detailCalls = 0;
  const calls: any[] = [];
  const errors: string[] = [];

  for (const [competitionId, group] of byComp) {
    const detailCallsBeforeCompetition = detailCalls;
    const cadenceSec = Math.min(...group.map(c => c.cadenceSeconds));
    const minSincePoll = Math.min(...group.map(c => c.minutesSincePoll));

    if (minSincePoll * 60 < cadenceSec) {
      calls.push({
        competition: competitionId,
        skipped: "cadencia_aguardando",
        cadenceSec,
        minSincePoll: Number(minSincePoll.toFixed(2))
      });
      continue;
    }

    const url = new URL(`${FD_BASE_URL}/competitions/${competitionId}/matches`);
    url.searchParams.set("dateFrom", dateFrom);
    url.searchParams.set("dateTo", dateTo);

    let apiResp: Response;
    let apiData: any = null;
    try {
      apiResp = await fetch(url, { headers: { "X-Auth-Token": token } });
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
    const apiToGame = new Map(group.map(c => [c.apiId, c.gameId]));
    const upserts: any[] = [];

    for (const m of matches) {
      const gameId = apiToGame.get(m.id);
      if (!gameId) continue;
      const statusShort = mapStatus(m.status, m.minute ?? null);
      const decision = detectDecision(m.score);
      const finalStatus =
        statusShort === "FT" && decision.pen ? "PEN" :
        statusShort === "FT" && decision.aet ? "AET" :
        statusShort;
      const live = liveByGame.get(gameId) || {};
      let cardSource = m;
      let cards = extractCardCounts(cardSource);
      const shouldFetchDetails =
        !hasCardCounts(cards) &&
        (LIVE_STATUSES.has(m.status) || LIVE_STATUSES.has(finalStatus) || FINAL_STATUSES.has(finalStatus)) &&
        detailCalls < MAX_MATCH_DETAIL_CALLS_PER_RUN;

      if (shouldFetchDetails) {
        const detailUrl = new URL(`${FD_BASE_URL}/matches/${m.id}`);
        try {
          const detailResp = await fetch(detailUrl, { headers: { "X-Auth-Token": token } });
          lastRateMinute = detailResp.headers.get("X-Requests-Available-Minute") || lastRateMinute;
          detailCalls += 1;
          const detailData = await detailResp.json();
          if (detailResp.ok) {
            cardSource = detailData;
            cards = extractCardCounts(cardSource);
          } else {
            errors.push(`match ${m.id}: HTTP ${detailResp.status} ${(detailData?.message || "").slice(0, 120)}`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`match ${m.id}: ${msg}`);
        }
      }

      upserts.push({
        game_id: gameId,
        api_fixture_id: m.id,
        status_short: finalStatus,
        status_long: m.status || null,
        elapsed: m.minute ?? null,
        goals_home: m.score?.fullTime?.home ?? null,
        goals_away: m.score?.fullTime?.away ?? null,
        pens_home: m.score?.penalties?.home ?? null,
        pens_away: m.score?.penalties?.away ?? null,
        yellow_cards_home: cards.yellowHome ?? live.yellow_cards_home ?? null,
        yellow_cards_away: cards.yellowAway ?? live.yellow_cards_away ?? null,
        red_cards_home: cards.redHome ?? live.red_cards_home ?? null,
        red_cards_away: cards.redAway ?? live.red_cards_away ?? null,
        corner_kicks_home: cards.cornersHome ?? live.corner_kicks_home ?? null,
        corner_kicks_away: cards.cornersAway ?? live.corner_kicks_away ?? null,
        last_synced_at: new Date().toISOString()
      });
    }

    let updated = 0;
    if (upserts.length) {
      const { error: upErr, count } = await supa
        .from("live_scores")
        .upsert(upserts, { onConflict: "game_id", count: "exact" });
      if (upErr) errors.push(`upsert comp ${competitionId}: ${upErr.message}`);
      else updated = count ?? upserts.length;
    }

    totalUpdated += updated;
    calls.push({
      competition: competitionId,
      matches_returned: matches.length,
      fixtures_updated: updated,
      match_details_polled: detailCalls - detailCallsBeforeCompetition
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
    competitions_processed: byComp.size,
    fixtures_updated: totalUpdated,
    requests_available_minute: lastRateMinute,
    calls,
    errors: errors.length ? errors : undefined
  });
});
