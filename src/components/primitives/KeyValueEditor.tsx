import { KeyRound, Plus, Trash2 } from "lucide-react";
import type { SecretSummary } from "../../contracts";
import type { KeyValueEntry } from "../../lib/profile";

export function KeyValueEditor({
  label,
  entries,
  secretIdPrefix,
  secrets,
  onChange,
}: {
  label: string;
  entries: KeyValueEntry[];
  secretIdPrefix: string;
  secrets: SecretSummary[];
  onChange: (entries: KeyValueEntry[]) => void;
}) {
  const secretListId = `secret-ids-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const suggestedSecretId = (key: string, index: number) => {
    const value = `${secretIdPrefix}-${key}`
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return value || `secret-${index + 1}`;
  };

  return (
    <fieldset className="key-value-editor">
      <legend>{label}</legend>
      {entries.map((entry, index) => (
        <div key={index}>
          <input
            aria-label={`${label} key ${index + 1}`}
            placeholder="Name"
            value={entry.key}
            onChange={(event) => onChange(entries.map((candidate, current) => current === index ? { ...candidate, key: event.currentTarget.value } : candidate))}
          />
          <input
            aria-label={`${label} value ${index + 1}`}
            placeholder="Value"
            type={entry.secret ? "password" : "text"}
            value={entry.value}
            onChange={(event) => onChange(entries.map((candidate, current) => current === index ? { ...candidate, value: event.currentTarget.value } : candidate))}
          />
          <label className="secret-toggle" title={entry.secret ? "Use a managed secret reference" : "Store this value in the OS keychain"}>
            <input
              type="checkbox"
              checked={entry.secret}
              aria-label={`Mark ${label} ${index + 1} as secret`}
              onChange={(event) => onChange(entries.map((candidate, current) => current === index ? {
                ...candidate,
                secret: event.currentTarget.checked,
                secretId: event.currentTarget.checked
                  ? candidate.secretId || suggestedSecretId(candidate.key, index)
                  : candidate.secretId,
              } : candidate))}
            />
            <KeyRound size={12} />
            <span>Secret</span>
          </label>
          <button className="icon-button" type="button" aria-label={`Remove ${label} ${index + 1}`} onClick={() => onChange(entries.filter((_, current) => current !== index))}><Trash2 size={14} /></button>
          {entry.secret && (
            <input
              className="secret-id-input"
              aria-label={`${label} secret ID ${index + 1}`}
              list={secretListId}
              placeholder="Secret ID"
              value={entry.secretId}
              onChange={(event) => onChange(entries.map((candidate, current) => current === index ? { ...candidate, secretId: event.currentTarget.value } : candidate))}
            />
          )}
        </div>
      ))}
      <button className="text-button" type="button" onClick={() => onChange([...entries, { key: "", value: "", secret: false, secretId: "" }])}><Plus size={14} /> Add {label.toLowerCase()}</button>
      <datalist id={secretListId}>
        {secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.label}</option>)}
      </datalist>
    </fieldset>
  );
}
