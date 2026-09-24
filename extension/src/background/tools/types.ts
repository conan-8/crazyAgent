// Tool registry — the agent loop (Phase 4) calls these; the panel's dev
// channel (`run_tool`) calls the same implementations.
import type { StepEvent } from "../../shared/protocol";
import type { JsonSchemaObject, LlmToolSpec } from "../../shared/llm";
import type { BrowserAdapter } from "../adapters/types";

export interface ToolContext {
  tabId: number;
  adapter: BrowserAdapter;
  emit(event: StepEvent): void;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the LLM tool-call interface (Phase 4). */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Phase 6 gates these behind one-click confirmation. */
  sensitive?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
  /** Compact text/image presentation of a result for the LLM (optional). */
  present?(payload: unknown): { text?: string; image?: string };
}

export const toolRegistry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  toolRegistry.set(tool.name, tool);
}

/** LLM-facing tool spec. */
export function toLlmTool(tool: Tool): LlmToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

/** Basic JSON-Schema argument validation (required + primitive types). */
export function validateToolArgs(
  spec: { parameters: JsonSchemaObject } | undefined,
  args: Record<string, unknown>,
): { error?: string } {
  if (!spec) return { error: "unknown tool" };
  if (typeof args.__invalidJson === "string") {
    return { error: `ERROR: tool arguments were not valid JSON: ${args.__invalidJson.slice(0, 200)}` };
  }
  for (const key of spec.parameters.required ?? []) {
    if (args[key] === undefined) {
      return { error: `ERROR: missing required parameter: ${key}` };
    }
  }
  for (const [key, raw] of Object.entries(spec.parameters.properties ?? {})) {
    const value = args[key];
    if (value === undefined) continue;
    const expected = (raw as { type?: string }).type;
    const actual = typeof value;
    if (expected === "number" && actual !== "number") {
      return { error: `ERROR: parameter ${key} must be a number` };
    }
    if (expected === "string" && actual !== "string") {
      return { error: `ERROR: parameter ${key} must be a string` };
    }
    if (expected === "boolean" && actual !== "boolean") {
      return { error: `ERROR: parameter ${key} must be a boolean` };
    }
  }
  return {};
}
