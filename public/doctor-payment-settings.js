document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('[data-doctor-payment-form]');
  if (!form) return;
  const fileInput = form.querySelector('[data-doctor-qr-file]');
  const dataInput = form.querySelector('[data-doctor-qr-data]');
  const preview = form.querySelector('[data-doctor-qr-preview]');
  const upiInput = form.querySelector('[name="upiId"]');
  const verifyButton = form.querySelector('[data-verify-upi]');
  const verificationMessage = form.querySelector('[data-upi-verification]');
  verifyButton?.addEventListener('click', () => {
    const valid = /^[A-Za-z0-9._-]{2,80}@[A-Za-z0-9.-]{2,40}$/.test(upiInput.value.trim());
    verificationMessage.textContent = valid
      ? 'UPI ID format looks valid. Account ownership has not been verified.'
      : 'UPI ID format is invalid. Enter an ID like doctor@bank.';
    verificationMessage.dataset.valid = String(valid);
  });
  let readingFile = false;
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    dataInput.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      fileInput.value = '';
      window.alert('Choose a JPG, PNG or WebP QR image up to 5 MB.');
      return;
    }
    const reader = new FileReader();
    readingFile = true;
    reader.onload = () => {
      dataInput.value = String(reader.result || '');
      preview.src = dataInput.value;
      preview.hidden = false;
      readingFile = false;
    };
    reader.onerror = () => { readingFile = false; window.alert('The QR image could not be read. Please choose it again.'); };
    reader.readAsDataURL(file);
  });
  form.addEventListener('submit', (event) => {
    if (readingFile) {
      event.preventDefault();
      window.alert('Please wait for the QR image preview to finish loading.');
      return;
    }
    if (!preview.src || preview.hidden) {
      event.preventDefault();
      window.alert('Upload and preview a UPI QR image before saving.');
    }
  });
});
