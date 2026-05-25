/**
 * supabase.ts — Replaced Supabase SDK with a pg-based query builder
 * that mirrors the Supabase client API used throughout the codebase.
 * This lets all existing service code work without changes.
 */
import { query, pool } from './db.js';

type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/* ── Tiny chainable query builder ──────────────────────────────────── */
class QueryBuilder<T extends Record<string, unknown>> {
  private _table: string;
  private _selectCols: string = '*';
  private _filters: { col: string; op: string; val: unknown }[] = [];
  private _order: { col: string; asc: boolean } | null = null;
  private _limit: number | null = null;
  private _single = false;
  private _maybeSingle = false;
  private _count: 'exact' | null = null;
  private _headOnly = false;
  private _insertData: Partial<T> | Partial<T>[] | null = null;
  private _updateData: Partial<T> | null = null;
  private _upsertData: Partial<T> | Partial<T>[] | null = null;
  private _upsertConflict: string | null = null;
  private _deleteMode = false;
  private _inFilters: { col: string; vals: unknown[] }[] = [];
  private _returning: string = '*';
  private _notFilters: { col: string; val: unknown }[] = [];

  constructor(table: string) {
    this._table = table;
  }

  select(cols: string, opts?: { count?: 'exact'; head?: boolean }): this {
    this._selectCols = cols;
    if (opts?.count) this._count = opts.count;
    if (opts?.head)  this._headOnly = true;
    return this;
  }

  insert(data: Partial<T> | Partial<T>[]): this {
    this._insertData = data;
    return this;
  }

  update(data: Partial<T>): this {
    this._updateData = data;
    return this;
  }

  upsert(data: Partial<T> | Partial<T>[], opts?: { onConflict?: string }): this {
    this._upsertData = data;
    if (opts?.onConflict) this._upsertConflict = opts.onConflict;
    return this;
  }

  delete(): this {
    this._deleteMode = true;
    return this;
  }

  eq(col: string, val: unknown): this {
    this._filters.push({ col, op: '=', val });
    return this;
  }

  neq(col: string, val: unknown): this {
    this._notFilters.push({ col, val });
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this._inFilters.push({ col, vals });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this._order = { col, asc: opts?.ascending !== false };
    return this;
  }

  limit(n: number): this {
    this._limit = n;
    return this;
  }

  single(): this {
    this._single = true;
    this._limit = 1;
    return this;
  }

  maybeSingle(): this {
    this._maybeSingle = true;
    this._limit = 1;
    return this;
  }

  /* Build WHERE clause */
  private buildWhere(paramOffset = 1): { clause: string; params: unknown[] } {
    const params: unknown[] = [];
    const parts: string[] = [];
    let idx = paramOffset;

    for (const f of this._filters) {
      if (f.val === null) {
        parts.push(`"${f.col}" IS NULL`);
      } else {
        parts.push(`"${f.col}" ${f.op} $${idx++}`);
        params.push(f.val);
      }
    }
    for (const f of this._notFilters) {
      if (f.val === null) {
        parts.push(`"${f.col}" IS NOT NULL`);
      } else {
        parts.push(`"${f.col}" != $${idx++}`);
        params.push(f.val);
      }
    }
    for (const f of this._inFilters) {
      if (!f.vals.length) {
        parts.push('FALSE');
      } else {
        const placeholders = f.vals.map(() => `$${idx++}`).join(', ');
        parts.push(`"${f.col}" IN (${placeholders})`);
        params.push(...f.vals);
      }
    }

    return {
      clause: parts.length ? ' WHERE ' + parts.join(' AND ') : '',
      params,
    };
  }

