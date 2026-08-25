import { useEffect, useMemo, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Box,
  Braces,
  Cable,
  Check,
  ChevronDown,
  CircleDot,
  ClipboardCheck,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  FileInput,
  FileUp,
  FolderOpen,
  Import,
  Info,
  KeyRound,
  ListTree,
  LoaderCircle,
  Network,
  Pencil,
  Play,
  Plus,
  PlugZap,
  RefreshCw,
  Save,
  Search,
  Server,
  TerminalSquare,
  Trash2,
  Unplug,
  WandSparkles,
  Wrench,
  X,
} from "lucide-react";
import "./App.css";
import type {
  AppInfo,
  AutomatedRunResponse,
  CallRunResult,
  ConfigInputDefinition,
  ConfigSourceKind,
  ConnectionSnapshot,
  HttpObservation,
  ImportResult,
  PromptSummary,
  ProtocolEvent,
  ProtocolSelection,
  RunProgress,
  RunStatus,
  RunSummary,
  ServerProfile,
  ResourceSummary,
  ResourceTemplateSummary,
  SaveReportResponse,
  SecretSummary,
  ToolSummary,
  TransportConfig,
} from "./contracts";

const fallbackInfo: AppInfo = {
  name: "MCP Check",
  version: "0.1.0",
  formatVersion: 1,
  protocolVersions: [
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
    "2026-07-28",
  ],
};

const tabs = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "resources", label: "Resources", icon: FolderOpen },
  { id: "prompts", label: "Prompts", icon: FileCode2 },
  { id: "tests", label: "Tests", icon: ClipboardCheck },
  { id: "protocol", label: "Protocol", icon: ListTree },
  { id: "network", label: "Network", icon: Network },
  { id: "console", label: "Console", icon: TerminalSquare },
] as const;

type TabId = (typeof tabs)[number]["id"];

type TestDocument = {
  content: string;
  path: string | null;
};

type LiveRunCall = {
  index: number;
  operation: string;
  target: string;
  status: "pending" | "running" | RunStatus;
  result?: CallRunResult;
};

type LiveRunState = {
  name: string;
  total: number;
  protocolVersion: string | null;
  summary: RunSummary;
  calls: LiveRunCall[];
  connectionError: string | null;
};

type TestRunState = {
  run: AutomatedRunResponse | null;
  liveRun: LiveRunState | null;
  isRunning: boolean;
  reportPath: string;
  savedReports: SaveReportResponse | null;
};

type TestRunStateUpdate = TestRunState | ((current: TestRunState) => TestRunState);

function emptyTestRunState(): TestRunState {
  return {
    run: null,
    liveRun: null,
    isRunning: false,
    reportPath: "mcp-check-report.html",
    savedReports: null,
  };
}

type KeyValueEntry = { key: string; value: string; secret: boolean; secretId: string };

type ServerDraft = {
  name: string;
  transportType: TransportConfig["type"];
  command: string;
  args: string;
  cwd: string;
  env: KeyValueEntry[];
  envFile: string;
  url: string;
  headers: KeyValueEntry[];
  protocol: string;
  timeout: string;
  oauthClientId: string;
  oauthScopes: string;
  oauthMetadataUrl: string;
  oauthCallbackPort: string;
  oauthEnterpriseManaged: boolean;
};

type ServerEditorState = {
  originalName: string | null;
  draft: ServerDraft;
};

const exampleConfig = `{
  "mcpServers": {
    "local-tools": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server"]
    }
  }
}`;

const exampleTestSet = `name: Server smoke test
calls:
  - type: callTool
    name: echo
    arguments:
      message: hello
    expect:
      contains: hello
`;

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function transportLabel(transport: TransportConfig) {
  switch (transport.type) {
    case "stdio":
      return "Standard I/O";
    case "http":
      return "Streamable HTTP";
    case "sse":
      return "HTTP + SSE";
    case "auto":
      return "Auto-detect";
  }
}

function endpointLabel(transport: TransportConfig) {
  if (transport.type === "stdio") {
    return [transport.command, ...transport.args].join(" ");
  }
  return transport.url;
}

function protocolValue(protocol: ProtocolSelection) {
  switch (protocol.mode) {
    case "legacy":
      return `exact:${protocol.version ?? "2025-11-25"}`;
    case "auto":
      return "auto";
    case "modern":
      return "exact:2026-07-28";
    case "exact":
      return `exact:${protocol.version}`;
  }
}

function protocolFromValue(value: string): ProtocolSelection {
  if (value === "auto") {
    return { mode: "auto", legacyVersion: "2025-11-25" };
  }

  const version = value.replace("exact:", "");
  if (version === "2026-07-28") {
    return { mode: "modern" };
  }
  return { mode: "exact", version };
}

function referencedInputIds(profile: ServerProfile) {
  const ids = new Set<string>();
  for (const match of JSON.stringify(profile).matchAll(/\$\{input:([^}]+)\}/g)) {
    ids.add(match[1]);
  }
  return ids;
}

function referencedSecretIds(profile: ServerProfile) {
  const ids = new Set<string>();
  for (const match of JSON.stringify(profile).matchAll(/\$\{secret:([^}]+)\}/g)) {
    ids.add(match[1]);
  }
  return ids;
}

function keyValueEntries(values: Record<string, unknown>) {
  return Object.entries(values).map(([key, value]) => {
    const stringValue = String(value);
    const secretMatch = stringValue.match(/^\$\{secret:([^}]+)\}$/);
    return {
      key,
      value: secretMatch ? "" : stringValue,
      secret: Boolean(secretMatch),
      secretId: secretMatch?.[1] ?? "",
    };
  });
}

function emptyServerDraft(): ServerDraft {
  return {
    name: "",
    transportType: "http",
    command: "",
    args: "",
    cwd: "",
    env: [],
    envFile: "",
    url: "",
    headers: [],
    protocol: "auto",
    timeout: "",
    oauthClientId: "",
    oauthScopes: "",
    oauthMetadataUrl: "",
    oauthCallbackPort: "",
    oauthEnterpriseManaged: false,
  };
}

function profileDraft(profile: ServerProfile): ServerDraft {
  const draft = emptyServerDraft();
  draft.name = profile.name;
  draft.transportType = profile.transport.type;
  draft.protocol = protocolValue(profile.protocol);
  draft.timeout = profile.timeoutMs?.toString() ?? "";
  if (profile.transport.type === "stdio") {
    draft.command = profile.transport.command;
    draft.args = profile.transport.args.join("\n");
    draft.cwd = profile.transport.cwd ?? "";
    draft.env = keyValueEntries(profile.transport.env);
    draft.envFile = profile.transport.envFile ?? "";
  } else {
    draft.url = profile.transport.url;
    draft.headers = keyValueEntries(profile.transport.headers);
    if (profile.transport.type !== "websocket" && profile.transport.oauth) {
      draft.oauthClientId = profile.transport.oauth.clientId ?? "";
      draft.oauthScopes = profile.transport.oauth.scopes ?? "";
      draft.oauthMetadataUrl = profile.transport.oauth.authServerMetadataUrl ?? "";
      draft.oauthCallbackPort = profile.transport.oauth.callbackPort?.toString() ?? "";
      draft.oauthEnterpriseManaged = profile.transport.oauth.enterpriseManaged;
    }
  }
  return draft;
}

function entriesObject(entries: KeyValueEntry[]) {
  return Object.fromEntries(entries.filter((entry) => entry.key.trim()).map((entry) => {
    const key = entry.key.trim();
    if (!entry.secret) return [key, entry.value];
    const secretId = entry.secretId.trim();
    if (!secretId) throw new Error(`Secret ID is required for '${key}'.`);
    return [key, `\${secret:${secretId}}`];
  }));
}

function draftProfile(draft: ServerDraft, sourcePath: string | null): ServerProfile {
  const timeout = draft.timeout.trim() ? Number(draft.timeout) : null;
  let transport: TransportConfig;
  if (draft.transportType === "stdio") {
    transport = {
      type: "stdio",
      command: draft.command.trim(),
      args: draft.args.split("\n").map((argument) => argument.trim()).filter(Boolean),
      cwd: draft.cwd.trim() || null,
      env: entriesObject(draft.env),
      envFile: draft.envFile.trim() || null,
    };
  } else if (draft.transportType === "websocket") {
    transport = {
      type: "websocket",
      url: draft.url.trim(),
      headers: entriesObject(draft.headers) as Record<string, string>,
    };
  } else {
    const hasOAuth = Boolean(draft.oauthClientId || draft.oauthScopes || draft.oauthMetadataUrl || draft.oauthCallbackPort || draft.oauthEnterpriseManaged);
    transport = {
      type: draft.transportType,
      url: draft.url.trim(),
      headers: entriesObject(draft.headers) as Record<string, string>,
      oauth: hasOAuth ? {
        clientId: draft.oauthClientId.trim() || null,
        callbackPort: draft.oauthCallbackPort ? Number(draft.oauthCallbackPort) : null,
        scopes: draft.oauthScopes.trim() || null,
        authServerMetadataUrl: draft.oauthMetadataUrl.trim() || null,
        enterpriseManaged: draft.oauthEnterpriseManaged,
      } : null,
    };
  }
  return {
    formatVersion: 1,
    name: draft.name.trim(),
    transport,
    protocol: protocolFromValue(draft.protocol),
    source: { kind: "generic", path: sourcePath, scope: null },
    timeoutMs: Number.isFinite(timeout) ? timeout : null,
    trusted: false,
  };
}

function serializeProfiles(profiles: ServerProfile[]) {
  const mcpServers = Object.fromEntries(profiles.map((profile) => {
    const protocolEra = profile.protocol.mode === "auto"
      ? "auto"
      : profile.protocol.mode === "modern"
        ? "modern"
        : profile.protocol.mode === "exact"
          ? profile.protocol.version
          : "legacy";
    const timeout = profile.timeoutMs ?? undefined;
    if (profile.transport.type === "stdio") {
      return [profile.name, {
        type: "stdio",
        command: profile.transport.command,
        args: profile.transport.args,
        cwd: profile.transport.cwd ?? undefined,
        env: profile.transport.env,
        envFile: profile.transport.envFile ?? undefined,
        protocolEra,
        timeout,
      }];
    }
    return [profile.name, {
      type: profile.transport.type === "websocket" ? "ws" : profile.transport.type,
      url: profile.transport.url,
      headers: profile.transport.headers,
      ...(profile.transport.type !== "websocket" && profile.transport.oauth ? { oauth: profile.transport.oauth } : {}),
      protocolEra,
      timeout,
    }];
  }));
  return JSON.stringify({ mcpServers }, null, 2);
}

