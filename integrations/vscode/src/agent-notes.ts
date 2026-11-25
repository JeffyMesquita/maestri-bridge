import * as vscode from 'vscode';
import { SHOW_LINK_PATH, locateTerminal, parseShowLink } from '@maestri-bridge/core';
import type { ShowLinkErrorCode } from '@maestri-bridge/core';
import type { AgentMonitor } from './agent-monitor.ts';
import { noteAnchor, rangeForNote, resolveSavedNoteStops } from './agent-note-files.ts';
import { deliver } from './delivery.ts';
import { referencesForRange } from './editor-references.ts';
import { showFlowError } from './flow-errors.ts';
import { t } from './i18n/index.ts';
import type { MessageKey } from './i18n/index.ts';
import { NoteTours } from './notes-tour.ts';
import type { StopLocation, TourStop } from './notes-tour.ts';
import { readSavedNoteTour } from './note-tour-state.ts';
import type { SavedNoteStop, SavedNoteTour } from './note-tour-state.ts';
import type { ExtensionServices } from './services.ts';
import type { AgentTarget } from './target-memory.ts';
import { resolveWorkspaceFile } from './workspace-files.ts';

const ERROR_KEYS: Record<ShowLinkErrorCode, MessageKey> = {
  missingFile: 'notes.error.missingFile',
  fileTooLong: 'notes.error.fileTooLong',
  invalidLines: 'notes.error.invalidLines',
  textTooLong: 'notes.error.textTooLong',
  invalidAgent: 'notes.error.invalidAgent',
  nameTooLong: 'notes.error.nameTooLong',
};

const SAVED_TOUR_KEY = 'maestriBridge.lastNoteTour';

interface NoteThreadInfo {
  agentId?: string;
  name: string;
  anchor: string;
  viewed: boolean;
}