  /* Sanitize column names for SELECT (allow *, qualified names, aliases) */
  private sanitizeSelectCols(cols: string): string {
    if (cols === '*') return '*';
    return cols
      .split(',')
      .map(raw => {
        const c = raw.trim();
        /* allow foo(bar) for related tables like tenants(name, slug) */
        const relMatch = c.match(/^(\w+)\(([^)]+)\)$/);
        if (relMatch) return null; /* handled separately */
        /* allow plain column names and table.column */
        if (/^[\w.]+$/.test(c)) return `"${c.replace('.', '"."')}"`;
        return c;
      })
      .filter(Boolean)
      .join(', ');
  }

  /* Parse related-table selects like tenants(name, slug) */
  private extractRelations(cols: string): { base: string[]; relations: { table: string; cols: string[] }[] } {
    const base: string[] = [];
    const relations: { table: string; cols: string[] }[] = [];
    for (const raw of cols.split(',')) {
      const c = raw.trim();
      const relMatch = c.match(/^(\w+)\(([^)]+)\)$/);
      if (relMatch) {
        relations.push({ table: relMatch[1], cols: relMatch[2].split(',').map(s => s.trim()) });
      } else {
        base.push(c);
      }
    }
    return { base, relations };
  }

  async execute(): Promise<{ data: T | T[] | null; error: { message: string } | null; count?: number | null }> {
    try {
      /* ── INSERT ── */
      if (this._insertData !== null) {
        const rows = Array.isArray(this._insertData) ? this._insertData : [this._insertData];
        if (!rows.length) return { data: null, error: null };

        const keys = Object.keys(rows[0]) as (keyof T)[];
        const colNames = keys.map(k => `"${String(k)}"`).join(', ');
        const params: unknown[] = [];
        const valueSets = rows.map(row => {
          const placeholders = keys.map(() => `$${params.length + keys.indexOf(keys[keys.indexOf(keys[0])]) + 1}`);
          /* rebuild properly */
          const ph = keys.map((k, i) => { params.push(row[k] ?? null); return `$${params.length}`; });
          return `(${ph.join(', ')})`;
        });

        const sql = `INSERT INTO public."${this._table}" (${colNames}) VALUES ${valueSets.join(', ')} RETURNING ${this._returning}`;
        const result = await query<T>(sql, params);
        const data = this._single || this._maybeSingle ? (result.rows[0] ?? null) : result.rows;
        return { data: data as T | T[], error: null };
      }

      /* ── UPSERT ── */
      if (this._upsertData !== null) {
        const rows = Array.isArray(this._upsertData) ? this._upsertData : [this._upsertData];
        if (!rows.length) return { data: null, error: null };

        const keys = Object.keys(rows[0]) as (keyof T)[];
        const colNames = keys.map(k => `"${String(k)}"`).join(', ');
        const params: unknown[] = [];
        const valueSets = rows.map(row => {
          const ph = keys.map(k => { params.push(row[k] ?? null); return `$${params.length}`; });
          return `(${ph.join(', ')})`;
        });

        const conflictCol = this._upsertConflict
          ? `("${this._upsertConflict.split(',').map(s => s.trim()).join('", "')}")`
          : `("${String(keys[0])}")`;

        const updateSet = keys
          .filter(k => String(k) !== (this._upsertConflict || String(keys[0])))
          .map(k => `"${String(k)}" = EXCLUDED."${String(k)}"`)
          .join(', ');

        const sql = `INSERT INTO public."${this._table}" (${colNames}) VALUES ${valueSets.join(', ')}
          ON CONFLICT ${conflictCol} DO UPDATE SET ${updateSet}
          RETURNING ${this._returning}`;
        const result = await query<T>(sql, params);
        const data = this._single || this._maybeSingle ? (result.rows[0] ?? null) : result.rows;
        return { data: data as T | T[], error: null };
      }

      /* ── UPDATE ── */
      if (this._updateData !== null) {
        const entries = Object.entries(this._updateData);
        if (!entries.length) return { data: null, error: { message: 'No fields to update' } };

        const params: unknown[] = entries.map(([, v]) => v ?? null);
        const setClause = entries.map(([k], i) => `"${k}" = $${i + 1}`).join(', ');
        const { clause, params: whereParams } = this.buildWhere(params.length + 1);
        params.push(...whereParams);

        const sql = `UPDATE public."${this._table}" SET ${setClause}${clause} RETURNING ${this._returning}`;
        const result = await query<T>(sql, params);
        const data = this._single || this._maybeSingle ? (result.rows[0] ?? null) : result.rows;
        return { data: data as T | T[], error: null };
      }

      /* ── DELETE ── */
      if (this._deleteMode) {
        const { clause, params } = this.buildWhere();
        const sql = `DELETE FROM public."${this._table}"${clause}`;
        await query(sql, params);
        return { data: null, error: null };
      }

      /* ── SELECT ── */
      const { base: baseCols, relations } = this.extractRelations(this._selectCols);

      if (this._headOnly && this._count === 'exact') {
        const { clause, params } = this.buildWhere();
        const result = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM public."${this._table}"${clause}`, params
        );
        return { data: null, error: null, count: parseInt(result.rows[0]?.count ?? '0', 10) };
      }

      const safeCols = baseCols.map(c => {
        if (c === '*') return '*';
        if (/^[\w.]+$/.test(c)) return `"${this._table}"."${c}"`;
        return c;
      }).join(', ') || `"${this._table}".*`;

      /* Build JOINs for relations */
      const joinClauses: string[] = [];
      const extraCols: string[] = [];
      for (const rel of relations) {
        const relAlias = rel.table;
        const relCols = rel.cols.map(c => `"${relAlias}"."${c}" AS "${relAlias}.${c}"`).join(', ');
        extraCols.push(relCols);
        joinClauses.push(`LEFT JOIN public."${relAlias}" ON public."${relAlias}".id = "${this._table}"."${relAlias.replace(/s$/, '')}_id"`);
      }

      const allCols = [safeCols, ...extraCols].filter(Boolean).join(', ');
      const joins = joinClauses.join(' ');
      const { clause, params } = this.buildWhere();
      const orderClause = this._order ? ` ORDER BY "${this._table}"."${this._order.col}" ${this._order.asc ? 'ASC' : 'DESC'}` : '';
      const limitClause = this._limit ? ` LIMIT ${this._limit}` : '';

      const sql = `SELECT ${allCols} FROM public."${this._table}" ${joins}${clause}${orderClause}${limitClause}`;
      const result = await query<T>(sql, params);

      /* Re-nest relation columns: { "tenants.name": "X" } → tenants: { name: "X" } */
      const rows = result.rows.map(row => {
        const out: Record<string, unknown> = { ...row };
        for (const rel of relations) {
          const nested: Record<string, unknown> = {};
          for (const c of rel.cols) {
            const key = `${rel.table}.${c}`;
            if (key in out) { nested[c] = out[key]; delete out[key]; }
          }
          out[rel.table] = nested;
        }
        return out as T;
      });

      if (this._count === 'exact') {
        const { clause: cClause, params: cParams } = this.buildWhere();
        const cResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM public."${this._table}"${cClause}`, cParams
        );
        const count = parseInt(cResult.rows[0]?.count ?? '0', 10);
        if (this._single) return { data: rows[0] ?? null, error: rows[0] ? null : { message: 'No rows found' }, count };
        if (this._maybeSingle) return { data: rows[0] ?? null, error: null, count };
        return { data: rows, error: null, count };
      }

      if (this._single) {
        if (!rows.length) return { data: null, error: { message: 'No rows found' } };
        return { data: rows[0], error: null };
      }
      if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    } catch (err: unknown) {
      console.error(`[db] Error on table "${this._table}":`, (err as Error).message);
      return { data: null, error: { message: (err as Error).message } };
    }
  }

  then<TResult1 = { data: T | T[] | null; error: { message: string } | null; count?: number | null }>(
    resolve: (value: { data: T | T[] | null; error: { message: string } | null; count?: number | null }) => TResult1,
    reject?: (reason: unknown) => never,
  ): Promise<TResult1> {
    return this.execute().then(resolve, reject);
  }
}

