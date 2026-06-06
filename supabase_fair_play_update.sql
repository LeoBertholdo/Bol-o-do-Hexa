-- Fair-play tiebreaker support for Copa group standings.
-- Run this once in the Supabase SQL Editor before deploying the updated sync function.
-- It is idempotent and safe to rerun.

begin;

alter table public.live_scores
add column if not exists yellow_red_cards_home integer,
add column if not exists yellow_red_cards_away integer;

alter table public.results
add column if not exists yellow_cards_home integer check (yellow_cards_home >= 0),
add column if not exists yellow_cards_away integer check (yellow_cards_away >= 0),
add column if not exists yellow_red_cards_home integer check (yellow_red_cards_home >= 0),
add column if not exists yellow_red_cards_away integer check (yellow_red_cards_away >= 0),
add column if not exists red_cards_home integer check (red_cards_home >= 0),
add column if not exists red_cards_away integer check (red_cards_away >= 0);

commit;

select
  'fair_play_columns_ready' as status,
  count(*) filter (where table_name = 'results') as result_columns,
  count(*) filter (where table_name = 'live_scores') as live_score_columns
from information_schema.columns
where table_schema = 'public'
  and table_name in ('results', 'live_scores')
  and column_name in (
    'yellow_cards_home',
    'yellow_cards_away',
    'yellow_red_cards_home',
    'yellow_red_cards_away',
    'red_cards_home',
    'red_cards_away'
  );
