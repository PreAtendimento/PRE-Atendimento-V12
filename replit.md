# PRE-Atendimento V9 — Replit Configuration

## 🚫 REGRAS OBRIGATÓRIAS (AGENT)

Este projeto utiliza **EXCLUSIVAMENTE SUPABASE** como banco de dados.

É PROIBIDO:

- usar Replit Database
- usar PostgreSQL interno do Replit
- instalar ou usar módulo `postgresql-16`
- criar banco local (SQLite, Postgres local, etc)
- migrar dados para qualquer outro provider
- substituir Supabase por Prisma, Drizzle, Neon ou qualquer outro ORM/provider
- criar mocks de banco de dados
- alterar estrutura de persistência existente

Se variáveis do Supabase estiverem ausentes:

➡️ **PARAR execução imediatamente e informar erro claro**

---

## 🔐 VARIÁVEIS DE AMBIENTE OBRIGATÓRIAS

O backend NÃO deve iniciar sem:

- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- SUPABASE_POSTGRES_URL
- SUPABASE_JWT_SECRET
- GLOBAL_API_KEY

Nunca adicionar valores reais no código ou no repositório.

---

## 🧠 ARQUITETURA

Backend:
- Node.js + Express + TypeScript
- Arquivo principal: `src/server.ts`

Frontend:
- SPA estático servido pelo Express
- `public/index.html`
- `public/dashboard.html`

Banco:
- Supabase PostgreSQL (via pooler)

Integração externa:
- Evolution GO API
- https://evogo.pre-atendimento.com

---

## 🔒 SEGURANÇA E ISOLAMENTO

Isolamento obrigatório em duas camadas:

- `tenant_id` → organização
- `created_by` → usuário dono

Regras:

- usuário comum → acessa apenas seus próprios dados
- admin → acesso total

Filtros aplicados em TODAS as operações:

- listagem
- status
- QR Code
- connect
- disconnect
- delete
- purge

---

## 🗂 ESTRUTURA DO PROJETO
