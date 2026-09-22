import { RetrievedChunk, AnswerResponse, CatchUpResult, MeetingIntelligenceResult, ConfusionAssessment } from './types';
export declare function generateAnswer(question: string, chunks: RetrievedChunk[], options?: {
    isDuplicateQuestion?: boolean;
    duplicateContext?: string;
    freshnessMins?: number;
    userName?: string;
    conversationHistory?: string;
}): Promise<AnswerResponse>;
/**
 * Generate a digest summary for a given time period.
 */
export declare function generateDigest(chunks: RetrievedChunk[], period: {
    from: Date;
    to: Date;
}): Promise<string>;
/**
 * Generate a call recap from transcript chunks.
 */
export declare function generateCallRecap(chunks: RetrievedChunk[], callId: string): Promise<string>;
/**
 * Generate Catch-Up response ("What did I miss?")
 */
export declare function generateCatchUp(timeframeLabel: string, chunks: RetrievedChunk[], userName?: string): Promise<CatchUpResult>;
/**
 * Generate Meeting Intelligence (Summary, Decisions, Action Items, Speaker Mentions)
 */
export declare function generateMeetingIntelligence(callId: string, chunks: RetrievedChunk[]): Promise<MeetingIntelligenceResult>;
/**
 * Evaluate if multiple group members are asking similar questions or confused.
 * Used for Zeus Bot proactive intervention without explicit tag.
 */
export declare function detectGroupConfusion(recentMessages: {
    sender_name: string;
    text: string;
    timestamp: Date;
}[]): Promise<ConfusionAssessment>;
