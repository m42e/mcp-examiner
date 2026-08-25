import {
  Activity,
  ClipboardCheck,
  FileCode2,
  FolderOpen,
  ListTree,
  Network,
  TerminalSquare,
  Wrench,
} from "lucide-react";

export const tabs = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "resources", label: "Resources", icon: FolderOpen },
  { id: "prompts", label: "Prompts", icon: FileCode2 },
  { id: "tests", label: "Tests", icon: ClipboardCheck },
  { id: "protocol", label: "Protocol", icon: ListTree },
  { id: "network", label: "Network", icon: Network },
  { id: "console", label: "Console", icon: TerminalSquare },
] as const;

export type TabId = (typeof tabs)[number]["id"];
