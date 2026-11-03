import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  matchesKey,
  renderFakeCursor,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

/** Ghost text is a render overlay; it never enters the editor until accepted. */
export class SuggestionEditor extends CustomEditor {
  private suggestion: string | null = null;
  onDismissSuggestion?: () => void;
  colorSuggestion: (text: string) => string = (text) => `\x1b[90m${text}\x1b[39m`;

  setSuggestion(text: string | null): void {
    // Keep display and accepted text identical, without terminal controls or line breaks.
    const plain = text ? stripTerminalSequences(text).replace(/\s+/gu, " ").trim() : null;
    this.suggestion = plain && this.getText() === "" ? plain : null;
    this.invalidate();
    this.tui.requestRender();
  }

  private dismiss(): void {
    this.setSuggestion(null);
    this.onDismissSuggestion?.();
  }

  override setText(text: string): void {
    this.dismiss();
    super.setText(text);
  }

  override insertTextAtCursor(text: string): void {
    this.dismiss();
    super.insertTextAtCursor(text);
  }

  override handleInput(data: string): void {
    if (this.suggestion && this.getText() === "" && !this.isShowingAutocomplete()) {
      if (matchesKey(data, "tab")) {
        const text = this.suggestion;
        this.dismiss();
        super.setText(text);
        return;
      }
      if (matchesKey(data, "escape")) {
        this.dismiss();
        return;
      }
    }
    // Preserve all native editing, paste, app actions, and extension shortcuts.
    this.dismiss();
    super.handleInput(data);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (!this.suggestion || this.getText() !== "" || this.isShowingAutocomplete() || width < 1) {
      return lines;
    }
    const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
    const available = Math.max(1, width - padding * 2);
    // truncateToWidth may add ANSI resets; segment only the resulting plain text.
    const ghost = stripTerminalSequences(truncateToWidth(this.suggestion, available, "…")) || " ";
    const [first = " ", ...rest] = [...new Intl.Segmenter().segment(ghost)].map((part) => part.segment);
    const marker = this.focused ? CURSOR_MARKER : "";
    const display = this.colorSuggestion(renderFakeCursor(first)) + this.colorSuggestion(rest.join(""));
    lines[1] = " ".repeat(padding) + marker + display + " ".repeat(Math.max(0, width - padding - visibleWidth(ghost)));
    return lines;
  }
}
