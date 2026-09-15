import { useEffect, useState } from "react";
import { LoaderCircle, Maximize2, Minimize2, Play, WrapText, Wrench } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { ToolSummary } from "../../contracts";
import { schemaObjectInitial } from "../../lib/schema";
import { MarkdownText } from "../primitives/MarkdownText";
import { ModeToggle } from "../primitives/ModeToggle";
import { ResultViewer } from "../primitives/ResultViewer";
import { SchemaForm } from "../primitives/SchemaForm";

export function ToolsPanel({
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
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [schemaExpanded, setSchemaExpanded] = useState(false);
  const [schemaWrapped, setSchemaWrapped] = useState(false);
  const [result, setResult] = useState<unknown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    setSelectedName(tools[0]?.name ?? "");
    setArgumentsValue(schemaObjectInitial(tools[0]?.inputSchema));
    setArgumentsJson("{}");
    setRawArguments(false);
    setSchemaExpanded(false);
    setSchemaWrapped(false);
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
          <div className="tool-markdown-control">
            <span>Descriptions</span>
            <button
              className="markdown-toggle"
              type="button"
              aria-label={renderMarkdown ? "Disable formatted descriptions" : "Enable formatted descriptions"}
              aria-pressed={renderMarkdown}
              title={renderMarkdown ? "Show descriptions as plain text" : "Format descriptions as Markdown"}
              onClick={() => setRenderMarkdown((enabled) => !enabled)}
            >
              <span className="markdown-toggle-track" aria-hidden="true">
                <span />
              </span>
              {renderMarkdown ? "Formatted" : "Plain text"}
            </button>
          </div>
        </header>
        {selectedTool.description && (
          <MarkdownText
            value={selectedTool.description}
            renderMarkdown={renderMarkdown}
            className="tool-description"
            plainTag="p"
          />
        )}

        <div className={`tool-editor-grid${schemaExpanded ? " schema-expanded" : ""}`}>
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
                  renderMarkdown={renderMarkdown}
              />
            )}
          </section>
          <section className="tool-schema">
            <header className="tool-schema-header">
              <span>Input schema</span>
              <div className="tool-schema-actions">
                <button
                  className="icon-button"
                  type="button"
                  aria-label={schemaExpanded ? "Restore input schema" : "Expand input schema"}
                  aria-expanded={schemaExpanded}
                  title={schemaExpanded ? "Restore input schema" : "Expand input schema"}
                  onClick={() => setSchemaExpanded((expanded) => !expanded)}
                >
                  {schemaExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={schemaWrapped ? "Disable input schema wrapping" : "Enable input schema wrapping"}
                  aria-pressed={schemaWrapped}
                  title={schemaWrapped ? "Disable input schema wrapping" : "Enable input schema wrapping"}
                  onClick={() => setSchemaWrapped((wrapped) => !wrapped)}
                >
                  <WrapText size={14} />
                </button>
              </div>
            </header>
            <pre className={schemaWrapped ? "schema-pre-wrapped" : ""}>{JSON.stringify(selectedTool.inputSchema, null, 2)}</pre>
          </section>
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
