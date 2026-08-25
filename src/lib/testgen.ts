import type { ConnectionSnapshot, PromptSummary } from "../contracts";
import { generatedArguments } from "./schema";

export function promptArgumentValue(prompt: PromptSummary | undefined) {
  return Object.fromEntries((prompt?.arguments ?? []).map((argument) => [argument.name, ""]));
}

export function promptSchema(prompt: PromptSummary | undefined) {
  return {
    type: "object",
    properties: Object.fromEntries((prompt?.arguments ?? []).map((argument) => [argument.name, {
      type: "string",
      description: argument.description,
    }])),
    required: (prompt?.arguments ?? []).filter((argument) => argument.required).map((argument) => argument.name),
  };
}

export type GenerationItem = {
  id: string;
  kind: "Tool" | "Resource" | "Prompt";
  name: string;
  description?: string;
};

export function generationItems(snapshot: ConnectionSnapshot): GenerationItem[] {
  return [
    ...snapshot.tools.map((tool) => ({
      id: `tool:${tool.name}`,
      kind: "Tool" as const,
      name: tool.title ?? tool.name,
      description: tool.description ?? tool.name,
    })),
    ...snapshot.resources.map((resource) => ({
      id: `resource:${resource.uri}`,
      kind: "Resource" as const,
      name: resource.title ?? resource.name,
      description: resource.uri,
    })),
    ...snapshot.prompts.map((prompt) => ({
      id: `prompt:${prompt.name}`,
      kind: "Prompt" as const,
      name: prompt.title ?? prompt.name,
      description: prompt.description ?? prompt.name,
    })),
  ];
}

export function generateTestDocument(
  serverName: string,
  snapshot: ConnectionSnapshot,
  selected: Set<string>,
) {
  const calls: unknown[] = [];
  for (const tool of snapshot.tools) {
    if (!selected.has(`tool:${tool.name}`)) continue;
    const argumentsValue = generatedArguments(tool.inputSchema);
    calls.push({
      type: "callTool",
      name: tool.name,
      ...(Object.keys(argumentsValue).length > 0 ? { arguments: argumentsValue } : {}),
    });
  }
  for (const resource of snapshot.resources) {
    if (!selected.has(`resource:${resource.uri}`)) continue;
    calls.push({ type: "readResource", uri: resource.uri });
  }
  for (const prompt of snapshot.prompts) {
    if (!selected.has(`prompt:${prompt.name}`)) continue;
    const argumentsValue = Object.fromEntries(
      (prompt.arguments ?? []).map((argument) => [argument.name, ""]),
    );
    calls.push({
      type: "getPrompt",
      name: prompt.name,
      ...(Object.keys(argumentsValue).length > 0 ? { arguments: argumentsValue } : {}),
    });
  }
  return JSON.stringify({
    $schema: "./mcp-test.schema.json",
    name: `${serverName} generated checks`,
    description: `Generated from the discovered MCP definitions for ${serverName}. Add expectations after reviewing the first run.${snapshot.resourceTemplates.length > 0 ? ` ${snapshot.resourceTemplates.length} resource template(s) were skipped because they require concrete URIs.` : ""}`,
    calls,
  }, null, 2);
}
