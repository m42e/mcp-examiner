import { useEffect, useState } from "react";
import { Activity, Box, Check } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionSnapshot, ProtocolEvent, ServerProfile } from "../../contracts";
import { endpointLabel, transportLabel } from "../../lib/profile";
import { isTauriRuntime } from "../../lib/tauri";

export function Overview({
  profile,
  protocolVersions,
  connection,
}: {
  profile: ServerProfile;
  protocolVersions: string[];
  connection: ConnectionSnapshot | null;
}) {
  const [events, setEvents] = useState<ProtocolEvent[]>([]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke<ProtocolEvent[]>("session_events", {
      request: { serverName: profile.name },
    }).then(setEvents).catch(() => setEvents([]));
  }, [profile.name, connection?.protocolVersion]);

  return (
    <div className="overview-grid">
      <section className="summary-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Configuration</span>
            <h2>Connection profile</h2>
          </div>
          <span className="source-pill">{profile.source.kind}</span>
        </div>
        <dl className="definition-grid">
          <div>
            <dt>Transport</dt>
            <dd>{transportLabel(profile.transport)}</dd>
          </div>
          <div>
            <dt>Trust</dt>
            <dd>{profile.trusted ? "Approved" : "Review required"}</dd>
          </div>
          <div className="definition-wide">
            <dt>Endpoint</dt>
            <dd className="mono">{endpointLabel(profile.transport)}</dd>
          </div>
          <div>
            <dt>Timeout</dt>
            <dd>{profile.timeoutMs ? `${profile.timeoutMs} ms` : "Default"}</dd>
          </div>
          <div>
            <dt>Source scope</dt>
            <dd>{profile.source.scope ?? "Configuration root"}</dd>
          </div>
        </dl>
      </section>

      <section className="versions-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Compatibility</span>
            <h2>Published revisions</h2>
          </div>
          <Box size={18} />
        </div>
        <ol className="version-list">
          {protocolVersions
            .slice()
            .reverse()
            .map((version, index) => (
              <li key={version}>
                <span className={index === 0 ? "version-current" : ""}>
                  {version}
                </span>
                <small>{index === 0 ? "Modern" : "Legacy"}</small>
                <Check size={14} />
              </li>
            ))}
        </ol>
      </section>

      <section className="activity-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Session</span>
            <h2>Protocol activity</h2>
          </div>
          <span className="event-count">{events.length} events</span>
        </div>
        {events.length > 0 ? (
          <div className="overview-events">
            {events.slice(-6).reverse().map((event) => (
              <div key={event.sequence}>
                <span>#{event.sequence}</span>
                <b className={`direction-${event.direction}`}>{event.direction}</b>
                <code>{event.method}</code>
                <small>{event.elapsedMs} ms</small>
              </div>
            ))}
          </div>
        ) : (
          <div className="activity-empty">
            <Activity size={22} />
            <span>{connection ? "Waiting for session events" : "No retained session traffic"}</span>
          </div>
        )}
      </section>
    </div>
  );
}
