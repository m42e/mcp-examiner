export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
};

export function asSchema(schema: unknown): JsonSchema {
  return schema && typeof schema === "object" ? schema as JsonSchema : {};
}

export function schemaType(schema: JsonSchema) {
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  if (type) return type;
  if (schema.properties) return "object";
  if (schema.enum?.length) return typeof schema.enum[0];
  return "string";
}

export function emptySchemaValue(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  switch (schemaType(schema)) {
    case "object": return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([name, property]) => [name, emptySchemaValue(property)]),
    );
    case "array": return [];
    case "boolean": return false;
    case "number":
    case "integer": return 0;
    default: return "";
  }
}

export function schemaObjectInitial(schema: unknown): Record<string, unknown> {
  const initial = emptySchemaValue(asSchema(schema));
  return initial && typeof initial === "object" && !Array.isArray(initial)
    ? initial as Record<string, unknown>
    : {};
}

export function generatedArguments(schemaInput: unknown): Record<string, unknown> {
  const schema = asSchema(schemaInput);
  if (schemaType(schema) !== "object") return {};
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, property]) => [
      name,
      emptySchemaValue(property),
    ]),
  );
}
