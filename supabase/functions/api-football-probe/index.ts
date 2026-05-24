// FUNÇÃO DEBUG TEMPORÁRIA — proxia qualquer endpoint da football-data.org
// usando o FOOTBALL_DATA_TOKEN do ambiente. Não toca no banco.
// APAGAR depois que terminar de investigar a API.
//
// Body esperado:
// {
//   "path": "competitions/2000/standings",   // caminho relativo a /v4/
//   "params": { "season": 2026 }             // opcional, vira querystring
// }
//
// Exemplo de uso (no painel Supabase → Edge Functions → api-football-probe → Test):
// {"path":"competitions/2000/standings","params":{"season":2026}}

const FD_BASE_URL = "https://api.football-data.org/v4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Use POST." });

  const token = Deno.env.get("FOOTBALL_DATA_TOKEN");
  if (!token) return json(500, { error: "FOOTBALL_DATA_TOKEN não configurada nos Secrets." });

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }

  const path = String(body.path || "").replace(/^\/+/, "");
  if (!path) {
    return json(400, {
      error: "Campo 'path' obrigatório.",
      example: { path: "competitions/2000/standings", params: { season: 2026 } }
    });
  }

  const url = new URL(`${FD_BASE_URL}/${path}`);
  const params = body.params && typeof body.params === "object" ? body.params : {};
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  const apiResp = await fetch(url, { headers: { "X-Auth-Token": token } });
  const text = await apiResp.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }

  return json(200, {
    requested_url: url.toString(),
    http_status: apiResp.status,
    rate_limit_minute: apiResp.headers.get("X-Requests-Available-Minute"),
    rate_limit_day: apiResp.headers.get("X-Requests-Available-Day"),
    body: parsed
  });
});
