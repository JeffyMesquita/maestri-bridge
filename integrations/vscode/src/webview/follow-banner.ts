import type { FollowBannerView } from '../chat-protocol.ts';

export function createFollowBanner(send: (action: 'pause' | 'resume' | 'stop') => void): {
  element: HTMLElement;
  update: (view?: FollowBannerView) => void;
} {
  const element = document.createElement('section');
  element.className = 'follow-banner';
  element.hidden = true;
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  const icon = document.createElement('span');
  icon.className = 'follow-banner-icon';
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('strong');
  const actions = document.createElement('div');
  actions.className = 'follow-banner-actions';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  const stop = document.createElement('button');
  stop.type = 'button';
  let current: FollowBannerView | undefined;
  let signature = '';
  toggle.addEventListener('click', () => {
    if (current?.phase === 'paused') send('resume');
    else if (current?.phase === 'following') send('pause');
  });
  stop.addEventListener('click', () => send('stop'));
  actions.append(toggle, stop);
  element.append(icon, label, actions);
  return {
    element,
    update(view) {
      const next = JSON.stringify(view) ?? '';
      if (next === signature) return;
      signature = next;
      current = view;
      element.hidden = view === undefined;
      if (!view) return;
      element.dataset.accent = view.accent;
      element.dataset.phase = view.phase;
      element.title = view.tooltip;
      label.textContent = view.label;
      icon.textContent = view.phase === 'paused' ? 'Ⅱ' : view.phase === 'completed' ? '✓' : '◎';
      toggle.hidden = view.phase === 'completed';
      toggle.textContent = view.toggleLabel;
      stop.textContent = view.stopLabel;
    },
  };
}
