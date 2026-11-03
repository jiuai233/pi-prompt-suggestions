import type { Api, AssistantMessage, Message, Model, TranscriptContext } from "@earendil-works/pi-ai";
import type { ModelRuntime, ProjectedSessionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface SuggestionOptions {
  enabled?: boolean;
  model: Model<Api>;
  messages: readonly Message[];
  compaction?: { id: string; messages: readonly Message[] };
  complete: (model: Model<Api>, context: TranscriptContext, options: NonNullable<Parameters<ModelRuntime["completeSimple"]>[2]>) => Promise<AssistantMessage>;
  signal?: AbortSignal;
  sessionId?: string;
  agentDir?: string;
  isCurrent?: () => boolean;
  preferences?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  revision?: string;
}
export interface SuggestionResult { text: string | null; usage?: unknown; }
export const PREDICTION_INSTRUCTION: string;
export const EVIDENCE_INSTRUCTION: string;
export function supportsSuggestion(model: Pick<Model<Api>, "api"> | undefined): boolean;
export function supportsPersistentSuggestion(model: Pick<Model<Api>, "api" | "provider"> | undefined): boolean;
export function buildSuggestionMessages(messages: readonly Message[], preferences?: string, revision?: string): Message[];
export function buildCompactedSuggestionContext(branch: readonly SessionEntry[], projectedEntries: readonly ProjectedSessionEntry[]): { id: string; messages: ProjectedSessionEntry["messages"] } | undefined;
export function generateSuggestion(options: SuggestionOptions): Promise<SuggestionResult>;
