import { useEffect, useState } from "react";
import { Network, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { HttpObservation } from "../../contracts";

export function NetworkPanel({
  serverName,
  connected,
}: {
  serverName: string;
  connected: boolean;
}) {
  const [observations, setObservations] = useState<HttpObservation[]>([]);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setObservations(await invoke<HttpObservation[]>("http_observations", {
        request: { serverName },
      }));
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
          <span className="eyebrow">Streamable HTTP</span>
          <h2>Network observations</h2>
        </div>
        <button className="secondary-button" type="button" onClick={refresh} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} size={15} /> Refresh
        </button>
      </div>
      {observations.length > 0 ? (
        <div className="protocol-events">
          {observations.map((event) => (
            <details key={event.sequence}>
              <summary>
                <span>#{event.sequence}</span>
                <small>{event.elapsedMs} ms</small>
                <b>{event.method}</b>
                <code>{event.responseKind ?? "error"} / {event.url}</code>
              </summary>
              <div className="network-evidence">
                <section>
                  <h3>Request</h3>
                  <pre>{JSON.stringify({ headers: event.requestHeaders, body: event.requestBody }, null, 2)}</pre>
                </section>
                <section>
                  <h3>Response</h3>
                  <pre>{JSON.stringify({ body: event.responseBody ?? null, sessionId: event.sessionId, error: event.error }, null, 2)}</pre>
                </section>
              </div>
            </details>
          ))}
        </div>
      ) : (
        <div className="disconnected-panel compact">
          <Network size={26} />
          <span>{connected ? "No HTTP observations recorded" : "No retained HTTP history"}</span>
        </div>
      )}
    </div>
  );
}
