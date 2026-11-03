import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { loadPromptSuggestionPlugin } from "@/lib/prompt-suggestions-plugin";
import { readPromptSuggestionSettings, writePromptSuggestionSettings } from "@/lib/prompt-suggestion-settings";
import { promptSuggestionModelOptions } from "@/lib/prompt-suggestion-models";

export const dynamic = "force-dynamic";
const cwdFor = (request: Request) => new URL(request.url).searchParams.get("cwd") || undefined;

export async function GET(request: Request) {
  try {
    const [settings, models] = await Promise.all([readPromptSuggestionSettings(), promptSuggestionModelOptions(cwdFor(request))]);
    return Response.json({ settings, models });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
  try {
    const api = await loadPromptSuggestionPlugin();
    const settings = api.normalizeSuggestionSettings(body);
    const models = await promptSuggestionModelOptions(cwdFor(request));
    if (settings.enabled) api.validatePredictionSelection(settings, models);
    const saved = await writePromptSuggestionSettings(settings);
    return Response.json({ settings: saved, models });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
