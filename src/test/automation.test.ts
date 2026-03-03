/**
 * Automation Service Tests
 * Tests the automation state management and queue processing.
 */
import { MockStorageProvider } from './mock-storage';
import { TaskManager } from '../tasks/TaskManager';
import { AutomationService } from '../services/AutomationService';
import { CopilotAIService } from '../services/index';
import type { VBWorkspaceData } from '../storage/models';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

console.log('');
console.log('AutomationService Tests');
console.log('=======================');

(async () => {

// --- Test: initial state ---
{
  const storage = new MockStorageProvider() as unknown as import('../storage/StorageProvider').StorageProvider;
  const taskManager = new TaskManager(storage);
  const aiService = new CopilotAIService();
  const autoService = new AutomationService(storage, taskManager, aiService);

  const progress = autoService.getProgress();
  assert(progress.state === 'idle', 'initial state is idle');
  assert(progress.queue.length === 0, 'initial queue is empty');
  assert(progress.totalTasks === 0, 'initial totalTasks is 0');
  assert(progress.completedTasks === 0, 'initial completedTasks is 0');
  assert(!autoService.isActive(), 'isActive is false initially');
}

// --- Test: start with no tasks ---
{
  const storage = new MockStorageProvider() as unknown as import('../storage/StorageProvider').StorageProvider;
  const taskManager = new TaskManager(storage);
  const aiService = new CopilotAIService();
  const autoService = new AutomationService(storage, taskManager, aiService);

  // Start with empty task IDs — should not change state
  await autoService.start([]);
  assert(autoService.getProgress().state === 'idle', 'start with empty taskIds remains idle');
}

// --- Test: start with nonexistent task IDs ---
{
  const storage = new MockStorageProvider() as unknown as import('../storage/StorageProvider').StorageProvider;
  const taskManager = new TaskManager(storage);
  const aiService = new CopilotAIService();
  const autoService = new AutomationService(storage, taskManager, aiService);

  await autoService.start(['nonexistent-id']);
  assert(autoService.getProgress().state === 'idle', 'start with nonexistent IDs remains idle');
}

// --- Test: start with completed tasks only ---
{
  const storage = new MockStorageProvider() as unknown as import('../storage/StorageProvider').StorageProvider;
  const taskManager = new TaskManager(storage);
  const aiService = new CopilotAIService();
  const autoService = new AutomationService(storage, taskManager, aiService);

  // Add a session first
  const data = (storage as any).getData() as VBWorkspaceData;
  data.activeSessionId = 'session-1';
  data.sessions = [{ id: 'session-1', name: 'Test', projectPath: '', startedAt: new Date().toISOString(), endedAt: null, status: 'active' }];
  (storage as any).setData(data);

  // Add a completed task
  taskManager.addTask({ title: 'Done task', tag: 'feature', status: 'completed', sessionId: 'session-1' });
  const tasks = (storage as any).getData().tasks;
  const taskId = tasks[0].id;

  await autoService.start([taskId]);
  assert(autoService.getProgress().state === 'idle', 'start with only completed tasks remains idle');
}

// --- Test: cancel stops automation ---
{
  const storage = new MockStorageProvider() as unknown as import('../storage/StorageProvider').StorageProvider;
  const taskManager = new TaskManager(storage);
  const aiService = new CopilotAIService();
  const autoService = new AutomationService(storage, taskManager, aiService);

  // Add session and task
  const data = (storage as any).getData() as VBWorkspaceData;
  data.activeSessionId = 'session-1';
  data.sessions = [{ id: 'session-1', name: 'Test', projectPath: '', startedAt: new Date().toISOString(), endedAt: null, status: 'active' }];
  (storage as any).setData(data);
  taskManager.addTask({ title: 'Test task', tag: 'feature', status: 'up-next', sessionId: 'session-1' });

  const tasks = (storage as any).getData().tasks;
  const taskId = tasks[0].id;

  // Wire up a no-op send handler so it doesn't fail
  autoService.setSendToCopilotHandler(async () => {});
  autoService.setProgressHandler(() => {});

  // Start (will send to copilot, then wait for changes — which won't come in test)
  // We need to cancel right away
  const startPromise = autoService.start([taskId]);

  // Cancel immediately
  autoService.cancel();

  const progress = autoService.getProgress();
  assert(progress.state === 'idle', 'cancel sets state to idle');
  assert(!autoService.isActive(), 'isActive is false after cancel');
}

// --- Test: pause/resume ---
{
  const storage = new MockStorageProvider() as unknown as import('../storage/StorageProvider').StorageProvider;
  const taskManager = new TaskManager(storage);
  const aiService = new CopilotAIService();
  const autoService = new AutomationService(storage, taskManager, aiService);

  // Pause from idle does nothing
  autoService.pause();
  assert(autoService.getProgress().state === 'idle', 'pause from idle stays idle');

  // Resume from idle does nothing
  await autoService.resume();
  assert(autoService.getProgress().state === 'idle', 'resume from idle stays idle');
}

// Summary
console.log('');
console.log(`Done. ${passed} passed, ${failed} failed.`);
if (failed > 0) { process.exit(1); }

})();
