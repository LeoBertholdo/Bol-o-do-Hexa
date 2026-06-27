-- Bolao do Hexa 2026 - trava manual dos palpites do mata-mata.
-- Cole este arquivo no SQL Editor do Supabase e clique em Run.
-- Idempotente: pode rodar mais de uma vez.
--
-- O que faz:
--  1) Adiciona settings.knockout_predictions_open (default false = bloqueado).
--     Enquanto false, os confrontos do mata-mata sao revelados no app conforme
--     cada grupo encerra, mas ninguem palpita ate o admin liberar.
--  2) Atualiza o guard de palpites para barrar palpite de mata-mata de
--     nao-admin enquanto a trava estiver ligada (alem da trava por kickoff).

begin;

do $$
begin
  if to_regprocedure('app_private.is_admin()') is null then
    raise exception 'Rode supabase_setup.sql antes deste arquivo: app_private.is_admin() nao existe.';
  end if;
  if to_regprocedure('app_private.predictions_kickoff_guard()') is null then
    raise exception 'Rode supabase_prediction_lock_update.sql antes deste arquivo: guard nao existe.';
  end if;
end $$;

-- 1) Flag global de liberacao do mata-mata. Default false = travado.
alter table public.settings
  add column if not exists knockout_predictions_open boolean not null default false;

-- Garante a linha canonica de configuracao (o app le settings where id='main').
insert into public.settings (id) values ('main')
on conflict (id) do nothing;

-- 2) Guard de palpites passa a respeitar a trava manual do mata-mata.
--    Caminho da fase de grupos permanece identico ao anterior.
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
    -- Mata-mata: trava manual do admin tem precedencia sobre o horario do jogo.
    if not coalesce(
      (select knockout_predictions_open from public.settings where id = 'main'),
      false
    ) then
      raise exception 'Palpites do mata-mata ainda nao foram liberados.'
        using errcode = 'P0001';
    end if;

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

commit;

-- Conferencia rapida.
select
  exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='settings'
      and column_name='knockout_predictions_open'
  ) as coluna_ok,
  (select knockout_predictions_open from public.settings where id='main') as mata_mata_liberado;
