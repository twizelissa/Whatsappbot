import { Message, Transcript } from './types';
export declare function ingestMessage(msg: Omit<Message, 'id'>): Promise<string>;
export declare function ingestTranscript(transcript: Omit<Transcript, 'id'>[], callId: string): Promise<void>;
export declare function reembedUnprocessedChunks(batchSize?: number): Promise<number>;
