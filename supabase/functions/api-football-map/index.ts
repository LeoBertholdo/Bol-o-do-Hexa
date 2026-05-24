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
//   "dry_run": false             // opcional, só preview
// }
//
// Custo: 1 chamada à API por execução.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const FD_BASE_URL = "https://api.football-data.org/v4";

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

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
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
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  }
  if (req.method !== "POST") return json(405, { error: "Use POST." });

  const token = Deno.env.get("FOOTBALL_DATA_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = getSupabaseAdminKey();
  if (!token) {
    return json(500, {
      error: "FOOTBALL_DATA_TOKEN não configurada.",
      hint: "Cadastre o secret FOOTBALL_DATA_TOKEN com a chave da football-data.org."
    });
  }
  if (!supabaseUrl || !serviceKey) return json(500, { error: "Variáveis Supabase ausentes." });

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
    return {
      game_id: `${idPrefix}${id}`,
      api_fixture_id: id,
      tournament,
      league_id: comp.id,
      season,
      kickoff_utc: m.utcDate || null,
      home_team: m.homeTeam?.name || m.homeTeam?.shortName || null,
      away_team: m.awayTeam?.name || m.awayTeam?.shortName || null,
      round_label: m.matchday
        ? `${tournament === "brasileirao" ? "Rodada" : "Matchday"} ${m.matchday}`
        : (m.stage || null),
      updated_at: new Date().toISOString()
    };
  }).filter(Boolean);

  if (dryRun) {
    return json(200, {
      dry_run: true,
      competition: comp,
      season,
      total_matches_received: matches.length,
      will_insert: rows.length,
      requests_available_minute: rateMin,
      preview: rows.slice(0, 10)
    });
  }

  const { error: deleteErr } = await supa
    .from("api_fixture_map")
    .delete()
    .eq("tournament", tournament)
    .eq("league_id", comp.id)
    .eq("season", season);
  if (deleteErr) return json(500, { error: "Falha limpando mapa antigo.", detail: deleteErr.message });

  const { error: upErr } = await supa
    .from("api_fixture_map")
    .upsert(rows, { onConflict: "game_id" });
  if (upErr) return json(500, { error: "Falha salvando.", detail: upErr.message });

  // Cria stub em live_scores pra cada game_id novo
  const liveStubs = rows.map((r: any) => ({ game_id: r.game_id, api_fixture_id: r.api_fixture_id }));
  await supa.from("live_scores").upsert(liveStubs, { onConflict: "game_id", ignoreDuplicates: true });

  return json(200, {
    ok: true,
    competition: comp,
    season,
    tournament,
    inserted: rows.length,
    requests_available_minute: rateMin,
    sample: rows.slice(0, 5)
  });
});
