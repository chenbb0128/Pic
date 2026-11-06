(() => {
  'use strict';
  // Keep controls in the editor document so existing events and ID lookups stay intact.
  const actions = document.querySelector('.editor-toolbar-actions');
  if (window.parent === window) return;
  try { if (window.parent.location.origin !== window.location.origin) return; } catch { return; }
  actions.hidden = false;
  actions.addEventListener('click', event => {
    const action = event.target.closest('[data-editor-action]')?.dataset.editorAction;
    if (action) window.parent.postMessage({ type: 'heart-star-toolbar', action }, window.location.origin);
  });
  window.parent.postMessage({ type: 'heart-star-toolbar', action: 'ready' }, window.location.origin);
})();
