import type { Api, Model } from "@earendil-works/pi-ai";
import type { SuggestionOptions } from "./core.mjs";
export * from "./core.mjs";
export const apiVersion: 1;
export type SuggestionThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface SuggestionSettings {
  enabled: boolean;
  provider: string;
  modelId: string;
  thinkingLevel: SuggestionThinkingLevel;
  preferences: string;
}
export interface SuggestionModelOption {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: string[];
  supported: boolean;
  unsupportedReason?: string;
}
export const DEFAULT_PREFERENCES: string;
export const DEFAULT_SETTINGS: Readonly<SuggestionSettings>;
export const THINKING_LEVELS: readonly SuggestionThinkingLevel[];
export function suggestionSettingsPath(agentDir: string): string;
export function normalizeSuggestionSettings(value: unknown): SuggestionSettings;
export function readSuggestionSettings(agentDir: string): Promise<SuggestionSettings>;
export function writeSuggestionSettings(agentDir: string, patch: Partial<SuggestionSettings>): Promise<SuggestionSettings>;
export function subscribeSuggestionSettings(agentDir: string, listener: (settings: SuggestionSettings) => void): () => void;
export function suggestionModelOption(model: Model<Api>, thinkingLevels: readonly string[]): SuggestionModelOption;
export function validatePredictionSelection(settings: SuggestionSettings, models: readonly SuggestionModelOption[]): SuggestionModelOption;
export type SuggestionRequest = SuggestionOptions & { revision: string; isCurrent: () => boolean };
export class SuggestionController {
  text: string | null;
  constructor(onChange: (text: string | null) => void, onError?: (error: unknown) => void);
  start(request: SuggestionRequest): Promise<void> | undefined;
  clear(): void;
}
export interface SuggestionCommandOptions {
  agentDir: string;
  getModels: () => Promise<readonly SuggestionModelOption[]>;
  ui?: {
    select(title: string, options: string[]): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
  };
  overrides?: Partial<SuggestionSettings>;
}
export function runSuggestionCommand(message: string, options: SuggestionCommandOptions): Promise<string>;
