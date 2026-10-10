(() => {
  function setup() {
    document.querySelectorAll('[data-editable-settings]').forEach((form) => {
      const fields = form.querySelector('[data-editable-fields]');
      const editButton = form.querySelector('[data-edit-settings]');
      const saveButton = form.querySelector('[data-save-settings]');
      if (!fields || !editButton || !saveButton) return;
      editButton.addEventListener('click', (event) => {
        event.preventDefault();
        fields.disabled = false;
        editButton.hidden = true;
        saveButton.hidden = false;
        fields.querySelector('input:not([type="hidden"])')?.focus();
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
})();
