import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
};

type UiCsp = {
  connectDomains?: unknown;
  resourceDomains?: unknown;
  frameDomains?: unknown;
  baseUriDomains?: unknown;
};

type UiPermissions = {
  camera?: unknown;
  microphone?: unknown;
  geolocation?: unknown;
  clipboardWrite?: unknown;
};

export type McpAppResource = {
  html: string;
  csp?: UiCsp;
  permissions?: UiPermissions;
};

type ResourceContent = {
  mimeType?: unknown;
  text?: unknown;
  blob?: unknown;
  _meta?: unknown;
  meta?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isMcpAppMimeType(mimeType: unknown) {
  if (typeof mimeType !== "string") return false;
  const [mediaType, ...parameters] = mimeType.split(";");
  if (mediaType.trim().toLowerCase() !== "text/html") return false;

  return parameters.some((parameter) => {
    const separator = parameter.indexOf("=");
    if (separator === -1) return false;
    const name = parameter.slice(0, separator).trim().toLowerCase();
    const value = parameter
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .toLowerCase();
    return name === "profile" && value === "mcp-app";
  });
}

function decodeBase64(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function readUiMetadata(value: unknown) {
  const metadata = asRecord(value);
  const ui = asRecord(metadata?.ui);
  if (!ui) return {};
  return {
    csp: asRecord(ui.csp) as UiCsp | null ?? undefined,
    permissions: asRecord(ui.permissions) as UiPermissions | null ?? undefined,
  };
}

export function getMcpAppResource(value: unknown, listingMetadata?: unknown): McpAppResource | null {
  const response = asRecord(value);
  const contents = response?.contents;
  if (!Array.isArray(contents)) return null;
  const listingUiMetadata = readUiMetadata(listingMetadata);

  for (const rawContent of contents) {
    const content = asRecord(rawContent) as ResourceContent | null;
    if (!content || !isMcpAppMimeType(content.mimeType)) continue;
    const html = typeof content.text === "string" ? content.text : decodeBase64(content.blob);
    if (html === null) continue;

    const metadata = readUiMetadata(content._meta ?? content.meta);
    return {
      html,
      csp: metadata.csp ?? listingUiMetadata.csp,
      permissions: metadata.permissions ?? listingUiMetadata.permissions,
    };
  }

  return null;
}

function validSources(value: unknown, protocols: string[]) {
  if (!Array.isArray(value)) return [];
  return value.filter((source): source is string => (
    typeof source === "string" &&
    protocols.some((protocol) => source.trim().toLowerCase().startsWith(protocol)) &&
    !/[\s;'"<>]/.test(source)
  )).map((source) => source.trim());
}

function buildCsp(csp?: UiCsp) {
  const resourceDomains = validSources(csp?.resourceDomains, ["http://", "https://"]);
  const connectDomains = validSources(csp?.connectDomains, ["http://", "https://", "ws://", "wss://"]);
  const frameDomains = validSources(csp?.frameDomains, ["http://", "https://"]);
  const baseUriDomains = validSources(csp?.baseUriDomains, ["http://", "https://"]);
  const resources = resourceDomains.join(" ");

  return [
    `default-src 'none'`,
    `script-src 'self' 'unsafe-inline' ${resources}`,
    `style-src 'self' 'unsafe-inline' ${resources}`,
    `img-src 'self' data: ${resources}`,
    `media-src 'self' data: ${resources}`,
    `font-src 'self' data: ${resources}`,
    `connect-src ${connectDomains.length > 0 ? connectDomains.join(" ") : "'none'"}`,
    `frame-src ${frameDomains.length > 0 ? frameDomains.join(" ") : "'none'"}`,
    `object-src 'none'`,
    `base-uri ${baseUriDomains.length > 0 ? baseUriDomains.join(" ") : "'self'"}`,
    `form-action 'none'`,
  ].join("; ");
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function addCspMeta(html: string, csp?: UiCsp) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(buildCsp(csp))}">`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head?.index !== undefined) {
    const end = head.index + head[0].length;
    return `${html.slice(0, end)}${meta}${html.slice(end)}`;
  }

  const htmlElement = /<html\b[^>]*>/i.exec(html);
  if (htmlElement?.index !== undefined) {
    const end = htmlElement.index + htmlElement[0].length;
    return `${html.slice(0, end)}<head>${meta}</head>${html.slice(end)}`;
  }

  const doctype = /^\s*<!doctype\b[^>]*>\s*/i.exec(html)?.[0] ?? "";
  return `${doctype}<html><head>${meta}</head><body>${html.slice(doctype.length)}</body></html>`;
}

function permissionAllow(permissions?: UiPermissions) {
  const features = [
    ["camera", permissions?.camera],
    ["microphone", permissions?.microphone],
    ["geolocation", permissions?.geolocation],
    ["clipboard-write", permissions?.clipboardWrite],
  ];
  return features
    .filter(([, requested]) => requested !== undefined)
    .map(([feature]) => feature)
    .join("; ");
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  const message = asRecord(value);
  return message?.jsonrpc === "2.0" && (
    typeof message.method === "string" || Object.prototype.hasOwnProperty.call(message, "id")
  );
}

function postResult(source: WindowProxy, id: JsonRpcId, result: unknown) {
  source.postMessage({ jsonrpc: "2.0", id, result }, "*");
}

function postError(source: WindowProxy, id: JsonRpcId, message: string, code = -32602) {
  source.postMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  }, "*");
}

