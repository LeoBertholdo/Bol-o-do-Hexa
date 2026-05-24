# Teste de placares pelo Supabase

O teste aparece dentro do bolão nas abas **Brasileirão** e **Ranking BR**.

Apesar do nome histórico do arquivo, o teste atual usa **football-data.org**, não API-Football. A chave fica escondida nos Secrets do Supabase, e o HTML lê apenas as tabelas públicas protegidas por login.

## Fluxo atual

```txt
bolao2026.html
  -> Supabase
  -> api_fixture_map      calendário mapeado
  -> live_scores          placares atualizados pelo robô
  -> test_predictions     palpites do ranking paralelo
```

As Edge Functions usadas são:

- `api-football-map`: busca a temporada de uma competição e salva o calendário no Supabase.
- `api-football-sync`: atualiza os placares dos jogos mapeados quando estão perto de começar ou em andamento.

## Brasileirão Série A

Para preparar o teste, publique as funções e rode o SQL de `supabase_live_scores.sql`.

Depois, no painel do Supabase, invoque a função `api-football-map` uma vez com:

```json
{
  "competition": "BSA",
  "season": 2026,
  "tournament": "brasileirao",
  "id_prefix": "BR_"
}
```

Depois disso a página passa a carregar automaticamente os jogos do Supabase. Os resultados ao vivo são alimentados pelo cron descrito em `ROBO_SETUP.md`.

## Ranking paralelo

Os palpites do teste ficam em `test_predictions`, separados de `predictions`, então não interferem no ranking oficial da Copa. A aba **Ranking BR** recalcula a pontuação conforme `live_scores` recebe placares finalizados. Para mata-mata, `live_scores` também guarda placar no tempo regulamentar, placar após prorrogação, pênaltis e a sequência das cobranças quando a football-data.org fornecer esse detalhe.
