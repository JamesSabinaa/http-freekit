(function initializeDesktopCloseBehaviorModule() {
  'use strict';

  const VALID_BEHAVIORS = new Set(['hide', 'quit']);
  let currentBehavior = 'hide';
  let saveGeneration = 0;

  function getControls() {
    return {
      card: document.getElementById('desktopWindowBehaviorCard'),
      select: document.getElementById('closeWindowBehaviorSelect'),
      status: document.getElementById('closeWindowBehaviorStatus')
    };
  }

  function setStatus(element, message, isError = false) {
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('is-error', isError);
  }

  function hasDesktopBridge() {
    return typeof window.electronApi?.getCloseWindowBehavior === 'function' &&
      typeof window.electronApi?.setCloseWindowBehavior === 'function';
  }

  async function loadCloseWindowBehavior() {
    if (!hasDesktopBridge()) return;
    const { card, select, status } = getControls();
    if (card) card.hidden = false;
    if (!select) return;

    select.disabled = true;
    setStatus(status, 'Loading…');
    try {
      const behavior = await window.electronApi.getCloseWindowBehavior();
      if (!VALID_BEHAVIORS.has(behavior)) {
        throw new Error('The desktop app returned an invalid close-window setting');
      }
      currentBehavior = behavior;
      select.value = behavior;
      select.disabled = false;
      setStatus(status, '');
    } catch (error) {
      setStatus(status, `Could not load this setting: ${error.message}`, true);
    }
  }

  async function saveCloseWindowBehavior(behavior) {
    const { select, status } = getControls();
    if (!VALID_BEHAVIORS.has(behavior) || !hasDesktopBridge()) {
      if (select) select.value = currentBehavior;
      return;
    }

    const previousBehavior = currentBehavior;
    const generation = ++saveGeneration;
    if (select) select.disabled = true;
    setStatus(status, 'Saving…');
    try {
      const savedBehavior = await window.electronApi.setCloseWindowBehavior(behavior);
      if (!VALID_BEHAVIORS.has(savedBehavior)) {
        throw new Error('The desktop app did not confirm the close-window setting');
      }
      if (generation !== saveGeneration) return;
      currentBehavior = savedBehavior;
      if (select) select.value = savedBehavior;
      setStatus(status, 'Saved');
    } catch (error) {
      if (generation !== saveGeneration) return;
      currentBehavior = previousBehavior;
      if (select) select.value = previousBehavior;
      setStatus(status, `Could not save this setting: ${error.message}`, true);
    } finally {
      if (generation === saveGeneration && select) select.disabled = false;
    }
  }

  window.saveCloseWindowBehavior = saveCloseWindowBehavior;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadCloseWindowBehavior, { once: true });
  } else {
    void loadCloseWindowBehavior();
  }
})();