function hostCapabilities(resource: McpAppResource) {
  const capabilities: Record<string, unknown> = {
    openLinks: {},
    serverTools: {},
    serverResources: {},
    logging: {},
  };
  if (resource.csp !== undefined || resource.permissions !== undefined) {
    capabilities.sandbox = {
      ...(resource.csp === undefined ? {} : { csp: resource.csp }),
      ...(resource.permissions === undefined ? {} : { permissions: resource.permissions }),
    };
  }
  return capabilities;
}

export function McpAppPreview({
  resource,
  serverName,
  onActivity,
}: {
  resource: McpAppResource;
  serverName: string;
  onActivity: () => Promise<void>;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameHeight, setFrameHeight] = useState<number | null>(null);
  const sourceDocument = useMemo(
    () => addCspMeta(resource.html, resource.csp),
    [resource.html, resource.csp],
  );
  const allow = permissionAllow(resource.permissions);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    async function handleMessage(event: MessageEvent) {
      if (event.source !== iframe?.contentWindow || !isJsonRpcMessage(event.data)) return;
      const source = event.source;
      if (!source) return;
      const method = event.data.method;
      if (typeof method !== "string") return;
      const params = asRecord(event.data.params) ?? {};
      const hasId = Object.prototype.hasOwnProperty.call(event.data, "id");
      const id = event.data.id ?? null;

      if (method === "ui/notifications/size-changed") {
        const height = params.height;
        if (typeof height === "number" && Number.isFinite(height)) {
          setFrameHeight(Math.min(1200, Math.max(360, Math.ceil(height))));
        }
        return;
      }

      if (!hasId) return;

      try {
        switch (method) {
          case "ui/initialize":
            postResult(source, id, {
              protocolVersion: "2026-01-26",
              hostCapabilities: hostCapabilities(resource),
              hostInfo: { name: "MCP Examiner", title: "MCP Examiner", version: "0.1.4" },
              hostContext: {
                theme: "light",
                platform: "desktop",
                displayMode: "inline",
                availableDisplayModes: ["inline"],
                containerDimensions: { maxHeight: 1200 },
              },
            });
            return;
          case "ping":
            postResult(source, id, {});
            return;
          case "tools/call": {
            if (typeof params.name !== "string") {
              postError(source, id, "tools/call requires a tool name");
              return;
            }
            const result = await invoke<unknown>("call_tool", {
              request: {
                serverName,
                toolName: params.name,
                arguments: params.arguments ?? {},
              },
            });
            postResult(source, id, result);
            await onActivity();
            return;
          }
          case "resources/read": {
            if (typeof params.uri !== "string") {
              postError(source, id, "resources/read requires a URI");
              return;
            }
            const result = await invoke<unknown>("read_resource", {
              request: { serverName, uri: params.uri },
            });
            postResult(source, id, result);
            await onActivity();
            return;
          }
          case "ui/open-link":
            if (typeof params.url !== "string") {
              postError(source, id, "ui/open-link requires a URL");
              return;
            }
            await openUrl(params.url);
            postResult(source, id, {});
            return;
          case "ui/request-display-mode":
            postResult(source, id, { mode: "inline" });
            return;
          case "ui/message":
          case "ui/update-model-context":
          case "ui/resource-teardown":
            postResult(source, id, {});
            return;
          default:
            postError(source, id, `Unsupported MCP App method: ${method}`, -32601);
        }
      } catch (error) {
        postError(source, id, String(error), -32000);
      }
    }

    const listener = (event: MessageEvent) => {
      void handleMessage(event);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onActivity, resource.csp, resource.permissions, serverName]);

  return (
    <div className="mcp-app-preview">
      <div className="mcp-app-preview-toolbar">
        <strong>Interactive HTML</strong>
        <details>
          <summary>HTML source</summary>
          <pre>{resource.html}</pre>
        </details>
      </div>
      <iframe
        ref={iframeRef}
        className="mcp-app-preview-frame"
        title="MCP App preview"
        sandbox="allow-forms allow-scripts"
        allow={allow || undefined}
        referrerPolicy="no-referrer"
        srcDoc={sourceDocument}
        style={frameHeight === null ? undefined : { height: `${frameHeight}px` }}
      />
    </div>
  );
}