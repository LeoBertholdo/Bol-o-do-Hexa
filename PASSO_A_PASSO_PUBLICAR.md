# Publicar o Bolao do Hexa 2026 sem custo

Este projeto continua sendo um site HTML simples, mas agora pode usar Supabase como backend gratuito para login e salvamento online.

## O que ja esta preparado

- Cada participante cria login por e-mail e senha.
- Cada login escolhe um nome da lista de participantes uma unica vez.
- O participante so consegue alterar os proprios palpites e o proprio podio.
- O administrador consegue alterar placares oficiais, podio oficial e configuracoes financeiras.
- O ranking, grupos e pontuacao sao calculados no proprio HTML.
- O app ainda funciona em modo local se as chaves do Supabase estiverem vazias.

## Arquivos importantes

- `bolao2026.html`: o app.
- `index.html`: redireciona automaticamente para o app quando o site abrir pela raiz.
- `supabase_setup.sql`: estrutura do banco, login e regras de seguranca.

## 1. Criar o backend gratuito no Supabase

1. Acesse https://supabase.com e crie uma conta.
2. Crie um projeto novo no plano Free.
3. Entre no projeto, abra `SQL Editor`.
4. Abra o arquivo `supabase_setup.sql` desta pasta.
5. Copie tudo, cole no SQL Editor e clique em `Run`.

## 2. Ativar login por e-mail

1. No Supabase, abra `Authentication`.
2. Abra `Providers`.
3. Confirme que `Email` esta habilitado.
4. Para facilitar o bolao, voce pode desativar a confirmacao obrigatoria de e-mail. Se deixar ativada, cada participante precisa confirmar o e-mail antes de entrar.

## 3. Colar as chaves publicas no HTML

1. No Supabase, abra `Project Settings`.
2. Abra `API`.
3. Copie `Project URL`.
4. Copie a chave publica `anon` ou `publishable`.
5. No arquivo `bolao2026.html`, encontre este trecho:

```js
const SUPABASE_CONFIG = {
  url: "",
  anonKey: ""
};
```

6. Cole os valores assim:

```js
const SUPABASE_CONFIG = {
  url: "https://SEU-PROJETO.supabase.co",
  anonKey: "SUA-CHAVE-PUBLICA"
};
```

Use somente chave publica. Nunca cole `service_role` no HTML.

## 4. Definir quem sera administrador

1. Abra `bolao2026.html` no navegador.
2. Entre em `Configuracoes`.
3. A pessoa que sera administradora cria a conta com e-mail e senha.
4. Essa pessoa vincula a conta ao proprio nome de participante.
5. Volte ao Supabase, abra `SQL Editor` e rode este comando, trocando o e-mail pelo e-mail dessa pessoa:

```sql
update public.profiles
set role = 'admin'
where id = (
  select id
  from auth.users
  where email = 'EMAIL_DO_ADMINISTRADOR_AQUI'
);
```

6. A pessoa administradora recarrega o HTML. O perfil dela deve aparecer como `Administrador`.

## 5. Enviar dados antigos, se houver

Se voce ja tinha palpites ou resultados salvos no navegador:

1. Antes de qualquer mudanca, use `Backup` para exportar um JSON.
2. Depois de logar como administrador, va em `Configuracoes`.
3. Importe o JSON, se necessario.
4. Clique em `Publicar dados locais no Supabase`.

## 6. Publicar de graca no GitHub Pages

1. Crie uma conta em https://github.com, se ainda nao tiver.
2. Crie um repositorio publico, por exemplo `bolao-do-hexa`.
3. Envie para o repositorio estes arquivos:
   - `index.html`
   - `bolao2026.html`
4. No repositorio, abra `Settings`.
5. Abra `Pages`.
6. Em `Build and deployment`, escolha `Deploy from a branch`.
7. Escolha a branch `main` e a pasta `/root`.
8. Clique em `Save`.
9. O GitHub vai mostrar uma URL parecida com:

```txt
https://SEU-USUARIO.github.io/bolao-do-hexa/
```

## 7. Ajustar URL no Supabase

1. No Supabase, abra `Authentication`.
2. Abra `URL Configuration`.
3. Em `Site URL`, coloque a URL do GitHub Pages.
4. Em `Redirect URLs`, adicione tambem:

```txt
https://SEU-USUARIO.github.io/bolao-do-hexa/*
```

## 8. Como os participantes usam

1. Voce envia a URL do GitHub Pages.
2. Cada participante entra em `Configuracoes`.
3. Cada um cria uma conta.
4. Cada um escolhe o proprio nome.
5. Depois disso, cada participante preenche os proprios palpites em `Palpites` e o proprio podio em `Podio`.

## Observacoes importantes

- A chave `anon`/publica pode aparecer no HTML. A seguranca vem das regras RLS criadas no banco.
- O plano gratuito do Supabase tem limites e pode pausar projeto inativo. Para um bolao pequeno, deve ser suficiente; mantenha backups JSON.
- Se alguem escolher o nome errado, o administrador pode corrigir diretamente na tabela `profiles` do Supabase.
- Se mudar a lista de participantes, edite `DEFAULT_PARTICIPANTS` dentro de `bolao2026.html` antes de publicar.
