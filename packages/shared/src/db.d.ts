import { Pool } from 'pg';
export declare function getSupabaseClient(): import("@supabase/supabase-js").SupabaseClient<unknown, {
    PostgrestVersion: string;
}, never, never, {
    PostgrestVersion: string;
}>;
export declare function getPool(): Pool;
export declare function query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
export declare function queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
export declare function closePool(): Promise<void>;
