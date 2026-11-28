// The changes card and the keyboard command target the same session tool.
import { showPanel, togglePanel } from '../shell/registry.js';

export function openChangesPanel(): void {
  showPanel('changes');
}
export function toggleChangesPanel(): void {
  togglePanel('changes');
}
