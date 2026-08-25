export function ModeToggle({ raw, onChange }: { raw: boolean; onChange: (raw: boolean) => void }) {
  return (
    <span className="mode-toggle">
      <button className={!raw ? "active" : ""} type="button" onClick={() => onChange(false)}>Formatted</button>
      <button className={raw ? "active" : ""} type="button" onClick={() => onChange(true)}>JSON</button>
    </span>
  );
}
