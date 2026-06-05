-- Bolao do Hexa 2026 - trava confiavel de palpites.
-- Cole este arquivo no SQL Editor do Supabase e clique em Run.
-- Idempotente: pode rodar mais de uma vez.

begin;

create schema if not exists app_private;

do $$
begin
  if to_regprocedure('app_private.is_admin()') is null then
    raise exception 'Rode supabase_setup.sql antes deste arquivo: app_private.is_admin() nao existe.';
  end if;
end $$;

-- Mantem o mata-mata protegido por horario de cada jogo.
create table if not exists public.game_kickoffs (
  game_id text primary key,
  kickoff_utc timestamptz not null,
  updated_at timestamptz not null default now()
);

-- Prazo canonico no banco para grupos e podio.
-- O horario abaixo e 1 hora antes do primeiro jogo da Copa:
-- 2026-06-11 19:00:00 UTC -> trava em 2026-06-11 18:00:00 UTC.
create table if not exists public.prediction_lock_deadlines (
  lock_key text primary key,
  lock_at timestamptz not null,
  description text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint prediction_lock_deadlines_key_check check (lock_key in ('group_podium'))
);

insert into public.prediction_lock_deadlines (lock_key, lock_at, description)
values (
  'group_podium',
  '2026-06-11 18:00:00+00'::timestamptz,
  'Fase de grupos e podio fecham 1 hora antes da primeira partida da Copa.'
)
on conflict (lock_key) do update set
  lock_at = excluded.lock_at,
  description = excluded.description,
  updated_at = now();

alter table public.game_kickoffs enable row level security;
alter table public.prediction_lock_deadlines enable row level security;

grant select on public.game_kickoffs to authenticated;
grant insert, update, delete on public.game_kickoffs to authenticated;
grant select, insert, update, delete on public.prediction_lock_deadlines to authenticated;

drop policy if exists "prediction_lock_deadlines visible" on public.prediction_lock_deadlines;
create policy "prediction_lock_deadlines visible"
on public.prediction_lock_deadlines for select to authenticated using (true);

drop policy if exists "prediction_lock_deadlines admin insert" on public.prediction_lock_deadlines;
create policy "prediction_lock_deadlines admin insert"
on public.prediction_lock_deadlines for insert to authenticated
with check (app_private.is_admin());

drop policy if exists "prediction_lock_deadlines admin update" on public.prediction_lock_deadlines;
create policy "prediction_lock_deadlines admin update"
on public.prediction_lock_deadlines for update to authenticated
using (app_private.is_admin()) with check (app_private.is_admin());

drop policy if exists "prediction_lock_deadlines admin delete" on public.prediction_lock_deadlines;
create policy "prediction_lock_deadlines admin delete"
on public.prediction_lock_deadlines for delete to authenticated
using (app_private.is_admin());

create or replace function app_private.group_podium_lock_at()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select lock_at from public.prediction_lock_deadlines where lock_key = 'group_podium'),
    '2026-06-11 18:00:00+00'::timestamptz
  );
$$;

create or replace function app_private.predictions_kickoff_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_game_id text;
  kickoff timestamptz;
  deadline timestamptz;
begin
  if tg_op = 'DELETE' then
    target_game_id := old.game_id;
  else
    target_game_id := new.game_id;
  end if;

  if app_private.is_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if target_game_id ~ '^G[A-L][1-6]$' then
    deadline := app_private.group_podium_lock_at();

    if deadline is not null and now() >= deadline then
      raise exception 'Palpites encerrados: fase de grupos fechou 1 hora antes da primeira partida da Copa.'
        using errcode = 'P0001';
    end if;
  else
    select kickoff_utc into kickoff
    from public.game_kickoffs
    where game_id = target_game_id;

    if kickoff is not null and now() >= kickoff then
      raise exception 'Palpites encerrados: o jogo % ja comecou.', target_game_id
        using errcode = 'P0001';
    end if;
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

create or replace function app_private.podium_predictions_deadline_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  deadline timestamptz;
begin
  if app_private.is_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  deadline := app_private.group_podium_lock_at();

  if deadline is not null and now() >= deadline then
    raise exception 'Palpites encerrados: podio fechou 1 hora antes da primeira partida da Copa.'
      using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists podium_predictions_deadline_guard on public.podium_predictions;
create trigger podium_predictions_deadline_guard
before insert or update on public.podium_predictions
for each row execute function app_private.podium_predictions_deadline_guard();

drop trigger if exists podium_predictions_deadline_guard_delete on public.podium_predictions;
create trigger podium_predictions_deadline_guard_delete
before delete on public.podium_predictions
for each row execute function app_private.podium_predictions_deadline_guard();

commit;

select
  lock_key,
  lock_at,
  lock_at at time zone 'America/Sao_Paulo' as lock_at_sao_paulo,
  app_private.group_podium_lock_at() as effective_lock_at,
  exists (
    select 1
    from pg_trigger
    where tgname = 'predictions_kickoff_guard'
      and tgrelid = 'public.predictions'::regclass
      and not tgisinternal
  ) as predictions_trigger_ok,
  exists (
    select 1
    from pg_trigger
    where tgname = 'podium_predictions_deadline_guard'
      and tgrelid = 'public.podium_predictions'::regclass
      and not tgisinternal
  ) as podium_trigger_ok
from public.prediction_lock_deadlines
where lock_key = 'group_podium';
