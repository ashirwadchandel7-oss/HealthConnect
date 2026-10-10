const crypto = require('node:crypto');

const conditions = {
  parkinson: { endpoint: 'parkinson', title: "Parkinson's" },
  brain_tumor: { endpoint: 'brain_tumor', title: 'Brain tumor' },
  alzheimer: { endpoint: 'alzheimer', title: "Alzheimer's" },
};

function decodeImage(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
  const valid = match[1] === 'jpeg'
    ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    : match[1] === 'png'
      ? buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  return valid ? { buffer, mimeType: `image/${match[1]}` } : null;
}

module.exports = function registerPatientEarlyDetection({ app, pool, requireRole, authLimit }) {
  app.post('/api/patient/early-detection', requireRole('patient'), authLimit, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.body.aiConsent !== 'yes') return res.status(400).json({ error: 'Consent is required before sending a scan to the configured model service.' });
    const conditionKey = String(req.body.condition || '');
    if (!Object.hasOwn(conditions, conditionKey)) return res.status(400).json({ error: 'Choose Parkinson’s, brain tumor, or Alzheimer’s analysis.' });
    const condition = conditions[conditionKey];
    const image = decodeImage(String(req.body.imageData || ''));
    if (!image) return res.status(400).json({ error: 'Upload a valid JPG, PNG, or WebP scan under 5 MB.' });

    let baseUrl;
    try {
      const configured = new URL(String(process.env.MODEL_API_BASE_URL || '').trim());
      if (configured.protocol !== 'https:' && !(configured.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(configured.hostname))) {
        return res.status(503).json({ error: 'Set MODEL_API_BASE_URL to your private model service URL using HTTPS.' });
      }
      baseUrl = configured.toString().replace(/\/+$/, '');
    } catch {
      return res.status(503).json({ error: 'Early detection is not connected. Configure MODEL_API_BASE_URL for your deployed Python model service.' });
    }

    try {
      const upload = new FormData();
      upload.append('image', new Blob([image.buffer], { type: image.mimeType }), 'scan');
      const response = await fetch(`${baseUrl}/predict/${condition.endpoint}`, {
        method: 'POST',
        body: upload,
        signal: AbortSignal.timeout(45000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error('Model service returned HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }
      const label = String(payload.class || '').trim().slice(0, 160);
      const confidence = Number(payload.confidence);
      if (!label || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return res.status(502).json({ error: 'The model service returned an invalid prediction. No result was saved.' });
      }
      const [saved] = await pool.execute(
        'INSERT INTO early_detection_predictions (patient_id,condition_key,predicted_class,confidence) VALUES (?,?,?,?)',
        [req.session.user.id, conditionKey, label, confidence.toFixed(6)]
      );
      return res.json({ prediction: { id: saved.insertId, condition: conditionKey, title: condition.title, label, confidence, createdAt: new Date().toISOString() } });
    } catch (error) {
      const requestId = crypto.randomBytes(4).toString('hex');
      console.error(`Early detection request ${requestId} failed:`, error.status || error.name);
      const message = error.name === 'TimeoutError' || error.name === 'AbortError'
        ? 'Scan analysis took too long. Try again later.'
        : error.status === 404
          ? 'This condition model is not available in the deployed model service.'
          : error.status
            ? 'The model service could not analyze this scan (HTTP ' + error.status + '). No result was saved.'
            : 'Could not reach the model service. Check its deployment and try again.';
      return res.status(502).json({ error: message });
    }
  });
};
