import type { FollowToggleView } from '../chat-protocol.ts';
import { t } from '../i18n/index.ts';

export function createFollowToggle(send: (action: 'toggle' | 'view') => void): {
  toggle: HTMLButtonElement;
  pending: HTMLButtonElement;
  update: (view?: FollowToggleView) => void;
} {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'follow-toggle';
  toggle.setAttribute('aria-pressed', 'false');
  const label = document.createElement('span');
  label.className = 'follow-toggle-label';
  toggle.append(label);

  const pending = document.createElement('button');
  pending.type = 'button';
  pending.className = 'follow-pending';
  pending.hidden = true;

  let signature = '';

  toggle.addEventListener('click', () => send('toggle'));
  pending.addEventListener('click', () => send('view'));

  return {
    toggle,
    pending,
    update(view) {
      const next = JSON.stringify(view ?? null);
      if (next === signature) return;
      signature = next;
      if (view === undefined) {
        toggle.setAttribute('aria-pressed', 'false');
        toggle.removeAttribute('data-phase');
        toggle.removeAttribute('data-error');
        toggle.title = t('follow.title');
        toggle.setAttribute('aria-label', t('follow.toggle'));
        label.textContent = t('follow.toggle');
        pending.hidden = true;
        return;
      }
      toggle.setAttribute('aria-pressed', String(view.pressed));
      toggle.dataset.phase = view.phase;
      toggle.dataset.error = String(view.error);
      toggle.title = view.tooltip;
      toggle.setAttribute('aria-label', view.toggleLabel);
      label.textContent = view.label;
      pending.textContent = view.viewLabel ?? '';
      pending.hidden = view.viewLabel === undefined;
      pending.title = view.viewLabel ?? '';
    },
  };
}
