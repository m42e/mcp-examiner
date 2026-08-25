export type ConfigSourceKind =
  | "auto"
  | "vsCode"
  | "claude"
  | "inspector"
  | "generic";

export type ProtocolSelection =
  | { mode: "legacy"; version: string | null }
  | { mode: "auto"; legacyVersion: string | null }
  | { mode: "modern" }
  | { mode: "exact"; version: string };

export type OAuthConfig = {
  clientId: string | null;
  callbackPort: number | null;
  scopes: string | null;
  authServerMetadataUrl: string | null;
  enterpriseManaged: boolean;
};

export type TransportConfig =
  | {
      type: "stdio";
      command: string;
      args: string[];
      cwd: string | null;
      env: Record<string, unknown>;
      envFile: string | null;
    }
  | {
      type: "http" | "sse" | "auto";
      url: string;
      headers: Record<string, string>;
      oauth: OAuthConfig | null;
    }
  | {
      type: "websocket";
      url: string;
      headers: Record<string, string>;
    };

export type ServerProfile = {
  formatVersion: number;
  name: string;
  transport: TransportConfig;
  protocol: ProtocolSelection;
  source: {
    kind: ConfigSourceKind;
    path: string | null;
    scope: string | null;
  };
  timeoutMs: number | null;
  trusted: boolean;
};

export type ImportDiagnostic = {
  level: "info" | "warning" | "error";
  server: string | null;
  field: string | null;
  message: string;
};

export type ConfigInputDefinition = {
  id: string;
  kind: "prompt" | "pick" | "command";
  description: string;
  secret: boolean;
  defaultValue: string | null;
  options: { label: string; value: string }[];
};

export type SecretSummary = {
  id: string;
  label: string;
  updatedAtUnixMs: number;
  available: boolean;
};

export type ImportResult = {
  formatVersion: number;
  sourceKind: ConfigSourceKind;
  profiles: ServerProfile[];
  inputs: ConfigInputDefinition[];
  diagnostics: ImportDiagnostic[];
};

export type AppInfo = {
  name: string;
  version: string;
  formatVersion: number;
  protocolVersions: string[];
};

export type ToolSummary = {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
  outputSchema: unknown | null;
  annotations: unknown | null;
  metadata: unknown | null;
};

export type ResourceSummary = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
};

export type ResourceTemplateSummary = {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

export type PromptArgumentSummary = {
  name: string;
  description?: string;
  required?: boolean;
};

export type PromptSummary = {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgumentSummary[];
};

export type ConnectionSnapshot = {
  serverName: string;
  protocolVersion: string;
  serverInfo: unknown | null;
  capabilities: unknown;
  instructions: string | null;
  tools: ToolSummary[];
  resources: ResourceSummary[];
  resourceTemplates: ResourceTemplateSummary[];
  prompts: PromptSummary[];
  discoveryErrors: Record<string, string>;
};

export type RunStatus = "passed" | "failed" | "error";

export type AssertionOutcome = {
  kind: string;
  passed: boolean;
  message: string;
};

export type CallRunResult = {
  index: number;
  operation: string;
  target: string;
  definition: TestCallDefinition;
  status: RunStatus;
  durationMs: number;
  response: unknown | null;
  assertions: AssertionOutcome[];
  error: string | null;
};

export type ResponseExpectation = {
  contains?: string;
  pattern?: string;
  json?: unknown;
};

export type TestCallDefinition =
  | { type: "callTool"; name: string; arguments?: Record<string, unknown>; expect?: ResponseExpectation }
  | { type: "readResource"; uri: string; expect?: ResponseExpectation }
  | { type: "getPrompt"; name: string; arguments?: Record<string, unknown>; expect?: ResponseExpectation };

export type PendingCall = {
  index: number;
  operation: string;
  target: string;
};

export type RunSummary = {
  total: number;
  passed: number;
  failed: number;
  errors: number;
};

export type RunProgress =
  | { event: "started"; name: string; total: number; calls: PendingCall[] }
  | { event: "connected"; protocolVersion: string }
  | { event: "callStarted"; index: number; operation: string; target: string }
  | { event: "callFinished"; call: CallRunResult; summary: RunSummary }
  | { event: "connectionFailed"; error: string };

export type TestRunResult = {
  formatVersion: number;
  name: string;
  description: string | null;
  serverName: string;
  serverProfile: ServerProfile;
  serverSnapshot: ConnectionSnapshot | null;
  protocolVersion: string | null;
  status: RunStatus;
  startedAtUnixMs: number;
  durationMs: number;
  summary: RunSummary;
  calls: CallRunResult[];
  protocolEvents: ProtocolEvent[];
  httpObservations: HttpObservation[];
  connectionError: string | null;
  shutdownError: string | null;
};

export type ProtocolEvent = {
  sequence: number;
  elapsedMs: number;
  direction: "clientToServer" | "serverToClient" | "internal";
  method: string;
  payload: unknown;
};

export type HttpObservation = {
  sequence: number;
  elapsedMs: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown | null;
  responseKind: string | null;
  responseBody: unknown | null;
  sessionId: string | null;
  error: string | null;
};

export type AutomatedRunResponse = {
  result: TestRunResult;
  reportHtml: string;
  reportYaml: string;
};

export type SaveReportResponse = {
  htmlPath: string;
  yamlPath: string;
};
