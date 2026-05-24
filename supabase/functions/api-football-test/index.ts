const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  return json(410, {
    error: "Função legada desativada.",
    message: "O teste atual do Brasileirão usa football-data.org pelas funções api-football-map e api-football-sync.",
    next_step: "No Supabase, atualize e teste a função api-football-map com competition=BSA, season=2026 e tournament=brasileirao.",
  });
});
