import type {
  ProtocolSelection,
  ServerProfile,
  TransportConfig,
} from "../contracts";

export type KeyValueEntry = {
  key: string;
  value: string;
  secret: boolean;
  secretId: string;
};

export type ServerDraft = {
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

export type ServerEditorState = {
  originalName: string | null;
  draft: ServerDraft;
};

export function transportLabel(transport: TransportConfig) {
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

export function endpointLabel(transport: TransportConfig) {
  if (transport.type === "stdio") {
    return [transport.command, ...transport.args].join(" ");
  }
  return transport.url;
}

export function protocolValue(protocol: ProtocolSelection) {
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

export function protocolFromValue(value: string): ProtocolSelection {
  if (value === "auto") {
    return { mode: "auto", legacyVersion: "2025-11-25" };
  }

  const version = value.replace("exact:", "");
  if (version === "2026-07-28") {
    return { mode: "modern" };
  }
  return { mode: "exact", version };
}

export function referencedInputIds(profile: ServerProfile) {
  const ids = new Set<string>();
  for (const match of JSON.stringify(profile).matchAll(/\$\{input:([^}]+)\}/g)) {
    ids.add(match[1]);
  }
  return ids;
}

export function referencedSecretIds(profile: ServerProfile) {
  const ids = new Set<string>();
  for (const match of JSON.stringify(profile).matchAll(/\$\{secret:([^}]+)\}/g)) {
    ids.add(match[1]);
  }
  return ids;
}

export function keyValueEntries(values: Record<string, unknown>) {
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

export function emptyServerDraft(): ServerDraft {
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

export function profileDraft(profile: ServerProfile): ServerDraft {
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

export function entriesObject(entries: KeyValueEntry[]) {
  return Object.fromEntries(entries.filter((entry) => entry.key.trim()).map((entry) => {
    const key = entry.key.trim();
    if (!entry.secret) return [key, entry.value];
    const secretId = entry.secretId.trim();
    if (!secretId) throw new Error(`Secret ID is required for '${key}'.`);
    return [key, `\${secret:${secretId}}`];
  }));
}

export function draftProfile(draft: ServerDraft, sourcePath: string | null): ServerProfile {
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

export function serializeProfiles(profiles: ServerProfile[]) {
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
