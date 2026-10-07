document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-appointment-booking]').forEach((form) => {
    const details = form.querySelector('[data-upi-booking-details]');
    const update = () => {
      if (details) details.hidden = form.querySelector('input[name="paymentMethod"]:checked')?.value !== 'UPI';
    };
    form.querySelectorAll('input[name="paymentMethod"]').forEach((input) => input.addEventListener('change', update));
    update();
  });
});
