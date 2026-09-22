"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEnv = getEnv;
const dotenv = __importStar(require("dotenv"));
const zod_1 = require("zod");
const path_1 = __importDefault(require("path"));
// Load from root .env
dotenv.config({ path: path_1.default.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path_1.default.resolve(process.cwd(), '.env') });
dotenv.config(); // fallback to standard default location
const envSchema = zod_1.z.object({
    // Supabase
    SUPABASE_URL: zod_1.z.string().url(),
    SUPABASE_SERVICE_KEY: zod_1.z.string().min(1),
    DATABASE_URL: zod_1.z.string().url(),
    // WhatsApp Cloud API — optional, only needed if using Meta webhook (not Baileys-only mode)
    WHATSAPP_PHONE_NUMBER_ID: zod_1.z.string().optional().default(''),
    WHATSAPP_ACCESS_TOKEN: zod_1.z.string().optional().default(''),
    WHATSAPP_VERIFY_TOKEN: zod_1.z.string().optional().default('unipods-bot'),
    WHATSAPP_BUSINESS_ACCOUNT_ID: zod_1.z.string().optional().default(''),
    // LLM
    OPENAI_API_KEY: zod_1.z.string().optional().transform(v => v || undefined),
    ANTHROPIC_API_KEY: zod_1.z.string().optional().transform(v => v || undefined),
    GEMINI_API_KEY: zod_1.z.string().optional().transform(v => v || undefined),
    LLM_PROVIDER: zod_1.z.enum(['openai', 'anthropic', 'gemini']).default('gemini'),
    LLM_MODEL: zod_1.z.string().default('gemini-1.5-flash'),
    // Embeddings
    EMBEDDING_PROVIDER: zod_1.z.enum(['openai', 'gemini', 'local']).default('gemini'),
    EMBEDDING_MODEL: zod_1.z.string().default('text-embedding-004'),
    EMBEDDING_DIMENSIONS: zod_1.z.string().transform(Number).default('768'),
    // Whisper
    WHISPER_PROVIDER: zod_1.z.enum(['openai', 'local']).default('openai'),
    WHISPER_MODEL: zod_1.z.string().default('whisper-1'),
    RECORDINGS_DIR: zod_1.z.string().default('./recordings'),
    // Microsoft Teams (Graph API) — optional; poller is silently disabled if not set
    TEAMS_TENANT_ID: zod_1.z.string().optional().transform(v => v || undefined),
    TEAMS_CLIENT_ID: zod_1.z.string().optional().transform(v => v || undefined),
    TEAMS_CLIENT_SECRET: zod_1.z.string().optional().transform(v => v || undefined),
    TEAMS_USER_ID: zod_1.z.string().optional().transform(v => v || undefined), // OneDrive owner; blank = org-wide search
    // App config
    GROUP_ID: zod_1.z.string().default(''),
    ANSWER_SERVICE_PORT: zod_1.z.string().transform(Number).default('3000'),
    SCHEDULER_PORT: zod_1.z.string().transform(Number).default('3001'),
    INGESTION_PORT: zod_1.z.string().transform(Number).default('3002'),
    // Feature flags
    ENABLE_DUPLICATE_DETECTION: zod_1.z.string().default('true'),
    ENABLE_PROACTIVE_RECAP: zod_1.z.string().default('true'),
    DIGEST_CRON: zod_1.z.string().default('0 8 * * *'), // daily at 8am
    // Similarity thresholds
    SIMILARITY_THRESHOLD: zod_1.z.string().transform(Number).default('0.35'),
    LOW_CONFIDENCE_THRESHOLD: zod_1.z.string().transform(Number).default('0.5'),
});
let _env;
function getEnv() {
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
exports.default = getEnv;
//# sourceMappingURL=config.js.map