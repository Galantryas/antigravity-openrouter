import * as vscode from 'vscode';

export interface ModelEntry {
  /** Stable key used to build the picker id and to remember the native identity. */
  alias: string;
  displayName: string;
  /** OpenRouter model id, e.g. `anthropic/claude-sonnet-4.5`. */
  modelId: string;
  contextLength?: number;
  maxOutputTokens?: number;
  vision?: boolean;
  reasoning?: boolean;
  providerOrder?: string[];
  allowFallbacks?: boolean;
}

export const PICKER_PREFIX = 'or/';

export function pickerId(alias: string): string {
  return `${PICKER_PREFIX}${alias}`;
}

export function aliasForModelId(modelId: string): string {
  return modelId
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * Keeps the user's model list and the `MODEL_PLACEHOLDER_M###` identities we
 * hand out to them. Identities must stay stable across restarts, otherwise a
 * saved picker selection would silently point at a different model.
 */
export class ModelRegistry {
  private readonly identityKey = 'antigravityOpenRouter.identities';

  constructor(private readonly context: vscode.ExtensionContext) {}

  entries(): ModelEntry[] {
    const configured = vscode.workspace.getConfiguration('antigravityOpenRouter').get<ModelEntry[]>('models', []);
    return configured.filter((entry) => entry?.alias && entry?.modelId);
  }

  byAlias(alias: string): ModelEntry | undefined {
    return this.entries().find((entry) => entry.alias === alias);
  }

  byPickerId(id: string): ModelEntry | undefined {
    if (!id.startsWith(PICKER_PREFIX)) return undefined;
    return this.byAlias(id.slice(PICKER_PREFIX.length));
  }

  identityFor(alias: string): string {
    const map = this.identities;
    const existing = map[alias];
    if (existing) return existing;

    const used = new Set(Object.values(map));
    const start = vscode.workspace.getConfiguration('antigravityOpenRouter').get<number>('identityPoolStart', 1600);
    let next = start;
    while (used.has(`MODEL_PLACEHOLDER_M${next}`) && next > 500) next--;
    const allocated = `MODEL_PLACEHOLDER_M${next}`;
    void this.context.globalState.update(this.identityKey, { ...map, [alias]: allocated });
    return allocated;
  }

  get identities(): Record<string, string> {
    return this.context.globalState.get<Record<string, string>>(this.identityKey, {});
  }
}
