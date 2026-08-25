import { useState } from "react";
import { AlertTriangle, LoaderCircle, Save, X } from "lucide-react";
import type { SecretSummary, TransportConfig } from "../../contracts";
import type { ServerDraft, ServerEditorState } from "../../lib/profile";
import { KeyValueEditor } from "../primitives/KeyValueEditor";

export function ServerDialog({
  state,
  protocolVersions,
  secrets,
  onChange,
  onSave,
  onClose,
}: {
  state: ServerEditorState;
  protocolVersions: string[];
  secrets: SecretSummary[];
  onChange: (state: ServerEditorState) => void;
  onSave: (draft: ServerDraft, originalName: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { draft } = state;
  const update = (patch: Partial<ServerDraft>) => onChange({ ...state, draft: { ...draft, ...patch } });
  const remote = draft.transportType !== "stdio";

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="server-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError(null);
          void onSave(draft, state.originalName)
            .catch((saveError) => setError(String(saveError)))
            .finally(() => setSaving(false));
        }}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Server configuration</span>
            <h2 id="server-dialog-title">{state.originalName ? "Edit MCP server" : "Add MCP server"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <div className="server-form">
          <label><span>Name</span><input autoFocus value={draft.name} onChange={(event) => update({ name: event.currentTarget.value })} /></label>
          <label><span>Transport</span><select value={draft.transportType} onChange={(event) => update({ transportType: event.currentTarget.value as TransportConfig["type"] })}><option value="stdio">Standard I/O</option><option value="http">Streamable HTTP</option><option value="sse">HTTP + SSE</option><option value="auto">Auto-detect</option><option value="websocket">WebSocket</option></select></label>
          <label><span>Protocol</span><select value={draft.protocol} onChange={(event) => update({ protocol: event.currentTarget.value })}><option value="auto">Auto negotiate</option>{protocolVersions.map((version) => <option key={version} value={`exact:${version}`}>{version}</option>)}</select></label>
          <label><span>Timeout (ms)</span><input type="number" min="1" value={draft.timeout} onChange={(event) => update({ timeout: event.currentTarget.value })} placeholder="Default" /></label>

          {remote ? (
            <>
              <label className="server-form-wide"><span>URL</span><input type="url" value={draft.url} onChange={(event) => update({ url: event.currentTarget.value })} placeholder="https://example.com/mcp" /></label>
              <div className="server-form-wide"><KeyValueEditor label="Headers" entries={draft.headers} secretIdPrefix={draft.name} secrets={secrets} onChange={(headers) => update({ headers })} /></div>
              {draft.transportType !== "websocket" && (
                <fieldset className="oauth-fields server-form-wide">
                  <legend>OAuth (optional)</legend>
                  <label><span>Client ID</span><input value={draft.oauthClientId} onChange={(event) => update({ oauthClientId: event.currentTarget.value })} /></label>
                  <label><span>Scopes</span><input value={draft.oauthScopes} onChange={(event) => update({ oauthScopes: event.currentTarget.value })} /></label>
                  <label className="server-form-wide"><span>Authorization metadata URL</span><input type="url" value={draft.oauthMetadataUrl} onChange={(event) => update({ oauthMetadataUrl: event.currentTarget.value })} /></label>
                  <label><span>Callback port</span><input type="number" min="1" max="65535" value={draft.oauthCallbackPort} onChange={(event) => update({ oauthCallbackPort: event.currentTarget.value })} /></label>
                  <label className="checkbox-label"><input type="checkbox" checked={draft.oauthEnterpriseManaged} onChange={(event) => update({ oauthEnterpriseManaged: event.currentTarget.checked })} /><span>Enterprise managed</span></label>
                </fieldset>
              )}
            </>
          ) : (
            <>
              <label className="server-form-wide"><span>Command</span><input value={draft.command} onChange={(event) => update({ command: event.currentTarget.value })} placeholder="npx" /></label>
              <label className="server-form-wide"><span>Arguments (one per line)</span><textarea value={draft.args} onChange={(event) => update({ args: event.currentTarget.value })} /></label>
              <label><span>Working directory</span><input value={draft.cwd} onChange={(event) => update({ cwd: event.currentTarget.value })} /></label>
              <label><span>Environment file</span><input value={draft.envFile} onChange={(event) => update({ envFile: event.currentTarget.value })} /></label>
              <div className="server-form-wide"><KeyValueEditor label="Environment" entries={draft.env} secretIdPrefix={draft.name} secrets={secrets} onChange={(env) => update({ env })} /></div>
            </>
          )}
        </div>

        {error && <div className="import-message import-error"><AlertTriangle size={15} /><span>{error}</span></div>}
        <footer className="dialog-footer">
          <button className="text-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} {saving ? "Saving" : "Save server"}</button>
        </footer>
      </form>
    </div>
  );
}
