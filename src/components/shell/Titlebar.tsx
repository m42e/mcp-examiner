import { Activity } from "lucide-react";
import type { AppInfo } from "../../contracts";

export function Titlebar({ appInfo }: { appInfo: AppInfo }) {
  return (
    <header className="titlebar">
      <div className="brand-block">
        <div className="brand-mark" aria-hidden="true">
          <Activity size={18} strokeWidth={2.4} />
        </div>
        <span className="brand-name">{appInfo.name}</span>
        <span className="build-tag">v{appInfo.version}</span>
      </div>
      <div className="titlebar-status">
        <span className="local-indicator">
          <span className="local-dot" /> Local workspace
        </span>
        <span className="revision-count">
          {appInfo.protocolVersions.length} revisions
        </span>
      </div>
    </header>
  );
}
