import { useEffect, useState } from "react";
import { Braces, FolderOpen, LoaderCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { ResourceSummary, ResourceTemplateSummary } from "../../contracts";
import { ResultViewer } from "../primitives/ResultViewer";

export function ResourcesPanel({
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
