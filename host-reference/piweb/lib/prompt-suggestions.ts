import type { SuggestionRequest, SuggestionController } from "../../../../plugins/prompt-suggestions/api.mjs";
import { loadPromptSuggestionPlugin, type PromptSuggestionPlugin } from "./prompt-suggestions-plugin";

/** Web only forwards the plugin's ephemeral text into the existing SSE channel. */
export class PromptSuggestions {
  text: string | null = null;
  private engine: SuggestionController | undefined;
  private plugin: PromptSuggestionPlugin | undefined;
  private generation = 0;
  private key: string | null = null;
  constructor(private readonly onChange: (text: string | null) => void) {}

  clear(): void {
    this.generation++;
    this.key = null;
    this.engine?.clear();
    if (this.text !== null) { this.text = null; this.onChange(null); }
  }

  start(request: SuggestionRequest): void {
    if (!request.enabled) { this.clear(); return; }
    const key = JSON.stringify([request.model.provider, request.model.id, request.revision, request.thinkingLevel, request.preferences]);
    if (key === this.key) return;
    this.clear();
    this.key = key;
    const generation = this.generation;
    void loadPromptSuggestionPlugin().then((api) => {
      if (generation !== this.generation || !request.isCurrent()) return;
      if (this.plugin !== api) {
        this.engine?.clear();
        this.plugin = api;
        this.engine = new api.SuggestionController((text) => {
          this.text = text;
          this.onChange(text);
        }, (error) => console.error("[pi-web] prompt suggestion failed:", error));
      }
      this.engine!.start(request);
    }).catch((error: unknown) => console.error("[pi-web] prompt suggestion plugin failed:", error));
  }
}
