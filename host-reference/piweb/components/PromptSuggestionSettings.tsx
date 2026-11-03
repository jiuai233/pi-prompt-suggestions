"use client";

import { type CSSProperties, type MutableRefObject, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  ConfigButton,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigField,
  ConfigSectionTitle,
  ConfigSwitch,
} from "./SettingsUi";

export interface PromptSuggestionSettings {
  enabled: boolean;
  provider: string;
  modelId: string;
  thinkingLevel: string;
  preferences: string;
}

interface PredictionModel {
  provider: string;
  id: string;
  name: string;
  thinkingLevels: string[];
  supported: boolean;
  unsupportedReason?: string;
}

interface SettingsResponse {
  settings: PromptSuggestionSettings;
  models: PredictionModel[];
}

export interface PromptSuggestionDraft {
  cwd: string | null;
  settings: PromptSuggestionSettings;
  saved: PromptSuggestionSettings;
}

const copy = {
  en: {
    title: "Prompt suggestions",
    independent: "Uses its own prediction model, independently of the chat model.",
    enabled: "Enable prompt suggestions",
    model: "Prediction model",
    thinking: "Thinking level",
    preferences: "Your preferences",
    preferencesHint: "Write in your own words. Your text is saved exactly as entered.",
    reload: "Reload",
    retry: "Retry",
    empty: "No available models for predictions. Enable a supported model, then reload.",
    missing: "The current prediction model is unavailable. Select an available model.",
    choose: "Select an available model",
    invalidThinking: "Select a thinking level supported by this model.",
    noThinking: "Not available",
    loadFailed: "Could not load settings",
    saveFailed: "Could not save settings",
    unsaved: "Unsaved changes",
    saved: "Saved. Applies to the next prediction.",
  },
  "zh-CN": {
    title: "灰字预测",
    independent: "预测模型单独设置，与主聊天模型独立。",
    enabled: "启用灰字预测",
    model: "预测模型",
    thinking: "推理档位",
    preferences: "你的偏好",
    preferencesHint: "用自己的话填写，按原文保存。",
    reload: "重新读取",
    retry: "重试",
    empty: "暂无可用的预测模型。启用支持预测的模型后重新读取。",
    missing: "当前预测模型不可用，请选择可用模型。",
    choose: "请选择可用模型",
    invalidThinking: "请选择此模型支持的推理档位。",
    noThinking: "无可选档位",
    loadFailed: "读取设置失败",
    saveFailed: "保存设置失败",
    unsaved: "有未保存的更改",
    saved: "已保存，下一次预测生效。",
  },
  "zh-TW": {
    title: "灰字預測",
    independent: "預測模型單獨設定，與主聊天模型獨立。",
    enabled: "啟用灰字預測",
    model: "預測模型",
    thinking: "推理檔位",
    preferences: "你的偏好",
    preferencesHint: "用自己的話填寫，按原文儲存。",
    reload: "重新讀取",
    retry: "重試",
    empty: "暫無可用的預測模型。啟用支援預測的模型後重新讀取。",
    missing: "目前預測模型不可用，請選擇可用模型。",
    choose: "請選擇可用模型",
    invalidThinking: "請選擇此模型支援的推理檔位。",
    noThinking: "無可選檔位",
    loadFailed: "讀取設定失敗",
    saveFailed: "儲存設定失敗",
    unsaved: "有未儲存的變更",
    saved: "已儲存，下一次預測生效。",
  },
};

// Local copy until this page joins the shared message catalog.
export function promptSuggestionCopy(locale: keyof typeof copy) {
  return copy[locale];
}

const noteStyle: CSSProperties = {
  margin: 0, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere",
};
const inputStyle: CSSProperties = {
  width: "100%", minWidth: 0, maxWidth: 320, padding: "6px 9px", boxSizing: "border-box",
  background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 5,
  color: "var(--text)", fontFamily: "inherit", fontSize: "inherit", lineHeight: 1.5,
};
const modelKey = (model: { provider: string; id: string }) => JSON.stringify([model.provider, model.id]);

