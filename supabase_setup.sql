-- Bolao do Hexa 2026 - estrutura online gratuita no Supabase
-- Cole este arquivo no SQL Editor do Supabase e clique em Run.

begin;

create schema if not exists app_private;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  participant_index integer not null unique check (participant_index >= 0),
  participant_name text not null,
  role text not null default 'participant' check (role in ('participant','admin')),
  created_at timestamptz not null default now()
);

-- Lista de e-mails autorizados a criar conta e vincular um slot no bolão.
-- Deve ser criada antes das funções que a referenciam.
create table if not exists public.invited_emails (
  email text primary key,
  participant_index integer not null unique check (participant_index >= 0)
);

create or replace function app_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

create or replace function app_private.has_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from profiles
    where role = 'admin'
  );
$$;

create or replace function app_private.owns_participant_index(idx integer)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from profiles
    where id = auth.uid()
      and participant_index = idx
  );
$$;

-- Verifica se o e-mail do usuário logado está convidado para o índice informado.
-- Usa auth.jwt() para ler o e-mail sem precisar acessar auth.users diretamente.
create or replace function app_private.is_invited_for_index(idx integer)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.invited_emails
    where email = (auth.jwt() ->> 'email')
      and participant_index = idx
  );
$$;

create or replace function app_private.prevent_removing_last_admin()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.role <> 'admin'
     and new.role = 'admin'
     and not exists (
       select 1
       from profiles
       where role = 'admin'
         and id <> old.id
     )
     and (
       old.participant_index is distinct from new.participant_index
       or old.participant_name is distinct from new.participant_name
     ) then
    raise exception 'A primeira promoção para administrador só pode alterar a permissão da própria conta.';
  end if;

  if old.role = 'admin'
     and new.role <> 'admin'
     and not exists (
       select 1
       from profiles
       where role = 'admin'
         and id <> old.id
     ) then
    raise exception 'Mantenha pelo menos um administrador ativo.';
  end if;
  return new;
end;
$$;

grant usage on schema app_private to authenticated;
grant execute on function app_private.is_admin() to authenticated;
grant execute on function app_private.has_admin() to authenticated;
grant execute on function app_private.owns_participant_index(integer) to authenticated;
grant execute on function app_private.is_invited_for_index(integer) to authenticated;

