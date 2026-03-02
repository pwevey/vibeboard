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

console.log('\nDone.\n');
