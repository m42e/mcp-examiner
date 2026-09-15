import { ChevronDown, LoaderCircle, LogIn, Pencil, PlugZap, Unplug } from "lucide-react";
import type { AppInfo, ConnectionSnapshot, ServerProfile } from "../../contracts";
import { endpointLabel, protocolValue } from "../../lib/profile";

export type ServerHeaderProps = {
  profile: ServerProfile;
  connection: ConnectionSnapshot | null;
  canConnect: boolean;
  connecting: boolean;
  oauthConfigured: boolean;
  oauthLoggingIn: boolean;
  protocolVersions: AppInfo["protocolVersions"];
  onEdit: () => void;
  onProtocolChange: (value: string) => void;
  onOAuthLogin: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
};

export function ServerHeader({
  profile,
  connection,
  canConnect,
  connecting,
  oauthConfigured,
  oauthLoggingIn,
  protocolVersions,
  onEdit,
  onProtocolChange,
  onOAuthLogin,
  onConnect,
  onDisconnect,
}: ServerHeaderProps) {
  return (
    <section className="server-header">
      <div className="server-identity">
        <span className="eyebrow">
          {connection
            ? `Connected / ${connection.protocolVersion}`
            : connecting
              ? "Connecting"
              : "Disconnected"}
        </span>
        <h1>{profile.name}</h1>
        <p>{endpointLabel(profile.transport)}</p>
      </div>
      <div className="server-actions">
        <button
          className="icon-button"
          type="button"
          aria-label="Edit MCP server"
          title={connection ? "Disconnect before editing" : "Edit MCP server"}
          disabled={Boolean(connection)}
          onClick={onEdit}
        >
          <Pencil size={15} />
        </button>
        <label className="protocol-select">
          <span>Protocol</span>
          <select
            value={protocolValue(profile.protocol)}
            onChange={(event) => onProtocolChange(event.currentTarget.value)}
            disabled={Boolean(connection)}
          >
            <option value="auto">Auto negotiate</option>
            {protocolVersions.map((version) => (
              <option key={version} value={`exact:${version}`}>
                {version}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
        {oauthConfigured && !connection && (
          <button
            className="secondary-button"
            type="button"
            onClick={onOAuthLogin}
            disabled={!canConnect || connecting || oauthLoggingIn}
          >
            {oauthLoggingIn ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
            {oauthLoggingIn ? "Logging in" : "Log in"}
          </button>
        )}
        {connection ? (
          <button
            className="secondary-button"
            type="button"
            onClick={onDisconnect}
          >
            <Unplug size={16} /> Disconnect
          </button>
        ) : (
          <button
            className="primary-button"
            type="button"
            onClick={onConnect}
            disabled={!canConnect || connecting}
          >
            {connecting ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <PlugZap size={16} />
            )}
            {connecting ? "Connecting" : "Connect"}
          </button>
        )}
      </div>
    </section>
  );
}
