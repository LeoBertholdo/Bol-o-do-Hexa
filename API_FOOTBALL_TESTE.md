# Teste da API-Football pelo Supabase

Este teste aparece dentro do bolão na aba **Teste API**.

Ele foi feito para simular o desenho oficial:

```txt
bolao2026.html
  -> Supabase Edge Function
  -> API-Football
  -> volta para o bolão
```

Assim a chave da API-Football fica escondida no Supabase e não aparece no HTML.

## 1. Criar a chave da API-Football

1. Entre em https://www.api-football.com.
2. Crie sua conta.
3. Copie a sua API key.

## 2. Instalar ou entrar na Supabase CLI

No terminal:

```bash
supabase login
```

Se a CLI não estiver instalada, instale primeiro seguindo a documentação oficial da Supabase.

## 3. Ligar este projeto ao seu Supabase

Use o ref do seu projeto Supabase:

```bash
supabase link --project-ref SEU_PROJECT_REF
```

O project ref é o começo da URL do Supabase.

Exemplo:

```txt
https://kbsjriixpqddgvwshucn.supabase.co
         ^ este trecho é o project ref
```

## 4. Salvar a chave como segredo

Não coloque a chave no HTML.

Rode:

```bash
supabase secrets set API_FOOTBALL_KEY=SUA_CHAVE_AQUI
```

## 5. Publicar a função de teste

Rode:

```bash
supabase functions deploy api-football-test
```

## 6. Testar dentro do bolão

1. Abra `bolao2026.html`.
2. Entre na sua conta do bolão.
3. Abra a aba **Teste API**.
4. Deixe os campos assim:
   - Liga: `71`
   - Temporada: `2026`
   - De: `2026-01-01`
   - Até: `2026-06-10`
5. Clique em **Buscar via Supabase**.

Se funcionar, os jogos do Brasileirão aparecem na tela.

## 7. Como apagar depois

Quando não precisar mais do teste:

1. Apague a pasta `supabase/functions/api-football-test`.
2. No `bolao2026.html`, procure por `API-FOOTBALL TEST LAB`.
3. Apague os blocos marcados.
4. Apague este arquivo `API_FOOTBALL_TESTE.md`.

