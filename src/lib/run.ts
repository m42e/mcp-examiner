import type {
  AutomatedRunResponse,
  CallRunResult,
  RunStatus,
  RunSummary,
  SaveReportResponse,
} from "../contracts";

export type TestDocument = {
  content: string;
  path: string | null;
};

export type LiveRunCall = {
  index: number;
  operation: string;
  target: string;
  status: "pending" | "running" | RunStatus;
  result?: CallRunResult;
};

export type LiveRunState = {
  name: string;
  total: number;
  protocolVersion: string | null;
  summary: RunSummary;
  calls: LiveRunCall[];
  connectionError: string | null;
};

export type TestRunState = {
  run: AutomatedRunResponse | null;
  liveRun: LiveRunState | null;
  isRunning: boolean;
  reportPath: string;
  savedReports: SaveReportResponse | null;
};

export type TestRunStateUpdate =
  | TestRunState
  | ((current: TestRunState) => TestRunState);

export function emptyTestRunState(): TestRunState {
  return {
    run: null,
    liveRun: null,
    isRunning: false,
    reportPath: "mcp-examiner-report.html",
    savedReports: null,
  };
}
