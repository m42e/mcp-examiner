import { useState } from "react";
import { ModeToggle } from "./ModeToggle";

export function ResultViewer({ value }: { value: unknown }) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (
      <div className="result-fields">
        {Object.entries(value as Record<string, unknown>).map(([name, fieldValue]) => (
          <ResultField key={name} name={name} value={fieldValue} />
        ))}
      </div>
    );
  }
  return <ResultField name="value" value={value} />;
}

function ResultField({ name, value }: { name: string; value: unknown }) {
  const [raw, setRaw] = useState(false);
  return (
    <section className="result-field">
      <header><strong>{name}</strong><ModeToggle raw={raw} onChange={setRaw} /></header>
      {raw ? <pre>{JSON.stringify(value, null, 2)}</pre> : <FormattedValue value={value} />}
    </section>
  );
}

function FormattedValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="formatted-empty">No value</span>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "object" && parsed !== null) return <FormattedValue value={parsed} />;
    } catch {
      return <div className="formatted-text">{value}</div>;
    }
    return <div className="formatted-text">{value}</div>;
  }
  if (typeof value === "boolean") return <span className={`value-badge ${value ? "true" : "false"}`}>{String(value)}</span>;
  if (typeof value === "number") return <span className="formatted-number">{value}</span>;
  if (Array.isArray(value)) {
    return <div className="formatted-list">{value.map((item, index) => <section key={index}><span>#{index + 1}</span><FormattedValue value={item} /></section>)}</div>;
  }
  return (
    <dl className="formatted-object">
      {Object.entries(value as Record<string, unknown>).map(([name, child]) => <div key={name}><dt>{name}</dt><dd><FormattedValue value={child} /></dd></div>)}
    </dl>
  );
}
