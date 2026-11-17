import * as vscode from 'vscode';
import type { AgentMonitor } from './agent-monitor.ts';
import { ChatController } from './chat-controller.ts';
import { composerHtml, createNonce } from './composer-html.ts';
import { t } from './i18n/index.ts';
import type { ComposerSeed, ExtensionServices } from './services.ts';

export function registerChatView(
  services: ExtensionServices,
  monitor: AgentMonitor,
): vscode.Disposable {
  const controller = new ChatController(services, monitor);
  let panel: vscode.WebviewPanel | undefined;

  const resources = (): vscode.Uri[] => [
    vscode.Uri.joinPath(services.context.extensionUri, 'media'),
    vscode.Uri.joinPath(services.context.extensionUri, 'dist'),
  ];

  const htmlFor = (webview: vscode.Webview): string =>
    composerHtml({
      cspSource: webview.cspSource,
      nonce: createNonce(),
      scriptUri: webview
        .asWebviewUri(vscode.Uri.joinPath(services.context.extensionUri, 'dist', 'chat.js'))
        .toString(),
      styleUri: webview
        .asWebviewUri(vscode.Uri.joinPath(services.context.extensionUri, 'media', 'chat.css'))
        .toString(),
    });

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView: (view) => {
      view.webview.options = { enableScripts: true, localResourceRoots: resources() };
      view.webview.html = htmlFor(view.webview);
      const surface = controller.addSurface(view.webview, view.visible);
      const messageListener = view.webview.onDidReceiveMessage((raw: unknown) => {
        void controller.handle(raw);
      });
      const visibilityListener = view.onDidChangeVisibility(() => {
        controller.setVisible(surface, view.visible);
      });
      view.onDidDispose(() => {
        messageListener.dispose();
        visibilityListener.dispose();
        controller.removeSurface(surface);
      });
    },
  };

  const viewRegistration = vscode.window.registerWebviewViewProvider(
    'maestriBridge.chat',
    provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  const attachPanel = (created: vscode.WebviewPanel): void => {
    panel = created;
    created.webview.options = { enableScripts: true, localResourceRoots: resources() };
    created.iconPath = vscode.Uri.joinPath(
      services.context.extensionUri,
      'media',
      'maestri-logo.svg',
    );
    created.webview.html = htmlFor(created.webview);

    const surface = controller.addSurface(created.webview, created.visible);
    const messageListener = created.webview.onDidReceiveMessage((raw: unknown) => {
      void controller.handle(raw);
    });
    const viewStateListener = created.onDidChangeViewState(() => {
      controller.setVisible(surface, created.visible);
    });
    created.onDidDispose(() => {
      messageListener.dispose();
      viewStateListener.dispose();
      controller.removeSurface(surface);
      if (panel === created) {
        panel = undefined;
      }
    });
  };

  const openInEditor = vscode.commands.registerCommand(
    'maestriBridge.chat.openInEditor',
    () => {
      if (panel !== undefined) {
        panel.reveal(undefined, false);
        return;
      }

      attachPanel(
        vscode.window.createWebviewPanel(
          'maestriBridge.chatPanel',
          t('chat.panel.title'),
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: resources(),
          },
        ),
      );
    },
  );

  const serializer = vscode.window.registerWebviewPanelSerializer('maestriBridge.chatPanel', {
    deserializeWebviewPanel: async (restored) => {
      if (panel !== undefined) {
        restored.dispose();
        return;
      }
      restored.title = t('chat.panel.title');
      attachPanel(restored);
    },
  });

  const openComposer = vscode.commands.registerCommand(
    'maestriBridge.openComposer',
    (seed?: ComposerSeed) => {
      void controller.open(seed);
    },
  );

  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('maestriBridge.language') && panel !== undefined) {
      panel.title = t('chat.panel.title');
    }
  });

  return new vscode.Disposable(() => {
    openInEditor.dispose();
    serializer.dispose();
    openComposer.dispose();
    configListener.dispose();
    viewRegistration.dispose();
    panel?.dispose();
    panel = undefined;
    controller.dispose();
  });
}
