-- Robô de placares via football-data.org: tabelas e regras de acesso.
-- Cole no SQL Editor do Supabase e clique em Run.
-- Pode rodar quantas vezes quiser, é idempotente (não duplica nada).

begin;

-- ============================================
-- TABELA "MAPA": liga o ID do jogo do nosso bolão
-- ao ID que a API usa internamente.
--   - tournament = 'copa' usa game_ids tipo GC1, R32_01, etc.
--   - tournament = 'brasileirao' usa game_ids gerados (BR_<api_id>)
-- ============================================
create table if not exists public.api_fixture_map (
  game_id text primary key,
  api_fixture_id bigint not null unique,
  tournament text not null default 'copa' check (tournament in ('copa','brasileirao','teste')),
  league_id integer not null,
  season integer not null,
  kickoff_utc timestamptz not null,
  home_team text,
  away_team text,
  round_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.api_fixture_map
drop constraint if exists api_fixture_map_tournament_check;

alter table public.api_fixture_map
add constraint api_fixture_map_tournament_check
check (tournament in ('copa','brasileirao','teste'));

create index if not exists api_fixture_map_kickoff_idx on public.api_fixture_map(kickoff_utc);
create index if not exists api_fixture_map_tournament_idx on public.api_fixture_map(tournament);

-- ============================================
-- TABELA "AO VIVO": último estado conhecido de cada jogo
-- que veio da API. É a memória do robô.
-- ============================================
create table if not exists public.live_scores (
  game_id text primary key references public.api_fixture_map(game_id) on delete cascade,
  api_fixture_id bigint not null,
  status_short text,   -- NS, 1H, HT, 2H, ET, BT, P, FT, AET, PEN, SUSP, CANC, PST
  status_long text,
  elapsed integer,
  goals_home integer,
  goals_away integer,
  regular_goals_home integer,
  regular_goals_away integer,
  extra_time_goals_home integer,
  extra_time_goals_away integer,
  after_extra_goals_home integer,
  after_extra_goals_away integer,
  pens_home integer,
  pens_away integer,
  penalty_shootout jsonb,
  yellow_cards_home integer,
  yellow_cards_away integer,
  red_cards_home integer,
  red_cards_away integer,
  corner_kicks_home integer,
  corner_kicks_away integer,
  last_synced_at timestamptz not null default now(),
  is_locked_by_admin boolean not null default false
);

alter table public.live_scores
add column if not exists regular_goals_home integer,
add column if not exists regular_goals_away integer,
add column if not exists extra_time_goals_home integer,
add column if not exists extra_time_goals_away integer,
add column if not exists after_extra_goals_home integer,
add column if not exists after_extra_goals_away integer,
add column if not exists penalty_shootout jsonb,
add column if not exists yellow_cards_home integer,
add column if not exists yellow_cards_away integer,
add column if not exists red_cards_home integer,
add column if not exists red_cards_away integer,
add column if not exists corner_kicks_home integer,
add column if not exists corner_kicks_away integer;

-- ============================================
-- PALPITES DE TESTE: ranking paralelo para torneios de ensaio.
-- Não mexe nas tabelas oficiais predictions/results do bolão da Copa.
-- ============================================
create table if not exists public.test_predictions (
  tournament text not null default 'brasileirao' check (tournament in ('brasileirao','teste')),
  participant_index integer not null check (participant_index >= 0),
  game_id text not null references public.api_fixture_map(game_id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  s1 integer not null check (s1 between 0 and 30),
  s2 integer not null check (s2 between 0 and 30),
  updated_at timestamptz not null default now(),
  primary key (tournament, participant_index, game_id)
);

alter table public.test_predictions
drop constraint if exists test_predictions_tournament_check;

alter table public.test_predictions
add constraint test_predictions_tournament_check
check (tournament in ('brasileirao','teste'));

create index if not exists test_predictions_game_idx on public.test_predictions(game_id);
create index if not exists test_predictions_participant_idx on public.test_predictions(participant_index);

-- ============================================
-- TABELA "DIÁRIO": registra cada chamada à API.
-- Use isso pra acompanhar consumo e erros do robô.
-- ============================================
create table if not exists public.api_sync_log (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  endpoint text,
  league_id integer,
  fixtures_polled integer default 0,
  fixtures_updated integer default 0,
  requests_remaining_day integer,
  requests_remaining_minute integer,
  ok boolean not null default true,
  message text
);

create index if not exists api_sync_log_ran_at_idx on public.api_sync_log(ran_at desc);

-- View pra ver consumo do dia (em horário de São Paulo).
-- security_invoker faz a view respeitar as permissões/RLS de quem consulta.
create or replace view public.api_sync_today
with (security_invoker = true) as
  select
    count(*) as chamadas_hoje,
    min(requests_remaining_day) as restando_hoje,
    max(ran_at) as ultima_chamada,
    coalesce(sum(fixtures_updated), 0) as placares_atualizados,
    count(*) filter (where ok = false) as erros
  from public.api_sync_log
  where ran_at >= (date_trunc('day', now() at time zone 'America/Sao_Paulo')) at time zone 'America/Sao_Paulo';

-- ============================================
-- RLS: tudo visível pra usuário logado, escrita só admin.
-- (O robô usa service_role e bypassa RLS, não precisa de policy.)
-- ============================================
alter table public.api_fixture_map enable row level security;
alter table public.live_scores enable row level security;
alter table public.test_predictions enable row level security;
alter table public.api_sync_log enable row level security;

grant select on public.api_fixture_map to authenticated;
grant select on public.live_scores to authenticated;
grant select, insert, update, delete on public.test_predictions to authenticated;
grant select on public.api_sync_log to authenticated;
grant select on public.api_sync_today to authenticated;
grant update on public.live_scores to authenticated;

-- Realtime: permite que a aba Brasileirão receba o placar assim que live_scores muda.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'live_scores'
     ) then
    alter publication supabase_realtime add table public.live_scores;
  end if;
end $$;

drop policy if exists "api_fixture_map visible" on public.api_fixture_map;
create policy "api_fixture_map visible"
on public.api_fixture_map for select to authenticated using (true);

drop policy if exists "api_fixture_map admin write" on public.api_fixture_map;
drop policy if exists "api_fixture_map admin insert" on public.api_fixture_map;
drop policy if exists "api_fixture_map admin update" on public.api_fixture_map;
drop policy if exists "api_fixture_map admin delete" on public.api_fixture_map;
create policy "api_fixture_map admin insert"
on public.api_fixture_map for insert to authenticated
with check (app_private.is_admin());

create policy "api_fixture_map admin update"
on public.api_fixture_map for update to authenticated
using (app_private.is_admin()) with check (app_private.is_admin());

create policy "api_fixture_map admin delete"
on public.api_fixture_map for delete to authenticated
using (app_private.is_admin());

drop policy if exists "live_scores visible" on public.live_scores;
create policy "live_scores visible"
on public.live_scores for select to authenticated using (true);

-- Admin pode trancar/destrancar um jogo (impede o robô de sobrescrever)
drop policy if exists "live_scores admin lock" on public.live_scores;
create policy "live_scores admin lock"
on public.live_scores for update to authenticated
using (app_private.is_admin()) with check (app_private.is_admin());

drop policy if exists "test_predictions visible" on public.test_predictions;
create policy "test_predictions visible"
on public.test_predictions for select to authenticated using (true);

drop policy if exists "test_predictions owner insert" on public.test_predictions;
create policy "test_predictions owner insert"
on public.test_predictions for insert to authenticated
with check (
  app_private.owns_participant_index(participant_index)
  or app_private.is_admin()
);

drop policy if exists "test_predictions owner update" on public.test_predictions;
create policy "test_predictions owner update"
on public.test_predictions for update to authenticated
using (
  app_private.owns_participant_index(participant_index)
  or app_private.is_admin()
)
with check (
  app_private.owns_participant_index(participant_index)
  or app_private.is_admin()
);

drop policy if exists "test_predictions owner delete" on public.test_predictions;
create policy "test_predictions owner delete"
on public.test_predictions for delete to authenticated
using (
  app_private.owns_participant_index(participant_index)
  or app_private.is_admin()
);

drop policy if exists "api_sync_log visible" on public.api_sync_log;
create policy "api_sync_log visible"
on public.api_sync_log for select to authenticated using (true);

commit;

-- ============================================
-- PASSO SEGUINTE (rodar SEPARADO, depois de criar o secret BOLAO_CRON_SECRET):
--
-- 1. Vá em Project Settings → Edge Functions → Secrets.
-- 2. Crie ou copie o valor de BOLAO_CRON_SECRET.
-- 3. Substitua COLE_AQUI_A_SENHA_DO_BOLAO_CRON_SECRET abaixo e rode no SQL Editor.
-- 4. Isso agenda o robô pra acordar de minuto em minuto.
--
-- (Não cole esse trecho ainda. Termine o setup antes — veja ROBO_SETUP.md)
-- ============================================
--
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
--
-- select cron.unschedule(jobid) from cron.job where jobname = 'api-football-tick';
--
-- select cron.schedule(
--   'api-football-tick',
--   '* * * * *',
--   $$
--   select net.http_post(
--     url := 'https://kbsjriixpqddgvwshucn.supabase.co/functions/v1/api-football-sync-',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-bolao-cron-secret', 'COLE_AQUI_A_SENHA_DO_BOLAO_CRON_SECRET'
--     ),
--     body := '{}'::jsonb,
--     timeout_milliseconds := 30000
--   );
--   $$
-- );
