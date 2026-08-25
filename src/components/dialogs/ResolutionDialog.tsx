import { useState } from "react";
import { AlertTriangle, LoaderCircle, PlugZap, X } from "lucide-react";
import type { ConfigInputDefinition } from "../../contracts";

export type ResolutionDialogProps = {
  serverName: string;
  inputs: ConfigInputDefinition[];
  storedSecretIds: string[];
  onConnect: (values: Record<string, string>) => Promise<void>;
  onClose: () => void;
};

export function ResolutionDialog({
  serverName,
  inputs,
  storedSecretIds,
  onConnect,
  onClose,
}: ResolutionDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(inputs.map((input) => [input.id, input.defaultValue ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const stored = new Set(storedSecretIds);
  const complete = inputs.every((input) => values[input.id]?.length > 0 || (input.secret && stored.has(input.id)));

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="resolution-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resolution-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!complete || connecting) return;
          setConnecting(true);
          setError(null);
          void onConnect(values)
            .catch((connectError) => setError(String(connectError)))
            .finally(() => setConnecting(false));
        }}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Connection values</span>
            <h2 id="resolution-title">Connect to {serverName}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="resolution-fields">
          {inputs.map((input) => (
            <label key={input.id}>
              <span>{input.description}</span>
              {input.kind === "pick" && input.options.length > 0 ? (
                <select
                  value={values[input.id]}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setValues((current) => ({
                      ...current,
                      [input.id]: value,
                    }));
                  }}
                >
                  <option value="">Select a value</option>
                  {input.options.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={input.secret ? "password" : "text"}
                  value={values[input.id]}
                  autoComplete="off"
                  autoFocus={input === inputs[0]}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setValues((current) => ({
                      ...current,
                      [input.id]: value,
                    }));
                  }}
                />
              )}
              {input.kind === "command" && (
                <small>Command inputs are never executed; provide the resulting value.</small>
              )}
              {input.secret && stored.has(input.id) && (
                <small>Stored in the OS keychain. Enter a new value to replace it.</small>
              )}
            </label>
          ))}
        </div>
        {error && <div className="import-message import-error"><AlertTriangle size={15} /><span>{error}</span></div>}
        <footer className="dialog-footer">
          <button className="text-button" type="button" onClick={onClose} disabled={connecting}>Cancel</button>
          <button
            className="primary-button"
            type="submit"
            disabled={!complete || connecting}
            aria-label="Connect"
          >
            {connecting ? <LoaderCircle className="spin" size={16} /> : <PlugZap size={16} />} {connecting ? "Connecting" : "Connect"}
          </button>
        </footer>
      </form>
    </div>
  );
}
