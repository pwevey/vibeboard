/**
 * Unit Tests — SessionManager
 */
import * as assert from 'assert';
import { MockStorageProvider } from './mock-storage';
import { SessionManager } from '../session/SessionManager';

function createSessionManager(storage?: MockStorageProvider): { sm: SessionManager; storage: MockStorageProvider } {
  const s = storage ?? new MockStorageProvider();
  const sm = new SessionManager(s as any);
  return { sm, storage: s };
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('SessionManager Tests');
console.log('====================');

// ── hasActiveSession ──

test('hasActiveSession returns false initially', () => {
  const { sm } = createSessionManager();
  assert.strictEqual(sm.hasActiveSession(), false);
});

test('hasActiveSession returns true after startSession', () => {
  const { sm } = createSessionManager();
  sm.startSession('/test');
  assert.strictEqual(sm.hasActiveSession(), true);
});

// ── startSession ──

test('startSession creates a new session', () => {
  const { sm, storage } = createSessionManager();
  const session = sm.startSession('/test');
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.projectPath, '/test');
  assert.ok(session.id);
  assert.ok(session.startedAt);
  assert.strictEqual(session.endedAt, null);
  assert.strictEqual(storage.getData().activeSessionId, session.id);
  assert.strictEqual(storage.getData().sessions.length, 1);
});

test('startSession ends previous session automatically', () => {
  const { sm, storage } = createSessionManager();
  const s1 = sm.startSession('/test');
  const s2 = sm.startSession('/test');
  assert.notStrictEqual(s1.id, s2.id);
  assert.strictEqual(storage.getData().activeSessionId, s2.id);
  const oldSession = storage.getData().sessions.find((s) => s.id === s1.id);
  assert.strictEqual(oldSession?.status, 'ended');
  assert.ok(oldSession?.endedAt);
});

// ── getActiveSession ──

test('getActiveSession returns null when no session', () => {
  const { sm } = createSessionManager();
  assert.strictEqual(sm.getActiveSession(), null);
});

test('getActiveSession returns the active session', () => {
  const { sm } = createSessionManager();
  const session = sm.startSession('/test');
  const active = sm.getActiveSession();
  assert.strictEqual(active?.id, session.id);
});

// ── endSession ──

test('endSession returns summary and clears active session', () => {
  const { sm, storage } = createSessionManager();
  sm.startSession('/test');
  const summary = sm.endSession();
  assert.ok(summary);
  assert.strictEqual(summary!.tasksCompleted, 0);
  assert.strictEqual(storage.getData().activeSessionId, null);
});

test('endSession returns null when no active session', () => {
  const { sm } = createSessionManager();
  assert.strictEqual(sm.endSession(), null);
});

test('endSession marks session as ended', () => {
  const { sm, storage } = createSessionManager();
  const session = sm.startSession('/test');
  sm.endSession();
  const ended = storage.getData().sessions.find((s) => s.id === session.id);
  assert.strictEqual(ended?.status, 'ended');
  assert.ok(ended?.endedAt);
});

// ── computeSummary ──

test('computeSummary counts completed tasks', () => {
  const { sm, storage } = createSessionManager();
  const session = sm.startSession('/test');
  // Manually add tasks
  const data = storage.getData();
  data.tasks.push(
    { id: 't1', title: 'A', description: '', tag: 'feature', priority: 'medium', status: 'completed', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), order: 0, sessionId: session.id, boardId: 'default', timeSpentMs: 0, timerStartedAt: null },
    { id: 't2', title: 'B', description: '', tag: 'bug', priority: 'high', status: 'up-next', createdAt: new Date().toISOString(), completedAt: null, order: 0, sessionId: session.id, boardId: 'default', timeSpentMs: 0, timerStartedAt: null },
    { id: 't3', title: 'C', description: '', tag: 'feature', priority: 'low', status: 'completed', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), order: 1, sessionId: session.id, boardId: 'default', timeSpentMs: 0, timerStartedAt: null }
  );
  storage.setData(data);

  const summary = sm.computeSummary(storage.getData(), session.id);
  assert.strictEqual(summary.tasksCompleted, 2);
  assert.strictEqual(summary.tasksCarriedOver, 1);
  assert.strictEqual(summary.tasksByTag['feature'], 2);
  assert.strictEqual(summary.tasksByTag['bug'], 0);
});

// ── getSessionHistory ──

test('getSessionHistory returns ended sessions sorted by most recent', () => {
  const { sm, storage } = createSessionManager();
  sm.startSession('/test');
  sm.endSession();
  sm.startSession('/test');
  sm.endSession();

  const history = sm.getSessionHistory();
  assert.strictEqual(history.sessions.length, 2);
  assert.strictEqual(history.summaries.length, 2);
  // Most recent first
  const t0 = new Date(history.sessions[0].startedAt).getTime();
  const t1 = new Date(history.sessions[1].startedAt).getTime();
  assert.ok(t0 >= t1);
});