function App() {
  const [appInfo, setAppInfo] = useState(fallbackInfo);
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [query, setQuery] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importContent, setImportContent] = useState(exampleConfig);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [importSource, setImportSource] =
    useState<ConfigSourceKind>("auto");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [connections, setConnections] = useState<
    Record<string, ConnectionSnapshot>
  >({});
  const [connectingName, setConnectingName] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [protocolCounts, setProtocolCounts] = useState<Record<string, number>>({});
  const [testCounts, setTestCounts] = useState<Record<string, number>>({});
  const [testDocuments, setTestDocuments] = useState<Record<string, TestDocument>>({});
  const [testRuns, setTestRuns] = useState<Record<string, TestRunState>>({});
  const [profileInputs, setProfileInputs] = useState<
    Record<string, ConfigInputDefinition[]>
  >({});
  const [resolutionRequest, setResolutionRequest] = useState<{
    profile: ServerProfile;
    inputs: ConfigInputDefinition[];
    storedSecretIds: string[];
  } | null>(null);
  const [serverEditor, setServerEditor] = useState<ServerEditorState | null>(null);
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    invoke<AppInfo>("app_info").then(setAppInfo).catch(() => undefined);
    void refreshSecrets();
  }, []);

  const selectedProfile =
    profiles.find((profile) => profile.name === selectedName) ?? null;
  const selectedConnection = selectedName ? connections[selectedName] : null;
  const selectedTestDocument = selectedProfile
    ? testDocuments[selectedProfile.name] ?? { content: exampleTestSet, path: null }
    : null;
  const selectedTestRun = selectedProfile
    ? testRuns[selectedProfile.name] ?? emptyTestRunState()
    : null;

  const tabCounts: Partial<Record<TabId, number>> = selectedProfile
    ? {
        tools: selectedConnection?.tools.length ?? 0,
        resources:
          (selectedConnection?.resources.length ?? 0) +
          (selectedConnection?.resourceTemplates.length ?? 0),
        prompts: selectedConnection?.prompts.length ?? 0,
        tests: testCounts[selectedProfile.name] ?? 0,
        protocol: protocolCounts[selectedProfile.name] ?? 0,
      }
    : {};

  const filteredProfiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return profiles;
    return profiles.filter((profile) =>
      profile.name.toLowerCase().includes(normalizedQuery),
    );
  }, [profiles, query]);

  async function refreshSecrets() {
    if (!isTauriRuntime()) {
      setSecretError("Secret management requires the MCP Check desktop runtime.");
      return;
    }
    try {
      setSecrets(await invoke<SecretSummary[]>("list_secrets"));
      setSecretError(null);
    } catch (error) {
      setSecretError(String(error));
    }
  }

  function openSecrets() {
    setShowSecrets(true);
    void refreshSecrets();
  }

  async function previewImport() {
    setIsImporting(true);
    setImportError(null);
    setImportResult(null);

    if (!isTauriRuntime()) {
      setImportError("Config import requires the MCP Check desktop runtime.");
      setIsImporting(false);
      return;
    }

    try {
      const result = await invoke<ImportResult>("import_config_preview", {
        content: importContent,
        source: importSource,
      });
      setImportResult(result);
    } catch (error) {
      setImportError(String(error));
    } finally {
      setIsImporting(false);
    }
  }

  async function loadConfigFile() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "MCP configuration", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      setImportContent(await invoke<string>("read_document", { path }));
      setImportPath(path);
      setImportResult(null);
      setImportError(null);
    } catch (error) {
      setImportError(String(error));
    }
  }

  async function saveConfigFile() {
    const path = await saveDialog({
      defaultPath: importPath ?? "mcp.json",
      filters: [{ name: "MCP configuration", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      const savedPath = await invoke<string>("write_document", {
        request: { path, content: importContent },
      });
      setImportPath(savedPath);
      setImportError(null);
    } catch (error) {
      setImportError(String(error));
    }
  }

  function installImport(result: ImportResult) {
    const definitions = result.inputs ?? [];
    setProfileInputs((current) => {
      const next = { ...current };
      for (const profile of result.profiles) {
        const referenced = referencedInputIds(profile);
        next[profile.name] = definitions.filter((input) => referenced.has(input.id));
      }
      return next;
    });
    setProfiles((current) => {
      const importedNames = new Set(
        result.profiles.map((profile) => profile.name),
      );
      return [
        ...current.filter((profile) => !importedNames.has(profile.name)),
        ...result.profiles,
      ];
    });
    setTestDocuments((current) => {
      const next = { ...current };
      for (const profile of result.profiles) {
        next[profile.name] ??= { content: exampleTestSet, path: null };
      }
      return next;
    });
    setTestCounts((current) => {
      const next = { ...current };
      for (const profile of result.profiles) next[profile.name] ??= 1;
      return next;
    });
    setSelectedName(result.profiles[0]?.name ?? null);
    setActiveTab("overview");
  }

  function acceptImport() {
    if (!importResult) return;
    installImport(importResult);
    setShowImport(false);
    setImportResult(null);
  }

  async function openWorkspaceConfig() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "MCP configuration", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      const content = await invoke<string>("read_document", { path });
      const result = await invoke<ImportResult>("import_config_preview", {
        content,
        source: "auto",
      });
      setImportContent(content);
      setImportPath(path);
      setImportError(null);
      installImport(result);
    } catch (error) {
      setConnectionError(String(error));
    }
  }

  async function saveWorkspaceConfig() {
    const path = await saveDialog({
      defaultPath: importPath ?? "mcp.json",
      filters: [{ name: "MCP configuration", extensions: ["json"] }],
    });
    if (!path) return;
    const content = serializeProfiles(profiles);
    try {
      const savedPath = await invoke<string>("write_document", {
        request: { path, content },
      });
      setImportContent(content);
      setImportPath(savedPath);
      setConnectionError(null);
    } catch (error) {
      setConnectionError(String(error));
    }
  }

  async function saveServerDraft(draft: ServerDraft, originalName: string | null) {
    const profile = draftProfile(draft, importPath);
    if (!profile.name) throw new Error("Server name is required.");
    if (profile.transport.type === "stdio" && !profile.transport.command) {
      throw new Error("Command is required for stdio servers.");
    }
    if (profile.transport.type !== "stdio" && !profile.transport.url) {
      throw new Error("URL is required for remote servers.");
    }
    if (profiles.some((candidate) => candidate.name === profile.name && candidate.name !== originalName)) {
      throw new Error(`A server named '${profile.name}' already exists.`);
    }
    const secretEntries = (draft.transportType === "stdio" ? draft.env : draft.headers)
      .filter((entry) => entry.secret && entry.key.trim() && entry.value);
    for (const entry of secretEntries) {
      if (!isTauriRuntime()) {
        throw new Error("Secret storage requires the MCP Check desktop runtime.");
      }
      await invoke<SecretSummary>("set_secret", {
        request: {
          id: entry.secretId.trim(),
          label: `${profile.name} / ${entry.key.trim()}`,
          value: entry.value,
        },
      });
    }
    setProfiles((current) => originalName
      ? current.map((candidate) => candidate.name === originalName ? profile : candidate)
      : [...current, profile]);
    if (originalName && originalName !== profile.name) {
      setTestDocuments((current) => {
        const next = { ...current, [profile.name]: current[originalName] ?? { content: exampleTestSet, path: null } };
        delete next[originalName];
        return next;
      });
      setTestCounts((current) => {
        const next = { ...current, [profile.name]: current[originalName] ?? 1 };
        delete next[originalName];
        return next;
      });
      setTestRuns((current) => {
        const next = { ...current };
        if (current[originalName]) next[profile.name] = current[originalName];
        delete next[originalName];
        return next;
      });
    } else if (!originalName) {
      setTestDocuments((current) => ({ ...current, [profile.name]: { content: exampleTestSet, path: null } }));
      setTestCounts((current) => ({ ...current, [profile.name]: 1 }));
    }
    setSelectedName(profile.name);
    setActiveTab("overview");
    setServerEditor(null);
    if (secretEntries.length > 0) void refreshSecrets();
  }

  function updateProtocol(value: string) {
    if (!selectedProfile) return;
    setProfiles((current) =>
      current.map((profile) =>
        profile.name === selectedProfile.name
          ? { ...profile, protocol: protocolFromValue(value) }
          : profile,
      ),
    );
  }

  async function connectSelected() {
    if (!selectedProfile || !isTauriRuntime()) return;

    let profile = selectedProfile;
    if (!profile.trusted) {
      profile = { ...profile, trusted: true };
      setProfiles((current) =>
        current.map((candidate) =>
          candidate.name === profile.name ? profile : candidate,
        ),
      );
    }

    await continueConnection(profile);
  }

  async function continueConnection(profile: ServerProfile) {
    const inputs = profileInputs[profile.name] ?? [];
    let availableSecretIds = new Set<string>();
    if (isTauriRuntime()) {
      try {
        const storedSecrets = await invoke<SecretSummary[]>("list_secrets");
        setSecrets(storedSecrets);
        setSecretError(null);
        availableSecretIds = new Set(
          storedSecrets.filter((secret) => secret.available).map((secret) => secret.id),
        );
      } catch (error) {
        setSecretError(String(error));
        setConnectionError(String(error));
        return;
      }
    }

    const resolutionInputs = inputs.filter(
      (input) => !input.secret || !availableSecretIds.has(input.id),
    );
    const knownInputIds = new Set(inputs.map((input) => input.id));
    const requestedInputIds = new Set(resolutionInputs.map((input) => input.id));
    for (const id of referencedSecretIds(profile)) {
      if (!availableSecretIds.has(id) && !requestedInputIds.has(id)) {
        resolutionInputs.push({
          id,
          kind: "prompt",
          description: `Managed secret: ${id}`,
          secret: true,
          defaultValue: null,
          options: [],
        });
        requestedInputIds.add(id);
      }
    }
    for (const id of referencedInputIds(profile)) {
      if (!availableSecretIds.has(id) && !requestedInputIds.has(id) && !knownInputIds.has(id)) {
        resolutionInputs.push({
          id,
          kind: "prompt",
          description: `Configuration input: ${id}`,
          secret: true,
          defaultValue: null,
          options: [],
        });
        requestedInputIds.add(id);
      }
    }

    if (resolutionInputs.length > 0) {
      setResolutionRequest({
        profile,
        inputs: resolutionInputs,
        storedSecretIds: [...availableSecretIds],
      });
      return;
    }
    await connectProfile(profile, {});
  }

  async function connectWithResolution(
    request: { profile: ServerProfile; inputs: ConfigInputDefinition[] },
    values: Record<string, string>,
  ) {
    for (const input of request.inputs) {
      const value = values[input.id];
      if (input.secret && value) {
        await invoke<SecretSummary>("set_secret", {
          request: {
            id: input.id,
            label: input.description || input.id,
            value,
          },
        });
      }
    }
    await refreshSecrets();
    await connectProfile(request.profile, values);
  }

  async function connectProfile(
    profile: ServerProfile,
    inputs: Record<string, string>,
  ) {
    setResolutionRequest(null);
    setConnectingName(profile.name);
    setConnectionError(null);
    try {
      const snapshot = await invoke<ConnectionSnapshot>("connect_server", {
        profile,
        context: { inputs },
      });
      setConnections((current) => ({
        ...current,
        [profile.name]: snapshot,
      }));
      await refreshProtocolCount(profile.name);
      setActiveTab(snapshot.tools.length > 0 ? "tools" : "overview");
    } catch (error) {
      setConnectionError(String(error));
    } finally {
      setConnectingName(null);
    }
  }

  async function disconnectSelected() {
    if (!selectedProfile || !selectedConnection) return;
    setConnectionError(null);
    try {
      await invoke("disconnect_server", {
        request: { serverName: selectedProfile.name },
      });
      setConnections((current) => {
        const next = { ...current };
        delete next[selectedProfile.name];
        return next;
      });
      await refreshProtocolCount(selectedProfile.name);
      setActiveTab("overview");
    } catch (error) {
      setConnectionError(String(error));
    }
  }

  async function refreshProtocolCount(serverName: string) {
    try {
      const events = await invoke<ProtocolEvent[]>("session_events", {
        request: { serverName },
      });
      setProtocolCounts((current) => ({ ...current, [serverName]: events.length }));
    } catch {
      setProtocolCounts((current) => ({ ...current, [serverName]: 0 }));
    }
  }

  function updateTestRun(serverName: string, update: TestRunStateUpdate) {
    setTestRuns((current) => {
      const existing = current[serverName] ?? emptyTestRunState();
      const next = typeof update === "function" ? update(existing) : update;
      return { ...current, [serverName]: next };
    });
  }

  return (
    <div className="app-shell">
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

      <aside className="server-rail">
        <div className="rail-heading">
          <span>Servers</span>
          <div className="rail-actions">
            <button className="icon-button icon-button-dark" type="button" aria-label="Open MCP configuration" title="Open MCP configuration" onClick={openWorkspaceConfig}><FileUp size={15} /></button>
            <button className="icon-button icon-button-dark" type="button" aria-label="Save MCP configuration" title="Save MCP configuration" onClick={saveWorkspaceConfig} disabled={profiles.length === 0}><Save size={15} /></button>
            <button className="icon-button icon-button-dark" type="button" aria-label="Add MCP server" title="Add MCP server" onClick={() => setServerEditor({ originalName: null, draft: emptyServerDraft() })}><Plus size={15} /></button>
            <button className="icon-button icon-button-dark" type="button" aria-label="Paste MCP JSON" title="Paste MCP JSON" onClick={() => setShowImport(true)}><Import size={15} /></button>
          </div>
        </div>

        <label className="server-search">
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
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
              onClick={() => {
                setSelectedName(profile.name);
                setActiveTab("overview");
              }}
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

        <button className="rail-footer" type="button" onClick={openSecrets} aria-label="Manage secrets" title="Manage secrets">
          <KeyRound size={14} />
          <span>Manage secrets</span>
        </button>
      </aside>

      <main className="workspace">
        {selectedProfile ? (
          <>
            <section className="server-header">
              <div className="server-identity">
                <span className="eyebrow">
                  {selectedConnection
                    ? `Connected / ${selectedConnection.protocolVersion}`
                    : connectingName === selectedProfile.name
                      ? "Connecting"
                      : "Disconnected"}
                </span>
                <h1>{selectedProfile.name}</h1>
                <p>{endpointLabel(selectedProfile.transport)}</p>
              </div>
              <div className="server-actions">
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Edit MCP server"
                  title={selectedConnection ? "Disconnect before editing" : "Edit MCP server"}
                  disabled={Boolean(selectedConnection)}
                  onClick={() => setServerEditor({ originalName: selectedProfile.name, draft: profileDraft(selectedProfile) })}
                >
                  <Pencil size={15} />
                </button>
                <label className="protocol-select">
                  <span>Protocol</span>
                  <select
                    value={protocolValue(selectedProfile.protocol)}
                    onChange={(event) => updateProtocol(event.currentTarget.value)}
                    disabled={Boolean(selectedConnection)}
                  >
                    <option value="auto">Auto negotiate</option>
                    {appInfo.protocolVersions.map((version) => (
                      <option key={version} value={`exact:${version}`}>
                        {version}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} aria-hidden="true" />
                </label>
                {selectedConnection ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={disconnectSelected}
                  >
                    <Unplug size={16} /> Disconnect
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    type="button"
                    onClick={connectSelected}
                    disabled={
                      !isTauriRuntime() || connectingName === selectedProfile.name
                    }
                  >
                    {connectingName === selectedProfile.name ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <PlugZap size={16} />
                    )}
                    {connectingName === selectedProfile.name
                      ? "Connecting"
                      : "Connect"}
                  </button>
                )}
              </div>
            </section>

            <nav className="workspace-tabs" aria-label="Server inspector">
              {tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={activeTab === id ? "tab-active" : ""}
                  type="button"
                  onClick={() => setActiveTab(id)}
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

            <section className="workspace-content">
              {activeTab === "overview" ? (
                <Overview
                  profile={selectedProfile}
                  protocolVersions={appInfo.protocolVersions}
                  connection={selectedConnection}
                />
              ) : activeTab === "tools" && selectedConnection ? (
                <ToolsPanel
                  serverName={selectedProfile.name}
                  tools={selectedConnection.tools}
                  onActivity={() => refreshProtocolCount(selectedProfile.name)}
                />
              ) : activeTab === "resources" && selectedConnection ? (
                <ResourcesPanel
                  serverName={selectedProfile.name}
                  resources={selectedConnection.resources}
                  templates={selectedConnection.resourceTemplates}
                  onActivity={() => refreshProtocolCount(selectedProfile.name)}
                />
              ) : activeTab === "prompts" && selectedConnection ? (
                <PromptsPanel
                  serverName={selectedProfile.name}
                  prompts={selectedConnection.prompts}
                  onActivity={() => refreshProtocolCount(selectedProfile.name)}
                />
              ) : activeTab === "tests" && selectedTestDocument ? (
                <AutomationPanel
                  profile={selectedProfile}
                  snapshot={selectedConnection}
                  document={selectedTestDocument}
                  runState={selectedTestRun ?? emptyTestRunState()}
                  onDocumentChange={(document) =>
                    setTestDocuments((current) => ({
                      ...current,
                      [selectedProfile.name]: document,
                    }))
                  }
                  onCountChange={(count) =>
                    setTestCounts((current) => ({
                      ...current,
                      [selectedProfile.name]: count,
                    }))
                  }
                  onRunStateChange={(update) => updateTestRun(selectedProfile.name, update)}
                  onRunComplete={() =>
                    void refreshProtocolCount(selectedProfile.name).then(() =>
                      setConnections((current) => {
                        const next = { ...current };
                        delete next[selectedProfile.name];
                        return next;
                      }),
                    )
                  }
                />
              ) : activeTab === "protocol" ? (
                <ProtocolPanel
                  serverName={selectedProfile.name}
                  connected={Boolean(selectedConnection)}
                />
              ) : activeTab === "network" ? (
                <NetworkPanel
                  serverName={selectedProfile.name}
                  connected={Boolean(selectedConnection)}
                />
              ) : (
                <DisconnectedPanel tab={activeTab} />
              )}
            </section>
          </>
        ) : (
          <EmptyWorkspace onImport={() => setShowImport(true)} />
        )}
      </main>

      {showImport && (
        <ImportDialog
          content={importContent}
          path={importPath}
          source={importSource}
          result={importResult}
          error={importError}
          isImporting={isImporting}
          onContentChange={setImportContent}
          onLoad={loadConfigFile}
          onSave={saveConfigFile}
          onSourceChange={setImportSource}
          onPreview={previewImport}
          onAccept={acceptImport}
          onClose={() => {
            setShowImport(false);
            setImportResult(null);
            setImportError(null);
          }}
        />
      )}
      {serverEditor && (
        <ServerDialog
          state={serverEditor}
          protocolVersions={appInfo.protocolVersions}
          secrets={secrets}
          onChange={setServerEditor}
          onSave={saveServerDraft}
          onClose={() => setServerEditor(null)}
        />
      )}
      {showSecrets && (
        <SecretsDialog
          secrets={secrets}
          error={secretError}
          onChanged={refreshSecrets}
          onClose={() => setShowSecrets(false)}
        />
      )}
      {resolutionRequest && (
        <ResolutionDialog
          serverName={resolutionRequest.profile.name}
          inputs={resolutionRequest.inputs}
          storedSecretIds={resolutionRequest.storedSecretIds}
          onConnect={(values) => connectWithResolution(resolutionRequest, values)}
          onClose={() => setResolutionRequest(null)}
        />
      )}
      {connectionError && (
        <div className="connection-toast" role="alert">
          <AlertTriangle size={16} />
          <span>{connectionError}</span>
          <button
            className="icon-button"
            type="button"
            aria-label="Dismiss connection error"
            onClick={() => setConnectionError(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyWorkspace({ onImport }: { onImport: () => void }) {
  return (
    <section className="empty-workspace">
      <div className="empty-signal" aria-hidden="true">
        <span />
        <Cable size={30} />
        <span />
      </div>
      <span className="eyebrow">Workspace ready</span>
      <h1>No servers configured</h1>
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

function Overview({
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

function ToolsPanel({
  serverName,
  tools,
  onActivity,
}: {
  serverName: string;
  tools: ToolSummary[];
  onActivity: () => Promise<void>;
}) {
  const [selectedName, setSelectedName] = useState(tools[0]?.name ?? "");
  const [argumentsValue, setArgumentsValue] = useState<Record<string, unknown>>(
    schemaObjectInitial(tools[0]?.inputSchema),
  );
  const [argumentsJson, setArgumentsJson] = useState("{}");
  const [rawArguments, setRawArguments] = useState(false);
  const [result, setResult] = useState<unknown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    setSelectedName(tools[0]?.name ?? "");
    setArgumentsValue(schemaObjectInitial(tools[0]?.inputSchema));
    setArgumentsJson("{}");
    setRawArguments(false);
    setResult(null);
    setError(null);
  }, [serverName, tools]);

  const selectedTool =
    tools.find((tool) => tool.name === selectedName) ?? tools[0] ?? null;

  async function runTool() {
    if (!selectedTool) return;
    setIsRunning(true);
    setResult(null);
    setError(null);
    try {
      const parsed = rawArguments ? JSON.parse(argumentsJson) as unknown : argumentsValue;
      if (
        parsed === null ||
        Array.isArray(parsed) ||
        typeof parsed !== "object"
      ) {
        throw new Error("Tool arguments must be a JSON object.");
      }
      const output = await invoke<unknown>("call_tool", {
        request: {
          serverName,
          toolName: selectedTool.name,
          arguments: parsed,
        },
      });
      setResult(output);
      await onActivity();
    } catch (toolError) {
      setError(String(toolError));
    } finally {
      setIsRunning(false);
    }
  }

  if (!selectedTool) {
    return (
      <div className="disconnected-panel">
        <Wrench size={28} />
        <h2>No tools advertised</h2>
      </div>
    );
  }

  return (
    <div className="tools-workbench">
      <aside className="tool-list-panel">
        <div className="tool-list-heading">
          <span>Available tools</span>
          <strong>{tools.length}</strong>
        </div>
        <div className="tool-list">
          {tools.map((tool) => (
            <button
              key={tool.name}
              className={tool.name === selectedTool.name ? "tool-active" : ""}
              type="button"
              onClick={() => {
                setSelectedName(tool.name);
                setArgumentsValue(schemaObjectInitial(tool.inputSchema));
                setArgumentsJson("{}");
                setRawArguments(false);
                setResult(null);
                setError(null);
              }}
            >
              <Wrench size={14} />
              <span>
                <strong>{tool.title ?? tool.name}</strong>
                <small>{tool.name}</small>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="tool-detail">
        <header className="tool-detail-header">
          <div>
            <span className="eyebrow">Tool</span>
            <h2>{selectedTool.title ?? selectedTool.name}</h2>
            <code>{selectedTool.name}</code>
          </div>
        </header>
        {selectedTool.description && (
          <p className="tool-description">{selectedTool.description}</p>
        )}

        <div className="tool-editor-grid">
          <section className="schema-editor">
            <div className="field-heading">
              <span>Arguments</span>
              <ModeToggle raw={rawArguments} onChange={(raw) => {
                if (raw) setArgumentsJson(JSON.stringify(argumentsValue, null, 2));
                else {
                  try { setArgumentsValue(JSON.parse(argumentsJson) as Record<string, unknown>); } catch { return; }
                }
                setRawArguments(raw);
              }} />
            </div>
            {rawArguments ? (
              <textarea
                aria-label="Arguments JSON"
                value={argumentsJson}
                onChange={(event) => setArgumentsJson(event.currentTarget.value)}
                spellCheck={false}
              />
            ) : (
              <SchemaForm
                schema={selectedTool.inputSchema}
                value={argumentsValue}
                onChange={(value) => setArgumentsValue(value as Record<string, unknown>)}
              />
            )}
          </section>
          <div className="tool-schema">
            <span>Input schema</span>
            <pre>{JSON.stringify(selectedTool.inputSchema, null, 2)}</pre>
          </div>
        </div>

        <div className="tool-run-row">
          <button
            className="primary-button"
            type="button"
            onClick={runTool}
            disabled={isRunning}
          >
            {isRunning ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Play size={15} fill="currentColor" />
            )}
            {isRunning ? "Running" : "Run tool"}
          </button>
        </div>

        {(result !== null || error) && (
          <section className={`tool-result ${error ? "tool-result-error" : ""}`}>
            <span>{error ? "Error" : "Result"}</span>
            {error ? <pre>{error}</pre> : <ResultViewer value={result} />}
          </section>
        )}
      </section>
    </div>
  );
}

function ResourcesPanel({
  serverName,
  resources,
  templates,
  onActivity,
}: {
  serverName: string;
  resources: ResourceSummary[];
  templates: ResourceTemplateSummary[];
  onActivity: () => Promise<void>;
}) {
  const firstTarget = resources[0]?.uri ?? templates[0]?.uriTemplate ?? "";
  const [selectedTarget, setSelectedTarget] = useState(firstTarget);
  const [uri, setUri] = useState(firstTarget);
  const [result, setResult] = useState<unknown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);

  useEffect(() => {
    const nextTarget = resources[0]?.uri ?? templates[0]?.uriTemplate ?? "";
    setSelectedTarget(nextTarget);
    setUri(nextTarget);
    setResult(null);
    setError(null);
  }, [serverName, resources, templates]);

  const selectedResource = resources.find(
    (resource) => resource.uri === selectedTarget,
  );
  const selectedTemplate = templates.find(
    (template) => template.uriTemplate === selectedTarget,
  );

  async function readResource() {
    if (!uri.trim()) return;
    setIsReading(true);
    setResult(null);
    setError(null);
    try {
      const output = await invoke<unknown>("read_resource", {
        request: { serverName, uri: uri.trim() },
      });
      setResult(output);
      await onActivity();
    } catch (readError) {
      setError(String(readError));
    } finally {
      setIsReading(false);
    }
  }

  if (!selectedResource && !selectedTemplate) {
    return (
      <div className="disconnected-panel">
        <FolderOpen size={28} />
        <h2>No resources advertised</h2>
      </div>
    );
  }

  return (
    <div className="tools-workbench">
      <aside className="tool-list-panel">
        <div className="tool-list-heading">
          <span>Resources</span>
          <strong>{resources.length + templates.length}</strong>
        </div>
        <div className="tool-list">
          {resources.map((resource) => (
            <button
              key={resource.uri}
              className={resource.uri === selectedTarget ? "tool-active" : ""}
              type="button"
              onClick={() => {
                setSelectedTarget(resource.uri);
                setUri(resource.uri);
                setResult(null);
                setError(null);
              }}
            >
              <FolderOpen size={14} />
              <span>
                <strong>{resource.title ?? resource.name}</strong>
                <small>{resource.uri}</small>
              </span>
            </button>
          ))}
          {templates.map((template) => (
            <button
              key={template.uriTemplate}
              className={
                template.uriTemplate === selectedTarget ? "tool-active" : ""
              }
              type="button"
              onClick={() => {
                setSelectedTarget(template.uriTemplate);
                setUri(template.uriTemplate);
                setResult(null);
                setError(null);
              }}
            >
              <Braces size={14} />
              <span>
                <strong>{template.title ?? template.name}</strong>
                <small>{template.uriTemplate}</small>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="tool-detail">
        <header className="tool-detail-header">
          <div>
            <span className="eyebrow">
              {selectedTemplate ? "Resource template" : "Resource"}
            </span>
            <h2>
              {selectedResource?.title ??
                selectedResource?.name ??
                selectedTemplate?.title ??
                selectedTemplate?.name}
            </h2>
          </div>
        </header>
        {(selectedResource?.description || selectedTemplate?.description) && (
          <p className="tool-description">
            {selectedResource?.description ?? selectedTemplate?.description}
          </p>
        )}

        <label className="primitive-input">
          <span>Resource URI</span>
          <input
            value={uri}
            onChange={(event) => setUri(event.currentTarget.value)}
          />
        </label>
        <div className="primitive-toolbar">
          <span>
            {selectedResource?.mimeType ?? selectedTemplate?.mimeType ?? "Unknown MIME"}
          </span>
          <button
            className="primary-button"
            type="button"
            onClick={readResource}
            disabled={isReading || uri.trim().length === 0}
          >
            {isReading ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <FolderOpen size={15} />
            )}
            {isReading ? "Reading" : "Read resource"}
          </button>
        </div>

        {(result !== null || error) && (
          <section className={`tool-result ${error ? "tool-result-error" : ""}`}>
            <span>{error ? "Error" : "Contents"}</span>
            {error ? <pre>{error}</pre> : <ResultViewer value={result} />}
          </section>
        )}
      </section>
    </div>
  );
}

function promptArgumentValue(prompt: PromptSummary | undefined) {
  return Object.fromEntries((prompt?.arguments ?? []).map((argument) => [argument.name, ""]));
}

function promptSchema(prompt: PromptSummary | undefined) {
  return {
    type: "object",
    properties: Object.fromEntries((prompt?.arguments ?? []).map((argument) => [argument.name, {
      type: "string",
      description: argument.description,
    }])),
    required: (prompt?.arguments ?? []).filter((argument) => argument.required).map((argument) => argument.name),
  };
}

function PromptsPanel({
  serverName,
  prompts,
  onActivity,
}: {
  serverName: string;
  prompts: PromptSummary[];
  onActivity: () => Promise<void>;
}) {
  const [selectedName, setSelectedName] = useState(prompts[0]?.name ?? "");
  const [argumentsValue, setArgumentsValue] = useState<Record<string, unknown>>(
    promptArgumentValue(prompts[0]),
  );
  const [argumentsJson, setArgumentsJson] = useState(JSON.stringify(promptArgumentValue(prompts[0]), null, 2));
  const [rawArguments, setRawArguments] = useState(false);
  const [result, setResult] = useState<unknown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setSelectedName(prompts[0]?.name ?? "");
    setArgumentsValue(promptArgumentValue(prompts[0]));
    setArgumentsJson(JSON.stringify(promptArgumentValue(prompts[0]), null, 2));
    setRawArguments(false);
    setResult(null);
    setError(null);
  }, [serverName, prompts]);

  const selectedPrompt =
    prompts.find((prompt) => prompt.name === selectedName) ?? prompts[0];

  async function getPrompt() {
    if (!selectedPrompt) return;
    setIsLoading(true);
    setResult(null);
    setError(null);
    try {
      const parsed = rawArguments ? JSON.parse(argumentsJson) as unknown : argumentsValue;
      if (
        parsed === null ||
        Array.isArray(parsed) ||
        typeof parsed !== "object"
      ) {
        throw new Error("Prompt arguments must be a JSON object.");
      }
      const output = await invoke<unknown>("get_prompt", {
        request: {
          serverName,
          promptName: selectedPrompt.name,
          arguments: parsed,
        },
      });
      setResult(output);
      await onActivity();
    } catch (promptError) {
      setError(String(promptError));
    } finally {
      setIsLoading(false);
    }
  }

  if (!selectedPrompt) {
    return (
      <div className="disconnected-panel">
        <FileCode2 size={28} />
        <h2>No prompts advertised</h2>
      </div>
    );
  }

  return (
    <div className="tools-workbench">
      <aside className="tool-list-panel">
        <div className="tool-list-heading">
          <span>Prompts</span>
          <strong>{prompts.length}</strong>
        </div>
        <div className="tool-list">
          {prompts.map((prompt) => (
            <button
              key={prompt.name}
              className={prompt.name === selectedPrompt.name ? "tool-active" : ""}
              type="button"
              onClick={() => {
                setSelectedName(prompt.name);
                setArgumentsValue(promptArgumentValue(prompt));
                setArgumentsJson(JSON.stringify(promptArgumentValue(prompt), null, 2));
                setRawArguments(false);
                setResult(null);
                setError(null);
              }}
            >
              <FileCode2 size={14} />
              <span>
                <strong>{prompt.title ?? prompt.name}</strong>
                <small>{prompt.name}</small>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="tool-detail">
        <header className="tool-detail-header">
          <div>
            <span className="eyebrow">Prompt</span>
            <h2>{selectedPrompt.title ?? selectedPrompt.name}</h2>
            <code>{selectedPrompt.name}</code>
          </div>
        </header>
        {selectedPrompt.description && (
          <p className="tool-description">{selectedPrompt.description}</p>
        )}

        <section className="schema-editor prompt-editor">
          <div className="field-heading">
            <span>Arguments</span>
            <ModeToggle raw={rawArguments} onChange={(raw) => {
              if (raw) setArgumentsJson(JSON.stringify(argumentsValue, null, 2));
              else {
                try { setArgumentsValue(JSON.parse(argumentsJson) as Record<string, unknown>); } catch { return; }
              }
              setRawArguments(raw);
            }} />
          </div>
          {rawArguments ? (
            <textarea aria-label="Arguments JSON" value={argumentsJson} onChange={(event) => setArgumentsJson(event.currentTarget.value)} spellCheck={false} />
          ) : (
            <SchemaForm schema={promptSchema(selectedPrompt)} value={argumentsValue} onChange={(value) => setArgumentsValue(value as Record<string, unknown>)} />
          )}
        </section>
        <div className="primitive-toolbar">
          <span>{selectedPrompt.arguments?.length ?? 0} arguments</span>
          <button
            className="primary-button"
            type="button"
            onClick={getPrompt}
            disabled={isLoading}
          >
            {isLoading ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Play size={15} fill="currentColor" />
            )}
            {isLoading ? "Loading" : "Get prompt"}
          </button>
        </div>

        {(result !== null || error) && (
          <section className={`tool-result ${error ? "tool-result-error" : ""}`}>
            <span>{error ? "Error" : "Messages"}</span>
            {error ? <pre>{error}</pre> : <ResultViewer value={result} />}
          </section>
        )}
      </section>
    </div>
  );
}

type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
};

function asSchema(schema: unknown): JsonSchema {
  return schema && typeof schema === "object" ? schema as JsonSchema : {};
}

function schemaType(schema: JsonSchema) {
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  if (type) return type;
  if (schema.properties) return "object";
  if (schema.enum?.length) return typeof schema.enum[0];
  return "string";
}

function emptySchemaValue(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  switch (schemaType(schema)) {
    case "object": return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([name, property]) => [name, emptySchemaValue(property)]),
    );
    case "array": return [];
    case "boolean": return false;
    case "number":
    case "integer": return 0;
    default: return "";
  }
}

function schemaObjectInitial(schema: unknown): Record<string, unknown> {
  const initial = emptySchemaValue(asSchema(schema));
  return initial && typeof initial === "object" && !Array.isArray(initial)
    ? initial as Record<string, unknown>
    : {};
}

function generatedArguments(schemaInput: unknown): Record<string, unknown> {
  const schema = asSchema(schemaInput);
  if (schemaType(schema) !== "object") return {};
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, property]) => [
      name,
      emptySchemaValue(property),
    ]),
  );
}

type GenerationItem = {
  id: string;
  kind: "Tool" | "Resource" | "Prompt";
  name: string;
  description?: string;
};

function generationItems(snapshot: ConnectionSnapshot): GenerationItem[] {
  return [
    ...snapshot.tools.map((tool) => ({
      id: `tool:${tool.name}`,
      kind: "Tool" as const,
      name: tool.title ?? tool.name,
      description: tool.description ?? tool.name,
    })),
    ...snapshot.resources.map((resource) => ({
      id: `resource:${resource.uri}`,
      kind: "Resource" as const,
      name: resource.title ?? resource.name,
      description: resource.uri,
    })),
    ...snapshot.prompts.map((prompt) => ({
      id: `prompt:${prompt.name}`,
      kind: "Prompt" as const,
      name: prompt.title ?? prompt.name,
      description: prompt.description ?? prompt.name,
    })),
  ];
}

function generateTestDocument(
  serverName: string,
  snapshot: ConnectionSnapshot,
  selected: Set<string>,
) {
  const calls: unknown[] = [];
  for (const tool of snapshot.tools) {
    if (!selected.has(`tool:${tool.name}`)) continue;
    const argumentsValue = generatedArguments(tool.inputSchema);
    calls.push({
      type: "callTool",
      name: tool.name,
      ...(Object.keys(argumentsValue).length > 0 ? { arguments: argumentsValue } : {}),
    });
  }
  for (const resource of snapshot.resources) {
    if (!selected.has(`resource:${resource.uri}`)) continue;
    calls.push({ type: "readResource", uri: resource.uri });
  }
  for (const prompt of snapshot.prompts) {
    if (!selected.has(`prompt:${prompt.name}`)) continue;
    const argumentsValue = Object.fromEntries(
      (prompt.arguments ?? []).map((argument) => [argument.name, ""]),
    );
    calls.push({
      type: "getPrompt",
      name: prompt.name,
      ...(Object.keys(argumentsValue).length > 0 ? { arguments: argumentsValue } : {}),
    });
  }
  return JSON.stringify({
    $schema: "./mcp-test.schema.json",
    name: `${serverName} generated checks`,
    description: `Generated from the discovered MCP definitions for ${serverName}. Add expectations after reviewing the first run.${snapshot.resourceTemplates.length > 0 ? ` ${snapshot.resourceTemplates.length} resource template(s) were skipped because they require concrete URIs.` : ""}`,
    calls,
  }, null, 2);
}

function ModeToggle({ raw, onChange }: { raw: boolean; onChange: (raw: boolean) => void }) {
  return (
    <span className="mode-toggle">
      <button className={!raw ? "active" : ""} type="button" onClick={() => onChange(false)}>Formatted</button>
      <button className={raw ? "active" : ""} type="button" onClick={() => onChange(true)}>JSON</button>
    </span>
  );
}

function SchemaForm({
  schema: schemaInput,
  value,
  onChange,
}: {
  schema: unknown;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const schema = asSchema(schemaInput);
  const type = schemaType(schema);

  if (schema.enum?.length) {
    return (
      <select value={JSON.stringify(value ?? schema.enum[0])} onChange={(event) => onChange(JSON.parse(event.currentTarget.value))}>
        {schema.enum.map((option) => <option key={JSON.stringify(option)} value={JSON.stringify(option)}>{String(option)}</option>)}
      </select>
    );
  }
  if (type === "object") {
    const objectValue = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const required = new Set(schema.required ?? []);
    return (
      <div className="schema-fields">
        {Object.entries(schema.properties ?? {}).map(([name, property]) => (
          <label className="schema-field" key={name}>
            <span>{property.title ?? name}{required.has(name) && <b> *</b>}</span>
            {property.description && <small>{property.description}</small>}
            <SchemaForm
              schema={property}
              value={objectValue[name] ?? emptySchemaValue(property)}
              onChange={(next) => onChange({ ...objectValue, [name]: next })}
            />
          </label>
        ))}
        {Object.keys(schema.properties ?? {}).length === 0 && <span className="empty-form">No arguments</span>}
      </div>
    );
  }
  if (type === "array") {
    const values = Array.isArray(value) ? value : [];
    const itemSchema = schema.items ?? {};
    return (
      <div className="array-editor">
        {values.map((item, index) => (
          <div className="array-row" key={index}>
            <SchemaForm schema={itemSchema} value={item} onChange={(next) => onChange(values.map((current, currentIndex) => currentIndex === index ? next : current))} />
            <button className="icon-button" type="button" aria-label={`Remove item ${index + 1}`} onClick={() => onChange(values.filter((_, currentIndex) => currentIndex !== index))}><Trash2 size={14} /></button>
          </div>
        ))}
        <button className="text-button" type="button" onClick={() => onChange([...values, emptySchemaValue(itemSchema)])}><Plus size={14} /> Add item</button>
      </div>
    );
  }
  if (type === "boolean") {
    return <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.currentTarget.checked)} />;
  }
  if (type === "number" || type === "integer") {
    return <input type="number" min={schema.minimum} max={schema.maximum} step={type === "integer" ? 1 : "any"} value={typeof value === "number" ? value : 0} onChange={(event) => onChange(event.currentTarget.valueAsNumber)} />;
  }
  return <input type="text" value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.currentTarget.value)} />;
}

function ResultViewer({ value }: { value: unknown }) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (
      <div className="result-fields">
        {Object.entries(value as Record<string, unknown>).map(([name, fieldValue]) => (
          <ResultField key={name} name={name} value={fieldValue} />
        ))}
      </div>
    );
  }
  return <ResultField name="value" value={value} />;
}

