import * as vscode from 'vscode';
import { SettingsAdapter } from './adapter/settings';
import { LanguageServerHub } from './adapter/lsHub';
import { ProxyServer } from './proxy/server';
import { ChatRouter } from './proxy/router';
import { OpenRouterClient } from './openrouter/client';
import { ModelRegistry } from './openrouter/models';
import { registerModelCommands } from './commands/models';
import { SettingsPanel } from './ui/settingsPanel';
import { Logger } from './util/log';

const ENABLED_KEY = 'antigravityOpenRouter.enabled';
const KEEPALIVE_MS = 15_000;
const HUB_RETRY_DELAYS = [0, 2_000, 5_000, 10_000, 20_000];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const log = new Logger('Antigravity OpenRouter', vscode.Uri.joinPath(context.globalStorageUri, 'openrouter.log').fsPath);
  context.subscriptions.push(log);

  const config = () => vscode.workspace.getConfiguration('antigravityOpenRouter');
  const settings = new SettingsAdapter(context, log);
  const hub = new LanguageServerHub(log);
  const registry = new ModelRegistry(context);
  const client = new OpenRouterClient(
    async () =>
      (await context.secrets.get('antigravityOpenRouter.apiKey')) ?? process.env.OPENROUTER_API_KEY ?? undefined,
  );
  const router = new ChatRouter(registry, client, log);
  const panel = new SettingsPanel(context, client, registry, log, () => render());
  const proxy = new ProxyServer({
    log,
    upstream: config().get<string>('upstream', 'https://daily-cloudcode-pa.googleapis.com'),
    captureDir: config().get<boolean>('recordCaptures', false) ? captureDir(context) : undefined,
    interceptor: (ctx) => router.intercept(ctx),
    transformers: [
      {
        matches: (url) => router.isCatalogRequest(url),
        transform: (body) => router.transformCatalog(body),
      },
    ],
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'antigravityOpenRouter.menu';
  context.subscriptions.push(status);

  let enabled = false;
  let keepalive: NodeJS.Timeout | undefined;
  let hubRetry: NodeJS.Timeout | undefined;

  const stopHubRetries = () => {
    if (hubRetry) clearTimeout(hubRetry);
    hubRetry = undefined;
  };

  /**
   * The language server may still be booting when the extension activates, so
   * the first SetCloudCodeURL can race it. Retry with backoff instead of
   * failing the whole enable flow.
   */
  const pushHub = async (url: string, attempt = 0): Promise<void> => {
    stopHubRetries();
    if (!enabled) return;
    if (await hub.setCloudCodeUrl(url)) return;
    if (attempt >= HUB_RETRY_DELAYS.length - 1) {
      log.warn('language server is still not reachable; native models keep working, generation routing is pending');
      return;
    }
    hubRetry = setTimeout(() => void pushHub(url, attempt + 1), HUB_RETRY_DELAYS[attempt]);
    hubRetry.unref();
  };

  const render = () => {
    const port = proxy.listening;
    const count = registry.entries().length;
    status.text = enabled ? `$(plug) OpenRouter ${count} :${port}` : '$(debug-disconnect) OpenRouter';
    status.tooltip = enabled
      ? `Antigravity OpenRouter is routing through ${proxy.url}\n${count} OpenRouter model(s) in the picker\nNative models forward to ${config().get('upstream')}`
      : 'Antigravity OpenRouter is off. Click to enable.';
    status.show();
  };

  const attach = async (): Promise<boolean> => {
    try {
      enabled = true;
      await settings.apply(proxy.url);
      await context.globalState.update(ENABLED_KEY, true);
      render();
      void pushHub(proxy.url);
      log.info('routing enabled');

      keepalive?.unref();
      keepalive = setInterval(() => {
        if (enabled) void pushHub(proxy.url);
      }, KEEPALIVE_MS);
      keepalive.unref();
      return true;
    } catch (error) {
      log.error('could not enable routing', error);
      void vscode.window.showErrorMessage(`Antigravity OpenRouter: ${(error as Error).message}`);
      return false;
    }
  };

  const detach = async (): Promise<void> => {
    enabled = false;
    stopHubRetries();
    if (keepalive) clearInterval(keepalive);
    keepalive = undefined;
    await context.globalState.update(ENABLED_KEY, false);
    try {
      await settings.restore();
      await hub.setCloudCodeUrl(config().get<string>('upstream', 'https://daily-cloudcode-pa.googleapis.com'));
    } catch (error) {
      log.error('could not restore native routing', error);
    }
    render();
    log.info('routing disabled; native endpoint restored');
  };

  const ensureProxy = async (): Promise<void> => {
    const port = config().get<number>('port', 57331);
    await proxy.start(port);
  };

  context.subscriptions.push(
    ...registerModelCommands({ context, client, registry, log, onChanged: render }),

    vscode.commands.registerCommand('antigravityOpenRouter.openSettings', () => panel.show()),

    vscode.commands.registerCommand('antigravityOpenRouter.enable', async () => {
      await ensureProxy();
      const ok = await attach();
      if (ok) {
        const action = await vscode.window.showInformationMessage(
          'OpenRouter routing enabled. Reload the window so the chat panel re-reads the model catalog.',
          'Reload Window',
        );
        if (action === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),

    vscode.commands.registerCommand('antigravityOpenRouter.disable', async () => {
      await detach();
      const action = await vscode.window.showInformationMessage(
        'OpenRouter routing disabled. Native Antigravity models are back.',
        'Reload Window',
      );
      if (action === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),

    vscode.commands.registerCommand('antigravityOpenRouter.restart', async () => {
      await ensureProxy();
      if (enabled) await attach();
      void vscode.window.showInformationMessage(`Proxy restarted on ${proxy.url}`);
    }),

    vscode.commands.registerCommand('antigravityOpenRouter.showLog', () => log.show()),
    vscode.commands.registerCommand('antigravityOpenRouter.reloadWindow', () =>
      vscode.commands.executeCommand('workbench.action.reloadWindow'),
    ),

    vscode.commands.registerCommand('antigravityOpenRouter.menu', async () => {
      const items: vscode.QuickPickItem[] = [
        { label: enabled ? '$(debug-disconnect) Disable' : '$(plug) Enable', description: enabled ? 'restore native routing' : 'route chat through the local proxy' },
        { label: '$(settings-gear) Open settings panel', description: 'API key and model list' },
        { label: '$(key) Set OpenRouter API key' },
        { label: '$(add) Add models…', description: `${registry.entries().length} configured` },
        { label: '$(trash) Remove models…' },
        { label: '$(refresh) Restart proxy' },
        { label: '$(output) Show log' },
        { label: '$(bank) Open settings' },
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: `Antigravity OpenRouter — ${enabled ? 'enabled' : 'disabled'}` });
      if (!picked) return;
      if (picked.label.includes('Open settings panel')) void vscode.commands.executeCommand('antigravityOpenRouter.openSettings');
      else if (picked.label.includes('Enable')) void vscode.commands.executeCommand('antigravityOpenRouter.enable');
      else if (picked.label.includes('Disable')) void vscode.commands.executeCommand('antigravityOpenRouter.disable');
      else if (picked.label.includes('API key')) void vscode.commands.executeCommand('antigravityOpenRouter.setApiKey');
      else if (picked.label.includes('Add models')) void vscode.commands.executeCommand('antigravityOpenRouter.addModel');
      else if (picked.label.includes('Remove models')) void vscode.commands.executeCommand('antigravityOpenRouter.removeModel');
      else if (picked.label.includes('Restart')) void vscode.commands.executeCommand('antigravityOpenRouter.restart');
      else if (picked.label.includes('log')) log.show();
      else void vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityOpenRouter');
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('antigravityOpenRouter.port')) return;
      void (async () => {
        await ensureProxy();
        if (enabled) await attach();
      })();
    }),
  );

  await ensureProxy();
  render();

  const wasEnabled = context.globalState.get<boolean>(ENABLED_KEY, false);
  if (wasEnabled && config().get<boolean>('autoEnable', true)) {
    await attach();
  } else if (settings.current && settings.current === proxy.url) {
    // We probably crashed last time; keep the loop alive so the IDE is not left
    // pointing at a dead port.
    await attach();
  }

  if (!(await client.hasKey())) {
    const action = await vscode.window.showWarningMessage(
      'Antigravity OpenRouter: no OpenRouter API key yet — injected models will only answer once one is set.',
      'Set API key',
    );
    if (action) void vscode.commands.executeCommand('antigravityOpenRouter.setApiKey');
  }
}

export async function deactivate(): Promise<void> {
  // Deliberately keep `jetski.cloudCodeUrl` in place: the window that replaces
  // this extension host re-attaches on activation. `Antigravity OpenRouter:
  // Disable` is the supported way to restore the native endpoint.
}

function captureDir(context: vscode.ExtensionContext): string {
  return vscode.Uri.joinPath(context.globalStorageUri, 'captures').fsPath;
}
