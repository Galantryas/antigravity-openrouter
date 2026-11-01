import * as vscode from 'vscode';
import { OpenRouterClient } from '../openrouter/client';
import { ModelEntry, ModelRegistry, aliasForModelId } from '../openrouter/models';
import { OpenRouterModelInfo } from '../openrouter/types';
import { Logger } from '../util/log';

const KEY_SECRET = 'antigravityOpenRouter.apiKey';

export class SettingsPanel {
  private panel: vscode.WebviewPanel | undefined;
  private catalog: OpenRouterModelInfo[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: OpenRouterClient,
    private readonly registry: ModelRegistry,
    private readonly log: Logger,
    private readonly onChange: () => void,
  ) {}

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      await this.pushState();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'antigravityOpenRouter.settings',
      'Antigravity OpenRouter',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = html();
    this.panel.onDidDispose(() => (this.panel = undefined));
    this.panel.webview.onDidReceiveMessage((message) => void this.handle(message));

    await this.pushState();
    void this.loadCatalog();
  }

  private async handle(message: { command: string; key?: string; ids?: string[]; alias?: string }): Promise<void> {
    switch (message.command) {
      case 'saveKey': {
        const key = (message.key ?? '').trim();
        if (key.length < 10) {
          this.post({ command: 'keyResult', ok: false, message: 'That does not look like an OpenRouter key.' });
          return;
        }
        await this.context.secrets.store(KEY_SECRET, key);
        const result = await this.client.validateKey();
        this.post({ command: 'keyResult', ok: result.ok, message: result.message });
        await this.pushState();
        this.onChange();
        return;
      }
      case 'testKey': {
        const result = await this.client.validateKey();
        this.post({ command: 'keyResult', ok: result.ok, message: result.message });
        return;
      }
      case 'loadCatalog': {
        await this.loadCatalog();
        return;
      }
      case 'addModels': {
        const ids = message.ids ?? [];
        if (ids.length === 0) return;
        const entries = [...this.registry.entries()];
        for (const id of ids) {
          const info = this.catalog.find((model) => model.id === id);
          entries.push(toEntry(info ?? { id }, entries));
        }
        await this.saveEntries(entries);
        return;
      }
      case 'removeModel': {
        const entries = this.registry.entries().filter((entry) => entry.alias !== message.alias);
        await this.saveEntries(entries);
        return;
      }
    }
  }

  private async saveEntries(entries: ModelEntry[]): Promise<void> {
    await vscode.workspace
      .getConfiguration('antigravityOpenRouter')
      .update('models', entries, vscode.ConfigurationTarget.Global);
    this.log.info(`model list saved (${entries.length} models)`);
    this.onChange();
    await this.pushState();
  }

  private async loadCatalog(): Promise<void> {
    if (!(await this.client.hasKey())) {
      this.post({ command: 'catalogResult', ok: false, message: 'Set an API key first.', models: [] });
      return;
    }
    try {
      this.catalog = await this.client.listModels();
      this.post({
        command: 'catalogResult',
        ok: true,
        message: `${this.catalog.length} models`,
        models: this.catalog.map((model) => ({
          id: model.id,
          name: model.name || model.id,
          context: model.context_length,
          vision: Boolean(model.architecture?.input_modalities?.includes('image')),
          tools: Boolean(model.supported_parameters?.includes('tools')),
        })),
      });
    } catch (error) {
      this.post({ command: 'catalogResult', ok: false, message: (error as Error).message, models: [] });
    }
  }

  private async pushState(): Promise<void> {
    const key = await this.context.secrets.get(KEY_SECRET);
    this.post({
      command: 'state',
      hasKey: Boolean(key),
      keyHint: key ? `${key.slice(0, 8)}…${key.slice(-4)}` : '',
      entries: this.registry.entries().map((entry) => ({
        alias: entry.alias,
        displayName: entry.displayName,
        modelId: entry.modelId,
        identity: this.registry.identityFor(entry.alias),
      })),
    });
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }
}

function toEntry(model: Partial<OpenRouterModelInfo>, existing: ModelEntry[]): ModelEntry {
  const id = model.id ?? 'model';
  const base = aliasForModelId(id) || 'model';
  let alias = base;
  let suffix = 2;
  while (existing.some((entry) => entry.alias === alias)) alias = `${base}-${suffix++}`;

  return {
    alias,
    displayName: model.name || id,
    modelId: id,
    contextLength: model.context_length,
    maxOutputTokens: Math.min(model.context_length ?? 32_000, 32_000),
    vision: Boolean(model.architecture?.input_modalities?.includes('image')),
    reasoning: Boolean(model.supported_parameters?.includes('reasoning')),
  };
}

