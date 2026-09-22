"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.embed = embed;
exports.embedOne = embedOne;
exports.cosineSimilarity = cosineSimilarity;
exports.toVectorString = toVectorString;
exports.chunkText = chunkText;
const openai_1 = __importDefault(require("openai"));
const generative_ai_1 = require("@google/generative-ai");
const config_1 = __importDefault(require("./config"));
let _openai = null;
let _geminiClient = null;
function getOpenAI() {
    if (!_openai) {
        const env = (0, config_1.default)();
        _openai = new openai_1.default({ apiKey: env.OPENAI_API_KEY });
    }
    return _openai;
}
function getGeminiClient() {
    if (!_geminiClient) {
        const env = (0, config_1.default)();
        if (!env.GEMINI_API_KEY)
            throw new Error('GEMINI_API_KEY is not set');
        _geminiClient = new generative_ai_1.GoogleGenerativeAI(env.GEMINI_API_KEY);
    }
    return _geminiClient;
}
/**
 * Generate embeddings for one or more text strings.
 * Returns an array of embedding vectors.
 */
async function embed(texts) {
    const env = (0, config_1.default)();
    if (env.EMBEDDING_PROVIDER === 'openai') {
        return embedOpenAI(texts);
    }
    if (env.EMBEDDING_PROVIDER === 'gemini') {
        return embedGemini(texts);
    }
    // Fallback: local embedding via sentence-transformers HTTP endpoint
    return embedLocal(texts);
}
async function embedOne(text) {
    const results = await embed([text]);
    return results[0];
}
async function embedOpenAI(texts) {
    const env = (0, config_1.default)();
    const openai = getOpenAI();
    // OpenAI max batch = 2048 strings; we chunk to be safe
    const BATCH_SIZE = 100;
    const results = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const res = await openai.embeddings.create({
            model: env.EMBEDDING_MODEL,
            input: batch,
            dimensions: env.EMBEDDING_DIMENSIONS,
        });
        for (const item of res.data) {
            results.push(item.embedding);
        }
    }
    return results;
}
async function embedGemini(texts) {
    const env = (0, config_1.default)();
    const model = getGeminiClient().getGenerativeModel({ model: env.EMBEDDING_MODEL });
    const results = [];
    // Gemini embedding API processes one text at a time
    for (const text of texts) {
        const result = await model.embedContent(text);
        results.push(result.embedding.values);
    }
    return results;
}
async function embedLocal(texts) {
    // Expects a local embedding server running at EMBEDDING_LOCAL_URL
    // e.g. using llama.cpp, Ollama, or sentence-transformers server
    const url = process.env.EMBEDDING_LOCAL_URL ?? 'http://localhost:8080/embedding';
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
    });
    if (!res.ok)
        throw new Error(`Local embedding server error: ${res.status}`);
    const data = (await res.json());
    return data.embeddings;
}
/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
/**
 * Format embedding as Postgres vector string: '[0.1,0.2,...]'
 */
function toVectorString(embedding) {
    return `[${embedding.join(',')}]`;
}
/**
 * Chunk text into overlapping segments for embedding.
 * Returns array of {text, startIdx, endIdx}.
 */
function chunkText(text, chunkSize = 500, overlap = 50) {
    const words = text.split(/\s+/);
    const chunks = [];
    for (let i = 0; i < words.length; i += chunkSize - overlap) {
        const slice = words.slice(i, i + chunkSize);
        if (slice.length === 0)
            break;
        chunks.push({
            text: slice.join(' '),
            startIdx: i,
            endIdx: i + slice.length - 1,
        });
        if (i + chunkSize >= words.length)
            break;
    }
    return chunks;
}
//# sourceMappingURL=embeddings.js.map