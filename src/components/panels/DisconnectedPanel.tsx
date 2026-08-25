import { Activity } from "lucide-react";
import { tabs, type TabId } from "../../lib/tabs";

export function DisconnectedPanel({ tab }: { tab: TabId }) {
  const currentTab = tabs.find((item) => item.id === tab);
  const Icon = currentTab?.icon ?? Activity;
  return (
    <div className="disconnected-panel">
      <Icon size={28} />
      <h2>{currentTab?.label}</h2>
      <span>Not connected</span>
    </div>
  );
}
