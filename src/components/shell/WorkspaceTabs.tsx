import type { TabId } from "../../lib/tabs";
import { tabs } from "../../lib/tabs";

export type WorkspaceTabsProps = {
  activeTab: TabId;
  tabCounts: Partial<Record<TabId, number>>;
  onSelect: (tab: TabId) => void;
};

export function WorkspaceTabs({ activeTab, tabCounts, onSelect }: WorkspaceTabsProps) {
  return (
    <nav className="workspace-tabs" aria-label="Server inspector">
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={activeTab === id ? "tab-active" : ""}
          type="button"
          onClick={() => onSelect(id)}
        >
          <Icon size={15} />
          {label}
          {tabCounts[id] !== undefined && (
            <span
              className="tab-count"
              aria-label={`${tabCounts[id]} ${id === "protocol" ? "messages" : id}`}
            >
              {tabCounts[id]}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}