function html(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; max-width: 900px; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
  h2 { font-size: 13px; font-weight: 600; margin: 24px 0 8px; text-transform: uppercase; letter-spacing: .04em; opacity: .8; }
  p.hint { margin: 0 0 12px; opacity: .75; font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; }
  input[type=password], input[type=search] {
    flex: 1; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font-family: inherit;
  }
  button { padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 2px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0 4px; }
  .status { font-size: 12px; margin-top: 6px; min-height: 16px; }
  .ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .bad { color: var(--vscode-errorForeground); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--vscode-panel-border, #3333); vertical-align: middle; }
  th { opacity: .7; font-weight: 500; }
  .tag { font-size: 10px; padding: 1px 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: 4px; }
  .scroll { max-height: 320px; overflow: auto; border: 1px solid var(--vscode-panel-border, #3333); border-radius: 3px; }
  .muted { opacity: .6; }
  label { display: flex; gap: 6px; align-items: center; }
</style>
</head>
<body>
  <h1>Antigravity OpenRouter</h1>
  <p class="hint">Models you add here appear in the native Antigravity model picker. Reload the window after changing the list.</p>

  <h2>API key</h2>
  <div class="row">
    <input id="key" type="password" placeholder="sk-or-…" autocomplete="off" spellcheck="false" />
    <button id="save">Save key</button>
    <button id="test" class="secondary">Test</button>
  </div>
  <div id="keystatus" class="status"></div>

  <h2>Models in the picker</h2>
  <div id="entries" class="scroll"><div class="muted" style="padding:8px">loading…</div></div>

  <h2>Add from OpenRouter</h2>
  <div class="row">
    <input id="search" type="search" placeholder="Search models (name or id)…" />
    <button id="reload" class="secondary">Refresh</button>
    <button id="add">Add selected</button>
  </div>
  <div id="catalogstatus" class="status"></div>
  <div id="catalog" class="scroll"><div class="muted" style="padding:8px">loading…</div></div>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let catalog = [];
  let selected = new Set();

  $('save').addEventListener('click', () => vscode.postMessage({ command: 'saveKey', key: $('key').value }));
  $('test').addEventListener('click', () => vscode.postMessage({ command: 'testKey' }));
  $('reload').addEventListener('click', () => vscode.postMessage({ command: 'loadCatalog' }));
  $('add').addEventListener('click', () => {
    if (selected.size === 0) return;
    vscode.postMessage({ command: 'addModels', ids: [...selected] });
    selected = new Set();
  });
  $('search').addEventListener('input', renderCatalog);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.command === 'state') {
      $('keystatus').innerHTML = message.hasKey
        ? '<span class="ok">Key stored</span> <span class="muted">' + message.keyHint + '</span>'
        : '<span class="bad">No key stored</span>';
      renderEntries(message.entries);
    } else if (message.command === 'keyResult') {
      $('keystatus').innerHTML = '<span class="' + (message.ok ? 'ok' : 'bad') + '">' + escapeHtml(message.message) + '</span>';
    } else if (message.command === 'catalogResult') {
      catalog = message.models || [];
      $('catalogstatus').innerHTML = '<span class="' + (message.ok ? 'ok' : 'bad') + '">' + escapeHtml(message.message) + '</span>';
      renderCatalog();
    }
  });

  function renderEntries(entries) {
    if (!entries || entries.length === 0) {
      $('entries').innerHTML = '<div class="muted" style="padding:8px">No models yet — add one below.</div>';
      return;
    }
    const rows = entries.map((entry) =>
      '<tr><td>' + escapeHtml(entry.displayName) + '</td>' +
      '<td class="muted">' + escapeHtml(entry.modelId) + '</td>' +
      '<td class="muted">' + escapeHtml(entry.identity) + '</td>' +
      '<td><button class="link" data-alias="' + escapeHtml(entry.alias) + '">remove</button></td></tr>').join('');
    $('entries').innerHTML = '<table><thead><tr><th>Name</th><th>OpenRouter id</th><th>Native id</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
    for (const button of $('entries').querySelectorAll('button[data-alias]')) {
      button.addEventListener('click', () => vscode.postMessage({ command: 'removeModel', alias: button.dataset.alias }));
    }
  }

  function renderCatalog() {
    const query = $('search').value.toLowerCase();
    const models = catalog.filter((model) => !query || model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query)).slice(0, 300);
    if (models.length === 0) {
      $('catalog').innerHTML = '<div class="muted" style="padding:8px">nothing to show</div>';
      return;
    }
    $('catalog').innerHTML = models.map((model) =>
      '<div style="padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border,#3333)">' +
        '<label><input type="checkbox" data-id="' + escapeHtml(model.id) + '"' + (selected.has(model.id) ? ' checked' : '') + ' />' +
        '<span>' + escapeHtml(model.name) + '</span>' +
        '<span class="muted">' + escapeHtml(model.id) + '</span>' +
        (model.tools ? '<span class="tag">tools</span>' : '') +
        (model.vision ? '<span class="tag">vision</span>' : '') +
        (model.context ? '<span class="tag">' + Math.round(model.context / 1000) + 'k</span>' : '') +
        '</label></div>').join('');
    for (const box of $('catalog').querySelectorAll('input[type=checkbox]')) {
      box.addEventListener('change', () => {
        if (box.checked) selected.add(box.dataset.id);
        else selected.delete(box.dataset.id);
      });
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  vscode.postMessage({ command: 'loadCatalog' });
</script>
</body>
</html>`;
}
