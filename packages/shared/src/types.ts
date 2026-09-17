// Shared types across all packages

export interface Message {
  id: string;
  sender: string;
  sender_name: string;
  timestamp: Date;
  text: string | null;
  source: 'whatsapp' | 'call_transcript';
  media_url: string | null;
  media_type: string | null;
  reply_to: string | null;
  group_id: string;
  metadata: Record<string, unknown>;
}

export interface Transcript {
  id: string;
  call_id: string;
  timestamp: number; // seconds from start of call
  speaker: string | null;
  text: string;
  metadata: Record<string, unknown>;
}

export interface Chunk {
  id: string;
  source_id: string;
  source_type: 'message' | 'transcript';
  text: string;
  embedding?: number[];
  metadata: ChunkMetadata;
  created_at: Date;
}

export interface ChunkMetadata {
  date: string;         // ISO date
  sender?: string;
  sender_name?: string;
  speaker?: string;
  source_type: 'message' | 'transcript';
  call_id?: string;
  group_id?: string;
  has_been_answered?: boolean;
}

export interface RetrievedChunk extends Chunk {
  similarity: number;
  rank?: number;
}

export interface AnswerRequest {
  question: string;
  user_phone: string;
  user_name?: string;
  group_id?: string;
}

export interface AnswerResponse {
  answer: string;
  sources: SourceCitation[];
  confidence: 'high' | 'medium' | 'low' | 'insufficient';
  is_duplicate_question: boolean;
  duplicate_context?: string;
}

export interface SourceCitation {
  date: string;
  sender?: string;
  source_type: 'message' | 'transcript';
  snippet: string;
  call_id?: string;
}

export interface DigestEntry {
  period_start: Date;
  period_end: Date;
  message_count: number;
  key_topics: string[];
  summary: string;
  action_items: string[];
}
