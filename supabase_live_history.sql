-- Histórico de mudanças de placar (evolução intra-jogo do gráfico do ranking).
-- O robô insere uma linha sempre que observa o placar de um jogo mudar.
-- Cole no SQL Editor do Supabase e clique em Run.
-- Pode rodar quantas vezes quiser, é idempotente (não duplica nada).
-- (Já aplicado no projeto em 11/06/2026 via migração "live_score_history".)

begin;

create table if not exists public.live_score_history (
  id bigint generated always as identity primary key,
  game_id text not null references public.api_fixture_map(game_id) on delete cascade,
  status_short text,
  elapsed integer,
  goals_home integer not null,
  goals_away integer not null,
  recorded_at timestamptz not null default now(),
  source text not null default 'robot' check (source in ('robot','admin'))
);

create index if not exists live_score_history_game_idx
  on public.live_score_history(game_id, recorded_at);

alter table public.live_score_history enable row level security;

grant select on public.live_score_history to authenticated;
grant insert, update, delete on public.live_score_history to authenticated;

drop policy if exists "live_score_history visible" on public.live_score_history;
create policy "live_score_history visible"
on public.live_score_history for select to authenticated using (true);

-- Admin pode limpar/corrigir lances registrados errados pela API.
-- (O robô usa service_role e bypassa RLS, não precisa de policy.)
drop policy if exists "live_score_history admin insert" on public.live_score_history;
create policy "live_score_history admin insert"
on public.live_score_history for insert to authenticated
with check (app_private.is_admin());

drop policy if exists "live_score_history admin update" on public.live_score_history;
create policy "live_score_history admin update"
on public.live_score_history for update to authenticated
using (app_private.is_admin()) with check (app_private.is_admin());

drop policy if exists "live_score_history admin delete" on public.live_score_history;
create policy "live_score_history admin delete"
on public.live_score_history for delete to authenticated
using (app_private.is_admin());

commit;
