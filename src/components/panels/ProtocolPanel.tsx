import { useEffect, useState } from "react";
import { AlertTriangle, ListTree, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { ProtocolEvent } from "../../contracts";

export function ProtocolPanel({
  serverName,
  connected,
}: {
  serverName: string;
  connected: boolean;
}) {
  const [events, setEvents] = useState<ProtocolEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<ProtocolEvent[]>("session_events", {
        request: { serverName },
      });
      setEvents(next);
    } catch (eventError) {
      setError(String(eventError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [serverName, connected]);

  return (
    <div className="protocol-panel">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">Redacted semantic events</span>
          <h2>Protocol timeline</h2>
        </div>
        <button className="secondary-button" type="button" onClick={refresh} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} size={15} /> Refresh
        </button>
      </div>
      {error && <p className="automation-error"><AlertTriangle size={14} /> {error}</p>}
      {events.length > 0 ? (
        <div className="protocol-events">
          {events.map((event) => (
            <details key={event.sequence} open={event.direction === "internal"}>
              <summary>
                <span>#{event.sequence}</span>
                <small>{event.elapsedMs} ms</small>
                <b className={`direction-${event.direction}`}>{event.direction}</b>
                <code>{event.method}</code>
              </summary>
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </details>
          ))}
        </div>
      ) : (
        <div className="disconnected-panel compact">
          <ListTree size={26} />
          <span>{connected ? "No protocol events recorded" : "No retained session history"}</span>
        </div>
      )}
    </div>
  );
}