function ResultField({ name, value }: { name: string; value: unknown }) {
  const [raw, setRaw] = useState(false);
  return (
    <section className="result-field">
      <header><strong>{name}</strong><ModeToggle raw={raw} onChange={setRaw} /></header>
      {raw ? <pre>{JSON.stringify(value, null, 2)}</pre> : <FormattedValue value={value} />}
    </section>
  );
}

function FormattedValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="formatted-empty">No value</span>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "object" && parsed !== null) return <FormattedValue value={parsed} />;
    } catch { /* plain text */ }
    return <div className="formatted-text">{value}</div>;
  }
  if (typeof value === "boolean") return <span className={`value-badge ${value ? "true" : "false"}`}>{String(value)}</span>;
  if (typeof value === "number") return <span className="formatted-number">{value}</span>;
  if (Array.isArray(value)) {
    return <div className="formatted-list">{value.map((item, index) => <section key={index}><span>#{index + 1}</span><FormattedValue value={item} /></section>)}</div>;
  }
  return (
    <dl className="formatted-object">
      {Object.entries(value as Record<string, unknown>).map(([name, child]) => <div key={name}><dt>{name}</dt><dd><FormattedValue value={child} /></dd></div>)}
    </dl>
  );
}

function NetworkPanel({
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

function ProtocolPanel({
  serverName,
  connected,
}: {
  serverName: string;
  connected: boolean;
}) {
  const [events, setEvents] = useState<ProtocolEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<ProtocolEvent[]>("session_events", {
        request: { serverName },
      });
      setEvents(next);
    } catch (eventError) {
      setError(String(eventError));
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
          <span className="eyebrow">Redacted semantic events</span>
          <h2>Protocol timeline</h2>
        </div>
        <button className="secondary-button" type="button" onClick={refresh} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} size={15} /> Refresh
        </button>
      </div>
      {error && <p className="automation-error"><AlertTriangle size={14} /> {error}</p>}
      {events.length > 0 ? (
        <div className="protocol-events">
          {events.map((event) => (
            <details key={event.sequence} open={event.direction === "internal"}>
              <summary>
                <span>#{event.sequence}</span>
                <small>{event.elapsedMs} ms</small>
                <b className={`direction-${event.direction}`}>{event.direction}</b>
                <code>{event.method}</code>
              </summary>
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </details>
          ))}
        </div>
      ) : (
        <div className="disconnected-panel compact">
          <ListTree size={26} />
          <span>{connected ? "No protocol events recorded" : "No retained session history"}</span>
        </div>
      )}
    </div>
  );
}

function DisconnectedPanel({ tab }: { tab: TabId }) {
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

function AutomationPanel({
  profile,
  snapshot,
  document,
  runState,
  onDocumentChange,
  onCountChange,
  onRunStateChange,
  onRunComplete,
}: {
  profile: ServerProfile;
  snapshot: ConnectionSnapshot | null;
  document: TestDocument;
  runState: TestRunState;
  onDocumentChange: (document: TestDocument) => void;
  onCountChange: (count: number) => void;
  onRunStateChange: (update: TestRunStateUpdate) => void;
  onRunComplete: () => void;
}) {
  const { content, path: testPath } = document;
  const [validation, setValidation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showGeneration, setShowGeneration] = useState(false);
  const [generationSelection, setGenerationSelection] = useState<string[]>([]);
  const { run, liveRun, isRunning, reportPath, savedReports } = runState;

  const availableGenerationItems = snapshot ? generationItems(snapshot) : [];
  const generatedCallCount = availableGenerationItems.length;

  function applyGeneration() {
    if (!snapshot) return;
    const selected = new Set(generationSelection);
    onDocumentChange({
      content: generateTestDocument(profile.name, snapshot, selected),
      path: testPath,
    });
    setValidation(null);
    onRunStateChange((current) => ({ ...current, run: null, liveRun: null, savedReports: null }));
    setError(null);
    setShowGeneration(false);
  }

  function generateTests() {
    if (!snapshot || generatedCallCount === 0) return;
    setGenerationSelection(availableGenerationItems.map((item) => item.id));
    setShowGeneration(true);
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      invoke<number>("validate_test_set", { content })
        .then(onCountChange)
        .catch(() => onCountChange(0));
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [content]);

  async function validate() {
    setError(null);
    try {
      const count = await invoke<number>("validate_test_set", { content });
      onCountChange(count);
      setValidation(`Valid test set / ${count} calls`);
    } catch (validationError) {
      setValidation(null);
      setError(String(validationError));
    }
  }

  async function loadTestFile() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "MCP test set", extensions: ["yaml", "yml", "json"] }],
    });
    if (!path) return;
    try {
      onDocumentChange({
        content: await invoke<string>("read_document", { path }),
        path,
      });
      setValidation(null);
      onRunStateChange((current) => ({ ...current, run: null, liveRun: null, savedReports: null }));
      setError(null);
    } catch (loadError) {
      setError(String(loadError));
    }
  }

  async function saveTestFile() {
    const path = await saveDialog({
      defaultPath: testPath ?? "mcp-test.yaml",
      filters: [{ name: "MCP test set", extensions: ["yaml", "yml", "json"] }],
    });
    if (!path) return;
    try {
      const savedPath = await invoke<string>("write_document", {
        request: { path, content },
      });
      onDocumentChange({ content, path: savedPath });
      setError(null);
    } catch (saveError) {
      setError(String(saveError));
    }
  }

  async function execute() {
    onRunStateChange((current) => ({
      ...current,
      isRunning: true,
      run: null,
      liveRun: null,
      savedReports: null,
    }));
    setError(null);
    try {
      const onProgress = new Channel<RunProgress>();
      onProgress.onmessage = (progress) => {
        switch (progress.event) {
          case "started":
            onRunStateChange((current) => ({
              ...current,
              liveRun: {
                name: progress.name,
                total: progress.total,
                protocolVersion: null,
                summary: { total: progress.total, passed: 0, failed: 0, errors: 0 },
                calls: progress.calls.map((call) => ({ ...call, status: "pending" })),
                connectionError: null,
              },
            }));
            break;
          case "connected":
            onRunStateChange((current) => current.liveRun ? {
              ...current,
              liveRun: { ...current.liveRun, protocolVersion: progress.protocolVersion },
            } : current);
            break;
          case "callStarted":
            onRunStateChange((current) => current.liveRun ? {
              ...current,
              liveRun: {
                ...current.liveRun,
                calls: current.liveRun.calls.map((call) => call.index === progress.index ? { ...call, status: "running" } : call),
              },
            } : current);
            break;
          case "callFinished":
            onRunStateChange((current) => current.liveRun ? {
              ...current,
              liveRun: {
                ...current.liveRun,
                summary: progress.summary,
                calls: current.liveRun.calls.map((call) => call.index === progress.call.index
                  ? { ...call, status: progress.call.status, result: progress.call }
                  : call),
              },
            } : current);
            break;
          case "connectionFailed":
            onRunStateChange((current) => current.liveRun ? {
              ...current,
              liveRun: { ...current.liveRun, connectionError: progress.error },
            } : current);
            break;
        }
      };
      const response = await invoke<AutomatedRunResponse>("run_automated_test", {
        request: { profile, content, context: { inputs: {} } },
        onProgress,
      });
      onRunStateChange((current) => ({
        ...current,
        isRunning: false,
        run: response,
        liveRun: null,
        reportPath: `${response.result.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "mcp-check"}.html`,
      }));
      onCountChange(response.result.summary.total);
      setValidation(`Valid test set / ${response.result.summary.total} calls`);
      onRunComplete();
    } catch (runError) {
      setError(String(runError));
    } finally {
      onRunStateChange((current) => ({ ...current, isRunning: false }));
    }
  }

  async function saveReports() {
    if (!run) return;
    setError(null);
    try {
      const reports = await invoke<SaveReportResponse>("save_report_bundle", {
        request: {
          htmlPath: reportPath,
          html: run.reportHtml,
          yaml: run.reportYaml,
        },
      });
      onRunStateChange((current) => ({ ...current, savedReports: reports }));
    } catch (saveError) {
      setError(String(saveError));
    }
  }

  return (
    <>
    <div className="automation-panel">
      <section className="automation-editor">
        <div className="panel-heading-row">
          <div>
            <span className="eyebrow">JSON or YAML</span>
            <h2>Automated test set</h2>
            <code className="document-path">{testPath ?? "Unsaved mcp-test.yaml"}</code>
          </div>
          <div className="panel-actions">
            <button
              className="text-button"
              type="button"
              onClick={generateTests}
              disabled={!snapshot || generatedCallCount === 0}
              title={snapshot ? `Generate ${generatedCallCount} calls from discovered definitions` : "Connect to discover server definitions"}
            >
              <WandSparkles size={14} /> Generate
            </button>
            <button className="text-button" type="button" onClick={loadTestFile}><FileUp size={14} /> Open</button>
            <button className="text-button" type="button" onClick={saveTestFile}><Save size={14} /> Save</button>
            <button className="text-button" type="button" onClick={validate}>Validate</button>
            <button
              className="primary-button"
              type="button"
              onClick={execute}
              disabled={!profile.trusted || isRunning}
              title={profile.trusted ? "Run test set" : "Approve this server with Connect first"}
            >
              {isRunning ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
              {isRunning ? "Running" : "Run all"}
            </button>
          </div>
        </div>
        <textarea
          aria-label="Test set source"
          value={content}
          onChange={(event) => {
            onDocumentChange({ content: event.currentTarget.value, path: testPath });
            setValidation(null);
          }}
          spellCheck={false}
        />
        {!profile.trusted && (
          <p className="automation-note">Approve this server with Connect before running tests.</p>
        )}
        {validation && <p className="automation-valid"><Check size={14} /> {validation}</p>}
        {error && <p className="automation-error"><AlertTriangle size={14} /> {error}</p>}
      </section>

      <section className="automation-results">
        <div className="panel-heading-row">
          <div>
            <span className="eyebrow">Latest run</span>
            <h2>{run?.result.name ?? liveRun?.name ?? "No results"}</h2>
          </div>
          {run && (
            <div className="report-save-controls">
              <input
                aria-label="Report HTML path"
                value={reportPath}
                onChange={(event) => onRunStateChange((current) => ({ ...current, reportPath: event.currentTarget.value }))}
              />
              <button className="secondary-button" type="button" onClick={saveReports} disabled={!reportPath.trim()}>
                <Download size={15} /> Save HTML + YAML
              </button>
            </div>
          )}
        </div>
        {run ? (
          <>
            <div className={`run-summary run-${run.result.status}`}>
              <strong>{run.result.status}</strong>
              <span>{run.result.summary.passed} passed</span>
              <span>{run.result.summary.failed} failed</span>
              <span>{run.result.summary.errors} errors</span>
              <span>{run.result.durationMs} ms</span>
            </div>
            {savedReports && (
              <div className="saved-reports" role="status">
                <Check size={15} />
                <span><strong>HTML</strong><code>{savedReports.htmlPath}</code></span>
                <span><strong>YAML</strong><code>{savedReports.yamlPath}</code></span>
              </div>
            )}
            <div className="run-calls">
              {run.result.calls.map((call) => (
                <details key={call.index} open={call.status !== "passed"}>
                  <summary>
                    <span>#{call.index}</span>
                    <strong>{call.operation}</strong>
                    <code>{call.target}</code>
                    <b className={`call-${call.status}`}>{call.status}</b>
                  </summary>
                  {call.error && <p className="automation-error">{call.error}</p>}
                  {call.assertions.map((assertion) => (
                    <p className={assertion.passed ? "assertion-pass" : "assertion-fail"} key={`${call.index}-${assertion.kind}`}>
                      {assertion.passed ? <Check size={13} /> : <X size={13} />}
                      <strong>{assertion.kind}</strong> {assertion.message}
                    </p>
                  ))}
                  <pre>{JSON.stringify(call.response, null, 2)}</pre>
                </details>
              ))}
            </div>
          </>
        ) : liveRun ? (
          <>
            <div className={`run-summary ${liveRun.connectionError ? "run-error" : "run-running"}`}>
              <strong>{liveRun.connectionError ? "error" : "running"}</strong>
              <span>{liveRun.summary.passed} passed</span>
              <span>{liveRun.summary.failed} failed</span>
              <span>{liveRun.summary.errors} errors</span>
              <span>{liveRun.calls.filter((call) => call.result).length} / {liveRun.total} complete</span>
            </div>
            <div className="run-progress" aria-label="Run progress">
              <span style={{ width: `${liveRun.total === 0 ? 100 : liveRun.calls.filter((call) => call.result).length / liveRun.total * 100}%` }} />
            </div>
            {liveRun.connectionError && <p className="automation-error"><AlertTriangle size={14} /> {liveRun.connectionError}</p>}
            <div className="run-calls">
              {liveRun.calls.map((call) => (
                <details key={call.index} open={call.status === "running" || Boolean(call.result && call.result.status !== "passed")}>
                  <summary>
                    <span>#{call.index}</span>
                    <strong>{call.operation}</strong>
                    <code>{call.target}</code>
                    <b className={`call-${call.status}`}>
                      {call.status === "running" && <LoaderCircle className="spin" size={12} />}
                      {call.status}
                    </b>
                  </summary>
                  {call.result?.error && <p className="automation-error">{call.result.error}</p>}
                  {call.result?.assertions.map((assertion) => (
                    <p className={assertion.passed ? "assertion-pass" : "assertion-fail"} key={`${call.index}-${assertion.kind}`}>
                      {assertion.passed ? <Check size={13} /> : <X size={13} />}
                      <strong>{assertion.kind}</strong> {assertion.message}
                    </p>
                  ))}
                  {call.result && <pre>{JSON.stringify(call.result.response, null, 2)}</pre>}
                </details>
              ))}
            </div>
          </>
        ) : (
          <div className="disconnected-panel compact"><ClipboardCheck size={26} /><span>Run a test set to inspect assertions</span></div>
        )}
      </section>
    </div>
    {showGeneration && (
      <div className="dialog-backdrop" role="presentation">
        <section className="generation-dialog" role="dialog" aria-modal="true" aria-labelledby="generate-title">
          <header className="dialog-header">
            <div>
              <span className="eyebrow">Server definitions</span>
              <h2 id="generate-title">Select tests to generate</h2>
            </div>
            <button className="icon-button" type="button" onClick={() => setShowGeneration(false)} aria-label="Close"><X size={18} /></button>
          </header>
          <div className="generation-toolbar">
            <span>{generationSelection.length} of {generatedCallCount} selected</span>
            <div>
              <button className="text-button" type="button" onClick={() => setGenerationSelection(availableGenerationItems.map((item) => item.id))}>Select all</button>
              <button className="text-button" type="button" onClick={() => setGenerationSelection([])}>Select none</button>
            </div>
          </div>
          <div className="generation-list">
            {availableGenerationItems.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={generationSelection.includes(item.id)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setGenerationSelection((current) => checked
                      ? [...current, item.id]
                      : current.filter((id) => id !== item.id));
                  }}
                />
                <span><strong>{item.name}</strong><small>{item.description}</small></span>
                <b>{item.kind}</b>
              </label>
            ))}
          </div>
          <div className={`generation-warning ${content.trim() ? "visible" : ""}`}>
            {content.trim() && <><AlertTriangle size={14} /><span>The current test document contains content and will be replaced.</span></>}
          </div>
          <footer className="dialog-footer">
            <button className="text-button" type="button" onClick={() => setShowGeneration(false)}>Cancel</button>
            <button className="primary-button" type="button" onClick={applyGeneration} disabled={generationSelection.length === 0}><WandSparkles size={15} /> {content.trim() ? "Replace and generate" : "Generate selected"}</button>
          </footer>
        </section>
      </div>
    )}
    </>
  );
}

