import { Cable, ChevronRight, CircleDot, FileInput, FolderOpen } from "lucide-react";
import type { RecentConfig } from "../../contracts";

type EmptyWorkspaceProps = {
  recentConfigs: RecentConfig[];
  onSelectConfig: (path: string) => void;
  onImport: () => void;
};

function configName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function EmptyWorkspace({
  recentConfigs,
  onSelectConfig,
  onImport,
}: EmptyWorkspaceProps) {
  return (
    <section className="empty-workspace">
      <div className="empty-signal" aria-hidden="true">
        <span />
        <Cable size={30} />
        <span />
      </div>
      <span className="eyebrow">Workspace ready</span>
      <h1>No servers configured</h1>
      {recentConfigs.length > 0 && (
        <div className="recent-configs" aria-label="Previously loaded configurations">
          <span className="recent-configs-heading">Previously loaded</span>
          <div className="recent-config-list">
            {recentConfigs.map((config) => (
              <button
                key={config.path}
                className="recent-config-button"
                type="button"
                title={config.path}
                onClick={() => onSelectConfig(config.path)}
              >
                <FolderOpen size={17} />
                <span>
                  <strong>{configName(config.path)}</strong>
                  <small>{config.path}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="empty-actions">
        <button className="primary-button" type="button" onClick={onImport}>
          <FileInput size={17} /> Import config
        </button>
      </div>
      <div className="supported-row" aria-label="Supported config families">
        <span>VS Code</span>
        <CircleDot size={10} />
        <span>Claude</span>
        <CircleDot size={10} />
        <span>Inspector</span>
      </div>
    </section>
  );
}
