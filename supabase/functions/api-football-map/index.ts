// O MAPEADOR — versão football-data.org.
// Roda 1 vez por torneio. Busca todos os jogos de uma competição/temporada
// e salva no api_fixture_map.
//
// Body esperado:
// {
//   "competition": "PL",         // código (ver tabela abaixo) OU competition_id (int)
//   "season": 2025,              // ano de início da temporada (2025 = 2025-26)
//   "tournament": "teste",       // tag livre: copa | brasileirao | teste
//   "id_prefix": "PL_",          // opcional, prefixo do game_id gerado
//   "use_bolao_game_ids": true,  // copa: tenta mapear para GA1/R32_01/etc.
//   "dry_run": false             // opcional, só preview
// }
//
// Custo: 1 chamada à API por execução.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const FD_BASE_URL = "https://api.football-data.org/v4";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bolao-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// Competições do free tier (id da football-data.org → código curto da API)
const COMPETITIONS: Record<string, { id: number; code: string; name: string }> = {
  BSA: { id: 2013, code: "BSA", name: "Campeonato Brasileiro Série A" },
  PL:  { id: 2021, code: "PL",  name: "Premier League (England)" },
  BL1: { id: 2002, code: "BL1", name: "Bundesliga (Germany)" },
  SA:  { id: 2019, code: "SA",  name: "Serie A (Italy)" },
  PD:  { id: 2014, code: "PD",  name: "La Liga (Spain)" },
  FL1: { id: 2015, code: "FL1", name: "Ligue 1 (France)" },
  DED: { id: 2003, code: "DED", name: "Eredivisie (Netherlands)" },
  PPL: { id: 2017, code: "PPL", name: "Primeira Liga (Portugal)" },
  ELC: { id: 2016, code: "ELC", name: "Championship (England)" },
  CL:  { id: 2001, code: "CL",  name: "UEFA Champions League" },
  EC:  { id: 2018, code: "EC",  name: "European Championship" },
  WC:  { id: 2000, code: "WC",  name: "FIFA World Cup" },
  CLI: { id: 2152, code: "CLI", name: "Copa Libertadores" }
};

const COPA_KICKOFF_TOLERANCE_MS = 10 * 60 * 1000;

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

