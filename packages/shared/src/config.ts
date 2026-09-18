import * as dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';

// Load from root .env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config(); // fallback to standard default location


const envSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  DATABASE_URL: z.string().url(),

  // WhatsApp Cloud API — optional, only needed if using Meta webhook (not Baileys-only mode)
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().optional().default(''),
  WHATSAPP_VERIFY_TOKEN: z.string().optional().default('unipods-bot'),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional().default(''),

  // LLM
  OPENAI_API_KEY: z.string().optional().transform(v => v || undefined),
  ANTHROPIC_API_KEY: z.string().optional().transform(v => v || undefined),
  GEMINI_API_KEY: z.string().optional().transform(v => v || undefined),
  LLM_PROVIDER: z.enum(['openai', 'anthropic', 'gemini']).default('gemini'),
  LLM_MODEL: z.string().default('gemini-1.5-flash'),

  // Embeddings
  EMBEDDING_PROVIDER: z.enum(['openai', 'gemini', 'local']).default('gemini'),
  EMBEDDING_MODEL: z.string().default('text-embedding-004'),
  EMBEDDING_DIMENSIONS: z.string().transform(Number).default('768'),

  // Whisper
  WHISPER_PROVIDER: z.enum(['openai', 'local']).default('openai'),
  WHISPER_MODEL: z.string().default('whisper-1'),
  RECORDINGS_DIR: z.string().default('./recordings'),

  // Microsoft Teams (Graph API) — optional; poller is silently disabled if not set
  TEAMS_TENANT_ID: z.string().optional().transform(v => v || undefined),
  TEAMS_CLIENT_ID: z.string().optional().transform(v => v || undefined),
  TEAMS_CLIENT_SECRET: z.string().optional().transform(v => v || undefined),
  TEAMS_USER_ID: z.string().optional().transform(v => v || undefined),    // OneDrive owner; blank = org-wide search

  // App config
  GROUP_ID: z.string().default(''),
  ANSWER_SERVICE_PORT: z.string().transform(Number).default('3000'),
  SCHEDULER_PORT: z.string().transform(Number).default('3001'),
  INGESTION_PORT: z.string().transform(Number).default('3002'),

  // Feature flags
  ENABLE_DUPLICATE_DETECTION: z.string().default('true'),
  ENABLE_PROACTIVE_RECAP: z.string().default('true'),
  DIGEST_CRON: z.string().default('0 8 * * *'), // daily at 8am

  // Similarity thresholds
  SIMILARITY_THRESHOLD: z.string().transform(Number).default('0.35'),
  LOW_CONFIDENCE_THRESHOLD: z.string().transform(Number).default('0.5'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env;

export function getEnv(): Env {
  if (!_env) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error('❌ Invalid environment variables:');
      console.error(result.error.flatten().fieldErrors);
      process.exit(1);
    }
    _env = result.data;
  }
  return _env;
}

export default getEnv;
