import { TaskStatus, TaskTag } from '../storage/models';

/**
 * Column definitions for the Kanban board.
 */
export const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'up-next', label: 'Up Next' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'completed', label: 'Completed' },
  { id: 'notes', label: 'Notes' },
];

/**
 * Tag definitions with display labels and colors.
 */
export const TAGS: { id: TaskTag; label: string; color: string }[] = [
  { id: 'feature', label: 'Feature', color: '#4CAF50' },
  { id: 'bug', label: 'Bug', color: '#F44336' },
  { id: 'refactor', label: 'Refactor', color: '#2196F3' },
  { id: 'note', label: 'Note', color: '#FF9800' },
  { id: 'plan', label: 'Plan', color: '#9C27B0' },
];

/**
 * Storage file path relative to workspace root.
 */
export const STORAGE_DIR = '.vibeboard';
export const STORAGE_FILE = 'data.json';

/**
 * Debounce delay for storage writes (ms).
 */
export const STORAGE_WRITE_DEBOUNCE_MS = 300;
