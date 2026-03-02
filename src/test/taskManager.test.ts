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
});

console.log('\nDone.\n');
