import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type {
  AppInfo,
  ConfigInputDefinition,
  ConfigSourceKind,
  ConnectionSnapshot,
  ImportResult,
  ProtocolEvent,
  ServerProfile,
  SecretSummary,
} from "./contracts";
import {
  draftProfile,
  emptyServerDraft,
  profileDraft,
  protocolFromValue,
  referencedInputIds,
  referencedSecretIds,
  serializeProfiles,
  type ServerDraft,
  type ServerEditorState,
} from "./lib/profile";
import {
  emptyTestRunState,
  type TestDocument,
  type TestRunState,
  type TestRunStateUpdate,
} from "./lib/run";
import { isTauriRuntime } from "./lib/tauri";
import type { TabId } from "./lib/tabs";
import { EmptyWorkspace } from "./components/shell/EmptyWorkspace";
import { Overview } from "./components/panels/Overview";
import { ToolsPanel } from "./components/panels/ToolsPanel";
import { ResourcesPanel } from "./components/panels/ResourcesPanel";
import { PromptsPanel } from "./components/panels/PromptsPanel";
import { NetworkPanel } from "./components/panels/NetworkPanel";
import { ProtocolPanel } from "./components/panels/ProtocolPanel";
import { ConsolePanel } from "./components/panels/ConsolePanel";
import { DisconnectedPanel } from "./components/panels/DisconnectedPanel";
import { AutomationPanel } from "./components/panels/AutomationPanel";
import { Titlebar } from "./components/shell/Titlebar";
import { ServerRail } from "./components/shell/ServerRail";
import { ServerHeader } from "./components/shell/ServerHeader";
import { WorkspaceTabs } from "./components/shell/WorkspaceTabs";
import { ConnectionToast } from "./components/shell/ConnectionToast";
import { ServerDialog } from "./components/dialogs/ServerDialog";
import { SecretsDialog } from "./components/dialogs/SecretsDialog";
import { ResolutionDialog } from "./components/dialogs/ResolutionDialog";
import { ImportDialog } from "./components/dialogs/ImportDialog";

const fallbackInfo: AppInfo = {
  name: "MCP Examiner",
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
  const [connectionToastVisible, setConnectionToastVisible] = useState(false);
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

  function reportConnectionError(error: unknown) {
    setConnectionError(String(error));
    setConnectionToastVisible(true);
  }

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
        ...(connectionError ? { console: 1 } : {}),
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
      setSecretError("Secret management requires the MCP Examiner desktop runtime.");
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
      setImportError("Config import requires the MCP Examiner desktop runtime.");
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
      reportConnectionError(error);
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
      reportConnectionError(error);
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
        throw new Error("Secret storage requires the MCP Examiner desktop runtime.");
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
        reportConnectionError(error);
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
      reportConnectionError(error);
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
      reportConnectionError(error);
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
      <Titlebar appInfo={appInfo} />

      <ServerRail
        profiles={profiles}
        filteredProfiles={filteredProfiles}
        selectedName={selectedName}
        connections={connections}
        query={query}
        onQueryChange={setQuery}
        onSelect={(name) => {
          setSelectedName(name);
          setActiveTab("overview");
        }}
        onOpenConfig={openWorkspaceConfig}
        onSaveConfig={saveWorkspaceConfig}
        onAddServer={() => setServerEditor({ originalName: null, draft: emptyServerDraft() })}
        onPasteConfig={() => setShowImport(true)}
        onOpenSecrets={openSecrets}
      />

      <main className="workspace">
        {selectedProfile ? (
          <>
            <ServerHeader
              profile={selectedProfile}
              connection={selectedConnection}
              canConnect={isTauriRuntime()}
              connecting={connectingName === selectedProfile.name}
              protocolVersions={appInfo.protocolVersions}
              onEdit={() => setServerEditor({ originalName: selectedProfile.name, draft: profileDraft(selectedProfile) })}
              onProtocolChange={updateProtocol}
              onConnect={connectSelected}
              onDisconnect={disconnectSelected}
            />

            <WorkspaceTabs
              activeTab={activeTab}
              tabCounts={tabCounts}
              onSelect={setActiveTab}
            />

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
              ) : activeTab === "console" ? (
                <ConsolePanel
                  serverName={selectedProfile.name}
                  connected={Boolean(selectedConnection)}
                  connectionError={connectionError}
                  onClearError={() => setConnectionError(null)}
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
      {connectionError && connectionToastVisible && (
        <ConnectionToast
          error={connectionError}
          onDismiss={() => setConnectionToastVisible(false)}
        />
      )}
    </div>
  );
}

export default App;
