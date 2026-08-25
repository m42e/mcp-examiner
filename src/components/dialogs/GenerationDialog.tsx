import { AlertTriangle, WandSparkles, X } from "lucide-react";
import type { GenerationItem } from "../../lib/testgen";

export type GenerationDialogProps = {
  items: GenerationItem[];
  selection: string[];
  content: string;
  onSelectionChange: (selection: string[]) => void;
  onApply: () => void;
  onClose: () => void;
};

export function GenerationDialog({
  items,
  selection,
  content,
  onSelectionChange,
  onApply,
  onClose,
}: GenerationDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="generation-dialog" role="dialog" aria-modal="true" aria-labelledby="generate-title">
        <header className="dialog-header">
          <div>
            <span className="eyebrow">Server definitions</span>
            <h2 id="generate-title">Select tests to generate</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="generation-toolbar">
          <span>{selection.length} of {items.length} selected</span>
          <div>
            <button className="text-button" type="button" onClick={() => onSelectionChange(items.map((item) => item.id))}>Select all</button>
            <button className="text-button" type="button" onClick={() => onSelectionChange([])}>Select none</button>
          </div>
        </div>
        <div className="generation-list">
          {items.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={selection.includes(item.id)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  onSelectionChange(checked
                    ? [...selection, item.id]
                    : selection.filter((id) => id !== item.id));
                }}
              />
              <span><strong>{item.name}</strong><small>{item.description}</small></span>
              <b>{item.kind}</b>
            </label>
          ))}
        </div>
        <div className={`generation-warning ${content.trim() ? "visible" : ""}`}>
          {content.trim() && <><AlertTriangle size={14} /><span>The current test document contains content and will be replaced.</span></>}
        </div>
        <footer className="dialog-footer">
          <button className="text-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="button" onClick={onApply} disabled={selection.length === 0}><WandSparkles size={15} /> {content.trim() ? "Replace and generate" : "Generate selected"}</button>
        </footer>
      </section>
    </div>
  );
}