const COPA_FIXTURES: Array<readonly [string, string, string?, string?]> = [
  ["GA1","2026-06-11T19:00:00Z","México","África do Sul"],["GA2","2026-06-12T02:00:00Z","Coreia do Sul","Rep. Tcheca"],["GA3","2026-06-19T01:00:00Z","México","Coreia do Sul"],["GA4","2026-06-18T16:00:00Z","África do Sul","Rep. Tcheca"],["GA5","2026-06-25T01:00:00Z","México","Rep. Tcheca"],["GA6","2026-06-25T01:00:00Z","África do Sul","Coreia do Sul"],
  ["GB1","2026-06-12T19:00:00Z","Canadá","Bósnia-Herzegovina"],["GB2","2026-06-13T19:00:00Z","Catar","Suíça"],["GB3","2026-06-18T22:00:00Z","Canadá","Catar"],["GB4","2026-06-18T19:00:00Z","Bósnia-Herzegovina","Suíça"],["GB5","2026-06-24T19:00:00Z","Canadá","Suíça"],["GB6","2026-06-24T19:00:00Z","Bósnia-Herzegovina","Catar"],
  ["GC1","2026-06-13T22:00:00Z","Brasil","Marrocos"],["GC2","2026-06-14T01:00:00Z","Haiti","Escócia"],["GC3","2026-06-20T00:30:00Z","Brasil","Haiti"],["GC4","2026-06-19T22:00:00Z","Marrocos","Escócia"],["GC5","2026-06-24T22:00:00Z","Brasil","Escócia"],["GC6","2026-06-24T22:00:00Z","Marrocos","Haiti"],
  ["GD1","2026-06-13T01:00:00Z","EUA","Paraguai"],["GD2","2026-06-14T04:00:00Z","Austrália","Turquia"],["GD3","2026-06-19T19:00:00Z","EUA","Austrália"],["GD4","2026-06-20T03:00:00Z","Paraguai","Turquia"],["GD5","2026-06-26T02:00:00Z","EUA","Turquia"],["GD6","2026-06-26T02:00:00Z","Paraguai","Austrália"],
  ["GE1","2026-06-14T17:00:00Z","Alemanha","Curaçau"],["GE2","2026-06-14T23:00:00Z","Costa do Marfim","Equador"],["GE3","2026-06-20T20:00:00Z","Alemanha","Costa do Marfim"],["GE4","2026-06-21T00:00:00Z","Curaçau","Equador"],["GE5","2026-06-25T20:00:00Z","Alemanha","Equador"],["GE6","2026-06-25T20:00:00Z","Curaçau","Costa do Marfim"],
  ["GF1","2026-06-14T20:00:00Z","Holanda","Japão"],["GF2","2026-06-15T02:00:00Z","Suécia","Tunísia"],["GF3","2026-06-20T17:00:00Z","Holanda","Suécia"],["GF4","2026-06-21T04:00:00Z","Japão","Tunísia"],["GF5","2026-06-25T23:00:00Z","Holanda","Tunísia"],["GF6","2026-06-25T23:00:00Z","Japão","Suécia"],
  ["GG1","2026-06-15T19:00:00Z","Bélgica","Egito"],["GG2","2026-06-16T01:00:00Z","Irã","Nova Zelândia"],["GG3","2026-06-21T19:00:00Z","Bélgica","Irã"],["GG4","2026-06-22T01:00:00Z","Egito","Nova Zelândia"],["GG5","2026-06-27T03:00:00Z","Bélgica","Nova Zelândia"],["GG6","2026-06-27T03:00:00Z","Egito","Irã"],
  ["GH1","2026-06-15T16:00:00Z","Espanha","Cabo Verde"],["GH2","2026-06-15T22:00:00Z","Arábia Saudita","Uruguai"],["GH3","2026-06-21T16:00:00Z","Espanha","Arábia Saudita"],["GH4","2026-06-21T22:00:00Z","Cabo Verde","Uruguai"],["GH5","2026-06-27T00:00:00Z","Espanha","Uruguai"],["GH6","2026-06-27T00:00:00Z","Cabo Verde","Arábia Saudita"],
  ["GI1","2026-06-16T19:00:00Z","França","Senegal"],["GI2","2026-06-16T22:00:00Z","Iraque","Noruega"],["GI3","2026-06-22T21:00:00Z","França","Iraque"],["GI4","2026-06-23T00:00:00Z","Senegal","Noruega"],["GI5","2026-06-26T19:00:00Z","França","Noruega"],["GI6","2026-06-26T19:00:00Z","Senegal","Iraque"],
  ["GJ1","2026-06-17T01:00:00Z","Argentina","Argélia"],["GJ2","2026-06-17T04:00:00Z","Áustria","Jordânia"],["GJ3","2026-06-22T17:00:00Z","Argentina","Áustria"],["GJ4","2026-06-23T03:00:00Z","Argélia","Jordânia"],["GJ5","2026-06-28T02:00:00Z","Argentina","Jordânia"],["GJ6","2026-06-28T02:00:00Z","Argélia","Áustria"],
  ["GK1","2026-06-17T17:00:00Z","Portugal","Rep. D. do Congo"],["GK2","2026-06-18T02:00:00Z","Uzbequistão","Colômbia"],["GK3","2026-06-23T17:00:00Z","Portugal","Uzbequistão"],["GK4","2026-06-24T02:00:00Z","Rep. D. do Congo","Colômbia"],["GK5","2026-06-27T23:30:00Z","Portugal","Colômbia"],["GK6","2026-06-27T23:30:00Z","Rep. D. do Congo","Uzbequistão"],
  ["GL1","2026-06-17T20:00:00Z","Inglaterra","Croácia"],["GL2","2026-06-17T23:00:00Z","Gana","Panamá"],["GL3","2026-06-23T20:00:00Z","Inglaterra","Gana"],["GL4","2026-06-23T23:00:00Z","Croácia","Panamá"],["GL5","2026-06-27T21:00:00Z","Inglaterra","Panamá"],["GL6","2026-06-27T21:00:00Z","Croácia","Gana"],
  ["R32_01","2026-06-28T19:00:00Z"],["R32_02","2026-06-29T20:30:00Z"],["R32_03","2026-06-30T01:00:00Z"],["R32_04","2026-06-29T17:00:00Z"],["R32_05","2026-06-30T21:00:00Z"],["R32_06","2026-06-30T17:00:00Z"],["R32_07","2026-07-01T01:00:00Z"],["R32_08","2026-07-01T16:00:00Z"],["R32_09","2026-07-02T00:00:00Z"],["R32_10","2026-07-01T20:00:00Z"],["R32_11","2026-07-02T23:00:00Z"],["R32_12","2026-07-02T19:00:00Z"],["R32_13","2026-07-03T03:00:00Z"],["R32_14","2026-07-03T22:00:00Z"],["R32_15","2026-07-04T01:30:00Z"],["R32_16","2026-07-03T18:00:00Z"],
  ["R16_01","2026-07-04T21:00:00Z"],["R16_02","2026-07-04T17:00:00Z"],["R16_03","2026-07-05T20:00:00Z"],["R16_04","2026-07-06T00:00:00Z"],["R16_05","2026-07-06T19:00:00Z"],["R16_06","2026-07-07T00:00:00Z"],["R16_07","2026-07-07T16:00:00Z"],["R16_08","2026-07-07T20:00:00Z"],
  ["QF_01","2026-07-09T20:00:00Z"],["QF_02","2026-07-10T19:00:00Z"],["QF_03","2026-07-11T21:00:00Z"],["QF_04","2026-07-12T01:00:00Z"],
  ["SF_01","2026-07-14T19:00:00Z"],["SF_02","2026-07-15T19:00:00Z"],["P3","2026-07-18T21:00:00Z"],["FINAL","2026-07-19T19:00:00Z"]
];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
  });
}