test('getSessionHistory excludes active sessions', () => {
  const { sm } = createSessionManager();
  sm.startSession('/test');
  const history = sm.getSessionHistory();
  assert.strictEqual(history.sessions.length, 0);
});

// ── Models ──

test('createDefaultWorkspaceData has correct shape', () => {
  const { createDefaultWorkspaceData } = require('../storage/models');
  const data = createDefaultWorkspaceData();
  assert.strictEqual(data.version, 1);
  assert.strictEqual(data.activeSessionId, null);
  assert.ok(Array.isArray(data.sessions));
  assert.ok(Array.isArray(data.tasks));
  assert.ok(Array.isArray(data.undoStack));
  assert.strictEqual(data.activeBoardId, 'default');
  assert.ok(Array.isArray(data.boards));
  assert.strictEqual(data.boards.length, 1);
  assert.strictEqual(data.boards[0].name, 'Main Board');
});

test('TASK_TEMPLATES has expected entries', () => {
  const { TASK_TEMPLATES } = require('../storage/models');
  assert.strictEqual(TASK_TEMPLATES.length, 5);
  assert.strictEqual(TASK_TEMPLATES[0].name, 'Bug Report');
  assert.strictEqual(TASK_TEMPLATES[4].name, 'AI Prompt Idea');
});

// ── pauseSession / resumeSession ──

test('pauseSession sets pausedAt on active session', () => {
  const { sm, storage } = createSessionManager();
  sm.startSession('/test');
  const result = sm.pauseSession();
  assert.strictEqual(result, true);
  const session = sm.getActiveSession();
  assert.ok(session?.pausedAt);
});

test('pauseSession returns false when no active session', () => {
  const { sm } = createSessionManager();
  assert.strictEqual(sm.pauseSession(), false);
});

test('pauseSession returns false when already paused', () => {
  const { sm } = createSessionManager();
  sm.startSession('/test');
  sm.pauseSession();
  assert.strictEqual(sm.pauseSession(), false);
});

test('resumeSession accumulates paused time and clears pausedAt', () => {
  const { sm, storage } = createSessionManager();
  sm.startSession('/test');

  // Manually set pausedAt to 500ms ago
  const data = storage.getData();
  const session = data.sessions.find((s: any) => s.id === data.activeSessionId)!;
  session.pausedAt = new Date(Date.now() - 500).toISOString();
  storage.setData(data);

  const result = sm.resumeSession();
  assert.strictEqual(result, true);

  const updated = sm.getActiveSession();
  assert.strictEqual(updated?.pausedAt, null);
  assert.ok((updated?.totalPausedMs || 0) >= 400); // at least ~400ms
});

test('resumeSession returns false when not paused', () => {
  const { sm } = createSessionManager();
  sm.startSession('/test');
  assert.strictEqual(sm.resumeSession(), false);
});

test('endSession while paused excludes paused time from duration', () => {
  const { sm, storage } = createSessionManager();
  sm.startSession('/test');

  // Set startedAt to 10s ago, pause 5s ago
  const data = storage.getData();
  const session = data.sessions.find((s: any) => s.id === data.activeSessionId)!;
  const now = Date.now();
  session.startedAt = new Date(now - 10000).toISOString();
  session.pausedAt = new Date(now - 5000).toISOString();
  session.totalPausedMs = 0;
  storage.setData(data);

  const summary = sm.endSession();
  assert.ok(summary);
  // Duration should be ~5s (10s total minus ~5s paused), not 10s
  assert.ok(summary!.duration < 7000, `Duration ${summary!.duration}ms should be less than 7000ms`);
  assert.ok(summary!.duration >= 3000, `Duration ${summary!.duration}ms should be at least 3000ms`);
});

test('computeSummary subtracts totalPausedMs from duration', () => {
  const { sm, storage } = createSessionManager();
  const session = sm.startSession('/test');

  // Set startedAt to 20s ago with 8s of paused time
  const data = storage.getData();
  const s = data.sessions.find((s: any) => s.id === session.id)!;
  const now = Date.now();
  s.startedAt = new Date(now - 20000).toISOString();
  s.totalPausedMs = 8000;
  storage.setData(data);

  const summary = sm.computeSummary(storage.getData(), session.id);
  // Duration should be ~12s (20s - 8s paused), not 20s
  assert.ok(summary.duration < 14000, `Duration ${summary.duration}ms should be less than 14000ms`);
  assert.ok(summary.duration >= 10000, `Duration ${summary.duration}ms should be at least 10000ms`);
});

console.log('\nDone.\n');
