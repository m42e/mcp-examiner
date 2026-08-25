import { Plus, Trash2 } from "lucide-react";
import { asSchema, emptySchemaValue, schemaType } from "../../lib/schema";

export function SchemaForm({
  schema: schemaInput,
  value,
  onChange,
}: {
  schema: unknown;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const schema = asSchema(schemaInput);
  const type = schemaType(schema);

  if (schema.enum?.length) {
    return (
      <select value={JSON.stringify(value ?? schema.enum[0])} onChange={(event) => onChange(JSON.parse(event.currentTarget.value))}>
        {schema.enum.map((option) => <option key={JSON.stringify(option)} value={JSON.stringify(option)}>{String(option)}</option>)}
      </select>
    );
  }
  if (type === "object") {
    const objectValue = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const required = new Set(schema.required ?? []);
    return (
      <div className="schema-fields">
        {Object.entries(schema.properties ?? {}).map(([name, property]) => (
          <label className="schema-field" key={name}>
            <span>{property.title ?? name}{required.has(name) && <b> *</b>}</span>
            {property.description && <small>{property.description}</small>}
            <SchemaForm
              schema={property}
              value={objectValue[name] ?? emptySchemaValue(property)}
              onChange={(next) => onChange({ ...objectValue, [name]: next })}
            />
          </label>
        ))}
        {Object.keys(schema.properties ?? {}).length === 0 && <span className="empty-form">No arguments</span>}
      </div>
    );
  }
  if (type === "array") {
    const values = Array.isArray(value) ? value : [];
    const itemSchema = schema.items ?? {};
    return (
      <div className="array-editor">
        {values.map((item, index) => (
          <div className="array-row" key={index}>
            <SchemaForm schema={itemSchema} value={item} onChange={(next) => onChange(values.map((current, currentIndex) => currentIndex === index ? next : current))} />
            <button className="icon-button" type="button" aria-label={`Remove item ${index + 1}`} onClick={() => onChange(values.filter((_, currentIndex) => currentIndex !== index))}><Trash2 size={14} /></button>
          </div>
        ))}
        <button className="text-button" type="button" onClick={() => onChange([...values, emptySchemaValue(itemSchema)])}><Plus size={14} /> Add item</button>
      </div>
    );
  }
  if (type === "boolean") {
    return <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.currentTarget.checked)} />;
  }
  if (type === "number" || type === "integer") {
    return <input type="number" min={schema.minimum} max={schema.maximum} step={type === "integer" ? 1 : "any"} value={typeof value === "number" ? value : 0} onChange={(event) => onChange(event.currentTarget.valueAsNumber)} />;
  }
  return <input type="text" value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.currentTarget.value)} />;
}
