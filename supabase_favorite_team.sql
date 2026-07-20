-- Bolao do Hexa 2026 - time do coracao por usuario.
-- Pode ser executado mais de uma vez: tabela, grants e policies sao idempotentes.

begin;

create table if not exists public.user_team_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  competition text not null,
  team_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, competition),
  constraint user_team_preferences_competition_check
    check (competition ~ '^[a-z0-9_-]{2,32}$'),
  constraint user_team_preferences_team_key_check
    check (team_key = btrim(team_key) and char_length(team_key) between 2 and 64)
);

alter table public.user_team_preferences enable row level security;

revoke all on public.user_team_preferences from anon;
grant select, insert, update on public.user_team_preferences to authenticated;

drop policy if exists "users read own team preferences" on public.user_team_preferences;
drop policy if exists "signed in users read team preferences" on public.user_team_preferences;
create policy "signed in users read team preferences"
on public.user_team_preferences for select
to authenticated
using (true);

drop policy if exists "users create own team preferences" on public.user_team_preferences;
create policy "users create own team preferences"
on public.user_team_preferences for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "users update own team preferences" on public.user_team_preferences;
create policy "users update own team preferences"
on public.user_team_preferences for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

commit;

-- Verificacao rapida: deve retornar RLS ativo e tres policies.
select
  c.relrowsecurity as rls_enabled,
  count(p.policyname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policies p
  on p.schemaname = n.nspname
 and p.tablename = c.relname
where n.nspname = 'public'
  and c.relname = 'user_team_preferences'
group by c.relrowsecurity;
