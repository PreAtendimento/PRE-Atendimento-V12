import pg from 'pg';

const SQL_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '001_create_migrations_table',
    sql: `
      CREATE TABLE IF NOT EXISTS public._migrations (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    name: '002_create_instances_table',
    sql: `
      CREATE TABLE IF NOT EXISTS public.instances (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        instance_name TEXT NOT NULL UNIQUE,
        status        TEXT NOT NULL DEFAULT 'creating',
        metadata      JSONB,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_instances_instance_name ON public.instances (instance_name);
      CREATE INDEX IF NOT EXISTS idx_instances_status ON public.instances (status);
    `,
  },
  {
    name: '003_create_updated_at_trigger',
    sql: `
      CREATE OR REPLACE FUNCTION public.set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_instances_updated_at ON public.instances;
      CREATE TRIGGER trg_instances_updated_at
        BEFORE UPDATE ON public.instances
        FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
    `,
  },
  {
    name: '004_create_instance_logs_table',
    sql: `
      CREATE TABLE IF NOT EXISTS public.instance_logs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        instance_id UUID NOT NULL REFERENCES public.instances (id) ON DELETE CASCADE,
        event       TEXT NOT NULL,
        payload     JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_instance_logs_instance_id ON public.instance_logs (instance_id);
      CREATE INDEX IF NOT EXISTS idx_instance_logs_event ON public.instance_logs (event);
      CREATE INDEX IF NOT EXISTS idx_instance_logs_created_at ON public.instance_logs (created_at DESC);
    `,
  },
  {
    name: '005b_create_users_table',
    sql: `
      CREATE TABLE IF NOT EXISTS public.users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'user',
        active        BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON public.users (email);
    `,
  },
  {
    name: '005_enable_rls',
    sql: `
      ALTER TABLE public.instances ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.instance_logs ENABLE ROW LEVEL SECURITY;

      DO $$ BEGIN
        CREATE POLICY "service_role_all_instances" ON public.instances
          FOR ALL TO service_role USING (true) WITH CHECK (true);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE POLICY "anon_select_instances" ON public.instances
          FOR SELECT TO anon USING (true);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE POLICY "service_role_all_logs" ON public.instance_logs
          FOR ALL TO service_role USING (true) WITH CHECK (true);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE POLICY "anon_select_logs" ON public.instance_logs
          FOR SELECT TO anon USING (true);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,
  },
  /* ── 006: Tabela de tenants (clientes/organizações) ── */
  {
    name: '006_create_tenants_table',
    sql: `
      CREATE TABLE IF NOT EXISTS public.tenants (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name       TEXT NOT NULL,
        slug       TEXT NOT NULL UNIQUE,
        active     BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tenants_slug ON public.tenants (slug);

      ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN
        CREATE POLICY "service_role_all_tenants" ON public.tenants
          FOR ALL TO service_role USING (true) WITH CHECK (true);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      INSERT INTO public.tenants (name, slug)
      VALUES ('Default', 'default')
      ON CONFLICT (slug) DO NOTHING;
    `,
  },
  /* ── 007: tenant_id em users ── */
  {
    name: '007_add_tenant_to_users',
    sql: `
      ALTER TABLE public.users
        ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);

      UPDATE public.users
      SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'default')
      WHERE tenant_id IS NULL;

      CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON public.users (tenant_id);
    `,
  },
  /* ── 008: tenant_id + created_by em instances ── */
  {
    name: '008_add_tenant_to_instances',
    sql: `
      ALTER TABLE public.instances
        ADD COLUMN IF NOT EXISTS tenant_id  UUID REFERENCES public.tenants(id),
        ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.users(id);

      UPDATE public.instances
      SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'default')
      WHERE tenant_id IS NULL;

      CREATE INDEX IF NOT EXISTS idx_instances_tenant_id ON public.instances (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_instances_created_by ON public.instances (created_by);
    `,
  },
  /* ── 009: corrigir RLS — remover acesso anônimo irrestrito ── */
  {
    name: '009_fix_rls_instance_isolation',
    sql: `
      /* ── Remover políticas permissivas que expõem dados a qualquer pessoa ── */
      DROP POLICY IF EXISTS "anon_select_instances" ON public.instances;
      DROP POLICY IF EXISTS "anon_select_logs"      ON public.instance_logs;

      /* ── Política para authenticated: usuário só vê suas próprias instâncias ── */
      DO $$ BEGIN
        CREATE POLICY "owner_select_instances" ON public.instances
          FOR SELECT TO authenticated
          USING (created_by::text = auth.uid()::text);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE POLICY "owner_insert_instances" ON public.instances
          FOR INSERT TO authenticated
          WITH CHECK (created_by::text = auth.uid()::text);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE POLICY "owner_update_instances" ON public.instances
          FOR UPDATE TO authenticated
          USING (created_by::text = auth.uid()::text)
          WITH CHECK (created_by::text = auth.uid()::text);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE POLICY "owner_delete_instances" ON public.instances
          FOR DELETE TO authenticated
          USING (created_by::text = auth.uid()::text);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      /* ── Logs: usuário só vê logs das suas próprias instâncias ── */
      DO $$ BEGIN
        CREATE POLICY "owner_select_logs" ON public.instance_logs
          FOR SELECT TO authenticated
          USING (
            instance_id IN (
              SELECT id FROM public.instances
              WHERE created_by::text = auth.uid()::text
            )
          );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,
  },
];

export async function runMigrations(): Promise<void> {
  const connectionString = process.env.SUPABASE_POSTGRES_URL;

  if (!connectionString) {
    console.warn('⚠️  SUPABASE_POSTGRES_URL não definida — pulando migrations.');
    return;
  }

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    console.log('✅ Conectado ao Supabase via pooler');

    await client.query(SQL_MIGRATIONS[0].sql);

    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM public._migrations'
    );
    const applied = new Set(rows.map((r) => r.name));

    for (const migration of SQL_MIGRATIONS) {
      if (applied.has(migration.name)) {
        console.log(`⏭️  Já aplicada: ${migration.name}`);
        continue;
      }
      console.log(`🔄 Aplicando: ${migration.name}`);
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO public._migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
        [migration.name]
      );
      console.log(`✅ Concluída: ${migration.name}`);
    }

    console.log('🎉 Todas as migrations aplicadas com sucesso.');
  } catch (err) {
    console.error('❌ Erro nas migrations:', err);
    throw err;
  } finally {
    await client.end();
  }
}
