const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io";

type FixtureResponse = {
  fixture?: {
    id?: number;
    date?: string;
    status?: { short?: string; long?: string; elapsed?: number | null };
    venue?: { name?: string; city?: string };
  };
  league?: { round?: string };
  teams?: {
    home?: { name?: string; logo?: string };
    away?: { name?: string; logo?: string };
  };
  goals?: { home?: number | null; away?: number | null };
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function cleanDate(value: unknown, fallback: string) {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function apiErrors(errors: unknown) {
  if (!errors) return [];
  if (Array.isArray(errors)) return errors.map(String).filter(Boolean);
  if (typeof errors === "object") return Object.values(errors).flat().map(String).filter(Boolean);
  return [String(errors)].filter(Boolean);
}

function normalizeFixture(row: FixtureResponse) {
  return {
    id: row.fixture?.id,
    dateIso: row.fixture?.date || "",
    round: row.league?.round || "Rodada sem nome",
    venue: row.fixture?.venue?.name || "",
    city: row.fixture?.venue?.city || "",
    statusShort: row.fixture?.status?.short || "",
    statusLong: row.fixture?.status?.long || "",
    elapsed: row.fixture?.status?.elapsed ?? null,
    home: row.teams?.home?.name || "Mandante",
    away: row.teams?.away?.name || "Visitante",
    homeLogo: row.teams?.home?.logo || "",
    awayLogo: row.teams?.away?.logo || "",
    goalsHome: row.goals?.home ?? null,
    goalsAway: row.goals?.away ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Use POST." });

  const apiKey = Deno.env.get("API_FOOTBALL_KEY");
  if (!apiKey) {
    return json(500, {
      error: "API_FOOTBALL_KEY nao foi configurada nos Secrets do Supabase.",
    });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const league = Number(body.league || 71);
  const season = Number(body.season || 2026);
  const from = cleanDate(body.from, "2026-01-01");
  const to = cleanDate(body.to, "2026-06-10");
  const timezone = String(body.timezone || "America/Sao_Paulo");

  if (!Number.isInteger(league) || league <= 0) return json(400, { error: "Liga invalida." });
  if (!Number.isInteger(season) || season < 2000 || season > 2100) return json(400, { error: "Temporada invalida." });

  const url = new URL(`${API_FOOTBALL_BASE_URL}/fixtures`);
  url.searchParams.set("league", String(league));
  url.searchParams.set("season", String(season));
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("timezone", timezone);

  const apiResponse = await fetch(url, {
    headers: {
      "x-apisports-key": apiKey,
    },
  });

  const apiData = await apiResponse.json().catch(() => null);
  const errors = apiErrors(apiData?.errors);

  if (!apiResponse.ok || errors.length) {
    return json(502, {
      error: errors[0] || `API-Football respondeu HTTP ${apiResponse.status}.`,
      status: apiResponse.status,
      api: {
        results: apiData?.results ?? null,
        errors: apiData?.errors ?? null,
      },
    });
  }

  const fixtures = Array.isArray(apiData?.response)
    ? apiData.response.map(normalizeFixture).filter((fixture) => fixture.id)
    : [];

  return json(200, {
    fixtures,
    api: {
      results: apiData?.results ?? fixtures.length,
      paging: apiData?.paging ?? null,
      parameters: apiData?.parameters ?? null,
    },
    rateLimit: {
      requestsRemaining: apiResponse.headers.get("x-ratelimit-requests-remaining"),
      minuteRemaining: apiResponse.headers.get("x-ratelimit-remaining"),
    },
  });
});
