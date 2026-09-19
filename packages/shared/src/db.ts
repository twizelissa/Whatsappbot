import { createClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import getEnv from './config';

let _supabase: ReturnType<typeof createClient> | null = null;
let _pool: Pool | null = null;

export function getSupabaseClient() {
  if (!_supabase) {
    const env = getEnv();
    _supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  }
  return _supabase;
}

export function getPool(): Pool {
  if (!_pool) {
    const env = getEnv();
    _pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      ssl: { rejectUnauthorized: false },
    });

    _pool.on('error', (err) => {
      console.error('Unexpected DB pool error:', err);
    });
  }
  return _pool;
}

export async function query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
  let retries = 2;
  while (retries >= 0) {
    try {
      const pool = getPool();
      const result = await pool.query(sql, params);
      return result.rows as T[];
    } catch (err: any) {
      const isConnError = 
        err?.message?.includes('Connection terminated') || 
        err?.message?.includes('connection timeout') ||
        err?.code === '57P01';
      if (isConnError && retries > 0) {
        console.warn(`⚠️ DB Connection lost, resetting pool and retrying (${retries} left)...`);
        await closePool();
        retries--;
        await new Promise((res) => setTimeout(res, 1000));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Database query failed after retries');
}

export async function queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
