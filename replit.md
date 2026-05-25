# PRE-Atendimento — Replit Agent Rules

---

## ⚠️ LEITURA OBRIGATÓRIA ANTES DE QUALQUER AÇÃO

Este projeto é importado do GitHub para o Replit.  
Leia **todas** as regras abaixo antes de fazer qualquer coisa.

---

## 🗄️ BANCO DE DADOS — SUPABASE EXCLUSIVO

Este projeto utiliza **EXCLUSIVAMENTE SUPABASE** como banco de dados.

**NUNCA:**
- usar Replit Database
- usar PostgreSQL interno do Replit
- instalar `postgresql-16` ou qualquer banco local
- criar banco SQLite, Postgres local ou qualquer outro
- migrar para Neon, PlanetScale, Drizzle, Prisma ou qualquer alternativa
- criar `DATABASE_URL` apontando para banco local do Replit
- criar fallback automático de banco
- criar mocks de banco de dados
- alterar estrutura de persistência
- rodar migrations contra banco local

Qualquer tentativa de substituir o Supabase → está **incorreto**. Parar e aguardar instrução.

---

## 🔐 SECRETS — FLUXO DE IMPORT

Ao importar este projeto do GitHub para o Replit, as variáveis de ambiente **não existem ainda**.

**Regra:** Assumir que os secrets serão informados pelo usuário.  
**Nunca** criar valores padrão, fallback ou mock para secrets.

### Secrets obrigatórios — solicitar ao usuário se ausentes:

| Secret | Descrição | Onde encontrar no Supabase |
|--------|-----------|---------------------------|
| `SUPABASE_URL` | URL do projeto | Project Settings → API → Project URL |
| `SUPABASE_DB_URL` | String de conexão Postgres (pooler) | Project Settings → Database → Connection string → URI (porta 6543) |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave de serviço (server-side) | Project Settings → API → service_role |
| `SUPABASE_ANON_KEY` | Chave pública anon | Project Settings → API → anon public |
| `SUPABASE_JWT_SECRET` | Segredo JWT (legacy) | Project Settings → API → JWT Settings → JWT Secret |

### Como solicitar:

Usar `requestEnvVar` com `requestType: "secret"` para todos os ausentes de uma vez.  
Não iniciar o servidor até que os secrets estejam presentes.

### Se faltar qualquer variável:
→ PARAR execução  
→ Mostrar qual variável está faltando  
→ NÃO criar fallback  
→ NÃO tentar corrigir automaticamente  
→ Solicitar ao usuário  

---

## ⚙️ PADRÃO load-env.js (OBRIGATÓRIO)

O arquivo `load-env.js` na raiz do projeto mapeia:

```js
process.env.DATABASE_URL = process.env.SUPABASE_DB_URL
```

Ele é importado como **primeiro import** em `src/server.ts`:

```ts
import '../load-env.js';
```

Isso garante que conexões `pg` usem o Supabase via `SUPABASE_DB_URL`.  
**Nunca remover ou alterar este arquivo.**

---

## 🏗️ ARQUITETURA (NÃO ALTERAR)

```
src/
  server.ts              ← entrada principal (porta 5000)
  services/
    supabase.ts          ← cliente @supabase/supabase-js (MANTER)
    authService.ts       ← auth via pg + bcrypt
    instanceService.ts   ← lógica de instâncias WhatsApp
    evolutionGo.ts       ← integração Evolution GO API
  db/
    migrate.ts           ← migrations via SUPABASE_DB_URL

public/
  index.html             ← login
  dashboard.html         ← dashboard principal

load-env.js              ← mapeamento SUPABASE_DB_URL → DATABASE_URL
.env.example             ← documentação de variáveis
```

- Backend: Node.js + Express + TypeScript (`tsx`)
- Banco: Supabase PostgreSQL (pooler, SSL obrigatório)
- Auth: JWT próprio (bcrypt) + Supabase Auth para reset de senha
- API externa: Evolution GO (configurada pelo admin no painel)
- Porta: **5000** (obrigatória)

---

## 🔒 SEGURANÇA — ISOLAMENTO MULTI-TENANT

Duas camadas obrigatórias em todas as queries:
- `tenant_id`
- `created_by`

Regras:
- Usuário comum → apenas seus próprios dados (`tenant_id` + `created_by`)
- Admin → acesso total (sem filtro)

Aplicado em: listagem, criação, status, QR code, connect, disconnect, delete, purge.

---

## 🚨 COMPORTAMENTO DO AGENT

O Agent **NÃO pode:**
- Alterar layout ou frontend
- Alterar rotas existentes
- Refatorar código sem instrução explícita
- Instalar bibliotecas desnecessárias
- Alterar `.replit`
- Rodar migrations destrutivas
- Inventar arquitetura nova

---

## 🔁 LÓGICA DE STATUS DE INSTÂNCIAS

Valores válidos: `creating` | `active` | `connected` | `inactive` | `error`  
**APENAS** `connected` = instância conectada ao WhatsApp.

---

## 📡 EVOLUTION GO

- `create` → usa `GLOBAL_API_KEY`
- `connect` / `status` / `qr` → usa token da instância
- `delete` → usa UUID da instância
- QR retorna campos `Qrcode` e `Code`

---

## 🧪 DEBUG

Se houver erro:

**NÃO:** mudar banco, criar fallback, trocar provider, alterar estrutura  
**FAZER:**
1. Mostrar o erro completo
2. Indicar qual variável ou configuração está faltando
3. Aguardar instrução do usuário

---

## 🎯 RESULTADO ESPERADO AO IMPORTAR

1. Secrets informados pelo usuário via Replit Secrets
2. `load-env.js` mapeia `SUPABASE_DB_URL → DATABASE_URL`
3. `pnpm run dev` inicia o servidor na porta 5000
4. Supabase conectado como única fonte de dados
5. Nenhum banco local criado no Replit

## User preferences

- Banco de dados: Supabase exclusivamente
- Secrets: sempre solicitar ao usuário, nunca criar fallback
- Variáveis obrigatórias: SUPABASE_URL, SUPABASE_DB_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET
