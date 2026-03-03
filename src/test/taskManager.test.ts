/**
 * Unit Tests — TaskManager
 */
import * as assert from 'assert';
import { MockStorageProvider } from './mock-storage';
import { TaskManager } from '../tasks/TaskManager';

// Type coercion: MockStorageProvider implements the same interface
function createTaskManager(storage?: MockStorageProvider): { tm: TaskManager; storage: MockStorageProvider } {
  const s = storage ?? new MockStorageProvider();
  const tm = new TaskManager(s as any);
  return { tm, storage: s };
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

console.log('TaskManager Tests');
console.log('=================');

// ── addTask ──

test('addTask creates a task with correct fields', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'Test', tag: 'feature', status: 'up-next', sessionId: 's1' });
  assert.strictEqual(task.title, 'Test');
  assert.strictEqual(task.tag, 'feature');
  assert.strictEqual(task.status, 'up-next');
  assert.strictEqual(task.sessionId, 's1');
  assert.strictEqual(task.priority, 'medium'); // default
  assert.strictEqual(task.timeSpentMs, 0);
  assert.strictEqual(task.timerStartedAt, null);
  assert.strictEqual(task.completedAt, null);
  assert.strictEqual(storage.getData().tasks.length, 1);
});

test('addTask with explicit priority', () => {
  const { tm } = createTaskManager();
  const task = tm.addTask({ title: 'Urgent', tag: 'bug', status: 'up-next', sessionId: 's1', priority: 'high' });
  assert.strictEqual(task.priority, 'high');
});

test('addTask with description', () => {
  const { tm } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'note', status: 'notes', sessionId: 's1', description: 'Some info' });
  assert.strictEqual(task.description, 'Some info');
});

test('addTask increments order in same column', () => {
  const { tm } = createTaskManager();
  const t1 = tm.addTask({ title: 'A', tag: 'feature', status: 'up-next', sessionId: 's1' });
  const t2 = tm.addTask({ title: 'B', tag: 'feature', status: 'up-next', sessionId: 's1' });
  assert.ok(t2.order > t1.order);
});

// ── updateTask ──

test('updateTask changes title', () => {
  const { tm } = createTaskManager();
  const task = tm.addTask({ title: 'Old', tag: 'feature', status: 'up-next', sessionId: 's1' });
  const updated = tm.updateTask(task.id, { title: 'New' });
  assert.strictEqual(updated?.title, 'New');
});

test('updateTask changes priority', () => {
  const { tm } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  const updated = tm.updateTask(task.id, { priority: 'high' });
  assert.strictEqual(updated?.priority, 'high');
});

test('updateTask with invalid id returns null', () => {
  const { tm } = createTaskManager();
  const result = tm.updateTask('nonexistent', { title: 'X' });
  assert.strictEqual(result, null);
});

test('updateTask pushes undo entry', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  storage.getData().undoStack = []; // clear addTask undo
  tm.updateTask(task.id, { title: 'Changed' });
  assert.strictEqual(storage.getData().undoStack!.length, 1);
  assert.strictEqual(storage.getData().undoStack![0].action, 'edit');
});

// ── moveTask ──

test('moveTask changes status and order', () => {
  const { tm } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  const moved = tm.moveTask(task.id, 'backlog', 0);
  assert.strictEqual(moved?.status, 'backlog');
  assert.strictEqual(moved?.order, 0);
});

test('moveTask to completed sets completedAt', () => {
  const { tm } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  const moved = tm.moveTask(task.id, 'completed', 0);
  assert.ok(moved?.completedAt);
});

test('moveTask from completed clears completedAt', () => {
  const { tm } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  tm.moveTask(task.id, 'completed', 0);
  const moved = tm.moveTask(task.id, 'up-next', 0);
  assert.strictEqual(moved?.completedAt, null);
});

// ── completeTask ──

test('completeTask sets status and completedAt', () => {
  const { tm } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  const completed = tm.completeTask(task.id);
  assert.strictEqual(completed?.status, 'completed');
  assert.ok(completed?.completedAt);
});

test('completeTask stops active timer', () => {
  const { tm } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  tm.toggleTimer(task.id); // start timer
  const completed = tm.completeTask(task.id);
  assert.strictEqual(completed?.timerStartedAt, null);
  assert.ok((completed?.timeSpentMs ?? 0) >= 0);
});

// ── deleteTask ──

test('deleteTask removes the task', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  const result = tm.deleteTask(task.id);
  assert.strictEqual(result, true);
  assert.strictEqual(storage.getData().tasks.length, 0);
});

