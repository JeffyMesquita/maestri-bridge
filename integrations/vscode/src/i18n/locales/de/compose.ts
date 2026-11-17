import type { compose as source } from '../en/compose.ts';

export const compose: Record<keyof typeof source, string> = {
  'compose.changeAgent.title': 'Agent wechseln',
  'compose.delivery.sending': 'Sende an {name}…',
  'compose.delivery.sent': 'An {name} gesendet.',
  'compose.draft.author': 'Deine Nachricht',
  'compose.editor.noEditor': 'Öffne eine Datei, um an Maestri zu schreiben.',
  'compose.labels.currentFile': 'aktuelle Datei',
  'compose.message.empty': 'Schreibe eine Nachricht oder wähle einen Ausschnitt aus.',
  'compose.message.placeholder': 'Was soll der Agent tun?',
  'compose.message.prompt': 'Angehängt: {summary}',
  'compose.message.required': 'Schreibe eine Nachricht.',
  'compose.message.title': 'Nachricht an {name}',
  'compose.pickAgent.title': 'Welcher Agent?',
  'compose.prompt.heading': 'Referenz',
  'compose.thread.emptyMessage': 'Schreibe die Nachricht vor dem Senden.',
  'compose.thread.label': 'Maestri · {header} → {agent}',
  'compose.thread.labelNoAgent':
    'Maestri · {header} · klicke auf 👤, um den Agenten zu wählen',
  'compose.thread.placeholder':
    'Was soll der Agent mit diesem Ausschnitt tun? (⌘↩ sendet)',
  'compose.thread.prompt': 'Schreibe dem Maestri-Agenten…',
  'errors.agentNotWaiting': 'Dieser Agent wartet nicht auf eine Antwort.',
  'errors.connectFailed':
    'Verbindung zu Maestri unter {host}:{port} fehlgeschlagen. Prüfe, ob Maestri geöffnet und Wire aktiv ist.',
  'errors.chatBusy': 'Maestri ist gerade mit diesem Chat beschäftigt. Versuch es gleich noch einmal.',
  'errors.connectTimeout': 'Zeitüberschreitung beim Verbinden mit Maestri.',
  'errors.emptyMessage': 'Die Nachricht ist leer.',
  'errors.forbidden': 'Dieses Gerät darf das nicht (als Gast gekoppelt?).',
  'errors.invalidJsonBody': 'Ungültiger JSON-Inhalt.',
  'errors.invalidPin': 'Ungültiger Sicherheitsschlüssel.',
  'errors.invalidResponse': 'Ungültige Antwort von Maestri.',
  'errors.missingPairingSecret': 'Gib den Kopplungscode oder das Passwort ein.',
  'errors.pairAgain': 'Erneut koppeln',
  'errors.pairingUnauthorized':
    'Ungültiger Code oder ungültiges Passwort. Der Code ist 5 Minuten gültig und funktioniert nur bei geöffnetem Kopplungs-Tab.',
  'errors.pairingUnavailable':
    'Passwort-Kopplung ist in Maestri deaktiviert. Verwende den Code aus dem Kopplungs-Tab.',
  'errors.pinMismatch':
    'Der Sicherheitsschlüssel von Maestri stimmt nicht überein. Kopple erneut.',
  'errors.pinUnverifiable':
    'Der Sicherheitsschlüssel von Maestri konnte nicht überprüft werden.',
  'errors.rateLimited': 'Zu viele Versuche. Versuche es in {seconds} s erneut.',
  'errors.rateLimitedInstant': 'Zu viele Versuche. Versuche es gleich noch einmal.',
  'errors.requestTimeout': 'Zeitüberschreitung bei der Kommunikation mit Maestri.',
  'errors.responseTooLarge': 'Die Antwort von Maestri ist zu groß.',
  'errors.socketHandshakeFailed': 'Maestri hat die Live-Verbindung abgelehnt.',
  'errors.terminalNotRunning': 'Dieses Terminal läuft nicht in Maestri.',
  'errors.timeout':
    'Maestri hat zu lange gebraucht, um zu antworten. Versuche es erneut.',
  'errors.unauthorized':
    'Maestri hat die Anmeldedaten abgelehnt. Kopple erneut (Maestri: Mit Maestri koppeln).',
  'errors.unexpected': 'Unerwarteter Fehler.',
  'errors.unreachable': 'Maestri ist unter {host}:{port} nicht erreichbar.',
  'errors.unsupportedProtocol': 'Nicht unterstützte Maestri-Protokollversion.',
  'general.openInMaestri': 'In Maestri öffnen',
  'pairing.code.invalid': 'Der Code besteht aus 6 Ziffern.',
  'pairing.code.prompt':
    'Gib den 6-stelligen Code aus dem Kopplungs-Tab ein (5 Minuten gültig).',
  'pairing.connect.title': 'Verbindung mit Maestri wird hergestellt…',
  'pairing.method.code': 'Kopplungscode',
  'pairing.method.codeDescription': 'Kopplungs-Tab von Wire',
  'pairing.method.password': 'Passwort',
  'pairing.method.passwordDescription': 'Manuell-Tab von Wire',
  'pairing.method.placeholder': 'Wie möchtest du koppeln?',
  'pairing.method.title': 'Mit Maestri koppeln',
  'pairing.pairing.title': 'Kopplung mit Maestri…',
  'pairing.password.required': 'Gib das Passwort ein.',
  'pairing.password.title': 'Wire-Passwort',
  'pairing.security.confirm': 'Der Schlüssel stimmt überein',
  'pairing.security.detail':
    'Öffne Maestri › Wire › Tab Manuell und prüfe, ob der Sicherheitsschlüssel folgender ist:\n\n{hex}',
  'pairing.security.title': 'Sicherheitsschlüssel prüfen',
  'pairing.success': 'Mit Maestri gekoppelt.',
  'pairing.successGuest': 'Als Gast mit Maestri gekoppelt (schreibgeschützt).',
  'pairing.unpaired': 'Diese VS Code-Instanz wurde von Maestri getrennt.',
};
