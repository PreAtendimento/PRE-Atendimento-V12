# PRE-Atendimento — Replit Agent Rules

---

## 🚨 ATENÇÃO — LEIA ANTES DE QUALQUER AÇÃO

### ❌ PROIBIDO CRIAR BANCO DE DADOS LOCAL NO REPLIT

Este projeto já possui banco de dados próprio no **Supabase**.

O agente **NÃO deve, em nenhuma hipótese:**

- Criar banco PostgreSQL local no Replit
- Ativar integração `javascript_database` ou `postgresql` do Replit
- Usar `DATABASE_URL` gerada automaticamente pelo Replit
- Usar `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` do Replit
- Propor migração de banco para qualquer outro serviço
- Criar fallback automático de banco
- Criar banco SQLite, Neon, Drizzle, Prisma ou qualquer alternativa
- Criar mocks ou dados em memória como substituto ao banco

**Se o Replit sugerir automaticamente criar um banco local → RECUSAR e usar Supabase.**

---

## 🗄️ BANCO DE DADOS — SUPABASE EXCLUSIVO

Este projeto utiliza **EXCLUSIVAMENTE** o banco de dados hospedado no Supabase do proprietário.

Todas as operações de banco (leitura, escrita, migrations) devem usar:
- `SUPABASE_DB_URL` → conexão Postgres direta (pooler)
- `@supabase/supabase-js` → cliente SDK para operações gerais

O arquivo `load-env.js` na raiz mapeia automaticamente:
```
DATABASE_URL = SUPABASE_DB_URL
```

Este arquivo é importado como **primeiro import** em `src/server.ts`. Nunca remover.

---

## 🔐 SECRETS — FLUXO OBRIGATÓRIO AO IMPORTAR

Ao importar do GitHub para o Replit, **os secrets não existem ainda**.

**Regra:** Assumir que o usuário irá fornecer os secrets.  
**Nunca** inventar valores, criar fallbacks ou usar variáveis do Replit no lugar.

### Variáveis normais (não secret) — configurar via setEnvVar se ausentes:

| Variável | Valor padrão / onde encontrar |
|----------|-------------------------------|
| `SUPABASE_URL` | `https://yikemdxcswfvmwdvykiw.supabase.co` (já pré-configurada) |
| `SUPABASE_DB_URL` | Project Settings → Database → Connection string → URI Pooler (porta 6543) |

### Secrets obrigatórios — solicitar ao usuário se ausentes:

| Secret | Onde encontrar no Supabase |
|--------|---------------------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → service_role |
| `SUPABASE_ANON_KEY` | Project Settings → API → anon public |
| `SUPABASE_JWT_SECRET` | Project Settings → API → JWT Settings → JWT Secret |

### Se faltar qualquer variável:
1. PARAR — não iniciar o servidor
2. Mostrar qual variável está faltando
3. Solicitar ao usuário via secrets do Replit
4. NÃO criar fallback, NÃO inventar valores

---

## 🏗️ ARQUITETURA (NÃO ALTERAR)

```
src/
  server.ts              ← entrada principal (porta 5000)
  services/
    supabase.ts          ← cliente @supabase/supabase-js (MANTER)
    authService.ts       ← auth via pg direto no Supabase
    instanceService.ts   ← lógica de instâncias WhatsApp
    evolutionGo.ts       ← integração Evolution GO API
  db/
    migrate.ts           ← migrations via SUPABASE_DB_URL

public/
  index.html             ← login
  dashboard.html         ← dashboard principal

load-env.js              ← mapeia SUPABASE_DB_URL → DATABASE_URL (NUNCA REMOVER)
.env.example             ← documentação das variáveis necessárias
```

- Backend: Node.js + Express + TypeScript (`tsx`)
- Banco: Supabase PostgreSQL (pooler, SSL obrigatório)
- Auth: JWT próprio (bcrypt + jsonwebtoken) + Supabase Auth para reset de senha
- API externa: Evolution GO (URL configurada pelo admin no painel)
- Porta: **5000** (obrigatória)

---

## 🔒 SEGURANÇA — ISOLAMENTO MULTI-TENANT

Duas camadas obrigatórias em todas as queries:
- `tenant_id`
- `created_by`

Regras:
- Usuário comum → apenas seus próprios dados
- Admin → acesso total

---

## 🚨 COMPORTAMENTO DO AGENT

**NÃO pode:**
- Alterar layout ou frontend
- Alterar rotas existentes sem instrução explícita
- Refatorar código sem instrução explícita
- Instalar bibliotecas desnecessárias
- Rodar migrations destrutivas
- Criar banco local de qualquer tipo

**Se houver erro:**
1. Mostrar o erro completo
2. Indicar qual variável ou secret está faltando
3. Aguardar instrução do usuário — nunca corrigir automaticamente com fallback

---

## 🔁 STATUS DE INSTÂNCIAS

Valores válidos: `creating` | `active` | `connected` | `inactive` | `error`  
Apenas `connected` = instância conectada ao WhatsApp.

---

## 📡 EVOLUTION GO

- `create` → usa `GLOBAL_API_KEY`
- `connect` / `status` / `qr` → usa token da instância
- `delete` → usa UUID da instância
- QR retorna campos `Qrcode` e `Code`

---

## 🎯 RESULTADO ESPERADO AO IMPORTAR DO GITHUB

1. Agente lê este arquivo primeiro
2. Verifica quais secrets estão ausentes
3. Solicita secrets ao usuário (nunca cria fallback)
4. `load-env.js` mapeia `SUPABASE_DB_URL → DATABASE_URL`
5. `pnpm run dev` inicia na porta 5000
6. Supabase conectado — nenhum banco local criado no Replit

## User preferences

- Banco de dados: Supabase exclusivamente — nunca banco local do Replit
- Secrets: sempre solicitar ao usuário, nunca criar fallback ou valor padrão
- Variáveis obrigatórias: SUPABASE_URL, SUPABASE_DB_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET
- Se o Replit sugerir banco local automaticamente: recusar e usar Supabase