test('deleteTask with invalid id returns false', () => {
  const { tm } = createTaskManager();
  assert.strictEqual(tm.deleteTask('nonexistent'), false);
});

test('deleteTask pushes undo entry', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  storage.getData().undoStack = []; // clear addTask undo
  tm.deleteTask(task.id);
  assert.strictEqual(storage.getData().undoStack!.length, 1);
  assert.strictEqual(storage.getData().undoStack![0].action, 'delete');
});

// ── toggleTimer ──

test('toggleTimer starts timer', () => {
  const { tm } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  const toggled = tm.toggleTimer(task.id);
  assert.ok(toggled?.timerStartedAt);
  assert.strictEqual(toggled?.timeSpentMs, 0);
});

test('toggleTimer stops timer and accumulates time', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });

  // Manually set timerStartedAt in the past
  const data = storage.getData();
  const t = data.tasks.find((x) => x.id === task.id)!;
  t.timerStartedAt = new Date(Date.now() - 5000).toISOString();
  storage.setData(data);

  const stopped = tm.toggleTimer(task.id);
  assert.strictEqual(stopped?.timerStartedAt, null);
  assert.ok((stopped?.timeSpentMs ?? 0) >= 4000); // at least 4s (allowing clock slack)
});

// ── undo ──

test('undo restores edited task snapshot', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'Original', tag: 'feature', status: 'up-next', sessionId: 's1' });
  tm.updateTask(task.id, { title: 'Changed' });
  const action = tm.undo();
  assert.strictEqual(action, 'edit');
  const restored = storage.getData().tasks.find((t) => t.id === task.id);
  assert.strictEqual(restored?.title, 'Original');
});

test('undo restores deleted task', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'Deleted', tag: 'feature', status: 'up-next', sessionId: 's1' });
  tm.deleteTask(task.id);
  assert.strictEqual(storage.getData().tasks.length, 0);
  const action = tm.undo();
  assert.strictEqual(action, 'delete');
  assert.strictEqual(storage.getData().tasks.length, 1);
  assert.strictEqual(storage.getData().tasks[0].title, 'Deleted');
});

test('undo returns null when stack is empty', () => {
  const { tm } = createTaskManager();
  assert.strictEqual(tm.undo(), null);
});

test('undo stack max size is enforced', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  // Push 25 undo entries (max is 20)
  for (let i = 0; i < 25; i++) {
    tm.updateTask(task.id, { title: `Title ${i}` });
  }
  assert.ok(storage.getData().undoStack!.length <= 20);
});

test('undo removes added task', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'New Task', tag: 'feature', status: 'up-next', sessionId: 's1' });
  assert.strictEqual(storage.getData().tasks.length, 1);
  const action = tm.undo();
  assert.strictEqual(action, 'add');
  assert.strictEqual(storage.getData().tasks.length, 0);
});

test('addTask pushes undo entry', () => {
  const { tm, storage } = createTaskManager();
  tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  assert.strictEqual(storage.getData().undoStack!.length, 1);
  assert.strictEqual(storage.getData().undoStack![0].action, 'add');
});

test('undo restores timer state', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  // Clear the addTask undo entry
  storage.getData().undoStack = [];
  assert.strictEqual(task.timerStartedAt, null);
  tm.toggleTimer(task.id); // start timer
  const started = storage.getData().tasks.find((t) => t.id === task.id)!;
  assert.ok(started.timerStartedAt);
  const action = tm.undo();
  assert.strictEqual(action, 'timer');
  const restored = storage.getData().tasks.find((t) => t.id === task.id)!;
  assert.strictEqual(restored.timerStartedAt, null);
});

test('toggleTimer pushes undo entry', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  // Clear the addTask undo entry
  storage.getData().undoStack = [];
  tm.toggleTimer(task.id);
  assert.strictEqual(storage.getData().undoStack!.length, 1);
  assert.strictEqual(storage.getData().undoStack![0].action, 'timer');
});

test('undo of moveTask restores task and fixes sibling orders', () => {
  const { tm, storage } = createTaskManager();
  // Clear undo stack after setup
  const t1 = tm.addTask({ title: 'Existing', tag: 'feature', status: 'backlog', sessionId: 's1' });
  storage.getData().undoStack = [];
  // Set t1 order to 0
  const data = storage.getData();
  data.tasks.find((t) => t.id === t1.id)!.order = 0;
  storage.setData(data);

  // Add and move a second task to backlog at order 0 (shifts t1 to order 1)
  const t2 = tm.addTask({ title: 'Mover', tag: 'bug', status: 'up-next', sessionId: 's1' });
  storage.getData().undoStack = [];
  tm.moveTask(t2.id, 'backlog', 0);

  // t1 should have been shifted to order 1
  assert.strictEqual(storage.getData().tasks.find((t) => t.id === t1.id)!.order, 1);

  // Undo the move
  const action = tm.undo();
  assert.strictEqual(action, 'move');

  // t2 should be back in up-next
  const restoredT2 = storage.getData().tasks.find((t) => t.id === t2.id)!;
  assert.strictEqual(restoredT2.status, 'up-next');

  // t1 should have its order decremented back to 0
  const restoredT1 = storage.getData().tasks.find((t) => t.id === t1.id)!;
  assert.strictEqual(restoredT1.order, 0);
});