/* ── Supabase-compatible admin client shim ─────────────────────────── */
class SupabaseShim {
  from<T extends Record<string, unknown>>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(table);
  }

  /* Auth shim — password reset still uses Supabase Auth if configured,
     otherwise returns a graceful no-op */
  auth = {
    resetPasswordForEmail: async (email: string, opts?: { redirectTo?: string }) => {
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !serviceKey) {
        console.warn('[auth] SUPABASE_URL/SERVICE_ROLE_KEY not set — password reset email disabled.');
        return { error: { message: 'Email service not configured' } };
      }
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
        return client.auth.resetPasswordForEmail(email, opts);
      } catch (err: unknown) {
        return { error: { message: (err as Error).message } };
      }
    },
    getUser: async (token: string) => {
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !serviceKey) return { data: { user: null }, error: { message: 'Not configured' } };
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
        return client.auth.getUser(token);
      } catch (err: unknown) {
        return { data: { user: null }, error: { message: (err as Error).message } };
      }
    },
    admin: {
      createUser: async (opts: { email: string; email_confirm?: boolean; password?: string }) => {
        const supabaseUrl = process.env.SUPABASE_URL;
        const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !serviceKey) return { error: { message: 'Not configured' } };
        try {
          const { createClient } = await import('@supabase/supabase-js');
          const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
          return client.auth.admin.createUser(opts);
        } catch (err: unknown) {
          return { error: { message: (err as Error).message } };
        }
      },
    },
  };
}

export const supabaseAdmin  = new SupabaseShim();
export const supabaseClient = new SupabaseShim();
export const supabaseUrl    = process.env.SUPABASE_URL || '';
