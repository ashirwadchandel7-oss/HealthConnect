(() => {
  const root = document.querySelector('[data-consultation]');
  if (!root || root.dataset.status !== 'REQUESTED') return;

  const refresh = async () => {
    try {
      const response = await fetch(`/consultations/${root.dataset.consultation}/state`, { credentials: 'same-origin' });
      if (!response.ok) return;
      const state = await response.json();
      if (state.status !== root.dataset.status) window.location.reload();
    } catch {
      // Keep the request page usable during a brief network interruption.
    }
  };

  window.setInterval(refresh, 5000);
})();
