import { RetrievedChunk } from './types';
export interface SearchOptions {
    groupId?: string;
    sourceType?: 'message' | 'transcript' | 'all';
    topK?: number;
    dateFrom?: Date;
    dateTo?: Date;
    recencyBoost?: boolean;
}
/**
 * Hybrid search: combines vector similarity (semantic) with keyword (FTS) matching.
 * Results are re-ranked with recency boost applied.
 */
export declare function hybridSearch(question: string, options?: SearchOptions): Promise<RetrievedChunk[]>;
/**
 * Find if a question has been asked (and answered) before.
 * Returns the previous answer context if found, null otherwise.
 */
export declare function findDuplicateQuestion(question: string, threshold?: number): Promise<{
    context: string;
    date: string;
} | null>;
/**
 * Returns the most recent sync timestamp (latest message/transcript ingested).
 */
export declare function getLastSyncTimestamp(): Promise<Date | null>;
/**
 * Retrieves the most recent chunks from the database (for summary requests).
 */
export declare function getRecentChunks(groupId?: string, limit?: number): Promise<RetrievedChunk[]>;
/**
 * Retrieves the last N messages/answers for a specific group/DM JID to provide multi-turn conversation memory.
 */
export declare function getRecentThreadHistory(jid: string, limit?: number): Promise<string>;
/**
 * Get chunks for Catch-Up summary within a relative hours window (e.g. 24h, 48h, 168h)
 */
export declare function getCatchUpChunks(groupId?: string, hours?: number, limit?: number): Promise<RetrievedChunk[]>;
/**
 * Get transcript chunks for a specific meeting / call
 */
export declare function getMeetingChunks(callId: string): Promise<RetrievedChunk[]>;
