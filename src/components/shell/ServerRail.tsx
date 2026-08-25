import { FileUp, Import, KeyRound, Network, Plus, Save, Search, Server, TerminalSquare } from "lucide-react";
import type { ConnectionSnapshot, ServerProfile } from "../../contracts";
import { transportLabel } from "../../lib/profile";

export type ServerRailProps = {
  profiles: ServerProfile[];
  filteredProfiles: ServerProfile[];
  selectedName: string | null;
  connections: Record<string, ConnectionSnapshot>;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (name: string) => void;
  onOpenConfig: () => void;
  onSaveConfig: () => void;
  onAddServer: () => void;
  onPasteConfig: () => void;
  onOpenSecrets: () => void;
};

export function ServerRail({
  profiles,
  filteredProfiles,
  selectedName,
  connections,
  query,
  onQueryChange,
  onSelect,
  onOpenConfig,
  onSaveConfig,
  onAddServer,
  onPasteConfig,
  onOpenSecrets,
}: ServerRailProps) {
  return (
    <aside className="server-rail">
      <div className="rail-heading">
        <span>Servers</span>
        <div className="rail-actions">
          <button className="icon-button icon-button-dark" type="button" aria-label="Open MCP configuration" title="Open MCP configuration" onClick={onOpenConfig}><FileUp size={15} /></button>
          <button className="icon-button icon-button-dark" type="button" aria-label="Save MCP configuration" title="Save MCP configuration" onClick={onSaveConfig} disabled={profiles.length === 0}><Save size={15} /></button>
          <button className="icon-button icon-button-dark" type="button" aria-label="Add MCP server" title="Add MCP server" onClick={onAddServer}><Plus size={15} /></button>
          <button className="icon-button icon-button-dark" type="button" aria-label="Paste MCP JSON" title="Paste MCP JSON" onClick={onPasteConfig}><Import size={15} /></button>
        </div>
      </div>

      <label className="server-search">
        <Search size={15} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="Filter servers"
        />
      </label>

      <div className="server-list">
        {filteredProfiles.map((profile) => (
          <button
            key={profile.name}
            className={`server-row ${
              profile.name === selectedName ? "server-row-active" : ""
            }`}
            type="button"
            onClick={() => onSelect(profile.name)}
          >
            <span className="server-icon">
              {profile.transport.type === "stdio" ? (
                <TerminalSquare size={16} />
              ) : (
                <Network size={16} />
              )}
            </span>
            <span className="server-row-copy">
              <strong>{profile.name}</strong>
              <small>{transportLabel(profile.transport)}</small>
            </span>
            <span
              className={`status-dot ${
                connections[profile.name] ? "status-dot-connected" : ""
              }`}
              title={connections[profile.name] ? "Connected" : "Disconnected"}
            />
          </button>
        ))}

        {profiles.length === 0 && (
          <div className="rail-empty">
            <Server size={24} />
            <span>No servers</span>
          </div>
        )}
      </div>

      <button className="rail-footer" type="button" onClick={onOpenSecrets} aria-label="Manage secrets" title="Manage secrets">
        <KeyRound size={14} />
        <span>Manage secrets</span>
      </button>
    </aside>
  );
}
