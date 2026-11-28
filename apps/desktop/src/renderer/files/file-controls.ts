// A command may create the Files tile; deliver it when the owning session mounts.
type Control = 'search' | 'tree';
const pending = new Map<string, Control>();
const listeners = new Map<string, (control: Control) => void>();
export function requestFilesControl(id: string, control: Control) {
  const listener = listeners.get(id);
  if (listener) listener(control);
  else pending.set(id, control);
}
export function onFilesControl(id: string, fn: (control: Control) => void) {
  listeners.set(id, fn);
  const control = pending.get(id);
  if (control) {
    pending.delete(id);
    fn(control);
  }
  return () => {
    if (listeners.get(id) === fn) listeners.delete(id);
  };
}
