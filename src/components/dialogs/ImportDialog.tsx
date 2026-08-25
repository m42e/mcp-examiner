import { AlertTriangle, ArrowRight, FileUp, Info, Save, Server, X } from "lucide-react";
import type { ConfigSourceKind, ImportResult } from "../../contracts";
import { transportLabel } from "../../lib/profile";
import { isTauriRuntime } from "../../lib/tauri";

export type ImportDialogProps = {
  content: string;
  path: string | null;
  source: ConfigSourceKind;
  result: ImportResult | null;
  error: string | null;
  isImporting: boolean;
  onContentChange: (value: string) => void;
  onLoad: () => void;
  onSave: () => void;
  onSourceChange: (value: ConfigSourceKind) => void;
  onPreview: () => void;
  onAccept: () => void;
  onClose: () => void;
};

export function ImportDialog({
  content,
  path,
  source,
  result,
  error,
  isImporting,
  onContentChange,
  onLoad,
  onSave,
  onSourceChange,
  onPreview,
  onAccept,
  onClose,
}: ImportDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Configuration</span>
            <h2 id="import-title">Import servers</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="import-controls">
          <label>
            <span>Format</span>
            <select
              value={source}
              onChange={(event) =>
                onSourceChange(event.currentTarget.value as ConfigSourceKind)
              }
            >
              <option value="auto">Auto detect</option>
              <option value="vsCode">VS Code</option>
              <option value="claude">Claude</option>
              <option value="inspector">Inspector</option>
              <option value="generic">Generic MCP</option>
            </select>
          </label>
          <div className="document-actions">
            <button className="text-button" type="button" onClick={onLoad} disabled={!isTauriRuntime()}>
              <FileUp size={14} /> Open
            </button>
            <button className="text-button" type="button" onClick={onSave} disabled={!isTauriRuntime()}>
              <Save size={14} /> Save
            </button>
          </div>
        </div>

        <label className="config-editor">
          <span className="document-label"><strong>JSON configuration</strong><code>{path ?? "Unsaved mcp.json"}</code></span>
          <textarea
            value={content}
            onChange={(event) => onContentChange(event.currentTarget.value)}
            spellCheck={false}
          />
        </label>

        {error && (
          <div className="import-message import-error">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div className="import-preview">
            <div className="preview-summary">
              <strong>{result.profiles.length} servers found</strong>
              <span>{result.sourceKind}</span>
            </div>
            <div className="preview-list">
              {result.profiles.map((profile) => (
                <div key={profile.name} className="preview-row">
                  <Server size={15} />
                  <strong>{profile.name}</strong>
                  <span>{transportLabel(profile.transport)}</span>
                </div>
              ))}
            </div>
            {result.diagnostics.map((diagnostic, index) => (
              <div className="import-message" key={`${diagnostic.message}-${index}`}>
                <Info size={15} />
                <span>{diagnostic.message}</span>
              </div>
            ))}
          </div>
        )}

        <footer className="dialog-footer">
          <button className="text-button" type="button" onClick={onClose}>
            Cancel
          </button>
          {result ? (
            <button
              className="primary-button"
              type="button"
              onClick={onAccept}
              disabled={result.profiles.length === 0}
            >
              Import {result.profiles.length}
              <ArrowRight size={16} />
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              onClick={onPreview}
              disabled={isImporting || content.trim().length === 0}
            >
              {isImporting ? "Reading..." : "Preview"}
              <ArrowRight size={16} />
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
