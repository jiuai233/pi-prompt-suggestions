import { type Api, getSupportedThinkingLevels, type Message, type Model } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  buildCompactedSuggestionContext, readSuggestionSettings, runSuggestionCommand,
  SuggestionController, type SuggestionModelOption, type SuggestionSettings,
  subscribeSuggestionSettings, suggestionModelOption, validatePredictionSelection,
} from "./api.mjs";
import { SuggestionEditor } from "./editor.js";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

export default function promptSuggestions(pi: ExtensionAPI): void {
  pi.registerFlag("suggestions", { description: "Enable idle next-message suggestions for this process", type: "boolean" });
  pi.registerFlag("suggestions-model", { description: "Prediction model as provider/model; does not change the main model", type: "string" });
  pi.registerFlag("suggestions-thinking", { description: "Prediction thinking level", type: "string" });
  pi.registerFlag("suggestions-preferences", { description: "User preference reference text for this process", type: "string" });

  let editor: SuggestionEditor | undefined;
  let requestMessages: Message[] | undefined;
  let installedFactory: EditorFactory | undefined;
  let previousFactory: EditorFactory | undefined;
  let unsubscribeSettings: (() => void) | undefined;
  let generation = 0;
  let currentContext: ExtensionContext | undefined;
  const overrides: Partial<SuggestionSettings> = {};
  const engine = new SuggestionController((text) => editor?.setSuggestion(text), (error) => {
    currentContext?.ui.setStatus("prompt-suggestions", `预测失败：${error instanceof Error ? error.message : String(error)}`);
  });

  function clear(): void { generation++; engine.clear(); editor?.setSuggestion(null); }

  async function models(ctx: ExtensionContext): Promise<Array<{ model: Model<Api>; option: SuggestionModelOption }>> {
    const visible = ctx.scopedModels?.length ? ctx.scopedModels.map((item) => item.model) : await ctx.modelRegistry.getAvailable();
    return visible.map((model) => ({ model, option: suggestionModelOption(model, getSupportedThinkingLevels(model)) }));
  }

  function readFlags(): void {
    const enabled = pi.getFlag("suggestions");
    if (typeof enabled === "boolean") overrides.enabled = enabled;
    const target = pi.getFlag("suggestions-model");
    if (typeof target === "string") {
      const slash = target.indexOf("/");
      if (slash < 1 || slash === target.length - 1) throw new Error("--suggestions-model 需要 provider/model。");
      overrides.provider = target.slice(0, slash);
      overrides.modelId = target.slice(slash + 1);
    }
    const level = pi.getFlag("suggestions-thinking");
    if (typeof level === "string") overrides.thinkingLevel = level as SuggestionSettings["thinkingLevel"];
    const preferences = pi.getFlag("suggestions-preferences");
    if (typeof preferences === "string") overrides.preferences = preferences;
  }

  pi.registerCommand("suggestions", {
    description: "灰字预测：开关、独立选模、推理档位和用户偏好原文",
    handler: async (args, ctx) => {
      clear();
      try {
        const result = await runSuggestionCommand(`/suggestions ${args}`, {
          agentDir: getAgentDir(), getModels: async () => (await models(ctx)).map((item) => item.option),
          ui: ctx.ui, overrides,
        });
        if (ctx.mode === "print") console.log(result);
        else ctx.ui.notify(result, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.mode === "print") { console.error(message); process.exitCode = 1; }
        else ctx.ui.notify(message, "error");
      }
    },
  });

  async function start(ctx: ExtensionContext): Promise<void> {
    const target = editor;
    if (!target || !requestMessages || ctx.ui.getEditorComponent() !== installedFactory ||
        !ctx.isIdle() || ctx.hasPendingMessages() || target.getText() !== "") return;
    const projection = ctx.sessionManager.buildSessionProjection();
    const last = convertToLlm(projection.messages).at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop") return;
    const version = generation;
    const leafId = ctx.sessionManager.getLeafId();
    const sessionId = ctx.sessionManager.getSessionId();
    const captured = requestMessages;
    const isCurrent = () => generation === version && editor === target && requestMessages === captured &&
      ctx.sessionManager.getSessionId() === sessionId && ctx.sessionManager.getLeafId() === leafId &&
      ctx.ui.getEditorComponent() === installedFactory && ctx.isIdle() && !ctx.hasPendingMessages() && target.getText() === "";
    const settings = { ...await readSuggestionSettings(getAgentDir()), ...overrides };
    if (!settings.enabled || !isCurrent()) return;
    const choices = await models(ctx);
    if (!isCurrent()) return;
    validatePredictionSelection(settings, choices.map((item) => item.option));
    const model = choices.find((item) => item.option.provider === settings.provider && item.option.id === settings.modelId)!.model;
    ctx.ui.setStatus("prompt-suggestions", undefined);
    const compacted = buildCompactedSuggestionContext(ctx.sessionManager.getBranch(), projection.entries);
    engine.start({
      ...settings, model, messages: [...captured, last], sessionId, agentDir: getAgentDir(),
      compaction: compacted && { id: compacted.id, messages: convertToLlm(compacted.messages) },
      revision: leafId ?? String(last.timestamp), isCurrent,
      complete: (selected, context, options) => ctx.modelRegistry.streamSimple(selected, context, options).result(),
    });
  }

  pi.on("session_start", (_event, ctx) => {
    clear();
    unsubscribeSettings?.();
    requestMessages = undefined;
    editor = undefined;
    currentContext = ctx;
    readFlags();
    if (ctx.mode !== "tui") return;
    unsubscribeSettings = subscribeSuggestionSettings(getAgentDir(), clear);
    if (ctx.ui.getEditorComponent() !== installedFactory) previousFactory = ctx.ui.getEditorComponent();
    installedFactory = (tui, theme, keybindings) => {
      clear();
      const next = new SuggestionEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      next.onDismissSuggestion = clear;
      next.colorSuggestion = (text) => ctx.ui.theme.fg("dim", text);
      editor = next;
      return next;
    };
    ctx.ui.setEditorComponent(installedFactory);
  });
  pi.on("agent_settled", (event, ctx) => {
    if (ctx.mode !== "tui" || !editor) return;
    if (event.aborted) clear();
    else void start(ctx).catch((error: unknown) => ctx.ui.setStatus("prompt-suggestions", `预测失败：${error instanceof Error ? error.message : String(error)}`));
  });
  pi.on("context_with_system", (event, ctx) => {
    if (ctx.mode === "tui" && editor && ctx.ui.getEditorComponent() === installedFactory) requestMessages = structuredClone(convertToLlm(event.messages));
  });
  pi.on("input", () => clear());
  pi.on("agent_start", () => { requestMessages = undefined; clear(); });
  pi.on("model_select", () => clear());
  pi.on("session_before_switch", () => clear());
  pi.on("session_before_fork", () => clear());
  pi.on("session_before_tree", () => clear());
  pi.on("session_tree", () => clear());
  pi.on("session_before_compact", () => clear());
  pi.on("session_shutdown", (_event, ctx) => {
    clear(); unsubscribeSettings?.(); unsubscribeSettings = undefined;
    editor = undefined; currentContext = undefined;
    ctx.ui.setStatus("prompt-suggestions", undefined);
    if (installedFactory && ctx.ui.getEditorComponent() === installedFactory) ctx.ui.setEditorComponent(previousFactory);
    installedFactory = undefined; previousFactory = undefined;
  });
}
