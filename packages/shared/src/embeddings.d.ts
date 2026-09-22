/**
 * Generate embeddings for one or more text strings.
 * Returns an array of embedding vectors.
 */
export declare function embed(texts: string[]): Promise<number[][]>;
export declare function embedOne(text: string): Promise<number[]>;
/**
 * Cosine similarity between two vectors.
 */
export declare function cosineSimilarity(a: number[], b: number[]): number;
/**
 * Format embedding as Postgres vector string: '[0.1,0.2,...]'
 */
export declare function toVectorString(embedding: number[]): string;
/**
 * Chunk text into overlapping segments for embedding.
 * Returns array of {text, startIdx, endIdx}.
 */
export declare function chunkText(text: string, chunkSize?: number, overlap?: number): {
    text: string;
    startIdx: number;
    endIdx: number;
}[];
