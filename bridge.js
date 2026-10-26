// Runs in the extension's isolated world. Creates the hidden effects-engine
// iframe when the page script asks for it, and mirrors the on/off setting.
(() => {
  const root = document.documentElement;

  const applyEnabled = (v) => root && root.setAttribute('data-snapfx-enabled', v === false ? '0' : '1');
  const applyUnmirror = (v) => root && root.setAttribute('data-snapfx-unmirror', v === false ? '0' : '1');
  try {
    chrome.storage.local.get({ enabled: true, unmirror: true }, (s) => { applyEnabled(s.enabled); applyUnmirror(s.unmirror); });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.enabled) applyEnabled(ch.enabled.newValue);
      if (ch.unmirror) applyUnmirror(ch.unmirror.newValue);
    });
  } catch (e) { /* extension reloaded */ }

  document.addEventListener('snapfx:need-engine', () => {
    if (document.getElementById('snapfx-engine-frame')) return;
    const f = document.createElement('iframe');
    f.id = 'snapfx-engine-frame';
    f.src = chrome.runtime.getURL('engine.html');
    f.setAttribute('aria-hidden', 'true');
    f.tabIndex = -1;
    f.style.cssText =
      'position:fixed!important;width:2px!important;height:2px!important;left:-20px!important;top:-20px!important;' +
      'border:0!important;opacity:0!important;pointer-events:none!important;z-index:-1!important;';
    (document.body || document.documentElement).appendChild(f);
  });
})();
