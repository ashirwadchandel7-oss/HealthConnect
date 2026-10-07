const crypto = require('node:crypto');

function decodeMedicalImage(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
  const valid = match[1] === 'jpeg'
    ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    : match[1] === 'png'
      ? buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))
      : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  return valid ? { mediaType: `image/${match[1]}`, dataUrl, buffer } : null;
}

function decodeMedicalAudio(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const match = dataUrl.match(/^data:(audio\/(?:webm|ogg|wav|mp4|mpeg|mp3|aac|opus))(?:;codecs=[a-z0-9.+_-]+)?;base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
  const valid = mimeType === 'audio/webm'
    ? buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : mimeType === 'audio/ogg'
      ? buffer.subarray(0, 4).toString() === 'OggS'
      : mimeType === 'audio/wav'
        ? buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE'
        : mimeType === 'audio/mp4'
          ? buffer.subarray(4, 8).toString() === 'ftyp'
          : mimeType === 'audio/mpeg' || mimeType === 'audio/mp3'
            ? buffer.subarray(0, 3).toString() === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
            : true;
  return valid ? { mimeType, data: buffer.toString('base64') } : null;
}

module.exports = function registerPatientMedicalAssistant({ app, requireRole, authLimit }) {
  app.post('/api/patient/medical-assistant/transcribe', requireRole('patient'), authLimit, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.body.aiConsent !== 'yes') return res.status(400).json({ error: 'Confirm the AI data-sharing notice before transcribing voice.' });
    const audio = decodeMedicalAudio(String(req.body.audioData || ''));
    if (!audio) return res.status(400).json({ error: 'Voice recording is missing, invalid, or larger than 5 MB. Record a shorter message and try again.' });
    const baseUrl = String(process.env.MEDICAL_AI_BASE_URL || '').trim();
    const apiKey = String(process.env.MEDICAL_AI_API_KEY || '').trim();
    const model = String(process.env.MEDICAL_AI_MODEL || '').trim();
    let endpoint;
    try {
      const configuredUrl = new URL(baseUrl);
      if (configuredUrl.hostname !== 'generativelanguage.googleapis.com' || !apiKey || !model) {
        return res.status(503).json({ error: 'Voice transcription requires the Google Gemini API settings in the server .env file.' });
      }
      endpoint = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`);
    } catch {
      return res.status(503).json({ error: 'Gemini API URL is invalid. Check MEDICAL_AI_BASE_URL in .env.' });
    }
    const language = ['hi-IN', 'en-IN'].includes(String(req.body.language || '')) ? String(req.body.language) : 'hi-IN';
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'This is a speech-recognition task only. Transcribe only the words that are clearly audible, as spoken, in the original order. Never answer, summarize, translate, correct, expand, or infer words from medical context. Preserve Hindi-English code switching. Write Hindi words in Devanagari and English words in Latin script. If a word is unclear, omit it instead of guessing. Return only the transcript.' }] },
          contents: [{ role: 'user', parts: [
            { text: `Transcribe this recording into the question text. Preferred language: ${language}. Return only the words spoken.` },
            { inlineData: { mimeType: audio.mimeType, data: audio.data } },
          ] }],
          generationConfig: { temperature: 0, topP: 0.1, maxOutputTokens: 500, responseMimeType: 'text/plain', thinkingConfig: { thinkingLevel: 'low' } },
        }),
        signal: AbortSignal.timeout(45000),
      });
      const rawResponse = await response.text();
      let data = {};
      try { data = rawResponse ? JSON.parse(rawResponse) : {}; } catch {}
      if (!response.ok) {
        const providerMessage = String(data?.error?.message || '').replace(/https?:\/\/\S+/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
        const error = response.status === 503
          ? 'Google voice transcription is temporarily busy. Wait a moment and try again.'
          : response.status === 429
            ? 'Google AI Studio quota or rate limit reached. Check your AI Studio quota.'
            : `Voice transcription failed (HTTP ${response.status}). ${providerMessage}`.trim();
        return res.status(502).json({ error });
      }
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const transcript = parts.filter((part) => part?.thought !== true && typeof part?.text === 'string').map((part) => part.text).join('\n').trim();
      if (!transcript) return res.status(502).json({ error: 'No words were recognized. Speak clearly, then record again.' });
      return res.json({ transcript: transcript.slice(0, 4000) });
    } catch (error) {
      const requestId = crypto.randomBytes(4).toString('hex');
      console.error(`Medical voice transcription ${requestId} failed:`, error.name);
      const message = error.name === 'TimeoutError' || error.name === 'AbortError'
        ? 'Voice transcription took too long. Record a shorter message and try again.'
        : 'Could not reach Google voice transcription. Check your internet connection and try again.';
      return res.status(502).json({ error: message });
    }
  });

  app.post('/api/patient/medical-assistant', requireRole('patient'), authLimit, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const message = String(req.body.message || '').trim().slice(0, 4000);
    const imageData = String(req.body.imageData || '');
    if (!message && !imageData) return res.status(400).json({ error: 'Type a question or attach a medical image.' });
    if (req.body.aiConsent !== 'yes') return res.status(400).json({ error: 'Confirm the AI data-sharing notice before sending.' });
    const image = imageData ? decodeMedicalImage(imageData) : null;
    if (imageData && !image) return res.status(400).json({ error: 'Image must be a valid JPG, PNG or WebP file under 5 MB.' });

    const baseUrl = String(process.env.MEDICAL_AI_BASE_URL || '').trim().replace(/\/+$/, '');
    const apiKey = String(process.env.MEDICAL_AI_API_KEY || '').trim();
    const model = String(process.env.MEDICAL_AI_MODEL || '').trim();
    if (!baseUrl || !apiKey || !model || [baseUrl, apiKey, model].some((value) => /(your[-_ ]|placeholder|replace[-_ ]|example|changeme)/i.test(value))) {
      return res.status(503).json({ error: 'The medical assistant is not connected yet. Add MEDICAL_AI_BASE_URL, MEDICAL_AI_API_KEY, and MEDICAL_AI_MODEL to the server .env file.' });
    }

    let endpoint;
    let isGemini = false;
    try {
      const configuredUrl = new URL(baseUrl);
      if (configuredUrl.protocol !== 'https:' && !(configuredUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(configuredUrl.hostname))) {
        return res.status(503).json({ error: 'The AI service URL must use HTTPS (HTTP is allowed only for localhost testing).' });
      }
      isGemini = configuredUrl.hostname === 'generativelanguage.googleapis.com';
      endpoint = isGemini
        ? new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`)
        : new URL(baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`);
    } catch {
      return res.status(503).json({ error: 'MEDICAL_AI_BASE_URL is not a valid service URL.' });
    }

    let history = [];
    try {
      const parsed = JSON.parse(String(req.body.history || '[]'));
      if (Array.isArray(parsed)) history = parsed.slice(-8).flatMap((item) => {
        const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : null;
        const content = typeof item?.content === 'string' ? item.content.trim().slice(0, 2000) : '';
        return role && content ? [{ role, content }] : [];
      });
    } catch {}

    const userContent = image
      ? [{ type: 'text', text: message || 'Please describe this image in a health-information context. Do not diagnose.' }, { type: 'image_url', image_url: { url: image.dataUrl } }]
      : message;
    const systemPrompt = 'You are a careful patient health-information assistant. Reply in the same language as the latest user message (Hindi, Hinglish, or English) and use clear, simple wording. Answer the actual question directly, then give short practical next steps. Do not diagnose, claim certainty from a photo, prescribe or change medication, interpret an image as a definitive test, or replace a clinician. Ask concise follow-up questions only when needed. Mention urgent in-person care for severe or rapidly worsening symptoms. Do not claim to have reviewed records unless the user provided them in this chat. Keep answers calm and concise.';
    const conversation = [...history, { role: 'user', content: userContent }];
    const toGeminiParts = (content) => {
      if (typeof content === 'string') return [{ text: content }];
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) => {
        if (part?.type === 'text' && typeof part.text === 'string') return [{ text: part.text }];
        const url = part?.image_url?.url;
        const match = typeof url === 'string' ? url.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/) : null;
        return match ? [{ inlineData: { mimeType: match[1], data: match[2] } }] : [];
      });
    };
    const payload = isGemini
      ? {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: conversation.map((item) => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: toGeminiParts(item.content) })).filter((item) => item.parts.length),
          generationConfig: { temperature: 0.2, maxOutputTokens: 1200, thinkingConfig: { thinkingLevel: 'low' } },
        }
      : {
          model,
          max_tokens: 900,
          messages: [
            { role: 'system', content: systemPrompt },
            ...conversation,
          ],
        };
    try {
      let response;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: isGemini
            ? { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }
            : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(45000),
        });
        if (response.status !== 503 || attempt === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      const rawResponse = await response.text();
      let data = {};
      try { data = rawResponse ? JSON.parse(rawResponse) : {}; } catch {}
      if (!response.ok) {
        const providerMessage = String(data?.error?.message || data?.message || '').replace(/https?:\/\/\S+/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 220);
        const requestId = crypto.randomBytes(4).toString('hex');
        console.error(`Medical assistant request ${requestId} returned HTTP ${response.status}:`, providerMessage || 'No provider detail');
        const error = response.status === 401 || response.status === 403
          ? 'Google rejected the API key. Check MEDICAL_AI_API_KEY in .env.'
          : response.status === 404
            ? 'Google could not find this Gemini model or endpoint. Check MEDICAL_AI_BASE_URL and MEDICAL_AI_MODEL.'
            : response.status === 429
              ? 'Google AI Studio rate limit or quota reached. Check your AI Studio project quota and try again.'
              : response.status === 503
                ? 'Google AI is temporarily busy. Wait a minute and send your question again.'
              : `Gemini request failed (HTTP ${response.status}).${providerMessage ? ` ${providerMessage}` : ''}`;
        return res.status(502).json({ error });
      }
      const content = data?.candidates?.[0]?.content?.parts ?? data?.choices?.[0]?.message?.content;
      const answer = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((part) => part?.thought !== true && (part?.type === 'text' || typeof part?.text === 'string')).map((part) => part.text || '').join('\n')
          : '';
      if (!answer.trim()) return res.status(502).json({ error: 'The AI service returned an empty answer. Please try again.' });
      return res.json({ answer: answer.trim().slice(0, 6000) });
    } catch (error) {
      const requestId = crypto.randomBytes(4).toString('hex');
      console.error(`Medical assistant request ${requestId} failed:`, error.name);
      const userMessage = error.name === 'TimeoutError' || error.name === 'AbortError'
        ? 'The AI reply took too long. Try a shorter question and send it again.'
        : error.name === 'TypeError'
          ? 'The server could not reach Google AI. Check the internet connection and try again.'
          : 'The AI service is temporarily unavailable. Please try again shortly.';
      return res.status(502).json({ error: userMessage });
    }
  });
};

module.exports.decodeMedicalImage = decodeMedicalImage;
module.exports.decodeMedicalAudio = decodeMedicalAudio;
