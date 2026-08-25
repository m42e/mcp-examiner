import { useEffect, useState } from "react";
import { FileCode2, LoaderCircle, Play } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { PromptSummary } from "../../contracts";
import { promptArgumentValue, promptSchema } from "../../lib/testgen";
import { ModeToggle } from "../primitives/ModeToggle";
import { ResultViewer } from "../primitives/ResultViewer";
import { SchemaForm } from "../primitives/SchemaForm";

export function PromptsPanel({
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