function resolveCompetition(input: unknown): { id: number; code: string; name: string } | null {
  if (typeof input === "string") {
    const c = COMPETITIONS[input.toUpperCase()];
    return c || null;
  }
  if (typeof input === "number") {
    const found = Object.values(COMPETITIONS).find(c => c.id === input);
    return found || null;
  }
  return null;
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

function teamPairOrientation(aHome: string, aAway: string, bHome: string, bAway: string): "same" | "reversed" | null {
  const ah = normalizeTeamName(aHome);
  const aa = normalizeTeamName(aAway);
  const bh = normalizeTeamName(bHome);
  const ba = normalizeTeamName(bAway);
  if (ah === bh && aa === ba) return "same";
  if (ah === ba && aa === bh) return "reversed";
  return null;
}

function resolveCopaGameId(match: any, fallbackGameId: string): {
  gameId: string;
  confidence: string;
  mapped: boolean;
  bolaoHome?: string;
  bolaoAway?: string;
} {
  const kickoff = new Date(match?.utcDate || "").getTime();
  if (!Number.isFinite(kickoff)) return { gameId: fallbackGameId, confidence: "unmapped:no-date", mapped: false };

  const home = canonicalCopaTeamName(match?.homeTeam?.name || match?.homeTeam?.shortName || match?.homeTeam?.tla || "");
  const away = canonicalCopaTeamName(match?.awayTeam?.name || match?.awayTeam?.shortName || match?.awayTeam?.tla || "");
  const teamCandidates = COPA_FIXTURES
    .filter((fixture) => fixture[2] && fixture[3])
    .map((fixture) => ({
      fixture,
      delta: Math.abs(new Date(fixture[1]).getTime() - kickoff),
      orientation: teamPairOrientation(home, away, String(fixture[2]), String(fixture[3]))
    }))
    .filter(({ delta, orientation }) => delta <= COPA_KICKOFF_TOLERANCE_MS && orientation)
    .sort((a, b) => a.delta - b.delta);

  if (teamCandidates.length === 1) {
    const candidate = teamCandidates[0];
    return {
      gameId: String(candidate.fixture[0]),
      confidence: candidate.orientation === "reversed" ? "teams+kickoff:api-reversed" : "teams+kickoff",
      mapped: true,
      bolaoHome: String(candidate.fixture[2]),
      bolaoAway: String(candidate.fixture[3])
    };
  }

  const timeCandidates = COPA_FIXTURES
    .map((fixture) => ({
      fixture,
      delta: Math.abs(new Date(fixture[1]).getTime() - kickoff)
    }))
    .filter(({ delta }) => delta <= COPA_KICKOFF_TOLERANCE_MS)
    .sort((a, b) => a.delta - b.delta);

  if (timeCandidates.length === 1) {
    return { gameId: String(timeCandidates[0].fixture[0]), confidence: "unique-kickoff", mapped: true };
  }

  return {
    gameId: fallbackGameId,
    confidence: timeCandidates.length ? "unmapped:ambiguous-kickoff" : "unmapped:no-fixture-match",
    mapped: false
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

  const token = Deno.env.get("FOOTBALL_DATA_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = getSupabaseAdminKey();
  const cronSecret = Deno.env.get("BOLAO_CRON_SECRET");
  const isTrustedBackendCall = Boolean(cronSecret && req.headers.get("x-bolao-cron-secret") === cronSecret);
  if (!token) {
    return json(500, {
      error: "FOOTBALL_DATA_TOKEN não configurada.",
      hint: "Cadastre o secret FOOTBALL_DATA_TOKEN com a chave da football-data.org."
    });
  }
  if (!supabaseUrl || !serviceKey) return json(500, { error: "Variáveis Supabase ausentes." });

  if (!isTrustedBackendCall) {
    // Verifica que quem chamou está logado E é admin do bolão.
    // Sem isso, qualquer pessoa com o anonKey público apaga/recria o mapa de jogos.
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json(401, { error: "Login obrigatório." });
    }
    // O Supabase não deixa o secret começar com SUPABASE_, então usa BOLAO_PUBLISHABLE_KEY.
    // Ainda lê SUPABASE_ANON_KEY caso já exista como variável de ambiente nativa.
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
      return json(403, { error: "Só o administrador do bolão pode mapear a temporada." });
    }
  }

  const supa = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }

  const comp = resolveCompetition(body.competition);
  if (!comp) {
    return json(400, {
      error: "Parâmetro 'competition' inválido.",
      valid_codes: Object.keys(COMPETITIONS),
      example: { competition: "PL", season: 2025 }
    });
  }

  const season = Number(body.season || new Date().getUTCFullYear());
  if (!Number.isInteger(season) || season < 2000 || season > 2100) {
    return json(400, { error: "Temporada inválida." });
  }

  const tournament = ["copa","brasileirao","teste"].includes(String(body.tournament))
    ? String(body.tournament)
    : "teste";
  const idPrefix = String(body.id_prefix || `${comp.code}_`);
  const dryRun = Boolean(body.dry_run);
  const useBolaoGameIds = tournament === "copa" && body.use_bolao_game_ids !== false;
  const requireBolaoGameIds = useBolaoGameIds && body.require_bolao_game_ids !== false;
  const dateTo: string | null = typeof body.date_to === "string" ? body.date_to : null;

  // GET /v4/competitions/{id}/matches?season=YYYY[&dateTo=YYYY-MM-DD]
  const url = new URL(`${FD_BASE_URL}/competitions/${comp.id}/matches`);
  url.searchParams.set("season", String(season));
  if (dateTo) url.searchParams.set("dateTo", dateTo);

  const apiResp = await fetch(url, { headers: { "X-Auth-Token": token } });
  const apiData = await apiResp.json().catch(() => null);
  const rateMin = apiResp.headers.get("X-Requests-Available-Minute");

  if (!apiResp.ok) {
    return json(502, {
      error: apiData?.message || `football-data respondeu HTTP ${apiResp.status}.`,
      http_status: apiResp.status,
      api_body: apiData,
      requests_available_minute: rateMin
    });
  }

  const matches: any[] = Array.isArray(apiData?.matches) ? apiData.matches : [];
  if (!matches.length) {
    return json(200, {
      ok: false,
      inserted: 0,
      diagnostic: "Resposta sem jogos. Temporada errada ou competição sem dados.",
      competition: comp,
      season,
      requests_available_minute: rateMin
    });
  }

  const rows = matches.map((m) => {
    const id = m.id;
    if (!id) return null;
    const fallbackGameId = `${idPrefix}${id}`;
    const resolved = useBolaoGameIds
      ? resolveCopaGameId(m, fallbackGameId)
      : { gameId: fallbackGameId, confidence: "api-id", mapped: true };
    return {
      game_id: resolved.gameId,
      api_fixture_id: id,
      tournament,
      league_id: comp.id,
      season,
      kickoff_utc: m.utcDate || null,
      home_team: resolved.bolaoHome || m.homeTeam?.name || m.homeTeam?.shortName || null,
      away_team: resolved.bolaoAway || m.awayTeam?.name || m.awayTeam?.shortName || null,
      round_label: m.matchday
        ? `${tournament === "brasileirao" ? "Rodada" : "Matchday"} ${m.matchday}`
        : (m.stage || null),
      mapping_confidence: resolved.confidence,
      mapped_to_bolao_game_id: resolved.mapped,
      updated_at: new Date().toISOString()
    };
  }).filter(Boolean);

  const unmappedRows = rows.filter((row: any) => useBolaoGameIds && !row.mapped_to_bolao_game_id);
  const duplicateGameIds = Object.entries(rows.reduce((acc: Record<string, number>, row: any) => {
    acc[row.game_id] = (acc[row.game_id] || 0) + 1;
    return acc;
  }, {})).filter(([, count]) => count > 1).map(([gameId]) => gameId);

  if (dryRun) {
    return json(200, {
      dry_run: true,
      competition: comp,
      season,
      total_matches_received: matches.length,
      will_insert: rows.length,
      use_bolao_game_ids: useBolaoGameIds,
      unmapped_count: unmappedRows.length,
      unmapped_sample: unmappedRows.slice(0, 10),
      duplicate_game_ids: duplicateGameIds,
      requests_available_minute: rateMin,
      preview: rows.slice(0, 10)
    });
  }

  if (requireBolaoGameIds && unmappedRows.length) {
    return json(409, {
      error: "Alguns jogos da Copa não bateram com os IDs internos do bolão.",
      hint: "Rode com dry_run:true para revisar. Se quiser apenas o modo paralelo tipo Brasileirão, envie use_bolao_game_ids:false.",
      unmapped_count: unmappedRows.length,
      sample: unmappedRows.slice(0, 10)
    });
  }

  if (duplicateGameIds.length) {
    return json(409, {
      error: "Mapeamento gerou game_id duplicado.",
      duplicate_game_ids: duplicateGameIds,
      hint: "Não grave antes de resolver os horários/confrontos duplicados."
    });
  }

  const insertRows = rows.map(({ mapping_confidence, mapped_to_bolao_game_id, ...row }: any) => row);

  // Re-import sem destruir dados filhos: NÃO apagamos game_ids que continuam no
  // mapa. live_scores, live_score_history (gol a gol) e test_predictions têm
  // ON DELETE CASCADE em game_id, então um delete-tudo-e-reinsere apagaria o
  // histórico do gráfico, os palpites e o placar travado pelo admin. Em vez
  // disso lemos o que já existe, removemos só os game_ids que sumiram do import
  // (liberando o api_fixture_id deles antes do upsert) e fazemos upsert do resto.
  const keepIds = new Set(insertRows.map((r: any) => r.game_id));

  const { data: existingRows, error: existingErr } = await supa
    .from("api_fixture_map")
    .select("game_id")
    .eq("tournament", tournament)
    .eq("league_id", comp.id)
    .eq("season", season);
  if (existingErr) return json(500, { error: "Falha lendo mapa antigo.", detail: existingErr.message });

  const staleIds = (existingRows || [])
    .map((r: any) => r.game_id)
    .filter((id: string) => !keepIds.has(id));
  if (staleIds.length) {
    const { error: deleteErr } = await supa
      .from("api_fixture_map")
      .delete()
      .eq("tournament", tournament)
      .eq("league_id", comp.id)
      .eq("season", season)
      .in("game_id", staleIds);
    if (deleteErr) return json(500, { error: "Falha limpando mapa antigo.", detail: deleteErr.message });
  }

  const { error: upErr } = await supa
    .from("api_fixture_map")
    .upsert(insertRows, { onConflict: "game_id" });
  if (upErr) return json(500, { error: "Falha salvando.", detail: upErr.message });

  // Cria stub em live_scores pra cada game_id novo
  const liveStubs = insertRows.map((r: any) => ({ game_id: r.game_id, api_fixture_id: r.api_fixture_id }));
  await supa.from("live_scores").upsert(liveStubs, { onConflict: "game_id", ignoreDuplicates: true });

  return json(200, {
    ok: true,
    competition: comp,
    season,
    tournament,
    inserted: insertRows.length,
    use_bolao_game_ids: useBolaoGameIds,
    unmapped_count: unmappedRows.length,
    requests_available_minute: rateMin,
    sample: rows.slice(0, 5)
  });
});
