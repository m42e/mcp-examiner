import { Cable, CircleDot, FileInput } from "lucide-react";

export function EmptyWorkspace({ onImport }: { onImport: () => void }) {
  return (
    <section className="empty-workspace">
      <div className="empty-signal" aria-hidden="true">
        <span />
        <Cable size={30} />
        <span />
      </div>
      <span className="eyebrow">Workspace ready</span>
      <h1>No servers configured</h1>
      <div className="empty-actions">
        <button className="primary-button" type="button" onClick={onImport}>
          <FileInput size={17} /> Import config
        </button>
      </div>
      <div className="supported-row" aria-label="Supported config families">
        <span>VS Code</span>
        <CircleDot size={10} />
        <span>Claude</span>
        <CircleDot size={10} />
        <span>Inspector</span>
      </div>
    </section>
  );
}