export function registerAgentNotes(
  services: ExtensionServices,
  monitor: AgentMonitor,
): vscode.Disposable {
  const controller = vscode.comments.createCommentController('maestriBridgeNotes', 'Maestri');
  controller.options = {
    prompt: t('notes.reply.prompt'),
    placeHolder: t('notes.reply.placeholder'),
  };

  const tours = new NoteTours<vscode.CommentThread>();
  const threadAgent = new Map<vscode.CommentThread, NoteThreadInfo>();
  const checkpoints = new Map<string, vscode.CommentThread>();
  const storage = services.context.workspaceState;
  let pendingTour = readSavedNoteTour(storage.get<unknown>(SAVED_TOUR_KEY));
  interface UnresolvedSlot { key: string; note: SavedNoteStop; index: number; agentKey: string }
  let unresolvedStops: UnresolvedSlot[] = [];
  let unresolvedTourKey: string | undefined;
  let slotKeys: string[] = [];
  let checkpointKey: string | undefined;
  let generation = 0;
  let serial: Promise<unknown> = Promise.resolve();
  let activeAgent: string | undefined;
  let disposed = false;

  const noteKey = (note: SavedNoteStop): string =>
    [note.file, note.anchor, note.startLine ?? '', note.endLine ?? ''].join('|');
  // Serializa restore/retry/ingress para nao duplicar threads nem ressuscitar apos Clear.
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = serial.then(work, work);
    serial = run.catch(() => undefined);
    return run;
  };

  const activeTour = (): string | undefined =>
    activeAgent !== undefined && tours.stops(activeAgent).length > 0
      ? activeAgent
      : tours.latestAgent();

  const saveTour = async (): Promise<void> => {
    const saveGeneration = generation;
    if (disposed) {
      return;
    }
    const agentKey = activeTour();
    if (agentKey === undefined) {
      if (pendingTour !== undefined) {
        if (generation === saveGeneration) {
          await storage.update(SAVED_TOUR_KEY, placeUnresolved(pendingTour, pendingTour.agentKey));
        }
      } else if (generation === saveGeneration) {
        const remaining = unresolvedStops.length === 0
          ? undefined
          : ({
              version: 1,
              agentKey: unresolvedTourKey ?? unresolvedStops[0]!.agentKey,
              currentIndex: 0,
              stops: unresolvedStops.map((item) => item.note),
            } satisfies SavedNoteTour);
        await storage.update(SAVED_TOUR_KEY, remaining);
      }
      return;
    }

    const stops = tours.stops(agentKey);
    const savedStops: SavedNoteStop[] = [];
    for (const { thread, ...location } of stops) {
      const info = threadAgent.get(thread);
      if (info === undefined) {
        continue;
      }
      const saved: SavedNoteStop = {
        ...location,
        ...info,
        comments: thread.comments.map((comment) => ({
          text: typeof comment.body === 'string' ? comment.body : comment.body.value,
          author: comment.author.name,
          isReply: comment.contextValue === 'maestri.note.you',
        })),
      };
      savedStops.push(saved);
      const currentCheckpoint = checkpoints.get(agentKey);
      if (currentCheckpoint === thread && currentCheckpoint !== undefined) {
        checkpointKey = noteKey(saved);
      }
    }

    const snapshot: SavedNoteTour = {
      version: 1,
      agentKey,
      currentIndex: 0,
      stops: savedStops,
    };
    const ordered = placeUnresolved(snapshot, agentKey);
    if (ordered.stops.length === 0) {
      pendingTour = undefined;
      slotKeys = [];
      checkpointKey = undefined;
      if (generation === saveGeneration) {
        await storage.update(SAVED_TOUR_KEY, undefined);
      }
      return;
    }
    if (ordered.stops.length > 0) {
      ordered.currentIndex = Math.max(0, ordered.stops.findIndex(
        (note) => noteKey(note) === checkpointKey,
      ));
      slotKeys = ordered.stops.map(noteKey);
      pendingTour = undefined;
      await storage.update(SAVED_TOUR_KEY, ordered);
    }
  };

  const placeUnresolved = (snapshot: SavedNoteTour, agentKey: string): SavedNoteTour => {
    const keys = slotKeys.length > 0 ? slotKeys : snapshot.stops.map(noteKey);
    const byKey = new Map(snapshot.stops.map((note) => [noteKey(note), note] as const));
    const ordered: SavedNoteStop[] = [];
    for (const key of keys) {
      const held = unresolvedStops.find((item) => item.key === key && item.agentKey === agentKey);
      const note = held?.note ?? byKey.get(key);
      if (note !== undefined) {
        ordered.push(note);
      }
    }
    for (const note of snapshot.stops) {
      if (!keys.includes(noteKey(note))) {
        ordered.push(note);
      }
    }
    return { ...snapshot, stops: ordered };
  };

  const recordView = (thread: vscode.CommentThread): void => {
    const position = tours.position(thread);
    const info = threadAgent.get(thread);
    if (position !== undefined && info !== undefined) {
      info.viewed = true;
      activeAgent = position.agentKey;
      // Com slots ausentes, o checkpoint salvo nao deve saltar para a nota nova.
      if (unresolvedStops.some((item) => item.agentKey === position.agentKey) &&
          checkpointKey !== undefined) {
        return;
      }
      checkpoints.set(position.agentKey, thread);
    }
  };

  const createThread = (
    uri: vscode.Uri,
    range: vscode.Range,
    comments: vscode.Comment[],
    info: NoteThreadInfo,
  ): vscode.CommentThread => {
    const thread = controller.createCommentThread(uri, range, comments);
    thread.canReply = info.agentId !== undefined;
    thread.contextValue = info.agentId !== undefined ? 'maestri.note.reply' : 'maestri.note';
    threadAgent.set(thread, info);
    return thread;
  };

  const disposeThread = (thread: vscode.CommentThread): void => {
    threadAgent.delete(thread);
    thread.dispose();
  };

  const updateLabels = (agentKey: string): void => {
    const stops = tours.stops(agentKey);
    const total = stops.length;
    stops.forEach((stop, index) => {
      const info = threadAgent.get(stop.thread);
      const name = info?.name ?? t('notes.author.agent');
      stop.thread.label =
        total === 1
          ? t('notes.label.single', { name })
          : t('notes.label', { name, index: index + 1, total });
    });
  };

  const revealStop = async (stop: TourStop<vscode.CommentThread>): Promise<void> => {
    const document = await vscode.workspace.openTextDocument(stop.thread.uri);
    if (disposed || tours.position(stop.thread) === undefined) {
      return;
    }
    const range = stop.thread.range ?? rangeForNote(document, stop);
    const options: vscode.TextDocumentShowOptions = {
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One,
    };
    if (stop.startLine !== undefined) {
      options.selection = range;
    }
    const editor = await vscode.window.showTextDocument(stop.thread.uri, options);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    stop.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    recordView(stop.thread);
  };

  const resolveFile = async (file: string, name: string): Promise<vscode.Uri | undefined> => {
    const result = await resolveWorkspaceFile(file);
    if (result.kind === 'found') {
      return result.uri;
    }
    const key = result.kind === 'outside' ? 'notes.error.outsideWorkspace' : 'notes.error.notFound';
    void vscode.window.showWarningMessage(t(key, { name, file }));
    return undefined;
  };

  const agentLinksEnabled = (): boolean =>
    vscode.workspace.getConfiguration('maestriBridge').get<boolean>('agentLinks', true);

  const restorePendingTourInner = async (): Promise<boolean> => {
    const snapshot = pendingTour;
    if (snapshot === undefined) {
      return true;
    }

    const valid = await resolveSavedNoteStops(snapshot.stops);
    if (disposed || pendingTour !== snapshot || !agentLinksEnabled()) {
      return false;
    }

    // Slots estaveis: a nota ausente conserva sua posicao e identificacao.
    slotKeys = snapshot.stops.map(noteKey);
    unresolvedStops = snapshot.stops
      .map((note, index) => ({ note, index, agentKey: snapshot.agentKey, key: noteKey(note) }))
      .filter((item) => !valid.some((entry) => entry.index === item.index));
    unresolvedTourKey = unresolvedStops.length > 0 ? snapshot.agentKey : undefined;
    const checkpointNote = snapshot.stops[snapshot.currentIndex];
    checkpointKey = checkpointNote === undefined ? undefined : noteKey(checkpointNote);
    const skipped = unresolvedStops.length;
    if (skipped > 0) {
      void vscode.window.showWarningMessage(t('notes.review.skipped', { count: skipped }));
    }
    if (valid.length === 0) {
      // Tour inteiramente ausente continua restaurado em memoria: nao descartar slots.
      pendingTour = undefined;
      activeAgent = snapshot.agentKey;
      return true;
    }

    const stops = valid.map(({ note, document, range, located }): TourStop<vscode.CommentThread> => {
      const { file, agentId, name, anchor, viewed, comments } = note;
      const thread = createThread(
        document.uri,
        range,
        comments.map((comment) => ({
          body: markdown(comment.text),
          mode: vscode.CommentMode.Preview,
          author: { name: comment.isReply ? t('notes.author.you') : comment.author },
          contextValue: comment.isReply ? 'maestri.note.you' : 'maestri.note.agent',
        })),
        { agentId, name, anchor, viewed },
      );
      return { ...located, file, thread };
    });
    valid.forEach((entry, position) => {
      const stop = stops[position];
      if (stop !== undefined) {
        tours.insertAt(snapshot.agentKey, stop, entry.index);
      }
    });
    let currentIndex = valid.findIndex(({ index }) => index === snapshot.currentIndex);
    if (currentIndex < 0 && valid.length > 0) {
      // Checkpoint preservado: escolher o indice salvo mais proximo, nao o primeiro.
      currentIndex = valid.reduce((best, item, index) =>
        Math.abs(item.index - snapshot.currentIndex) < Math.abs(valid[best]!.index - snapshot.currentIndex)
          ? index
          : best, 0);
    }
    const current = stops[Math.max(0, currentIndex)];
    if (current !== undefined) {
      checkpoints.set(snapshot.agentKey, current.thread);
    }
    pendingTour = undefined;
    activeAgent = snapshot.agentKey;
    updateLabels(snapshot.agentKey);
    return true;
  };

  const retryUnresolvedInner = async (): Promise<void> => {
    const startedGeneration = generation;
    if (disposed || unresolvedStops.length === 0 || !agentLinksEnabled()) {
      return;
    }
    const tourKey = unresolvedTourKey ?? activeTour();
    const unresolved = unresolvedStops.filter((item) => tourKey === undefined || item.agentKey === tourKey);
    const resolved = await resolveSavedNoteStops(unresolved.map((item) => item.note));
    if (disposed || resolved.length === 0 || generation !== startedGeneration) {
      return;
    }
    const agentKey = tourKey ?? unresolved[0]?.agentKey ?? 'agent';
    for (const { note, document, range, located } of resolved) {
      const { agentId, name, anchor, viewed, comments } = note;
      const thread = createThread(
        document.uri,
        range,
        comments.map((comment) => ({
          body: markdown(comment.text),
          mode: vscode.CommentMode.Preview,
          author: { name: comment.isReply ? t('notes.author.you') : comment.author },
          contextValue: comment.isReply ? 'maestri.note.you' : 'maestri.note.agent',
        })),
        { agentId, name, anchor, viewed },
      );
      const slot = unresolved.find((item) => item.key === noteKey(note));
      const resolvedKeys = new Set(resolved.map((entry) => noteKey(entry.note)));
      const earlierUnresolved = slot === undefined ? 0 : unresolved.filter(
        (item) => item.agentKey === agentKey && item.index < slot.index && !resolvedKeys.has(item.key),
      ).length;
      const insertIndex = slot === undefined ? tours.stops(agentKey).length
        : Math.max(0, slot.index - earlierUnresolved);
      tours.insertAt(agentKey, { ...located, file: note.file, thread }, insertIndex);
    }
    unresolvedStops = unresolvedStops.filter(
      (item) => !resolved.some((entry) => noteKey(entry.note) === item.key),
    );
    if (unresolvedStops.length === 0) {
      unresolvedTourKey = undefined;
    }
    activeAgent = agentKey;
    updateLabels(agentKey);
    await saveTour();
  };

  const restorePendingTour = (): Promise<boolean> => enqueue(restorePendingTourInner);
  const retryUnresolved = (): Promise<void> => enqueue(retryUnresolvedInner);

  const reviewTour = async (chooseNote: boolean): Promise<void> => {
    try {
      if (!agentLinksEnabled()) {
        void vscode.window.showWarningMessage(t('notes.error.disabled'));
        return;
      }
      if (!(await restorePendingTour())) {
        return;
      }
      await retryUnresolved();
      const agentKey = activeTour();
      const stops = agentKey === undefined ? [] : tours.stops(agentKey);
      if (agentKey === undefined || stops.length === 0) {
        void vscode.window.showInformationMessage(t('notes.empty'));
        return;
      }

      let stop = stops.find((item) => item.thread === checkpoints.get(agentKey)) ?? stops[0];
      if (chooseNote) {
        const items = stops.map((item, index) => ({
          label: vscode.workspace.asRelativePath(item.thread.uri),
          description: t('notes.label', {
            name: t(threadAgent.get(item.thread)?.viewed ? 'notes.review.viewed' : 'notes.review.pending'),
            index: index + 1,
            total: stops.length,
          }),
          // Inicio do texto da nota, com a linha quando disponivel.
          detail: [
            item.thread.comments
              .map((comment) => (typeof comment.body === 'string' ? comment.body : comment.body.value))
              .join(' ')
              .trim()
              .slice(0, 160),
            item.startLine === undefined
              ? undefined
              : String(item.startLine) + '–' + String(item.endLine ?? item.startLine),
          ].filter(Boolean).join(' · '),
          stop: item,
        }));
        const choice = await vscode.window.showQuickPick(items, {
          title: t('notes.review.title'),
          matchOnDescription: true,
        });
        stop = choice?.stop;
      }

      if (stop !== undefined && tours.position(stop.thread) !== undefined && agentLinksEnabled()) {
        await revealStop(stop);
        await saveTour();
      }
    } catch (error) {
      await showFlowError(services.session, error);
    }
  };

  const handleUri = async (uri: vscode.Uri): Promise<void> => {
    if (uri.path !== SHOW_LINK_PATH) {
      return;
    }

    try {
      if (!agentLinksEnabled()) {
        void vscode.window.showWarningMessage(t('notes.error.disabled'));
        return;
      }

      const result = parseShowLink(uri.query);
      if (!result.ok) {
        void vscode.window.showWarningMessage(t(ERROR_KEYS[result.error]));
        return;
      }

      const request = result.request;
      const terminal =
        request.agentId === undefined
          ? undefined
          : monitor.snapshot?.terminals.find((item) => item.id === request.agentId);
      const name = request.from ?? terminal?.name ?? t('notes.author.agent');

      const fileUri = await resolveFile(request.file, name);
      if (fileUri === undefined) {
        return;
      }

      const document = await vscode.workspace.openTextDocument(fileUri);
      const location: StopLocation = { file: fileUri.fsPath };
      if (request.startLine !== undefined) {
        location.startLine = request.startLine;
      }
      if (request.endLine !== undefined) {
        location.endLine = request.endLine;
      }
      const range = rangeForNote(document, location);

      if (request.text === undefined) {
        const options: vscode.TextDocumentShowOptions = {
          preserveFocus: false,
          viewColumn: vscode.ViewColumn.One,
        };
        if (request.startLine !== undefined) {
          options.selection = range;
        }
        const editor = await vscode.window.showTextDocument(fileUri, options);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        return;
      }

      // Retomada passiva: sem abrir arquivo, sem mover foco, antes de qualquer nota nova.
      await restorePendingTour();

      const agentKey = request.agentId ?? request.from ?? 'agent';
      const { started, dropped } = tours.begin(agentKey, request.newTour);
      for (const thread of dropped) {
        disposeThread(thread);
      }
      if (started) {
        const heldUnresolved = unresolvedStops.some((item) => item.agentKey === agentKey);
        const restart = request.newTour || unresolvedTourKey !== agentKey;
        if (restart) {
          generation += 1;
          unresolvedStops = [];
          unresolvedTourKey = undefined;
        }
        if (restart || !heldUnresolved) {
          checkpoints.delete(agentKey);
          checkpointKey = undefined;
          slotKeys = [];
        }
      }
      const existing = tours.find(agentKey, location);
      const comment: vscode.Comment = {
        body: markdown(request.text),
        mode: vscode.CommentMode.Preview,
        author: { name },
        contextValue: 'maestri.note.agent',
        timestamp: new Date(),
      };

      if (existing !== undefined) {
        existing.thread.comments = [...existing.thread.comments, comment];
        updateLabels(agentKey);
        await revealStop(existing);
        await saveTour();
        return;
      }

      const thread = createThread(fileUri, range, [comment], {
        agentId: request.agentId,
        name,
        anchor: noteAnchor(document, range),
        viewed: false,
      });
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

      const stop: TourStop<vscode.CommentThread> = { file: fileUri.fsPath, thread };
      if (request.startLine !== undefined) {
        stop.startLine = request.startLine;
      }
      if (request.endLine !== undefined) {
        stop.endLine = request.endLine;
      }
      tours.push(agentKey, stop);
      updateLabels(agentKey);

      if (started) {
        await revealStop(stop);
      } else {
        const position = tours.position(thread);
        vscode.window.setStatusBarMessage(
          t('notes.added', {
            name,
            index: (position?.index ?? 0) + 1,
            total: position?.total ?? 1,
          }),
          6000,
        );
      }
      await saveTour();
    } catch (error) {
      await showFlowError(services.session, error);
    }
  };

  const stopAtSelection = (agentKey: string): TourStop<vscode.CommentThread> | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      return undefined;
    }
    const line = editor.selection.active.line + 1;
    return tours.stops(agentKey).find((stop) => {
      if (stop.file !== editor.document.uri.fsPath) {
        return false;
      }
      const start = stop.startLine ?? 1;
      const end = stop.endLine ?? start;
      return line >= start && line <= end;
    });
  };

  const firstOrLast = (
    agentKey: string,
    direction: 1 | -1,
  ): TourStop<vscode.CommentThread> | undefined => {
    const stops = tours.stops(agentKey);
    return direction === 1 ? stops[0] : stops.at(-1);
  };

  const navigate = async (
    direction: 1 | -1,
    thread?: vscode.CommentThread,
  ): Promise<void> => {
    try {
      await retryUnresolved();
      let base: TourStop<vscode.CommentThread> | undefined;
      if (thread !== undefined) {
        const position = tours.position(thread);
        if (position !== undefined) {
          base = tours.stops(position.agentKey)[position.index];
        }
      }

      if (base === undefined) {
        const agentKey = activeTour();
        if (agentKey === undefined) {
          void vscode.window.showInformationMessage(t('notes.empty'));
          return;
        }
        const checkpoint = checkpoints.get(agentKey);
        const checkpointStop = checkpoint === undefined
          ? undefined
          : tours.stops(agentKey).find((stop) => stop.thread === checkpoint);
        base = stopAtSelection(agentKey) ?? checkpointStop ?? firstOrLast(agentKey, direction);
      }

      if (base === undefined) {
        void vscode.window.showInformationMessage(t('notes.empty'));
        return;
      }

      const next = tours.neighbor(base.thread, direction);
      if (next !== undefined) {
        await revealStop(next);
        await saveTour();
      }
    } catch (error) {
      await showFlowError(services.session, error);
    }
  };

  const close = async (thread?: vscode.CommentThread): Promise<void> => {
    if (thread === undefined) {
      return;
    }
    const position = tours.position(thread);
    const agentKey = position?.agentKey;
    const stops = agentKey === undefined ? [] : tours.stops(agentKey);
    // Checkpoint ao fechar: proxima na ordem do tour, ou anterior na borda.
    const index = position?.index ?? -1;
    const nextCheckpoint = stops[index + 1] ?? stops[index - 1];
    const wasCheckpoint = agentKey !== undefined && checkpoints.get(agentKey) === thread;

    const removedKey = tours.remove(thread);
    disposeThread(thread);
    if (removedKey !== undefined) {
      if (wasCheckpoint) {
        checkpoints.delete(removedKey);
        if (nextCheckpoint !== undefined) {
          checkpoints.set(removedKey, nextCheckpoint.thread);
        }
      }
      updateLabels(removedKey);
      await saveTour();
    }
  };

  const clearThreads = (): void => {
    for (const thread of tours.clear()) {
      disposeThread(thread);
    }
    checkpoints.clear();
    activeAgent = undefined;
  };

  const clearAll = async (): Promise<void> => {
    generation += 1;
    pendingTour = undefined;
    unresolvedStops = [];
    unresolvedTourKey = undefined;
    slotKeys = [];
    checkpointKey = undefined;
    clearThreads();
    await storage.update(SAVED_TOUR_KEY, undefined);
  };

  const reply = async (commentReply: vscode.CommentReply): Promise<void> => {
    try {
      const text = commentReply.text.trim();
      if (text === '') {
        void vscode.window.showWarningMessage(t('compose.thread.emptyMessage'));
        return;
      }

      const thread = commentReply.thread;
      const info = threadAgent.get(thread);
      if (info?.agentId === undefined) {
        void vscode.window.showWarningMessage(t('notes.error.noAgent'));
        return;
      }

      const client = await services.session.ensureClient();
      if (client === undefined) {
        return;
      }

      const snapshot = monitor.snapshot;
      const located = await locateTerminal(client, info.agentId, {
        snapshots: snapshot === undefined ? [] : [snapshot],
        preferredWorkspaceId: snapshot?.workspace.id,
      });
      if (located === undefined) {
        void vscode.window.showWarningMessage(
          t('notes.error.agentNotFound', { name: info.name }),
        );
        return;
      }

      const target: AgentTarget = {
        workspaceId: located.workspace.id,
        workspaceName: located.workspace.name,
        terminalId: located.terminal.id,
        terminalName: located.terminal.name,
      };
      if (located.terminal.floorId !== undefined) {
        target.floorId = located.terminal.floorId;
      }
      if (located.terminal.floorName !== undefined) {
        target.floorName = located.terminal.floorName;
      }

      const document = await vscode.workspace.openTextDocument(thread.uri);
      const range = thread.range ?? rangeForNote(document, { file: document.uri.fsPath });
      const references = referencesForRange(document, range);
      const ok = await deliver({
        session: services.session,
        client,
        memory: services.memory,
        target,
        message: text,
        references,
        notifySuccess: false,
      });

      if (ok) {
        thread.comments = [
          ...thread.comments,
          {
            body: markdown(text),
            mode: vscode.CommentMode.Preview,
            author: { name: t('notes.author.you') },
            contextValue: 'maestri.note.you',
            timestamp: new Date(),
          },
        ];
        const position = tours.position(thread);
        if (position !== undefined) {
          tours.touch(position.agentKey);
          recordView(thread);
          await saveTour();
        }
      }
    } catch (error) {
      await showFlowError(services.session, error);
    }
  };

  const next = vscode.commands.registerCommand(
    'maestriBridge.notes.next',
    (thread?: vscode.CommentThread) => navigate(1, thread),
  );
  const previous = vscode.commands.registerCommand(
    'maestriBridge.notes.previous',
    (thread?: vscode.CommentThread) => navigate(-1, thread),
  );
  const resume = vscode.commands.registerCommand(
    'maestriBridge.notes.resume',
    () => reviewTour(false),
  );
  const review = vscode.commands.registerCommand(
    'maestriBridge.notes.review',
    () => reviewTour(true),
  );
  const closeCommand = vscode.commands.registerCommand('maestriBridge.notes.close', close);
  const clearAllCommand = vscode.commands.registerCommand('maestriBridge.notes.clearAll', clearAll);
  const replyCommand = vscode.commands.registerCommand('maestriBridge.notes.reply', reply);
  const uriHandler = vscode.window.registerUriHandler({ handleUri });

  // Ativacao restaura o tour salvo sem revelar notas ou roubar foco.
  void restorePendingTour();

  return new vscode.Disposable(() => {
    disposed = true;
    pendingTour = undefined;
    next.dispose();
    previous.dispose();
    resume.dispose();
    review.dispose();
    closeCommand.dispose();
    clearAllCommand.dispose();
    replyCommand.dispose();
    uriHandler.dispose();
    clearThreads();
    controller.dispose();
  });
}

function markdown(text: string): vscode.MarkdownString {
  const value = new vscode.MarkdownString(text);
  value.isTrusted = false;
  value.supportHtml = false;
  value.supportThemeIcons = false;
  return value;
}
