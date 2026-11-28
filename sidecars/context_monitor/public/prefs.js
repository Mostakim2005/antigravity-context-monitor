(() => {
  const MAX_SAVE_RETRIES = 4;
  let pendingPatch = null;
  let saving = false;
  let retryCount = 0;
  let retryTimer = null;

  function getApiFetch() {
    if (typeof globalThis.__cmOrigSidecarFetch === 'function') {
      return globalThis.__cmOrigSidecarFetch;
    }
    if (typeof globalThis.sidecar?.fetch === 'function') {
      return globalThis.sidecar.fetch.bind(globalThis.sidecar);
    }
    if (typeof globalThis.__cmOrigFetch === 'function') {
      return globalThis.__cmOrigFetch;
    }
    if (typeof globalThis.fetch === 'function') {
      return globalThis.fetch.bind(globalThis);
    }
    return null;
  }

  function hasServerBootstrap() {
    return Boolean(globalThis.__CM_UI_PREFS__ && typeof globalThis.__CM_UI_PREFS__ === 'object');
  }

  function getServerPrefs() {
    return hasServerBootstrap() ? globalThis.__CM_UI_PREFS__ : null;
  }

  function mergePatch(base, patch) {
    const out = { ...(base || {}) };
    if (patch?.sections && typeof patch.sections === 'object') {
      out.sections = { ...(out.sections || {}), ...patch.sections };
    }
    if (patch?.scope && typeof patch.scope === 'object') {
      out.scope = { ...(out.scope || {}), ...patch.scope };
    }
    if (patch?.switcher && typeof patch.switcher === 'object') {
      out.switcher = { ...(out.switcher || {}), ...patch.switcher };
    }
    if (typeof patch?.lang === 'string') out.lang = patch.lang;
    if (typeof patch?.activeTab === 'string') out.activeTab = patch.activeTab;
    return out;
  }

  async function flushServerSave() {
    if (saving || !pendingPatch) return;
    const f = getApiFetch();
    if (!f) return;

    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    saving = true;
    try {
      while (pendingPatch) {
        const batch = pendingPatch;
        pendingPatch = null;
        try {
          const res = await f('/api/ui-prefs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batch),
          });
          if (!res.ok) throw new Error(`/api/ui-prefs: ${res.status}`);
          const data = await res.json().catch(() => null);
          if (data?.prefs && typeof data.prefs === 'object') {
            globalThis.__CM_UI_PREFS__ = data.prefs;
          }
          retryCount = 0;
        } catch {
          pendingPatch = pendingPatch ? mergePatch(batch, pendingPatch) : batch;
          if (retryCount < MAX_SAVE_RETRIES) {
            const delayMs = 800 * (retryCount + 1);
            retryCount += 1;
            retryTimer = setTimeout(() => {
              retryTimer = null;
              flushServerSave();
            }, delayMs);
          }
          break;
        }
      }
    } finally {
      saving = false;
    }
  }

  function saveServerPatch(patch) {
    if (!patch || typeof patch !== 'object') return Promise.resolve();
    retryCount = 0;
    if (hasServerBootstrap()) {
      globalThis.__CM_UI_PREFS__ = mergePatch(globalThis.__CM_UI_PREFS__, patch);
    }
    pendingPatch = mergePatch(pendingPatch, patch);
    return flushServerSave();
  }

  async function fetchServerPrefs() {
    const f = getApiFetch();
    if (!f) return null;
    try {
      const res = await f('/api/ui-prefs', { method: 'GET' });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.prefs && typeof data.prefs === 'object') {
        globalThis.__CM_UI_PREFS__ = data.prefs;
        return data.prefs;
      }
    } catch {
      // ignore network error
    }
    return null;
  }

  function readLocal(key) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  function writeLocal(key, value) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // ignore storage failure
    }
  }

  globalThis.CM_PREFS = {
    hasServerBootstrap,
    getServerPrefs,
    saveServerPatch,
    fetchServerPrefs,
    readLocal,
    writeLocal,
  };
})();
