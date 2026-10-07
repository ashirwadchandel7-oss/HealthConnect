(() => {
  document.querySelectorAll('[data-editable-settings]').forEach((form) => {
    const fields = form.querySelector('[data-editable-fields]');
    const editButton = form.querySelector('[data-edit-settings]');
    const saveButton = form.querySelector('[data-save-settings]');
    if (!fields || !editButton || !saveButton) return;

    editButton.addEventListener('click', () => {
      fields.disabled = false;
      editButton.hidden = true;
      saveButton.hidden = false;
      fields.querySelector('input')?.focus();
    });
  });
})();
