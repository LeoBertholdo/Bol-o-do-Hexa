-- Bolao do Hexa 2026 - janela em cascata dos palpites do mata-mata.
-- Cole no SQL Editor do Supabase e clique em Run. Idempotente.
--
-- O que faz:
--  1) Adiciona settings.knockout_phase_overrides (jsonb, default {}).
--     Override por fase do admin: {"r32":"open"|"closed", ...}. {} = automatico.
--  2) Reescreve app_private.predictions_kickoff_guard() para uma JANELA EM
--     CASCATA por fase do mata-mata:
--       - cada fase ABRE quando a fase anterior encerra (todos os jogos com
--         resultado oficial em public.results). Para o R32, "anterior" = os 72
--         jogos da fase de grupos.
--       - cada fase FECHA 30 min antes do 1o jogo da propria fase
--         (min(kickoff_utc) em public.game_kickoffs - 30 min).
--       - override 'open' FORCA a abertura (ignora a fase anterior), mas o
--         fechamento 30 min antes continua valendo; 'closed' trava; admin
--         (is_admin) nunca e barrado.
--     O caminho da fase de grupos permanece identico (trava 1h antes da 1a partida).
--
-- Pre-requisitos: supabase_setup.sql (is_admin, group_podium_lock_at) e o trigger
-- predictions_kickoff_guard ja instalados.

begin;

do $$
begin
  if to_regprocedure('app_private.is_admin()') is null then
    raise exception 'Rode supabase_setup.sql antes: app_private.is_admin() nao existe.';
  end if;
  if to_regprocedure('app_private.group_podium_lock_at()') is null then
    raise exception 'Rode os scripts de setup antes: app_private.group_podium_lock_at() nao existe.';
  end if;
  if to_regprocedure('app_private.predictions_kickoff_guard()') is null then
    raise exception 'Rode supabase_prediction_lock_update.sql antes: guard nao existe.';
  end if;
end $$;

-- 1) Override por fase (admin). Default {} = automatico.
alter table public.settings
  add column if not exists knockout_phase_overrides jsonb not null default '{}'::jsonb;

insert into public.settings (id) values ('main') on conflict (id) do nothing;

-- 2) Guard com janela em cascata por fase.
create or replace function app_private.predictions_kickoff_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_game_id text;
  phase text;
  prev_pattern text;
  prev_needed int;
  this_pattern text;
  ov text;
  prev_done int;
  kickoff_deadline timestamptz;
  group_deadline timestamptz;
begin
  if tg_op = 'DELETE' then
    target_game_id := old.game_id;
  else
    target_game_id := new.game_id;
  end if;

  -- Admin nunca e barrado.
  if app_private.is_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Fase de grupos: trava 1h antes da 1a partida (inalterado).
  if target_game_id ~ '^G[A-L][1-6]$' then
    group_deadline := app_private.group_podium_lock_at();
    if group_deadline is not null and now() >= group_deadline then
      raise exception 'Palpites encerrados: fase de grupos fechou 1 hora antes da primeira partida da Copa.'
        using errcode = 'P0001';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Mata-mata: identifica a fase pelo id do jogo.
  phase := case
    when target_game_id ~ '^R32_' then 'r32'
    when target_game_id ~ '^R16_' then 'r16'
    when target_game_id ~ '^QF_'  then 'qf'
    when target_game_id ~ '^SF_'  then 'sf'
    when target_game_id =  'P3'    then 'p3'
    when target_game_id =  'FINAL' then 'final'
    else null
  end;

  if phase is null then
    raise exception 'Palpite invalido: jogo % nao reconhecido.', target_game_id
      using errcode = 'P0001';
  end if;

  -- Override do admin por fase: {"r32":"open"|"closed", ...}
  select nullif(s.knockout_phase_overrides ->> phase, '')
    into ov
  from public.settings s
  where s.id = 'main';

  if ov = 'closed' then
    raise exception 'Palpites desta fase do mata-mata estao fechados pelo administrador.'
      using errcode = 'P0001';
  end if;

  this_pattern := case phase
    when 'r32'   then '^R32_'
    when 'r16'   then '^R16_'
    when 'qf'    then '^QF_'
    when 'sf'    then '^SF_'
    when 'p3'    then '^P3$'
    when 'final' then '^FINAL$'
  end;

  -- Abertura automatica: fase anterior inteira encerrada (resultados oficiais
  -- lancados). Pulada quando o admin forcou 'open'.
  if ov is distinct from 'open' then
    prev_pattern := case phase
      when 'r32'   then '^G[A-L][1-6]$'
      when 'r16'   then '^R32_'
      when 'qf'    then '^R16_'
      when 'sf'    then '^QF_'
      when 'p3'    then '^SF_'
      when 'final' then '^SF_'
    end;
    prev_needed := case phase
      when 'r32'   then 72
      when 'r16'   then 16
      when 'qf'    then 8
      when 'sf'    then 4
      when 'p3'    then 2
      when 'final' then 2
    end;

    -- Abertura: fase anterior inteira encerrada (resultados oficiais lancados).
    select count(*) into prev_done from public.results where game_id ~ prev_pattern;
    if prev_done < prev_needed then
      raise exception 'Palpites do mata-mata ainda nao foram liberados para esta fase.'
        using errcode = 'P0001';
    end if;
  end if;

  -- Fechamento SEMPRE: 30 min antes do 1o jogo da fase. Vale inclusive quando o
  -- admin forcou 'open' -- a fase trava sozinha no horario.
  select min(kickoff_utc) - interval '30 minutes'
    into kickoff_deadline
  from public.game_kickoffs
  where game_id ~ this_pattern;

  if kickoff_deadline is not null and now() >= kickoff_deadline then
    raise exception 'Palpites encerrados: esta fase fechou 30 minutos antes do primeiro jogo.'
      using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

commit;

-- Conferencia rapida: estado automatico de cada fase agora.
with phases as (
  select * from (values
    ('r32','^G[A-L][1-6]$',72,'^R32_'),
    ('r16','^R32_',16,'^R16_'),
    ('qf','^R16_',8,'^QF_'),
    ('sf','^QF_',4,'^SF_'),
    ('p3','^SF_',2,'^P3$'),
    ('final','^SF_',2,'^FINAL$')
  ) as t(phase, prev_pattern, prev_needed, this_pattern)
)
select p.phase,
  (select count(*) from public.results r where r.game_id ~ p.prev_pattern) as prev_done,
  p.prev_needed,
  (select min(kickoff_utc) - interval '30 minutes'
     from public.game_kickoffs k where k.game_id ~ p.this_pattern) as closes_at,
  case
    when (select count(*) from public.results r where r.game_id ~ p.prev_pattern) < p.prev_needed
      then 'BLOQUEADO: fase anterior nao encerrou'
    when now() >= (select min(kickoff_utc) - interval '30 minutes'
                     from public.game_kickoffs k where k.game_id ~ p.this_pattern)
      then 'BLOQUEADO: fechou (30 min antes)'
    else 'ABERTO'
  end as auto_state
from phases p
order by array_position(array['r32','r16','qf','sf','p3','final'], p.phase);
