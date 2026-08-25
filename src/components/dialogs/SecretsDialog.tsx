import { useState } from "react";
import { AlertTriangle, Eye, EyeOff, KeyRound, LoaderCircle, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { SecretSummary } from "../../contracts";
import { isTauriRuntime } from "../../lib/tauri";

type SecretEditorState = {
  id: string;
  label: string;
  value: string;
  existing: boolean;
};

export function SecretsDialog({
  secrets,
  error,
  onChanged,
  onClose,
}: {
  secrets: SecretSummary[];
  error: string | null;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [editor, setEditor] = useState<SecretEditorState | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function addSecret() {
    setFormError(null);
    setEditor({ id: "", label: "", value: "", existing: false });
  }

  function editSecret(secret: SecretSummary) {
    setFormError(null);
    setEditor({ id: secret.id, label: secret.label, value: "", existing: true });
  }

  async function saveSecret() {
    if (!editor || !isTauriRuntime()) {
      setFormError("Secret storage requires the MCP Examiner desktop runtime.");
      return;
    }
    const id = editor.id.trim();
    if (!id) {
      setFormError("Secret ID is required.");
      return;
    }

    setBusy(true);
    setFormError(null);
    try {
      const value = editor.value || (editor.existing
        ? await invoke<string>("get_secret", { id })
        : "");
      if (!value) throw new Error("Secret value is required.");
      await invoke<SecretSummary>("set_secret", {
        request: { id, label: editor.label, value },
      });
      await onChanged();
      setRevealed((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setEditor(null);
    } catch (saveError) {
      setFormError(String(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSecret(secret: SecretSummary) {
    if (!window.confirm(`Delete the managed secret '${secret.label}'?`)) return;
    setBusy(true);
    setFormError(null);
    try {
      await invoke("delete_secret", { id: secret.id });
      setRevealed((current) => {
        const next = { ...current };
        delete next[secret.id];
        return next;
      });
      await onChanged();
      if (editor?.id === secret.id) setEditor(null);
    } catch (deleteError) {
      setFormError(String(deleteError));
    } finally {
      setBusy(false);
    }
  }

  async function toggleReveal(secret: SecretSummary) {
    if (revealed[secret.id] !== undefined) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[secret.id];
        return next;
      });
      return;
    }
    try {
      const value = await invoke<string>("get_secret", { id: secret.id });
      setRevealed((current) => ({ ...current, [secret.id]: value }));
      setFormError(null);
    } catch (revealError) {
      setFormError(String(revealError));
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="secrets-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="secrets-dialog-title"
      >
        <header className="dialog-header secrets-dialog-header">
          <div>
            <span className="eyebrow">Local credentials</span>
            <h2 id="secrets-dialog-title">Managed secrets</h2>
          </div>
          <div className="secret-dialog-actions">
            <button className="secondary-button" type="button" onClick={addSecret} disabled={busy}>
              <Plus size={15} /> Add secret
            </button>
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="secret-list" aria-label="Managed secrets">
          {secrets.map((secret) => (
            <div className="secret-row" key={secret.id}>
              <KeyRound size={16} aria-hidden="true" />
              <div className="secret-row-copy">
                <strong>{secret.label}</strong>
                <small><code>{secret.id}</code> / {secret.available ? "OS keychain" : "Unavailable"}</small>
              </div>
              <code className={`secret-value ${secret.available ? "" : "secret-value-unavailable"}`}>
                {revealed[secret.id] ?? "********"}
              </code>
              <div className="secret-row-actions">
                <button className="icon-button" type="button" disabled={!secret.available || busy} onClick={() => void toggleReveal(secret)} aria-label={`${revealed[secret.id] !== undefined ? "Hide" : "Reveal"} ${secret.label}`} title={revealed[secret.id] !== undefined ? "Hide secret" : "Reveal secret"}>
                  {revealed[secret.id] !== undefined ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button className="icon-button" type="button" disabled={busy} onClick={() => editSecret(secret)} aria-label={`Edit ${secret.label}`} title="Edit secret"><Pencil size={14} /></button>
                <button className="icon-button" type="button" disabled={busy} onClick={() => void deleteSecret(secret)} aria-label={`Delete ${secret.label}`} title="Delete secret"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
          {secrets.length === 0 && <div className="secret-list-empty"><KeyRound size={22} /><span>No managed secrets</span><small>Add one here or mark a server header/environment value as secret.</small></div>}
        </div>

        {(error || formError) && <div className="secret-dialog-message" role="alert"><AlertTriangle size={15} /><span>{formError ?? error}</span></div>}

        {editor && (
          <form className="secret-form" onSubmit={(event) => { event.preventDefault(); void saveSecret(); }}>
            <div className="secret-form-heading">
              <span className="eyebrow">{editor.existing ? "Update credential" : "New credential"}</span>
              <strong>{editor.existing ? editor.id : "Add a keychain entry"}</strong>
            </div>
            <label><span>Secret ID</span><input autoFocus={!editor.existing} value={editor.id} disabled={editor.existing} onChange={(event) => setEditor({ ...editor, id: event.currentTarget.value })} placeholder="github-token" /></label>
            <label><span>Label</span><input value={editor.label} onChange={(event) => setEditor({ ...editor, label: event.currentTarget.value })} placeholder="GitHub token" /></label>
            <label><span>{editor.existing ? "Replacement value" : "Value"}</span><input type="password" autoComplete="new-password" value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.currentTarget.value })} placeholder={editor.existing ? "Leave blank to keep current value" : "Enter secret value"} /></label>
            <footer className="dialog-footer">
              <button className="text-button" type="button" onClick={() => setEditor(null)} disabled={busy}>Cancel</button>
              <button className="primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} {busy ? "Saving" : "Save secret"}</button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
