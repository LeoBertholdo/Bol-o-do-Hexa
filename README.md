# Bolão do Hexa 2026

Aplicação web para gerenciar um bolão da Copa do Mundo FIFA 2026. Permite que um grupo de participantes registre palpites de placar para cada partida, acompanhe o ranking em tempo real e visualize a distribuição de prêmios.

Repositório oficial: [LeoBertholdo/Bol-o-do-Hexa](https://github.com/LeoBertholdo/Bol-o-do-Hexa)

---

## Visão geral

| Característica | Detalhe |
|---|---|
| Tecnologia | HTML + CSS + JavaScript puro — sem framework, sem build step |
| Backend | [Supabase](https://supabase.com) (PostgreSQL + Auth) |
| Fallback | `localStorage` para uso offline ou sem configuração remota |
| Edição | Tudo em um único arquivo — `bolao2026.html` |
| Copa | FIFA World Cup 2026 · 48 seleções · 12 grupos (A–L) · Fase final até 19/07/2026 |

---

## Estrutura de arquivos

```
.
├── index.html            # Redirect para bolao2026.html (entry point)
├── bolao2026.html        # Aplicação completa (HTML + CSS + JS em linha)
├── API_FOOTBALL_TESTE.md # Passo a passo do teste de placares via Supabase
├── supabase/
│   └── functions/
│       ├── api-football-map/
│       │   └── index.ts  # Mapeia jogos da football-data.org no Supabase
│       ├── api-football-sync/
│       │   └── index.ts  # Robô de placares ao vivo via football-data.org
└── assets/
    └── header-hexa-2026.png
```

`index.html` existe apenas para garantir que a raiz do repositório redirecione corretamente (útil em GitHub Pages ou qualquer servidor estático). Toda a lógica está em `bolao2026.html`.

O `bolao2026.html` também contém abas removíveis **Brasileirão** e **Ranking BR**. Elas usam as tabelas `api_fixture_map`, `live_scores` e `test_predictions` para testar o desenho de placares automáticos com ranking separado. Para a Copa, o mapeador tenta usar os IDs internos do bolão (`GA1`, `R32_01`, `FINAL` etc.) e o robô grava jogos finalizados também em `results`, sem sobrescrever resultado salvo manualmente por admin.

---

## Arquitetura

### Estado local

O estado da aplicação é um objeto JavaScript (`S`) serializado em `localStorage` sob a chave `bolao2026v4`. Toda escrita passa pela função `save()`, que serializa e persiste o objeto.

Estrutura do estado:

```js
{
  participants: string[],          // Nomes dos participantes
  config: {
    entryValue: number,            // Valor da entrada (padrão: R$ 200)
    prizePercents: [60, 25, 15]    // Distribuição do prêmio (1º, 2º, 3º)
  },
  results: { [gameId]: { s1, s2 } },     // Placares reais (preenchidos pelo admin)
  palpites: { [`${pi}_${gameId}`]: { s1, s2 } }, // Palpites por participante
  podio: { [participantIndex]: { p1, p2, p3, p4 } }, // Palpites de pódio
  actualPodio: { p1, p2, p3, p4 }        // Pódio real
}
```

### Sincronização remota (Supabase)

Quando `SUPABASE_CONFIG` está configurado, a aplicação usa a [Supabase JS Client](https://supabase.com/docs/reference/javascript) para sincronizar o estado entre participantes.

Tabelas utilizadas:

| Tabela | Conteúdo |
|---|---|
| `settings` | Configurações globais (valor de entrada, percentuais de prêmio) |
| `results` | Placares reais das partidas |
| `predictions` | Palpites de cada participante |
| `actual_podium` | Pódio oficial definido pelo admin |
| `podium_predictions` | Palpites de pódio por participante |
| `profiles` | Mapeamento usuário Supabase → índice de participante + role |
| `invited_emails` | Lista de e-mails autorizados a vincular cada participante |

O cliente faz polling a cada **30 segundos** (`REMOTE_POLL_MS`) para manter o ranking atualizado automaticamente. Usuários com `role = "admin"` podem editar resultados, configurações, permissões e convites.

### Geração do calendário

As partidas são geradas dinamicamente pela função `genGames()` com base nas constantes:

```js
const GROUP_ROUND_STARTS = { 1: "2026-06-11", 2: "2026-06-18", 3: "2026-06-25" }
const KO_DATE_STARTS = { r32: "2026-07-03", r16: "2026-07-07", qf: "2026-07-10",
                         sf: "2026-07-14", p3: "2026-07-18", final: "2026-07-19" }
```

Nenhum dado de partida é hardcoded além dos grupos e seleções. Os confrontos das fases eliminatórias são preenchidos manualmente pelo admin conforme os resultados são definidos. Em empate no mata-mata, o palpite guarda apenas quem passa; o resultado oficial guarda também se foi na prorrogação ou nos pênaltis, incluindo placar após prorrogação e a sequência da disputa quando a API fornecer.

---

## Regras de pontuação

| Evento | Pontos |
|---|---|
| Placar exato (cravada) | **+3** |
| Resultado correto (acertou o vencedor) | **+1** |
| Invertida (apostou no time errado para ganhar) | **−2** |
| Mata-mata: acertar quem passa | **+1 extra** quando também há acerto do vencedor ou de empate |
| Acertar o campeão (1º lugar no pódio) | **+20** |
| Acertar o vice-campeão (2º lugar) | **+10** |
| Acertar o 3º colocado | **+5** |
| Acertar o 4º colocado | **+3** |

Critérios de desempate no ranking: total de pontos → cravadas → menor número de invertidas → ordem alfabética.

No mata-mata, se houver vencedor no tempo normal, a cravada vale 3+1 e o acerto do vencedor sem cravar vale 1+1; erro vale 0 e invertida vale −2. Se o resultado oficial empatar no tempo regulamentar, só pontua quem também palpitou empate: empate cravado vale 3 pontos, empate não cravado vale 1, e acertar quem passa soma +1. Errar quem passa não tira ponto nessa versão; apenas não soma o bônus.

Os palpites da fase de grupos e os palpites de pódio podem ser preenchidos ou editados somente até 1 hora antes da primeira partida da Copa. Durante a fase de grupos, todos os participantes autenticados podem ver os palpites de todos. No mata-mata, cada palpite continua aberto até o início do próprio jogo, e os palpites dos outros participantes só aparecem depois desse bloqueio.

---

## Como fazer o deploy

A aplicação é um arquivo estático — qualquer servidor HTTP funciona.

**GitHub Pages (recomendado)**

1. Crie um repositório público no GitHub.
2. Faça push dos arquivos (`index.html`, `bolao2026.html`, `assets/`).
3. Ative GitHub Pages em *Settings → Pages → Branch: main → / (root)*.
4. O app estará disponível em `https://<usuario>.github.io/<repositorio>/`.

**Configurar o Supabase (opcional, mas necessário para sync multiplayer)**

1. Crie um projeto em [supabase.com](https://supabase.com).
2. Rode o arquivo `supabase_setup.sql` no SQL Editor para criar todo o schema, as policies e as funções auxiliares.
3. Ative autenticação por e-mail (Magic Link ou senha).
4. Edite `SUPABASE_CONFIG` em `bolao2026.html`:

```js
const SUPABASE_CONFIG = {
  url: "https://<seu-projeto>.supabase.co",
  anonKey: "<sua-anon-key>"
};
```

Sem essa configuração, o app funciona normalmente em modo offline usando apenas `localStorage`.

Depois do setup inicial, cadastre os e-mails dos participantes em `invited_emails` ou pela aba **Configurações** depois que o primeiro administrador assumir o controle do bolão.

Para aplicar somente a trava nova de palpites em um projeto Supabase já existente, rode `supabase_prediction_lock_update.sql` no SQL Editor. Ele cria/atualiza o prazo canônico `group_podium = 2026-06-11 18:00:00+00`, reinstala os triggers de `predictions` e `podium_predictions` e retorna uma linha de verificação.

---

## Participantes e configuração

Os participantes padrão estão definidos em:

```js
const DEFAULT_PARTICIPANTS = ["Leo B.", "Leo C.", "Gabriel", "Gustavo", "Otávio", "Vitão", "Thyago", "Luiz R."];
```

Em modo online, cada participante faz login com sua conta Supabase e vincula o usuário ao seu índice na lista. Em modo offline, a seleção é feita diretamente na aba **Configurações**.

---

## Dependências externas

| Biblioteca | Origem | Uso |
|---|---|---|
| `@supabase/supabase-js` | CDN (supabase.com) | Comunicação com o backend remoto |

Nenhuma outra dependência. Sem npm, sem bundler, sem transpilação.
