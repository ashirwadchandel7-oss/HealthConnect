(() => {
  const setup = () => {
    const form = document.querySelector('[data-early-detection]');
    if (!form) return;
    const fileInput = form.querySelector('[data-early-file]');
    const imageDataInput = form.querySelector('[data-early-image-data]');
    const preview = form.querySelector('[data-early-preview]');
    const status = form.querySelector('[data-early-status]');
    const submit = form.querySelector('[data-early-submit]');

    fileInput.addEventListener('change', () => {
      imageDataInput.value = '';
      preview.hidden = true;
      preview.removeAttribute('src');
      const file = fileInput.files?.[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
        fileInput.value = '';
        status.textContent = 'Choose a JPG, PNG, or WebP image under 5 MB.';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        imageDataInput.value = String(reader.result || '');
        preview.src = imageDataInput.value;
        preview.hidden = false;
        status.textContent = 'Scan ready. Your image is sent only after you submit with consent.';
      };
      reader.onerror = () => { status.textContent = 'Could not read this scan. Choose it again.'; };
      reader.readAsDataURL(file);
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (form.dataset.configured !== 'true') {
        status.textContent = 'The model service is not configured yet.';
        return;
      }
      if (!imageDataInput.value) {
        status.textContent = 'Choose a valid scan image first.';
        return;
      }
      submit.disabled = true;
      status.textContent = 'Sending scan for model analysis…';
      try {
        const body = new URLSearchParams();
        body.set('_csrf', form.elements._csrf.value);
        body.set('aiConsent', form.elements.aiConsent.checked ? 'yes' : 'no');
        body.set('condition', form.elements.condition.value);
        body.set('imageData', imageDataInput.value);
        const response = await fetch('/api/patient/early-detection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
          body: body.toString(),
          credentials: 'same-origin',
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Could not analyze this scan.');
        const label = result.prediction?.label;
        const confidence = Number(result.prediction?.confidence);
        if (!label || !Number.isFinite(confidence)) throw new Error('The model returned an invalid result.');
        status.textContent = `Screening result saved to your profile: ${label} (${(confidence * 100).toFixed(1)}% model confidence). This is not a diagnosis.`;
        form.reset();
        imageDataInput.value = '';
        preview.hidden = true;
        preview.removeAttribute('src');
        window.setTimeout(() => window.location.reload(), 900);
      } catch (error) {
        status.textContent = error.message || 'The model service is unavailable. Try again later.';
      } finally {
        submit.disabled = false;
      }
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
})();
