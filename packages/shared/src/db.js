"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSupabaseClient = getSupabaseClient;
exports.getPool = getPool;
exports.query = query;
exports.queryOne = queryOne;
exports.closePool = closePool;
const supabase_js_1 = require("@supabase/supabase-js");
const pg_1 = require("pg");
const config_1 = __importDefault(require("./config"));
let _supabase = null;
let _pool = null;
function getSupabaseClient() {
    if (!_supabase) {
        const env = (0, config_1.default)();
        _supabase = (0, supabase_js_1.createClient)(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false },
        });
    }
    return _supabase;
}
function getPool() {
    if (!_pool) {
        const env = (0, config_1.default)();
        _pool = new pg_1.Pool({
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
async function query(sql, params) {
    let retries = 2;
    while (retries >= 0) {
        try {
            const pool = getPool();
            const result = await pool.query(sql, params);
            return result.rows;
        }
        catch (err) {
            const isConnError = err?.message?.includes('Connection terminated') ||
                err?.message?.includes('connection timeout') ||
                err?.code === '57P01';
            if (isConnError && retries > 0) {
                console.warn(`⚠️ DB Connection lost, resetting pool and retrying (${retries} left)...`);
                await closePool();
                retries--;
                await new Promise((res) => setTimeout(res, 1000));
            }
            else {
                throw err;
            }
        }
    }
    throw new Error('Database query failed after retries');
}
async function queryOne(sql, params) {
    const rows = await query(sql, params);
    return rows[0] ?? null;
}
async function closePool() {
    if (_pool) {
        await _pool.end();
        _pool = null;
    }
}
//# sourceMappingURL=db.js.map