import type { ActivityEvent } from '@maestri-bridge/core';

export interface FollowActivity extends ActivityEvent {
  agentId: string;
}

export interface FollowState {
  sessionId: string;
  agentId: string;
  phase: 'following' | 'paused' | 'completed';
  lastSeq: number;
  focus?: FollowActivity;
  pending?: FollowActivity;
}

export interface FollowSummary {
  agentId: string;
  name: string;
  phase: FollowState['phase'];
}

export function startFollow(sessionId: string, agentId: string): FollowState {
  return { sessionId, agentId, phase: 'following', lastSeq: 0 };
}

export function receiveFollowActivity(
  state: FollowState,
  event: FollowActivity,
): { state: FollowState; activity?: FollowActivity } {
  if (
    state.phase === 'completed' || event.sessionId !== state.sessionId ||
    event.agentId !== state.agentId || event.seq <= state.lastSeq
  ) {
    return { state };
  }
  if (event.kind === 'finish') {
    return { state: { ...state, phase: 'completed', lastSeq: event.seq, pending: undefined }, activity: event };
  }
  if (state.phase === 'paused') {
    return {
      state: {
        ...state,
        lastSeq: event.seq,
        pending: event.kind === 'focus' ? event : state.pending,
      },
    };
  }
  return {
    state: {
      ...state,
      lastSeq: event.seq,
      focus: event.kind === 'focus' ? event : { ...event, kind: 'focus', message: undefined },
    },
    activity: event,
  };
}

export function pauseFollow(state: FollowState): FollowState {
  return state.phase === 'following'
    ? { ...state, phase: 'paused', pending: state.focus }
    : state;
}

export function resumeFollow(state: FollowState): { state: FollowState; activity?: FollowActivity } {
  if (state.phase !== 'paused') return { state };
  return {
    state: { ...state, phase: 'following', pending: undefined, focus: state.pending ?? state.focus },
    activity: state.pending,
  };
}