test('undo of completeTask restores original status', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  storage.getData().undoStack = [];
  tm.completeTask(task.id);
  assert.strictEqual(storage.getData().tasks.find((t) => t.id === task.id)!.status, 'completed');
  const action = tm.undo();
  assert.strictEqual(action, 'complete');
  const restored = storage.getData().tasks.find((t) => t.id === task.id)!;
  assert.strictEqual(restored.status, 'up-next');
  assert.strictEqual(restored.completedAt, null);
});

// ── redo ──

test('redo returns null when stack is empty', () => {
  const { tm } = createTaskManager();
  assert.strictEqual(tm.redo(), null);
});

test('redo re-applies undone edit', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'Original', tag: 'feature', status: 'up-next', sessionId: 's1' });
  tm.updateTask(task.id, { title: 'Changed' });
  tm.undo(); // undoes edit → title back to 'Original'
  assert.strictEqual(storage.getData().tasks.find((t) => t.id === task.id)!.title, 'Original');
  const action = tm.redo();
  assert.strictEqual(action, 'edit');
  assert.strictEqual(storage.getData().tasks.find((t) => t.id === task.id)!.title, 'Changed');
});

test('redo re-adds undone add', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'New Task', tag: 'feature', status: 'up-next', sessionId: 's1' });
  tm.undo(); // undoes add → task removed
  assert.strictEqual(storage.getData().tasks.length, 0);
  const action = tm.redo();
  assert.strictEqual(action, 'add');
  assert.strictEqual(storage.getData().tasks.length, 1);
  assert.strictEqual(storage.getData().tasks[0].title, 'New Task');
});

test('redo re-deletes undone delete', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'ToDelete', tag: 'feature', status: 'up-next', sessionId: 's1' });
  tm.deleteTask(task.id);
  assert.strictEqual(storage.getData().tasks.length, 0);
  tm.undo(); // undoes delete → task restored
  assert.strictEqual(storage.getData().tasks.length, 1);
  const action = tm.redo();
  assert.strictEqual(action, 'delete');
  assert.strictEqual(storage.getData().tasks.length, 0);
});

test('redo re-applies undone complete', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  storage.getData().undoStack = [];
  tm.completeTask(task.id);
  tm.undo(); // undoes complete
  assert.strictEqual(storage.getData().tasks.find((t) => t.id === task.id)!.status, 'up-next');
  const action = tm.redo();
  assert.strictEqual(action, 'complete');
  assert.strictEqual(storage.getData().tasks.find((t) => t.id === task.id)!.status, 'completed');
  assert.ok(storage.getData().tasks.find((t) => t.id === task.id)!.completedAt);
});

test('redo re-applies undone timer toggle', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  storage.getData().undoStack = [];
  tm.toggleTimer(task.id); // start timer
  assert.ok(storage.getData().tasks.find((t) => t.id === task.id)!.timerStartedAt);
  tm.undo(); // undo timer start
  assert.strictEqual(storage.getData().tasks.find((t) => t.id === task.id)!.timerStartedAt, null);
  const action = tm.redo();
  assert.strictEqual(action, 'timer');
  assert.ok(storage.getData().tasks.find((t) => t.id === task.id)!.timerStartedAt);
});

test('new action clears redo stack', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'T', tag: 'feature', status: 'up-next', sessionId: 's1' });
  tm.updateTask(task.id, { title: 'Changed' });
  tm.undo();
  assert.ok((storage.getData().redoStack?.length ?? 0) > 0);
  // Performing a new action should clear redo
  tm.updateTask(task.id, { title: 'New Change' });
  assert.strictEqual(storage.getData().redoStack?.length ?? 0, 0);
});

