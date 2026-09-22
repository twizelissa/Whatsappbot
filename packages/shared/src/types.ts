export type KnowledgeType =
  | 'MESSAGE'
  | 'MEETING'
  | 'MEETING_TRANSCRIPT'
  | 'DOCUMENT'
  | 'DECISION'
  | 'ACTION_ITEM'
  | 'ANNOUNCEMENT';

export interface KnowledgeObject {
  id: string;
  type: KnowledgeType;
  title: string;
  content: string;
  timestamp: Date;
  author?: string;
  participants?: string[];
  source: string;
  source_url?: string;
  group_id?: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
}

export interface Message {
  id: string;
  sender: string;
  sender_name: string;
  timestamp: Date;
  text: string | null;
  source: 'whatsapp' | 'call_transcript' | 'document';
  media_url: string | null;
  media_type: string | null;
  reply_to: string | null;
  group_id: string;
  is_admin: boolean;           // true if sender was a group admin at time of message
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
  source_type: 'message' | 'transcript' | 'document';
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
  title?: string;
  source_type: 'message' | 'transcript' | 'document';
  call_id?: string;
  group_id?: string;
  is_admin?: boolean;   // true if the original sender was a group admin
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
  humor_note?: string;
}

export interface SourceCitation {
  date: string;
  sender?: string;
  source_type: 'message' | 'transcript' | 'document';
  snippet: string;
  title?: string;
  call_id?: string;
}

export interface CatchUpTimeframe {
  period: 'today' | 'yesterday' | 'this_week' | 'custom';
  hours?: number;
}

export interface CatchUpResult {
  timeframe: string;
  summary: string;
  important_conversations: {
    topic: string;
    summary: string;
    participants: string[];
  }[];
  missed_meetings: {
    title: string;
    date: string;
    summary: string;
    decisions_count: number;
  }[];
  key_decisions: {
    decision: string;
    context: string;
    agreed_by?: string;
  }[];
  action_items: {
    task: string;
    assignee: string;
    due_date?: string;
  }[];
  personal_mentions: {
    sender: string;
    snippet: string;
    timestamp: string;
  }[];
}

export interface MeetingIntelligenceResult {
  call_id: string;
  title: string;
  date: string;
  duration_mins?: number;
  participants: string[];
  summary: string;
  decisions: string[];
  action_items: { assignee: string; task: string }[];
  speaker_mentions: { speaker: string; count: number }[];
}

export interface GroupInfo {
  jid: string;
  subject: string;
  participant_count?: number;
  joined_at?: string;
  is_active: boolean;
}

export interface BotStatusResponse {
  status: 'working' | 'sleeping';
  mode: 'active' | 'standby';
  active_groups_count: number;
  groups: GroupInfo[];
  total_messages: number;
  total_chunks: number;
  total_answers: number;
  last_message_at: string | null;
  uptime_seconds: number;
}

export interface ConfusionAssessment {
  is_confused: boolean;
  topic?: string;
  reason?: string;
  confidence: number;
  suggested_answer?: string;
  suggested_answer_query?: string;
}

export interface DigestEntry {
  period_start: Date;
  period_end: Date;
  message_count: number;
  key_topics: string[];
  summary: string;
  action_items: string[];
}

