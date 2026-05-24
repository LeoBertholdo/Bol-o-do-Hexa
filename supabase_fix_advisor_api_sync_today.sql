-- Corrige o aviso do Supabase Advisor:
-- "Security Definer View" em public.api_sync_today.
--
-- Rode uma vez no SQL Editor do Supabase.

begin;

alter view public.api_sync_today
set (security_invoker = true);

commit;
