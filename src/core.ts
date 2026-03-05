/**
 * Core module — contains the heavy classes (StorageProvider, SessionManager,
 * TaskManager, MessageHandler and their transitive dependencies like JiraService,
 * AutomationService, CopilotAIService).
 *
 * This is built as a SEPARATE bundle (dist/core.js) and loaded lazily via
 * require('./core') inside ensureInitialized(), so the extension activates
 * instantly without parsing all this code upfront.
 */
export { StorageProvider } from './storage/StorageProvider';
export { SessionManager } from './session/SessionManager';
export { TaskManager } from './tasks/TaskManager';
export { MessageHandler } from './ui/MessageHandler';