export function PromptSuggestionSettingsDetail({ cwd, draftRef }: {
  cwd: string | null;
  /** The Models panel owns the raw draft across trips to other sidebar entries. */
  draftRef: MutableRefObject<PromptSuggestionDraft | null>;
}) {
  const { locale, t } = useI18n();
  const text = promptSuggestionCopy(locale);
  const [saved, setSaved] = useState<PromptSuggestionSettings | null>(() => (
    draftRef.current?.cwd === cwd ? draftRef.current.saved : null
  ));
  const [draft, setDraft] = useState<PromptSuggestionSettings | null>(() => (
    draftRef.current?.cwd === cwd ? draftRef.current.settings : null
  ));
  const [models, setModels] = useState<PredictionModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const mounted = useRef(false);
  const endpoint = `/api/prompt-suggestions/settings${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setSavedOk(false);
    fetch(endpoint, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as SettingsResponse & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        return data;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setSaved(data.settings);
        setModels(data.models);
        // Keep only genuinely unsaved edits; a clean snapshot must follow the
        // server on Reload and when returning from another sidebar entry.
        const retained = draftRef.current;
        const hasEdits = retained?.cwd === cwd && JSON.stringify(retained.settings) !== JSON.stringify(retained.saved);
        const settings = hasEdits ? retained.settings : data.settings;
        draftRef.current = { cwd, settings, saved: data.settings };
        setDraft(settings);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cwd, draftRef, endpoint, reload]);

  const update = (settings: PromptSuggestionSettings) => {
    draftRef.current = { cwd, settings, saved: saved ?? settings };
    setDraft(settings);
    setSavedOk(false);
    setSaveError(null);
  };
  // Apply the same selectable catalog after reads and save responses without
  // replacing an unavailable model in the saved settings or the raw draft.
  const selectableModels = models.filter((model) => model.supported);
  const selected = draft ? selectableModels.find((model) => model.provider === draft.provider && model.id === draft.modelId) : undefined;
  const validThinking = selected && (selected.thinkingLevels.length === 0 || selected.thinkingLevels.includes(draft?.thinkingLevel ?? ""));
  const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
  // Turning predictions off remains possible if their model was disabled elsewhere.
  const canSave = Boolean(dirty && draft && !loading && !loadError && !saving
    && (!draft.enabled || (selected && validThinking)));

  const save = async () => {
    if (!draft || !canSave) return;
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await response.json() as SettingsResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      // A completed save may follow navigation. Do not replace a newer draft.
      const unchanged = draftRef.current?.cwd === cwd && draftRef.current.settings === draft;
      if (unchanged) draftRef.current = { cwd, settings: data.settings, saved: data.settings };
      else if (draftRef.current?.cwd === cwd) {
        draftRef.current = { ...draftRef.current, saved: data.settings };
      }
      if (!mounted.current) return;
      setSaved(data.settings);
      setModels(data.models);
      if (unchanged) setDraft(data.settings);
      setSavedOk(true);
    } catch (error: unknown) {
      if (mounted.current) setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <ConfigDetailStack>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <ConfigSectionTitle>{text.title}</ConfigSectionTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <ConfigButton size="small" disabled={loading || saving} onClick={() => setReload((value) => value + 1)}>
            {loadError ? text.retry : text.reload}
          </ConfigButton>
          <ConfigButton
            variant="primary"
            size="small"
            disabled={!canSave}
            className={savedOk ? "is-success" : undefined}
            onClick={() => void save()}
          >
            {savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}
          </ConfigButton>
        </ConfigDetailActions>
      </ConfigDetailHeader>

      <p style={noteStyle}>{text.independent}</p>
      {loading && <p role="status" style={noteStyle}>{t("i18n.loading")}</p>}
      {loadError && <p role="alert" style={{ ...noteStyle, color: "#f87171" }}>{text.loadFailed}: {loadError}</p>}

      {draft && (
        <>
          <ConfigField label={text.enabled}>
            <ConfigSwitch
              checked={draft.enabled}
              label={text.enabled}
              disabled={saving}
              onChange={(enabled) => update({ ...draft, enabled })}
            />
          </ConfigField>

          <ConfigField label={text.model}>
            <select
              aria-label={text.model}
              value={selected ? modelKey(selected) : ""}
              disabled={loading || saving || Boolean(loadError) || selectableModels.length === 0}
              style={inputStyle}
              onChange={(event) => {
                const model = selectableModels.find((entry) => modelKey(entry) === event.target.value);
                if (!model) return;
                update({
                  ...draft, provider: model.provider, modelId: model.id,
                  thinkingLevel: model.thinkingLevels.includes(draft.thinkingLevel)
                    ? draft.thinkingLevel : model.thinkingLevels[0] ?? draft.thinkingLevel,
                });
              }}
            >
              {!selected && <option disabled value="">{text.choose}</option>}
              {selectableModels.map((model) => (
                <option key={modelKey(model)} value={modelKey(model)}>
                  {model.name} · {model.provider}
                </option>
              ))}
            </select>
            {!loading && !loadError && selectableModels.length === 0 && <p role="status" style={noteStyle}>{text.empty}</p>}
            {!loading && !loadError && selectableModels.length > 0 && !selected && <p role="status" style={noteStyle}>{text.missing}</p>}
          </ConfigField>

          <ConfigField label={text.thinking}>
            <select
              aria-label={text.thinking}
              value={draft.thinkingLevel}
              disabled={loading || saving || Boolean(loadError) || !selected || selected.thinkingLevels.length === 0}
              style={inputStyle}
              onChange={(event) => update({ ...draft, thinkingLevel: event.target.value })}
            >
              {(!selected || selected.thinkingLevels.length === 0 || !validThinking) && (
                <option value={draft.thinkingLevel} disabled>{selected?.thinkingLevels.length ? text.invalidThinking : text.noThinking}</option>
              )}
              {selected?.thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
            {selected && !validThinking && <p role="status" style={noteStyle}>{text.invalidThinking}</p>}
          </ConfigField>

          <ConfigField label={text.preferences}>
            <textarea
              aria-label={text.preferences}
              value={draft.preferences}
              rows={8}
              disabled={saving}
              style={{ ...inputStyle, maxWidth: "100%", resize: "vertical" }}
              onChange={(event) => update({ ...draft, preferences: event.target.value })}
            />
            <p style={noteStyle}>{text.preferencesHint}</p>
          </ConfigField>

          {(dirty || savedOk) && <p role="status" style={noteStyle}>{savedOk ? text.saved : text.unsaved}</p>}
          {saveError && <p role="alert" style={{ ...noteStyle, color: "#f87171" }}>{text.saveFailed}: {saveError}</p>}
        </>
      )}
    </ConfigDetailStack>
  );
}
