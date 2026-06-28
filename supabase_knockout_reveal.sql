-- Bolao do Hexa 2026 - revelacao do palpite ALHEIO no mata-mata.
-- Cole no SQL Editor do Supabase e clique em Run. Idempotente.
--
-- Regra: no mata-mata, o palpite dos OUTROS participantes fica visivel quando a
-- FASE encerra (mesmo instante da trava de ESCRITA: 30 min antes do 1o jogo da
-- fase). Depois disso ninguem edita -> revelar a fase inteira de uma vez e seguro,
-- inclusive jogos que so acontecem dias depois. Isso SUBSTITUI a regra anterior,
-- que liberava por kickoff de CADA jogo (now >= kickoff_utc do proprio jogo).
--
-- Camadas alinhadas: front (koOthersRevealed/canViewParticipantPrediction/
-- copaSelfPickHTML) + este RLS. A trava de escrita (predictions_kickoff_guard)
-- NAO muda. Fase de grupos continua aberta a todos. Admin e dono bypassam.

begin;

-- Helper: o palpite do mata-mata para p_game_id ja pode ser revelado?
-- = agora passou do fechamento da fase = now() >= min(kickoff da fase) - 30 min.
-- A fase e identificada pelo prefixo do game_id (mesmo padrao do guard de escrita).
create or replace function app_private.ko_palpite_revealed(p_game_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with pat as (
    select case
      when p_game_id ~ '^R32_' then '^R32_'
      when p_game_id ~ '^R16_' then '^R16_'
      when p_game_id ~ '^QF_'  then '^QF_'
      when p_game_id ~ '^SF_'  then '^SF_'
      when p_game_id =  'P3'    then '^P3$'
      when p_game_id =  'FINAL' then '^FINAL$'
      else null
    end as p
  )
  select case
    when (select p from pat) is null then false
    else coalesce(
      now() >= (
        select min(k.kickoff_utc) - interval '30 minutes'
        from public.game_kickoffs k
        where k.game_id ~ (select p from pat)
      ),
      false
    )
  end;
$$;

-- Politica de leitura: grupos sao publicos entre logados; mata-mata so libera o
-- palpite alheio depois do fechamento da fase. Admin e dono (proprio palpite)
-- sempre veem.
drop policy if exists "predictions visible to signed in users" on public.predictions;
drop policy if exists "predictions visible with ko lock" on public.predictions;
create policy "predictions visible with ko lock"
on public.predictions for select to authenticated
using (
  app_private.is_admin()
  or user_id = (select auth.uid())
  or app_private.owns_participant_index(participant_index)
  or game_id ~ '^G[A-L][1-6]$'
  or app_private.ko_palpite_revealed(game_id)
);

commit;

-- Conferencia: estado de revelacao de cada fase agora.
with phases as (
  select * from (values
    ('r32','^R32_'),('r16','^R16_'),('qf','^QF_'),
    ('sf','^SF_'),('p3','^P3$'),('final','^FINAL$')
  ) as t(phase, pat)
)
select p.phase,
  (select min(kickoff_utc) from public.game_kickoffs k where k.game_id ~ p.pat) as primeiro_jogo,
  (select min(kickoff_utc) - interval '30 minutes'
     from public.game_kickoffs k where k.game_id ~ p.pat) as revela_em,
  case
    when now() >= (select min(kickoff_utc) - interval '30 minutes'
                     from public.game_kickoffs k where k.game_id ~ p.pat)
      then 'REVELADO'
    else 'OCULTO'
  end as estado_agora
from phases p
order by array_position(array['r32','r16','qf','sf','p3','final'], p.phase);
