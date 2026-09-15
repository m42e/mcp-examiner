import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileUp, Import, KeyRound, Network, Plus, Save, Search, Server, TerminalSquare } from "lucide-react";
import type { ConnectionSnapshot, ServerProfile } from "../../contracts";
import { transportLabel } from "../../lib/profile";

export type ServerRailProps = {
  profiles: ServerProfile[];
  filteredProfiles: ServerProfile[];
  selectedName: string | null;
  connections: Record<string, ConnectionSnapshot>;
  configDirty: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (name: string) => void;
  onOpenConfig: () => void;
  onSaveConfig: () => Promise<boolean>;
  onSaveConfigAs: () => Promise<boolean>;
  onAddServer: () => void;
  onPasteConfig: () => void;
  onOpenSecrets: () => void;
};

export function ServerRail({
  profiles,
  filteredProfiles,
  selectedName,
  connections,
  configDirty,
  query,
  onQueryChange,
  onSelect,
  onOpenConfig,
  onSaveConfig,
  onSaveConfigAs,
  onAddServer,
  onPasteConfig,
  onOpenSecrets,
}: ServerRailProps) {
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState(false);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  const saveFeedbackTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!saveMenuOpen) return;
    function closeMenu(event: PointerEvent) {
      if (!saveMenuRef.current?.contains(event.target as Node)) {
        setSaveMenuOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setSaveMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [saveMenuOpen]);

  useEffect(() => () => {
    if (saveFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(saveFeedbackTimeoutRef.current);
    }
  }, []);

  async function runSave(save: () => Promise<boolean>) {
    if (!(await save())) return;
    setSaveFeedback(true);
    if (saveFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(saveFeedbackTimeoutRef.current);
    }
    saveFeedbackTimeoutRef.current = window.setTimeout(() => {
      setSaveFeedback(false);
      saveFeedbackTimeoutRef.current = null;
    }, 1400);
  }

  const saveButtonClassName = [
    "icon-button",
    "icon-button-dark",
    "rail-save-button",
    configDirty ? "rail-save-button-dirty" : "",
    saveFeedback && !configDirty ? "rail-save-button-saved" : "",
  ].filter(Boolean).join(" ");

  return (
    <aside className="server-rail">
      <div className="rail-heading">
        <span>Servers</span>
        <div className="rail-actions">
          <button className="icon-button icon-button-dark" type="button" aria-label="Open MCP configuration" title="Open MCP configuration" onClick={onOpenConfig}><FileUp size={15} /></button>
          <div className="rail-save-menu" ref={saveMenuRef}>
            <button className={saveButtonClassName} type="button" aria-label="Save MCP configuration" title={configDirty ? "Save MCP configuration (unsaved changes)" : saveFeedback ? "Configuration saved" : "Save MCP configuration"} onClick={() => { setSaveMenuOpen(false); void runSave(onSaveConfig); }} disabled={profiles.length === 0}><Save size={15} /></button>
            <button className="icon-button icon-button-dark rail-save-menu-trigger" type="button" aria-label="Save MCP configuration options" title="Save MCP configuration options" aria-expanded={saveMenuOpen} aria-haspopup="menu" onClick={() => setSaveMenuOpen((open) => !open)} disabled={profiles.length === 0}><ChevronDown size={13} /></button>
            {saveMenuOpen && (
              <div className="rail-save-menu-panel" role="menu" aria-label="Save configuration">
                <button className="rail-save-menu-item" type="button" role="menuitem" onClick={() => { setSaveMenuOpen(false); void runSave(onSaveConfigAs); }}><Save size={14} /> Save as...</button>
              </div>
            )}
          </div>
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
