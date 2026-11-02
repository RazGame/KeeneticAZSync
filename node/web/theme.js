/* The inline boot applies the saved theme before the first paint. */
(() => {
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['auto', 'light', 'dark'].includes(value);
  let preference = valid(root.dataset.themePreference) ? root.dataset.themePreference : 'auto';
  const pickers = [...document.querySelectorAll('[data-theme-picker]')];
  function apply() {
    root.dataset.themePreference = preference;
    root.dataset.theme = preference === 'auto' ? (media.matches ? 'dark' : 'light') : preference;
    for (const picker of pickers) {
      picker.querySelector('summary').title = 'Цветовая тема: ' + ({ auto: 'как на устройстве', light: 'светлая', dark: 'тёмная' })[preference];
      for (const button of picker.querySelectorAll('[data-theme-option]')) {
        button.setAttribute('aria-pressed', String(button.dataset.themeOption === preference));
      }
    }
  }
  for (const picker of pickers) {
    for (const button of picker.querySelectorAll('[data-theme-option]')) button.addEventListener('click', () => {
      const value = button.dataset.themeOption;
      if (!valid(value)) return;
      preference = value;
      try { localStorage.setItem('awg_sync_theme', value); } catch { /* Theme still works when storage is blocked. */ }
      apply(); picker.open = false; picker.querySelector('summary').focus();
    });
  }
  media.addEventListener('change', () => { if (preference === 'auto') apply(); });
  window.addEventListener('storage', event => {
    if ((event.key === 'awg_sync_theme' || event.key === null) && (!event.storageArea || event.storageArea === localStorage)) {
      preference = valid(event.newValue) ? event.newValue : 'auto'; apply();
    }
  });
  document.addEventListener('click', event => {
    for (const picker of pickers) if (picker.open && !picker.contains(event.target)) picker.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    for (const picker of pickers) if (picker.open) { picker.open = false; picker.querySelector('summary').focus(); }
  });
  apply();
})();
