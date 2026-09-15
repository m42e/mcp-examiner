import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileUp, FolderOpen, Settings2 } from "lucide-react";
import type { AppInfo, RecentConfig } from "../../contracts";

export const fontScaleOptions = [
  { value: 1, label: "Default", detail: "100%" },
  { value: 1.15, label: "Large", detail: "115%" },
  { value: 1.3, label: "Larger", detail: "130%" },
] as const;

export type FontScale = (typeof fontScaleOptions)[number]["value"];

type TitlebarProps = {
  appInfo: AppInfo;
  fontScale: FontScale;
  recentConfigs: RecentConfig[];
  onFontScaleChange: (fontScale: FontScale) => void;
  onSelectConfig: (path: string) => void;
  onOpenConfig: () => void;
};

function configName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function Titlebar({
  appInfo,
  fontScale,
  recentConfigs,
  onFontScaleChange,
  onSelectConfig,
  onOpenConfig,
}: TitlebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function closeMenu(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    function closeSettings(event: PointerEvent) {
      if (!settingsRef.current?.contains(event.target as Node)) {
        setSettingsOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setSettingsOpen(false);
    }
    document.addEventListener("pointerdown", closeSettings);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeSettings);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [settingsOpen]);

  return (
    <header className="titlebar">
      <div className="brand-block">
        <div className="brand-mark" aria-hidden="true">
          <img src="/mcp-examiner-logo.svg" alt="" />
        </div>
        <div className="config-menu" ref={menuRef}>
          <button
            className="config-menu-trigger"
            type="button"
            aria-label="Load configuration"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            title="Load configuration"
            onClick={() => {
              setSettingsOpen(false);
              setMenuOpen((open) => !open);
            }}
          >
            <ChevronDown size={14} />
          </button>
          {menuOpen && (
            <div className="config-menu-panel" role="menu" aria-label="Configurations">
              <span className="config-menu-heading">Recent configurations</span>
              {recentConfigs.length === 0 ? (
                <span className="config-menu-empty">No recent configurations</span>
              ) : (
                recentConfigs.map((config) => (
                  <button
                    key={config.path}
                    className="config-menu-item"
                    type="button"
                    role="menuitem"
                    title={config.path}
                    onClick={() => {
                      setMenuOpen(false);
                      onSelectConfig(config.path);
                    }}
                  >
                    <FolderOpen size={15} />
                    <span>
                      <strong>{configName(config.path)}</strong>
                      <small>{config.path}</small>
                    </span>
                  </button>
                ))
              )}
              <div className="config-menu-divider" />
              <button
                className="config-menu-open"
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenConfig();
                }}
              >
                <FileUp size={15} /> Open configuration...
              </button>
            </div>
          )}
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
        <div className="settings-menu" ref={settingsRef}>
          <button
            className="icon-button"
            type="button"
            aria-label="Open settings"
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            title="Settings"
            onClick={() => {
              setMenuOpen(false);
              setSettingsOpen((open) => !open);
            }}
          >
            <Settings2 size={15} />
          </button>
          {settingsOpen && (
            <div className="settings-menu-panel" role="dialog" aria-label="Settings">
              <div className="settings-menu-header">
                <strong>Settings</strong>
                <span>Workspace preferences</span>
              </div>
              <div className="settings-menu-control">
                <span className="settings-menu-label">Font size</span>
                <div className="settings-size-options" role="group" aria-label="Font size">
                  {fontScaleOptions.map((option) => (
                    <button
                      key={option.value}
                      className="settings-size-option"
                      type="button"
                      aria-pressed={fontScale === option.value}
                      onClick={() => onFontScaleChange(option.value)}
                    >
                      <strong>{option.label}</strong>
                      <small>{option.detail}</small>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
