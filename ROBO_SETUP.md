# Robô do Placar Automático (football-data.org)

Guia passo a passo pra ligar o sync automático com a **football-data.org**.
A API-Football não cobre temporadas atuais no plano free, então trocamos pra **football-data.org**, que tem Premier League, La Liga, Serie A, Champions League e **Copa do Mundo 2026** grátis.

Seu project ref do Supabase: **`kbsjriixpqddgvwshucn`**

---

## O que vai ser ligado

```
A cada 1 minuto:
  Supabase (cron) acorda o ROBÔ
  ↓
  Robô olha o calendário → tem jogo agora?
  ├── NÃO  → dorme. (0 chamadas)
  └── SIM  → 1 chamada na football-data (cobre TODOS os jogos da rodada do dia)
            → salva placar na tabela live_scores
```

Limite do free tier da football-data: **10 chamadas/minuto** (não tem teto diário!). Muito mais folgado que a API-Football.

---

## Passo 1 — Cadastro na football-data.org

1. Entre em **https://www.football-data.org/client/register**.
2. Cadastra com e-mail (free, sem cartão).
3. Confirma o e-mail.
4. Vai no painel → copia teu **API Token** (uma string longa).

> Free tier inclui: Premier League, Bundesliga, Serie A, La Liga, Ligue 1, Eredivisie, Primeira Liga, Championship, Champions League, **Copa do Mundo**, Eurocopa, Copa Libertadores.

---

## Passo 2 — Trocar o secret no Supabase

No painel do Supabase → **Edge Functions** → **Manage Secrets** (ou ícone de cadeado):

1. **Apaga** o segredo antigo `API_FOOTBALL_KEY` (se existir).
2. **Adiciona** um novo:
   - Name: `FOOTBALL_DATA_TOKEN` (exatamente assim, com underscore)
   - Value: cola seu token da football-data
3. Salva.

---

## Passo 3 — Atualizar o código das 2 funções

Já tava deployado a versão antiga (API-Football). Agora você precisa atualizar pra versão nova (football-data).

**Para cada uma** das funções (`api-football-map` e `api-football-sync`):

1. Abre a função no painel → **Edit function** (ou o lápis).
2. Apaga tudo do editor.
3. Cola o conteúdo do arquivo correspondente:
   - [supabase/functions/api-football-map/index.ts](supabase/functions/api-football-map/index.ts)
   - [supabase/functions/api-football-sync/index.ts](supabase/functions/api-football-sync/index.ts)
4. Clica em **Deploy**.

---

## Passo 4 — Limpar o mapa antigo (se você já tinha rodado o map antes)

SQL Editor → New query → cola e Run:

```sql
truncate public.live_scores cascade;
truncate public.api_fixture_map cascade;
truncate public.api_sync_log;
```

---

## Passo 5 — Mapear a Premier League (teste, 1 chamada)

Domingo **24/05/2026** é o último round da Premier League — todos os 10 jogos no mesmo horário. Perfeito pra testar.

**Edge Functions → api-football-map → Test**

- HTTP Method: **POST**
- Body:
```json
{
  "competition": "PL",
  "season": 2025,
  "tournament": "teste"
}
```

> `season: 2025` = temporada 2025-26 (a football-data usa o ano de início).

A resposta vai vir tipo:
```json
{
  "ok": true,
  "competition": { "id": 2021, "code": "PL", "name": "Premier League (England)" },
  "season": 2025,
  "inserted": 380,
  "requests_available_minute": "9",
  "sample": [...]
}
```

380 jogos = uma temporada inteira de Premier League ✅

### Outras competições válidas (caso queira testar outra)

| Código | Nome | Quando rola |
|---|---|---|
| `PL` | Premier League | ago/2025 → mai/2026 |
| `SA` | Serie A (Itália) | ago/2025 → mai/2026 |
| `PD` | La Liga (Espanha) | ago/2025 → mai/2026 |
| `BL1` | Bundesliga | ago/2025 → mai/2026 |
| `FL1` | Ligue 1 (França) | ago/2025 → mai/2026 |
| `CL` | Champions League | set/2025 → jun/2026 (final) |
| `WC` | Copa do Mundo | jun/2026 → jul/2026 |

---

## Passo 6 — Pegar o service_role key

1. Supabase → **Project Settings** → **API**.
2. Em "Project API keys" tem `anon` e `service_role`. Pega o **service_role** (botão "Reveal").

> Essa chave dá poder total. **Nunca** cole no HTML, GitHub, lugar público. Só no SQL Editor.

---

## Passo 7 — Ligar o cron

SQL Editor → New query → cola (substituindo `COLE_AQUI_O_SERVICE_ROLE`):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare j bigint;
begin
  select jobid into j from cron.job where jobname = 'api-football-tick';
  if j is not null then perform cron.unschedule(j); end if;
end $$;

select cron.schedule(
  'api-football-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://kbsjriixpqddgvwshucn.supabase.co/functions/v1/api-football-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer COLE_AQUI_O_SERVICE_ROLE'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
```

A partir desse momento o robô acorda **todo minuto**. Quando não tem jogo, ele só checa e volta a dormir.

---

## Passo 8 — Conferir no domingo 24/05 (dia dos jogos)

Roda no SQL Editor:

```sql
-- O que tá pra rolar nas próximas horas
select home_team, away_team, kickoff_utc, round_label
from public.api_fixture_map
where kickoff_utc between now() and now() + interval '24 hours'
order by kickoff_utc;
```

E uma vez que os jogos comecem:

```sql
select m.home_team, m.away_team,
       l.status_short, l.elapsed,
       l.goals_home, l.goals_away,
       l.last_synced_at
from public.api_fixture_map m
left join public.live_scores l on l.game_id = m.game_id
where m.kickoff_utc between now() - interval '4 hours' and now() + interval '6 hours'
order by m.kickoff_utc;

-- Consumo do robô hoje
select * from public.api_sync_today;
```

---

## Como parar o robô

```sql
select cron.unschedule(jobid) from cron.job where jobname = 'api-football-tick';
```

## Como travar um jogo (admin sobrescreve a API)

```sql
update public.live_scores
set is_locked_by_admin = true,
    goals_home = 2, goals_away = 1, status_short = 'FT'
where game_id = 'PL_500001';
```

---

## Quando a Copa do Mundo começar (jun/2026)

1. Limpa o mapa: `truncate api_fixture_map cascade;`
2. Invoca o `api-football-map` com:
   ```json
   { "competition": "WC", "season": 2026, "tournament": "copa" }
   ```
3. O resto continua igual — mesmo robô, mesmo cron.

> A integração entre os game_ids da Copa (WC_xxx) e os IDs do bolão (GA1, R32_01...) é um próximo passo: vou montar a tradução quando o calendário da Copa estiver disponível na football-data.
