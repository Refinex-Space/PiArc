// Runs in an opaque sandbox. The parent displays the result exclusively as an image.
/** @param {MessageEvent<unknown>} event */
async function draw(event) {
  const message = event.data;
  if (
    event.source !== window.parent ||
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'draw' ||
    !('source' in message) ||
    !('id' in message) ||
    !('dark' in message) ||
    typeof message.source !== 'string' ||
    message.source.length > 32768 ||
    typeof message.id !== 'number'
  )
    return;
  try {
    // Per-document configuration and actions cannot override these application settings.
    if (/^\s*---/u.test(message.source) || /%%\s*\{/u.test(message.source))
      throw new Error('Embedded diagram configuration is disabled');
    const engine = window.mermaid;
    if (!engine) throw new Error('Diagram engine unavailable');
    engine.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 32768,
      maxEdges: 500,
      theme: message.dark ? 'dark' : 'neutral',
      htmlLabels: false,
      fontFamily: 'system-ui, sans-serif',
    });
    const { svg } = await engine.render('figure' + String(message.id), message.source);
    if (svg.length > 2 * 1024 * 1024) throw new Error('Diagram exceeds its display limit');
    window.parent.postMessage({ id: message.id, svg }, '*');
  } catch (e) {
    window.parent.postMessage(
      { id: message.id, error: e instanceof Error ? e.message : 'Invalid diagram' },
      '*',
    );
  }
}
window.addEventListener('message', (event) => {
  void draw(event);
});
window.parent.postMessage({ type: 'diagram-ready' }, '*');