create table if not exists public.settings (
  id text primary key default 'main' check (id = 'main'),
  entry_value numeric not null default 200 check (entry_value >= 0),
  prize_percents integer[] not null default array[60,25,15],
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.settings (id, entry_value, prize_percents)
values ('main', 200, array[60,25,15])
on conflict (id) do nothing;

create table if not exists public.results (
  game_id text primary key,
  s1 integer not null check (s1 between 0 and 30),
  s2 integer not null check (s2 between 0 and 30),
  ko_winner text,
  ko_decision text,
  after_et_s1 integer check (after_et_s1 between 0 and 30),
  after_et_s2 integer check (after_et_s2 between 0 and 30),
  pens_s1 integer check (pens_s1 between 0 and 30),
  pens_s2 integer check (pens_s2 between 0 and 30),
  penalty_shootout jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.results
add column if not exists ko_winner text;

alter table public.results
add column if not exists ko_decision text;

alter table public.results
add column if not exists after_et_s1 integer check (after_et_s1 between 0 and 30);

alter table public.results
add column if not exists after_et_s2 integer check (after_et_s2 between 0 and 30);

alter table public.results
add column if not exists pens_s1 integer check (pens_s1 between 0 and 30);

alter table public.results
add column if not exists pens_s2 integer check (pens_s2 between 0 and 30);

alter table public.results
add column if not exists penalty_shootout jsonb;

create table if not exists public.predictions (
  participant_index integer not null check (participant_index >= 0),
  game_id text not null,
  user_id uuid references auth.users(id) on delete set null,
  s1 integer check (s1 between 0 and 30),
  s2 integer check (s2 between 0 and 30),
  ko_winner text,
  ko_decision text,
  updated_at timestamptz not null default now(),
  primary key (participant_index, game_id)
);

alter table public.predictions
add column if not exists ko_winner text;

alter table public.predictions
add column if not exists ko_decision text;

create table if not exists public.actual_podium (
  id text primary key default 'main' check (id = 'main'),
  p1 text,
  p2 text,
  p3 text,
  p4 text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.actual_podium (id)
values ('main')
on conflict (id) do nothing;

create table if not exists public.podium_predictions (
  participant_index integer primary key check (participant_index >= 0),
  user_id uuid references auth.users(id) on delete set null,
  p1 text,
  p2 text,
  p3 text,
  p4 text,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.results enable row level security;
alter table public.predictions enable row level security;
alter table public.actual_podium enable row level security;
alter table public.podium_predictions enable row level security;
alter table public.invited_emails enable row level security;

grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.settings to authenticated;
grant select, insert, update, delete on public.results to authenticated;
grant select, insert, update, delete on public.predictions to authenticated;
grant select, insert, update, delete on public.actual_podium to authenticated;
grant select, insert, update, delete on public.podium_predictions to authenticated;
grant select, insert, update, delete on public.invited_emails to authenticated;

drop trigger if exists protect_last_admin on public.profiles;
create trigger protect_last_admin
before update on public.profiles
for each row
execute function app_private.prevent_removing_last_admin();

drop policy if exists "profiles visible to signed in users" on public.profiles;
create policy "profiles visible to signed in users"
on public.profiles for select to authenticated
using (true);

drop policy if exists "participants create own profile" on public.profiles;
create policy "participants create own profile"
on public.profiles for insert to authenticated
with check (
  id = auth.uid()
  and role = 'participant'
  and app_private.is_invited_for_index(participant_index)
);

drop policy if exists "admins update profiles" on public.profiles;
create policy "admins update profiles"
on public.profiles for update to authenticated
using (app_private.is_admin())
with check (app_private.is_admin());

drop policy if exists "bootstrap first admin" on public.profiles;
create policy "bootstrap first admin"
on public.profiles for update to authenticated
using (
  id = auth.uid()
  and not app_private.has_admin()
)
with check (
  id = auth.uid()
  and role = 'admin'
  and exists (
    select 1
    from public.profiles existing
    where existing.id = auth.uid()
      and existing.participant_index = participant_index
      and existing.participant_name = participant_name
  )
);

-- Policies: invited_emails
-- Qualquer usuário autenticado pode ver a lista (necessário para o app verificar seu slot).
-- Somente admins podem adicionar, alterar ou remover convites.
drop policy if exists "invited emails visible to signed in users" on public.invited_emails;
create policy "invited emails visible to signed in users"
on public.invited_emails for select to authenticated
using (true);

drop policy if exists "admins manage invited emails" on public.invited_emails;
create policy "admins manage invited emails"
on public.invited_emails for all to authenticated
using (app_private.is_admin())
with check (app_private.is_admin());

-- Permite que o primeiro usuário adicione SOMENTE o próprio e-mail à lista quando
-- ainda não existe nenhum administrador (bootstrap inicial pelo app, sem SQL Editor).
-- Assim que o primeiro admin for criado, esta policy deixa de valer.
drop policy if exists "bootstrap add own email" on public.invited_emails;
create policy "bootstrap add own email"
on public.invited_emails for insert to authenticated
with check (
  not app_private.has_admin()
  and email = (auth.jwt() ->> 'email')
);

drop policy if exists "settings visible to signed in users" on public.settings;
create policy "settings visible to signed in users"
on public.settings for select to authenticated
using (true);

drop policy if exists "admins insert settings" on public.settings;
create policy "admins insert settings"
on public.settings for insert to authenticated
with check (app_private.is_admin());

drop policy if exists "admins update settings" on public.settings;
create policy "admins update settings"
on public.settings for update to authenticated
using (app_private.is_admin())
with check (app_private.is_admin());

drop policy if exists "results visible to signed in users" on public.results;
create policy "results visible to signed in users"
on public.results for select to authenticated
using (true);

drop policy if exists "admins insert results" on public.results;
create policy "admins insert results"
on public.results for insert to authenticated
with check (app_private.is_admin());

drop policy if exists "admins update results" on public.results;
create policy "admins update results"
on public.results for update to authenticated
using (app_private.is_admin())
with check (app_private.is_admin());

drop policy if exists "admins delete results" on public.results;
create policy "admins delete results"
on public.results for delete to authenticated
using (app_private.is_admin());

drop policy if exists "predictions visible to signed in users" on public.predictions;
create policy "predictions visible to signed in users"
on public.predictions for select to authenticated
using (true);

drop policy if exists "participants insert own predictions" on public.predictions;
create policy "participants insert own predictions"
on public.predictions for insert to authenticated
with check (
  app_private.is_admin()
  or (user_id = auth.uid() and app_private.owns_participant_index(participant_index))
);

drop policy if exists "participants update own predictions" on public.predictions;
create policy "participants update own predictions"
on public.predictions for update to authenticated
using (
  app_private.is_admin()
  or ((user_id = auth.uid() or user_id is null) and app_private.owns_participant_index(participant_index))
)
with check (
  app_private.is_admin()
  or (user_id = auth.uid() and app_private.owns_participant_index(participant_index))
);

drop policy if exists "admins delete predictions" on public.predictions;
create policy "admins delete predictions"
on public.predictions for delete to authenticated
using (app_private.is_admin());

drop policy if exists "actual podium visible to signed in users" on public.actual_podium;
create policy "actual podium visible to signed in users"
on public.actual_podium for select to authenticated
using (true);

drop policy if exists "admins insert actual podium" on public.actual_podium;
create policy "admins insert actual podium"
on public.actual_podium for insert to authenticated
with check (app_private.is_admin());

drop policy if exists "admins update actual podium" on public.actual_podium;
create policy "admins update actual podium"
on public.actual_podium for update to authenticated
using (app_private.is_admin())
with check (app_private.is_admin());

drop policy if exists "podium predictions visible to signed in users" on public.podium_predictions;
create policy "podium predictions visible to signed in users"
on public.podium_predictions for select to authenticated
using (true);

drop policy if exists "participants insert own podium" on public.podium_predictions;
create policy "participants insert own podium"
on public.podium_predictions for insert to authenticated
with check (
  app_private.is_admin()
  or (user_id = auth.uid() and app_private.owns_participant_index(participant_index))
);

drop policy if exists "participants update own podium" on public.podium_predictions;
create policy "participants update own podium"
on public.podium_predictions for update to authenticated
using (
  app_private.is_admin()
  or ((user_id = auth.uid() or user_id is null) and app_private.owns_participant_index(participant_index))
)
with check (
  app_private.is_admin()
  or (user_id = auth.uid() and app_private.owns_participant_index(participant_index))
);

drop policy if exists "admins delete podium predictions" on public.podium_predictions;
create policy "admins delete podium predictions"
on public.podium_predictions for delete to authenticated
using (app_private.is_admin());

-- ============================================================
-- PASSO OBRIGATÓRIO APÓS RODAR ESTE SCRIPT:
-- Insira os e-mails e índices dos participantes na tabela
-- invited_emails. O índice deve bater com a posição do nome
-- no array DEFAULT_PARTICIPANTS do HTML (começa em 0).
--
-- IMPORTANTE: inclua seu próprio e-mail aqui antes de criar
-- sua conta no app — é ele que autoriza o seu cadastro.
-- Depois que você virar admin, pode gerenciar esta tabela
-- diretamente pela aba Config do bolão.
--
-- Exemplo:
-- insert into public.invited_emails (email, participant_index) values
--   ('voce@email.com',        0),
--   ('amigo1@email.com',      1),
--   ('amigo2@email.com',      2),
--   ('amigo3@email.com',      3);
-- ============================================================

commit;
