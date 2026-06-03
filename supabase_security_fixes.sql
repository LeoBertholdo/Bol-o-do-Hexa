-- Correções de segurança do Bolão do Hexa 2026.
-- Cole tudo no SQL Editor do Supabase e clique em Run.
-- Idempotente: pode rodar quantas vezes quiser.
-- Observação: projetos novos que rodarem o supabase_setup.sql atual já recebem
-- estas correções principais. Este arquivo continua útil para projetos antigos.
--
-- O que isso resolve (numerada como no review):
--   #3  Trava de kickoff no servidor pra palpites da Copa (tabela predictions).
--   #5  E-mails da lista de convidados deixam de ser visíveis pra todo mundo.
--   #6  Trava de kickoff no servidor pra palpites do Brasileirão (test_predictions).

begin;

-- ============================================================
-- #3 — Trava de palpites por kickoff (predictions da Copa)
-- ============================================================
-- Tabela auxiliar com o horário de cada jogo. O app preenche
-- automaticamente quando um admin abre o bolão online.
create table if not exists public.game_kickoffs (
  game_id text primary key,
  kickoff_utc timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.game_kickoffs enable row level security;
grant select on public.game_kickoffs to authenticated;
grant insert, update, delete on public.game_kickoffs to authenticated;

drop policy if exists "game_kickoffs visible" on public.game_kickoffs;
create policy "game_kickoffs visible"
on public.game_kickoffs for select to authenticated using (true);

drop policy if exists "game_kickoffs admin insert" on public.game_kickoffs;
create policy "game_kickoffs admin insert"
on public.game_kickoffs for insert to authenticated
with check (app_private.is_admin());

drop policy if exists "game_kickoffs admin update" on public.game_kickoffs;
create policy "game_kickoffs admin update"
on public.game_kickoffs for update to authenticated
using (app_private.is_admin()) with check (app_private.is_admin());

drop policy if exists "game_kickoffs admin delete" on public.game_kickoffs;
create policy "game_kickoffs admin delete"
on public.game_kickoffs for delete to authenticated
using (app_private.is_admin());

-- Trigger que recusa palpites depois que o jogo começou.
-- Admin continua podendo corrigir (ex.: registrar resultado oficial).
create or replace function app_private.predictions_kickoff_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  kickoff timestamptz;
begin
  if app_private.is_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  select kickoff_utc into kickoff
  from public.game_kickoffs
  where game_id = coalesce(new.game_id, old.game_id);
  if kickoff is not null and now() >= kickoff then
    raise exception 'Palpites encerrados: o jogo % já começou.', coalesce(new.game_id, old.game_id)
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists predictions_kickoff_guard on public.predictions;
create trigger predictions_kickoff_guard
before insert or update on public.predictions
for each row execute function app_private.predictions_kickoff_guard();

drop trigger if exists predictions_kickoff_guard_delete on public.predictions;
create trigger predictions_kickoff_guard_delete
before delete on public.predictions
for each row execute function app_private.predictions_kickoff_guard();

-- ============================================================
-- #6 — Mesma trava pros palpites do Brasileirão (test_predictions)
--      Usa a kickoff_utc que já está em api_fixture_map.
-- ============================================================
create or replace function app_private.test_predictions_kickoff_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  kickoff timestamptz;
begin
  if app_private.is_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  select kickoff_utc into kickoff
  from public.api_fixture_map
  where game_id = coalesce(new.game_id, old.game_id);
  if kickoff is not null and now() >= kickoff then
    raise exception 'Palpites encerrados: o jogo % já começou.', coalesce(new.game_id, old.game_id)
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists test_predictions_kickoff_guard on public.test_predictions;
create trigger test_predictions_kickoff_guard
before insert or update on public.test_predictions
for each row execute function app_private.test_predictions_kickoff_guard();

drop trigger if exists test_predictions_kickoff_guard_delete on public.test_predictions;
create trigger test_predictions_kickoff_guard_delete
before delete on public.test_predictions
for each row execute function app_private.test_predictions_kickoff_guard();

-- ============================================================
-- #5 — Esconde e-mails dos demais usuários
-- ============================================================
-- Antes: qualquer pessoa logada via toda a lista de convidados.
-- Agora: cada um vê só o próprio convite; admin vê tudo.
drop policy if exists "invited emails visible to signed in users" on public.invited_emails;
drop policy if exists "invited emails self select" on public.invited_emails;
create policy "invited emails self select"
on public.invited_emails for select to authenticated
using (
  email = (auth.jwt() ->> 'email')
  or app_private.is_admin()
);

commit;
