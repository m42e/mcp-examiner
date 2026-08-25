import { Channel, invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { AlertTriangle, Check, ClipboardCheck, Download, FileUp, LoaderCircle, Play, Save, WandSparkles, X } from "lucide-react";
import type { AutomatedRunResponse, ConnectionSnapshot, RunProgress, SaveReportResponse, ServerProfile } from "../../contracts";
import type { TestDocument, TestRunState, TestRunStateUpdate } from "../../lib/run";
import { generateTestDocument, generationItems } from "../../lib/testgen";
import { GenerationDialog } from "../dialogs/GenerationDialog";

export function AutomationPanel({
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
        reportPath: `${response.result.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "mcp-examiner"}.html`,
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
      <GenerationDialog
        items={availableGenerationItems}
        selection={generationSelection}
        content={content}
        onSelectionChange={setGenerationSelection}
        onApply={applyGeneration}
        onClose={() => setShowGeneration(false)}
      />
    )}
    </>
  );
}