function KeyValueEditor({
  label,
  entries,
  secretIdPrefix,
  secrets,
  onChange,
}: {
  label: string;
  entries: KeyValueEntry[];
  secretIdPrefix: string;
  secrets: SecretSummary[];
  onChange: (entries: KeyValueEntry[]) => void;
}) {
  const secretListId = `secret-ids-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const suggestedSecretId = (key: string, index: number) => {
    const value = `${secretIdPrefix}-${key}`
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return value || `secret-${index + 1}`;
  };

  return (
    <fieldset className="key-value-editor">
      <legend>{label}</legend>
      {entries.map((entry, index) => (
        <div key={index}>
          <input
            aria-label={`${label} key ${index + 1}`}
            placeholder="Name"
            value={entry.key}
            onChange={(event) => onChange(entries.map((candidate, current) => current === index ? { ...candidate, key: event.currentTarget.value } : candidate))}
          />
          <input
            aria-label={`${label} value ${index + 1}`}
            placeholder="Value"
            type={entry.secret ? "password" : "text"}
            value={entry.value}
            onChange={(event) => onChange(entries.map((candidate, current) => current === index ? { ...candidate, value: event.currentTarget.value } : candidate))}
          />
          <label className="secret-toggle" title={entry.secret ? "Use a managed secret reference" : "Store this value in the OS keychain"}>
            <input
              type="checkbox"
              checked={entry.secret}
              aria-label={`Mark ${label} ${index + 1} as secret`}
              onChange={(event) => onChange(entries.map((candidate, current) => current === index ? {
                ...candidate,
                secret: event.currentTarget.checked,
                secretId: event.currentTarget.checked
                  ? candidate.secretId || suggestedSecretId(candidate.key, index)
                  : candidate.secretId,
              } : candidate))}
            />
            <KeyRound size={12} />
            <span>Secret</span>
          </label>
          <button className="icon-button" type="button" aria-label={`Remove ${label} ${index + 1}`} onClick={() => onChange(entries.filter((_, current) => current !== index))}><Trash2 size={14} /></button>
          {entry.secret && (
            <input
              className="secret-id-input"
              aria-label={`${label} secret ID ${index + 1}`}
              list={secretListId}
              placeholder="Secret ID"
              value={entry.secretId}
              onChange={(event) => onChange(entries.map((candidate, current) => current === index ? { ...candidate, secretId: event.currentTarget.value } : candidate))}
            />
          )}
        </div>
      ))}
      <button className="text-button" type="button" onClick={() => onChange([...entries, { key: "", value: "", secret: false, secretId: "" }])}><Plus size={14} /> Add {label.toLowerCase()}</button>
      <datalist id={secretListId}>
        {secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.label}</option>)}
      </datalist>
    </fieldset>
  );
}

function ServerDialog({
  state,
  protocolVersions,
  secrets,
  onChange,
  onSave,
  onClose,
}: {
  state: ServerEditorState;
  protocolVersions: string[];
  secrets: SecretSummary[];
  onChange: (state: ServerEditorState) => void;
  onSave: (draft: ServerDraft, originalName: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { draft } = state;
  const update = (patch: Partial<ServerDraft>) => onChange({ ...state, draft: { ...draft, ...patch } });
  const remote = draft.transportType !== "stdio";

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="server-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError(null);
          void onSave(draft, state.originalName)
            .catch((saveError) => setError(String(saveError)))
            .finally(() => setSaving(false));
        }}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Server configuration</span>
            <h2 id="server-dialog-title">{state.originalName ? "Edit MCP server" : "Add MCP server"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <div className="server-form">
          <label><span>Name</span><input autoFocus value={draft.name} onChange={(event) => update({ name: event.currentTarget.value })} /></label>
          <label><span>Transport</span><select value={draft.transportType} onChange={(event) => update({ transportType: event.currentTarget.value as TransportConfig["type"] })}><option value="stdio">Standard I/O</option><option value="http">Streamable HTTP</option><option value="sse">HTTP + SSE</option><option value="auto">Auto-detect</option><option value="websocket">WebSocket</option></select></label>
          <label><span>Protocol</span><select value={draft.protocol} onChange={(event) => update({ protocol: event.currentTarget.value })}><option value="auto">Auto negotiate</option>{protocolVersions.map((version) => <option key={version} value={`exact:${version}`}>{version}</option>)}</select></label>
          <label><span>Timeout (ms)</span><input type="number" min="1" value={draft.timeout} onChange={(event) => update({ timeout: event.currentTarget.value })} placeholder="Default" /></label>

          {remote ? (
            <>
              <label className="server-form-wide"><span>URL</span><input type="url" value={draft.url} onChange={(event) => update({ url: event.currentTarget.value })} placeholder="https://example.com/mcp" /></label>
              <div className="server-form-wide"><KeyValueEditor label="Headers" entries={draft.headers} secretIdPrefix={draft.name} secrets={secrets} onChange={(headers) => update({ headers })} /></div>
              {draft.transportType !== "websocket" && (
                <fieldset className="oauth-fields server-form-wide">
                  <legend>OAuth (optional)</legend>
                  <label><span>Client ID</span><input value={draft.oauthClientId} onChange={(event) => update({ oauthClientId: event.currentTarget.value })} /></label>
                  <label><span>Scopes</span><input value={draft.oauthScopes} onChange={(event) => update({ oauthScopes: event.currentTarget.value })} /></label>
                  <label className="server-form-wide"><span>Authorization metadata URL</span><input type="url" value={draft.oauthMetadataUrl} onChange={(event) => update({ oauthMetadataUrl: event.currentTarget.value })} /></label>
                  <label><span>Callback port</span><input type="number" min="1" max="65535" value={draft.oauthCallbackPort} onChange={(event) => update({ oauthCallbackPort: event.currentTarget.value })} /></label>
                  <label className="checkbox-label"><input type="checkbox" checked={draft.oauthEnterpriseManaged} onChange={(event) => update({ oauthEnterpriseManaged: event.currentTarget.checked })} /><span>Enterprise managed</span></label>
                </fieldset>
              )}
            </>
          ) : (
            <>
              <label className="server-form-wide"><span>Command</span><input value={draft.command} onChange={(event) => update({ command: event.currentTarget.value })} placeholder="npx" /></label>
              <label className="server-form-wide"><span>Arguments (one per line)</span><textarea value={draft.args} onChange={(event) => update({ args: event.currentTarget.value })} /></label>
              <label><span>Working directory</span><input value={draft.cwd} onChange={(event) => update({ cwd: event.currentTarget.value })} /></label>
              <label><span>Environment file</span><input value={draft.envFile} onChange={(event) => update({ envFile: event.currentTarget.value })} /></label>
              <div className="server-form-wide"><KeyValueEditor label="Environment" entries={draft.env} secretIdPrefix={draft.name} secrets={secrets} onChange={(env) => update({ env })} /></div>
            </>
          )}
        </div>

        {error && <div className="import-message import-error"><AlertTriangle size={15} /><span>{error}</span></div>}
        <footer className="dialog-footer">
          <button className="text-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} {saving ? "Saving" : "Save server"}</button>
        </footer>
      </form>
    </div>
  );
}

type SecretEditorState = {
  id: string;
  label: string;
  value: string;
  existing: boolean;
};

function SecretsDialog({
  secrets,
  error,
  onChanged,
  onClose,
}: {
  secrets: SecretSummary[];
  error: string | null;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [editor, setEditor] = useState<SecretEditorState | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function addSecret() {
    setFormError(null);
    setEditor({ id: "", label: "", value: "", existing: false });
  }

  function editSecret(secret: SecretSummary) {
    setFormError(null);
    setEditor({ id: secret.id, label: secret.label, value: "", existing: true });
  }

  async function saveSecret() {
    if (!editor || !isTauriRuntime()) {
      setFormError("Secret storage requires the MCP Check desktop runtime.");
      return;
    }
    const id = editor.id.trim();
    if (!id) {
      setFormError("Secret ID is required.");
      return;
    }

    setBusy(true);
    setFormError(null);
    try {
      const value = editor.value || (editor.existing
        ? await invoke<string>("get_secret", { id })
        : "");
      if (!value) throw new Error("Secret value is required.");
      await invoke<SecretSummary>("set_secret", {
        request: { id, label: editor.label, value },
      });
      await onChanged();
      setRevealed((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setEditor(null);
    } catch (saveError) {
      setFormError(String(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSecret(secret: SecretSummary) {
    if (!window.confirm(`Delete the managed secret '${secret.label}'?`)) return;
    setBusy(true);
    setFormError(null);
    try {
      await invoke("delete_secret", { id: secret.id });
      setRevealed((current) => {
        const next = { ...current };
        delete next[secret.id];
        return next;
      });
      await onChanged();
      if (editor?.id === secret.id) setEditor(null);
    } catch (deleteError) {
      setFormError(String(deleteError));
    } finally {
      setBusy(false);
    }
  }

  async function toggleReveal(secret: SecretSummary) {
    if (revealed[secret.id] !== undefined) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[secret.id];
        return next;
      });
      return;
    }
    try {
      const value = await invoke<string>("get_secret", { id: secret.id });
      setRevealed((current) => ({ ...current, [secret.id]: value }));
      setFormError(null);
    } catch (revealError) {
      setFormError(String(revealError));
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="secrets-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="secrets-dialog-title"
      >
        <header className="dialog-header secrets-dialog-header">
          <div>
            <span className="eyebrow">Local credentials</span>
            <h2 id="secrets-dialog-title">Managed secrets</h2>
          </div>
          <div className="secret-dialog-actions">
            <button className="secondary-button" type="button" onClick={addSecret} disabled={busy}>
              <Plus size={15} /> Add secret
            </button>
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="secret-list" aria-label="Managed secrets">
          {secrets.map((secret) => (
            <div className="secret-row" key={secret.id}>
              <KeyRound size={16} aria-hidden="true" />
              <div className="secret-row-copy">
                <strong>{secret.label}</strong>
                <small><code>{secret.id}</code> / {secret.available ? "OS keychain" : "Unavailable"}</small>
              </div>
              <code className={`secret-value ${secret.available ? "" : "secret-value-unavailable"}`}>
                {revealed[secret.id] ?? "********"}
              </code>
              <div className="secret-row-actions">
                <button className="icon-button" type="button" disabled={!secret.available || busy} onClick={() => void toggleReveal(secret)} aria-label={`${revealed[secret.id] !== undefined ? "Hide" : "Reveal"} ${secret.label}`} title={revealed[secret.id] !== undefined ? "Hide secret" : "Reveal secret"}>
                  {revealed[secret.id] !== undefined ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button className="icon-button" type="button" disabled={busy} onClick={() => editSecret(secret)} aria-label={`Edit ${secret.label}`} title="Edit secret"><Pencil size={14} /></button>
                <button className="icon-button" type="button" disabled={busy} onClick={() => void deleteSecret(secret)} aria-label={`Delete ${secret.label}`} title="Delete secret"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
          {secrets.length === 0 && <div className="secret-list-empty"><KeyRound size={22} /><span>No managed secrets</span><small>Add one here or mark a server header/environment value as secret.</small></div>}
        </div>

        {(error || formError) && <div className="secret-dialog-message" role="alert"><AlertTriangle size={15} /><span>{formError ?? error}</span></div>}

        {editor && (
          <form className="secret-form" onSubmit={(event) => { event.preventDefault(); void saveSecret(); }}>
            <div className="secret-form-heading">
              <span className="eyebrow">{editor.existing ? "Update credential" : "New credential"}</span>
              <strong>{editor.existing ? editor.id : "Add a keychain entry"}</strong>
            </div>
            <label><span>Secret ID</span><input autoFocus={!editor.existing} value={editor.id} disabled={editor.existing} onChange={(event) => setEditor({ ...editor, id: event.currentTarget.value })} placeholder="github-token" /></label>
            <label><span>Label</span><input value={editor.label} onChange={(event) => setEditor({ ...editor, label: event.currentTarget.value })} placeholder="GitHub token" /></label>
            <label><span>{editor.existing ? "Replacement value" : "Value"}</span><input type="password" autoComplete="new-password" value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.currentTarget.value })} placeholder={editor.existing ? "Leave blank to keep current value" : "Enter secret value"} /></label>
            <footer className="dialog-footer">
              <button className="text-button" type="button" onClick={() => setEditor(null)} disabled={busy}>Cancel</button>
              <button className="primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} {busy ? "Saving" : "Save secret"}</button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}

type ResolutionDialogProps = {
  serverName: string;
  inputs: ConfigInputDefinition[];
  storedSecretIds: string[];
  onConnect: (values: Record<string, string>) => Promise<void>;
  onClose: () => void;
};

function ResolutionDialog({
  serverName,
  inputs,
  storedSecretIds,
  onConnect,
  onClose,
}: ResolutionDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(inputs.map((input) => [input.id, input.defaultValue ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const stored = new Set(storedSecretIds);
  const complete = inputs.every((input) => values[input.id]?.length > 0 || (input.secret && stored.has(input.id)));

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="resolution-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resolution-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!complete || connecting) return;
          setConnecting(true);
          setError(null);
          void onConnect(values)
            .catch((connectError) => setError(String(connectError)))
            .finally(() => setConnecting(false));
        }}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Connection values</span>
            <h2 id="resolution-title">Connect to {serverName}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="resolution-fields">
          {inputs.map((input) => (
            <label key={input.id}>
              <span>{input.description}</span>
              {input.kind === "pick" && input.options.length > 0 ? (
                <select
                  value={values[input.id]}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setValues((current) => ({
                      ...current,
                      [input.id]: value,
                    }));
                  }}
                >
                  <option value="">Select a value</option>
                  {input.options.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={input.secret ? "password" : "text"}
                  value={values[input.id]}
                  autoComplete="off"
                  autoFocus={input === inputs[0]}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setValues((current) => ({
                      ...current,
                      [input.id]: value,
                    }));
                  }}
                />
              )}
              {input.kind === "command" && (
                <small>Command inputs are never executed; provide the resulting value.</small>
              )}
              {input.secret && stored.has(input.id) && (
                <small>Stored in the OS keychain. Enter a new value to replace it.</small>
              )}
            </label>
          ))}
        </div>
        {error && <div className="import-message import-error"><AlertTriangle size={15} /><span>{error}</span></div>}
        <footer className="dialog-footer">
          <button className="text-button" type="button" onClick={onClose} disabled={connecting}>Cancel</button>
          <button
            className="primary-button"
            type="submit"
            disabled={!complete || connecting}
            aria-label="Connect"
          >
            {connecting ? <LoaderCircle className="spin" size={16} /> : <PlugZap size={16} />} {connecting ? "Connecting" : "Connect"}
          </button>
        </footer>
      </form>
    </div>
  );
}

type ImportDialogProps = {
  content: string;
  path: string | null;
  source: ConfigSourceKind;
  result: ImportResult | null;
  error: string | null;
  isImporting: boolean;
  onContentChange: (value: string) => void;
  onLoad: () => void;
  onSave: () => void;
  onSourceChange: (value: ConfigSourceKind) => void;
  onPreview: () => void;
  onAccept: () => void;
  onClose: () => void;
};

function ImportDialog({
  content,
  path,
  source,
  result,
  error,
  isImporting,
  onContentChange,
  onLoad,
  onSave,
  onSourceChange,
  onPreview,
  onAccept,
  onClose,
}: ImportDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Configuration</span>
            <h2 id="import-title">Import servers</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="import-controls">
          <label>
            <span>Format</span>
            <select
              value={source}
              onChange={(event) =>
                onSourceChange(event.currentTarget.value as ConfigSourceKind)
              }
            >
              <option value="auto">Auto detect</option>
              <option value="vsCode">VS Code</option>
              <option value="claude">Claude</option>
              <option value="inspector">Inspector</option>
              <option value="generic">Generic MCP</option>
            </select>
          </label>
          <div className="document-actions">
            <button className="text-button" type="button" onClick={onLoad} disabled={!isTauriRuntime()}>
              <FileUp size={14} /> Open
            </button>
            <button className="text-button" type="button" onClick={onSave} disabled={!isTauriRuntime()}>
              <Save size={14} /> Save
            </button>
          </div>
        </div>

        <label className="config-editor">
          <span className="document-label"><strong>JSON configuration</strong><code>{path ?? "Unsaved mcp.json"}</code></span>
          <textarea
            value={content}
            onChange={(event) => onContentChange(event.currentTarget.value)}
            spellCheck={false}
          />
        </label>

        {error && (
          <div className="import-message import-error">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div className="import-preview">
            <div className="preview-summary">
              <strong>{result.profiles.length} servers found</strong>
              <span>{result.sourceKind}</span>
            </div>
            <div className="preview-list">
              {result.profiles.map((profile) => (
                <div key={profile.name} className="preview-row">
                  <Server size={15} />
                  <strong>{profile.name}</strong>
                  <span>{transportLabel(profile.transport)}</span>
                </div>
              ))}
            </div>
            {result.diagnostics.map((diagnostic, index) => (
              <div className="import-message" key={`${diagnostic.message}-${index}`}>
                <Info size={15} />
                <span>{diagnostic.message}</span>
              </div>
            ))}
          </div>
        )}

        <footer className="dialog-footer">
          <button className="text-button" type="button" onClick={onClose}>
            Cancel
          </button>
          {result ? (
            <button
              className="primary-button"
              type="button"
              onClick={onAccept}
              disabled={result.profiles.length === 0}
            >
              Import {result.profiles.length}
              <ArrowRight size={16} />
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              onClick={onPreview}
              disabled={isImporting || content.trim().length === 0}
            >
              {isImporting ? "Reading..." : "Preview"}
              <ArrowRight size={16} />
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

export default App;
