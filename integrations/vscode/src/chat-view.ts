import * as vscode from 'vscode';
import type { AgentMonitor } from './agent-monitor.ts';
import type { AgentFollow } from './agent-follow.ts';
import { parseChatFromWebview } from './chat-protocol.ts';
import type { ChatToWebview, FollowToggleView } from './chat-protocol.ts';
import { ChatController } from './chat-controller.ts';
import { composerHtml, createNonce } from './composer-html.ts';
import { t } from './i18n/index.ts';
import type { ComposerSeed, ExtensionServices } from './services.ts';

export function registerChatView(
  services: ExtensionServices,
  monitor: AgentMonitor,
  follow: AgentFollow,
): vscode.Disposable {
  const controller = new ChatController(services, monitor, (target) => follow.setChatTarget(target));
  let panel: vscode.WebviewPanel | undefined;

  const sendFollowing = (webview: vscode.Webview): void => {
    const summary = follow.summary;
    const phase = summary?.phase;
    const pendingCount = summary?.pendingCount ?? 0;
    const error = summary?.error ?? false;
    const followView: FollowToggleView | undefined = phase === undefined ? undefined : {
      phase,
      pendingCount,
      error,
      pressed: true,
      label: t(phase === 'starting' ? 'follow.statusStarting'
        : phase === 'following' ? 'follow.statusFollowing' : 'follow.statusPaused'),
      toggleLabel: t('follow.toggle'),
      tooltip: summary?.errorReason ? t(`follow.${summary.errorReason}`)
        : error ? t('follow.updateFailed')
          : summary?.limited ? t('follow.snapshotLimited') : t('follow.title'),
      viewLabel: phase === 'paused' && pendingCount > 0
        ? t(pendingCount === 1 ? 'follow.pendingOne' : 'follow.pendingMany', { count: pendingCount })
        : undefined,
    };
    const message: ChatToWebview = { type: 'followState', follow: followView };
    void webview.postMessage(message);
  };

  const receive = (webview: vscode.Webview, raw: unknown): void => {
    const parsed = parseChatFromWebview(raw);
    if (parsed?.type === 'followAction') {
      if (parsed.action === 'view') void follow.viewPending();
      else void follow.toggle(controller.currentTarget);
      return;
    }
    if (parsed?.type === 'ready') sendFollowing(webview);
    void controller.handle(raw);
  };

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
      const updateFollowing = (): void => {
        sendFollowing(view.webview);
      };
      updateFollowing();
      const followListener = follow.onDidChange(updateFollowing);
      const surface = controller.addSurface(view.webview, view.visible);
      const messageListener = view.webview.onDidReceiveMessage((raw: unknown) => {
        receive(view.webview, raw);
      });
      const visibilityListener = view.onDidChangeVisibility(() => {
        controller.setVisible(surface, view.visible);
      });
      view.onDidDispose(() => {
        followListener.dispose();
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
    const followListener = follow.onDidChange(() => {
      sendFollowing(created.webview);
    });
    const messageListener = created.webview.onDidReceiveMessage((raw: unknown) => {
      receive(created.webview, raw);
    });
    const viewStateListener = created.onDidChangeViewState(() => {
      controller.setVisible(surface, created.visible);
    });
    created.onDidDispose(() => {
      followListener.dispose();
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
