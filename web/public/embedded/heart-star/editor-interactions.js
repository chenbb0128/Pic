(function () {
  'use strict';

  function resizeSelection(states, selection, delta) {
    selection.forEach(index => {
      const state = states[index];
      if (state) state.size = Math.max(25, Math.min(120, Math.round(((Number(state.size) || 0.62) + delta) * 100))) / 100;
    });
  }

  function createSelection({ canvas, surface, getBoard, isPhotoDrag, onStart, onSelection, canResize, onResize }) {
    const box = document.createElement('div');
    box.className = 'selection-marquee';
    box.hidden = true;
    box.setAttribute('aria-hidden', 'true');
    surface.append(box);
    let drag = null;

    function clear() {
      const previous = drag;
      drag = null;
      box.hidden = true;
      if (previous && canvas.hasPointerCapture(previous.id)) canvas.releasePointerCapture(previous.id);
      return previous;
    }

    canvas.addEventListener('pointerdown', event => {
      const board = getBoard();
      if (event.button !== 0 || event.isPrimary === false || isPhotoDrag() || !board?.ready) return;
      const bounds = canvas.getBoundingClientRect();
      const contentBottom = bounds.top + bounds.height * board.contentRatio;
      if (event.clientY >= contentBottom) return;
      onStart();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, shift: event.shiftKey, token: board.token, moved: false };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
      drag.moved = true;
      box.hidden = false;
      box.style.left = `${Math.min(drag.x, event.clientX)}px`;
      box.style.top = `${Math.min(drag.y, event.clientY)}px`;
      box.style.width = `${Math.abs(event.clientX - drag.x)}px`;
      box.style.height = `${Math.abs(event.clientY - drag.y)}px`;
      event.preventDefault();
    });
    canvas.addEventListener('pointerup', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const current = clear(), board = getBoard();
      if (!current.moved || !board?.ready || current.token !== board.token) return;
      const bounds = canvas.getBoundingClientRect(), contentHeight = bounds.height * board.contentRatio;
      const left = Math.min(current.x, event.clientX), right = Math.max(current.x, event.clientX);
      const top = Math.min(current.y, event.clientY), bottom = Math.max(current.y, event.clientY);
      const indices = [];
      board.slots.forEach((slot, index) => {
        const state = board.states[index] || {};
        const x = bounds.left + (slot.x + (state.dx || 0)) / board.width * bounds.width;
        const y = bounds.top + (slot.y + (state.dy || 0)) / board.height * contentHeight;
        if (x >= left && x <= right && y >= top && y <= bottom) indices.push(index);
      });
      onSelection(indices, !!current.shift);
    });
    for (const name of ['pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(name, event => { if (drag?.id === event.pointerId) clear(); });
    }
    canvas.addEventListener('wheel', event => {
      if (!event.altKey || event.ctrlKey || event.metaKey || !canResize()) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.getBoundingClientRect().height : 1;
      const delta = event.deltaY * unit;
      if (!Number.isFinite(delta) || !delta) return;
      event.preventDefault();
      const steps = Math.max(1, Math.min(6, Math.round(Math.abs(delta) / 100)));
      onResize((delta < 0 ? 1 : -1) * 0.02 * steps);
    }, { passive: false });
  }

  function createSections(fields) {
    fields.forEach((field, index) => {
      const key = `heart-star-section-${field.id || field.querySelector('input[id],select[id],textarea[id]')?.id || index}`;
      let label = field.firstElementChild;
      if (!label?.classList.contains('label')) {
        label = document.createElement('div');
        label.className = 'label';
        label.textContent = field.id === 'copyField' ? '文案编辑' : '功能设置';
      }
      const head = document.createElement('div');
      head.className = 'feature-head';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'feature-toggle';
      head.append(label, button);
      field.prepend(head);
      let expanded = true;
      try { expanded = globalThis.localStorage.getItem(key) !== 'closed'; } catch { /* Storage may be disabled. */ }
      function apply(open) {
        expanded = open;
        field.classList.toggle('feature-collapsed', !open);
        button.textContent = open ? '收起' : '展开';
        button.setAttribute('aria-expanded', String(open));
        button.setAttribute('aria-label', `${open ? '收起' : '展开'}${label.textContent.trim()}`);
      }
      button.addEventListener('click', () => {
        apply(!expanded);
        try { globalThis.localStorage.setItem(key, expanded ? 'open' : 'closed'); } catch { /* Keep controls usable. */ }
      });
      apply(expanded);
    });
  }

  globalThis.HeartStarInteractions = { createSelection, resizeSelection, createSections };
})();