test('undo then redo cycles correctly', () => {
  const { tm, storage } = createTaskManager();
  const task = tm.addTask({ title: 'A', tag: 'feature', status: 'up-next', sessionId: 's1' });
  tm.updateTask(task.id, { title: 'B' });
  tm.updateTask(task.id, { title: 'C' });
  // Undo twice
  tm.undo(); // C → B
  assert.strictEqual(storage.getData().tasks.find((t) => t.id === task.id)!.title, 'B');
  tm.undo(); // B → A
  assert.strictEqual(storage.getData().tasks.find((t) => t.id === task.id)!.title, 'A');
  // Redo twice
  tm.redo(); // A → B
  assert.strictEqual(storage.getData().tasks.find((t) => t.id === task.id)!.title, 'B');
  tm.redo(); // B → C
  assert.strictEqual(storage.getData().tasks.find((t) => t.id === task.id)!.title, 'C');
});

// ── carryOverTasks ──

test('carryOverTasks moves non-completed tasks to new session', () => {
  const { tm, storage } = createTaskManager();
  tm.addTask({ title: 'Active', tag: 'feature', status: 'up-next', sessionId: 'old' });
  tm.addTask({ title: 'Done', tag: 'feature', status: 'up-next', sessionId: 'old' });
  tm.completeTask(storage.getData().tasks[1].id);
  const carried = tm.carryOverTasks('old', 'new');
  assert.strictEqual(carried, 1);
  const active = storage.getData().tasks.find((t) => t.title === 'Active');
  assert.strictEqual(active?.sessionId, 'new');
  assert.strictEqual(active?.carriedFromSessionId, 'old');
  assert.strictEqual(active?.boardId, 'default'); // should update to new session's board
});

// ── carryOverAllTasks ──

test('carryOverAllTasks gathers incomplete tasks from multiple ended sessions', () => {
  const { tm, storage } = createTaskManager();

  // Simulate two ended sessions with incomplete tasks
  const data = storage.getData();
  data.sessions = [
    { id: 's1', name: 'Session 1', projectPath: '', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T01:00:00Z', status: 'ended' as const },
    { id: 's2', name: 'Session 2', projectPath: '', startedAt: '2026-01-02T00:00:00Z', endedAt: '2026-01-02T01:00:00Z', status: 'ended' as const },
    { id: 's3', name: 'Session 3', projectPath: '', startedAt: '2026-01-03T00:00:00Z', endedAt: null, status: 'active' as const },
  ];
  data.activeSessionId = 's3';
  storage.setData(data);

  // Add tasks to each ended session
  tm.addTask({ title: 'S1 Task', tag: 'feature', status: 'up-next', sessionId: 's1' });
  tm.addTask({ title: 'S1 Done', tag: 'bug', status: 'up-next', sessionId: 's1' });
  tm.completeTask(storage.getData().tasks.find((t) => t.title === 'S1 Done')!.id);
  tm.addTask({ title: 'S2 Task A', tag: 'refactor', status: 'backlog', sessionId: 's2' });
  tm.addTask({ title: 'S2 Task B', tag: 'note', status: 'notes', sessionId: 's2' });

  // Carry over all to session 3
  const carried = tm.carryOverAllTasks('s3');
  assert.strictEqual(carried, 3); // S1 Task + S2 Task A + S2 Task B (not S1 Done which is completed)

  const tasks = storage.getData().tasks;
  const carriedTasks = tasks.filter((t) => t.sessionId === 's3' && t.carriedFromSessionId);
  assert.strictEqual(carriedTasks.length, 3);

  // Verify they came from different sessions
  const fromS1 = carriedTasks.filter((t) => t.carriedFromSessionId === 's1');
  const fromS2 = carriedTasks.filter((t) => t.carriedFromSessionId === 's2');
  assert.strictEqual(fromS1.length, 1);
  assert.strictEqual(fromS2.length, 2);
});

test('carryOverAllTasks skips active session tasks', () => {
  const { tm, storage } = createTaskManager();

  const data = storage.getData();
  data.sessions = [
    { id: 's1', name: 'Session 1', projectPath: '', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T01:00:00Z', status: 'ended' as const },
    { id: 's2', name: 'Session 2', projectPath: '', startedAt: '2026-01-02T00:00:00Z', endedAt: null, status: 'active' as const },
  ];
  data.activeSessionId = 's2';
  storage.setData(data);

  tm.addTask({ title: 'Old Task', tag: 'feature', status: 'up-next', sessionId: 's1' });
  tm.addTask({ title: 'Current Task', tag: 'feature', status: 'up-next', sessionId: 's2' });

  const carried = tm.carryOverAllTasks('s2');
  assert.strictEqual(carried, 1); // Only the s1 task, not the s2 task

  const old = storage.getData().tasks.find((t) => t.title === 'Old Task');
  assert.strictEqual(old?.sessionId, 's2');
  assert.strictEqual(old?.carriedFromSessionId, 's1');
});

console.log('\nDone.\n');
