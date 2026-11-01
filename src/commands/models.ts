import * as vscode from 'vscode';
import { OpenRouterClient } from '../openrouter/client';
import { ModelEntry, ModelRegistry, aliasForModelId } from '../openrouter/models';
import { Logger } from '../util/log';

const KEY_SECRET = 'antigravityOpenRouter.apiKey';

export interface ModelCommandDeps {
  context: vscode.ExtensionContext;
  client: OpenRouterClient;
  registry: ModelRegistry;
  log: Logger;
  /** Called after the model list changes so the catalog can be re-served. */
  onChanged: () => void;
}

export function registerModelCommands(deps: ModelCommandDeps): vscode.Disposable[] {
  const { context, client, registry, log } = deps;

  return [
    vscode.commands.registerCommand('antigravityOpenRouter.setApiKey', async () => {
      try {
        log.info('setApiKey command invoked');
        const existing = await Promise.resolve(context.secrets.get(KEY_SECRET)).catch(() => undefined);
        const value = await vscode.window.showInputBox({
          title: 'OpenRouter API key',
          prompt: existing ? 'A key is already stored. Enter a new one to replace it.' : 'Paste your OpenRouter API key (sk-or-…)',
          password: true,
          ignoreFocusOut: true,
          validateInput: (input) => (input.trim().length < 10 ? 'That does not look like an API key' : undefined),
        });
        log.info(`setApiKey input box returned ${value ? 'a value' : 'nothing'}`);
        if (!value) return;

        await context.secrets.store(KEY_SECRET, value.trim());
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Checking OpenRouter key…' },
          () => client.validateKey(),
        );
        if (result.ok) void vscode.window.showInformationMessage(`OpenRouter key saved. ${result.message}.`);
        else void vscode.window.showErrorMessage(`Key saved, but validation failed: ${result.message}`);
      } catch (error) {
        log.error('setApiKey failed', error);
        void vscode.window.showErrorMessage(`Antigravity OpenRouter: ${(error as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('antigravityOpenRouter.testKey', async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Contacting OpenRouter…' },
        () => client.validateKey(),
      );
      if (result.ok) void vscode.window.showInformationMessage(`OpenRouter reachable: ${result.message}.`);
      else void vscode.window.showErrorMessage(`OpenRouter check failed: ${result.message}`);
    }),

    vscode.commands.registerCommand('antigravityOpenRouter.addModel', async () => {
      if (!(await client.hasKey())) {
        const action = await vscode.window.showWarningMessage('Set an OpenRouter API key first.', 'Set key');
        if (action) void vscode.commands.executeCommand('antigravityOpenRouter.setApiKey');
        return;
      }

      const catalog = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fetching OpenRouter models…' },
        () => client.listModels(),
      );

      const existing = new Set(registry.entries().map((entry) => entry.modelId));
      const picked = await vscode.window.showQuickPick(
        catalog
          .filter((model) => !existing.has(model.id))
          .map((model) => ({
            label: model.name || model.id,
            description: model.id,
            detail: [
              model.context_length ? `context ${Math.round(model.context_length / 1000)}k` : undefined,
              model.architecture?.input_modalities?.includes('image') ? 'vision' : undefined,
              model.supported_parameters?.includes('tools') ? 'tools' : undefined,
              model.pricing?.prompt ? `in $${model.pricing.prompt}/tok` : undefined,
            ]
              .filter(Boolean)
              .join(' · '),
            model,
          })),
        {
          title: 'Add OpenRouter models to the Antigravity picker',
          placeHolder: 'Search by name or id, select one or more',
          canPickMany: true,
          matchOnDescription: true,
        },
      );
      if (!picked || picked.length === 0) return;

      const entries = [...registry.entries()];
      for (const item of picked) {
        const model = item.model;
        entries.push(toEntry(model, entries));
      }

      await vscode.workspace
        .getConfiguration('antigravityOpenRouter')
        .update('models', entries, vscode.ConfigurationTarget.Global);
      log.info(`saved ${picked.length} model(s); picker now has ${entries.length}`);
      deps.onChanged();

      const action = await vscode.window.showInformationMessage(
        `Added ${picked.length} model(s). Reload the window to see them in the Antigravity model picker.`,
        'Reload Window',
      );
      if (action === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),

    vscode.commands.registerCommand('antigravityOpenRouter.removeModel', async () => {
      const entries = registry.entries();
      if (entries.length === 0) {
        void vscode.window.showInformationMessage('No OpenRouter models are configured.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map((entry) => ({ label: entry.displayName, description: entry.modelId, entry })),
        { title: 'Remove OpenRouter models', canPickMany: true },
      );
      if (!picked || picked.length === 0) return;

      const remove = new Set(picked.map((item) => item.entry.alias));
      const remaining = entries.filter((entry) => !remove.has(entry.alias));
      await vscode.workspace
        .getConfiguration('antigravityOpenRouter')
        .update('models', remaining, vscode.ConfigurationTarget.Global);
      deps.onChanged();
      void vscode.window.showInformationMessage(`Removed ${picked.length} model(s). Reload the window to refresh the picker.`);
    }),

    vscode.commands.registerCommand('antigravityOpenRouter.listModels', async () => {
      const entries = registry.entries();
      if (entries.length === 0) {
        void vscode.window.showInformationMessage('No OpenRouter models are configured.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map((entry) => ({
          label: entry.displayName,
          description: entry.modelId,
          detail: registry.identityFor(entry.alias),
        })),
        { title: 'Configured OpenRouter models' },
      );
      if (picked) log.show();
    }),
  ];
}

function toEntry(
  model: { id: string; name?: string; context_length?: number; architecture?: { input_modalities?: string[] }; supported_parameters?: string[] },
  existing: ModelEntry[],
): ModelEntry {
  const base = aliasForModelId(model.id) || 'model';
  let alias = base;
  let suffix = 2;
  while (existing.some((entry) => entry.alias === alias)) alias = `${base}-${suffix++}`;

  return {
    alias,
    displayName: model.name || model.id,
    modelId: model.id,
    contextLength: model.context_length,
    maxOutputTokens: Math.min(model.context_length ?? 32_000, 32_000),
    vision: Boolean(model.architecture?.input_modalities?.includes('image')),
    reasoning: Boolean(model.supported_parameters?.includes('reasoning')),
  };
}
