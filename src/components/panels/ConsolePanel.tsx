import { AlertTriangle, TerminalSquare, X } from "lucide-react";

export function ConsolePanel({
  serverName,
  connected,
  connectionError,
  onClearError,
}: {
  serverName: string;
  connected: boolean;
  connectionError: string | null;
  onClearError: () => void;
}) {
  return (
    <div className="protocol-panel console-panel">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">Connection log</span>
          <h2>Console</h2>
        </div>
        {connectionError && (
          <button className="secondary-button" type="button" onClick={onClearError}>
            <X size={15} /> Clear
          </button>
        )}
      </div>
      {connectionError ? (
        <div className="console-error" role="alert">
          <div className="console-error-heading">
            <AlertTriangle size={15} />
            <strong>Connection error</strong>
            <span>{serverName}</span>
          </div>
          <pre>{connectionError}</pre>
        </div>
      ) : (
        <div className="disconnected-panel compact">
          <TerminalSquare size={26} />
          <span>{connected ? "No console output" : "Not connected"}</span>
        </div>
      )}
    </div>
  );
}