document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('[data-medical-chat]');
  if (!form) return;
  const log = form.parentElement.querySelector('[data-medical-chat-log]');
  const message = form.querySelector('[data-medical-message]');
  const status = form.querySelector('[data-medical-status]');
  const sendButton = form.querySelector('[data-send-medical]');
  const cameraInput = form.querySelector('[data-camera-input]');
  const galleryInput = form.querySelector('[data-gallery-input]');
  const imageDataInput = form.querySelector('[data-medical-image-data]');
  const attachment = form.querySelector('[data-medical-attachment]');
  const preview = form.querySelector('[data-medical-preview]');
  const filename = form.querySelector('[data-medical-filename]');
  const cameraDialog = form.parentElement.querySelector('[data-camera-dialog]');
  const cameraVideo = cameraDialog.querySelector('[data-camera-video]');
  const cameraStatus = cameraDialog.querySelector('[data-camera-status]');
  const history = [];
  let selectedImage = null;
  let recorder = null;
  let recordingStream = null;
  let recordingTimer = null;
  let cameraStream = null;
  let previousPreviewUrl = '';
  const voiceButton = form.querySelector('[data-start-voice]');
  const voiceLanguage = form.querySelector('[data-voice-language]');
  let nativeRecognition = null;
  let nativeListening = false;
  let nativePrefix = '';
  let nativeFinalText = '';
  let nativeError = '';
  let nativeTimer = null;

  const resetVoiceButton = () => {
    voiceButton.disabled = false;
    voiceButton.textContent = '🎙 Speak';
    voiceButton.setAttribute('aria-pressed', 'false');
    voiceLanguage.disabled = false;
  };

  const startNativeSpeechRecognition = (SpeechRecognition) => {
    const recognition = new SpeechRecognition();
    nativeRecognition = recognition;
    nativeListening = true;
    nativePrefix = message.value.trim();
    nativeFinalText = '';
    nativeError = '';
    recognition.lang = voiceLanguage.value;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const finalParts = [];
      const interimParts = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = String(result?.[0]?.transcript || '').trim();
        if (!text) continue;
        if (result.isFinal) finalParts.push(text);
        else interimParts.push(text);
      }
      nativeFinalText = finalParts.join(' ').trim();
      const spokenText = [nativeFinalText, interimParts.join(' ').trim()].filter(Boolean).join(' ');
      message.value = [nativePrefix, spokenText].filter(Boolean).join(' ').slice(0, 4000);
      message.dispatchEvent(new Event('input', { bubbles: true }));
      status.textContent = interimParts.length ? 'Listening… live words appear in the question box. Press Stop when finished.' : 'Listening… speak clearly, then press Stop.';
    };
    recognition.onerror = (event) => { nativeError = String(event.error || ''); };
    recognition.onend = () => {
      if (nativeTimer) clearTimeout(nativeTimer);
      nativeTimer = null;
      nativeListening = false;
      nativeRecognition = null;
      resetVoiceButton();
      message.value = [nativePrefix, nativeFinalText].filter(Boolean).join(' ').slice(0, 4000);
      message.dispatchEvent(new Event('input', { bubbles: true }));
      if (nativeError === 'not-allowed' || nativeError === 'service-not-allowed') {
        status.textContent = 'Microphone or speech recognition permission was denied. Allow it in browser site settings, then try again.';
      } else if (nativeError === 'network') {
        status.textContent = 'Browser speech recognition could not reach its speech service. Check your internet and try again.';
      } else if (!nativeFinalText) {
        status.textContent = nativeError === 'no-speech' ? 'No speech was heard. Check the selected language and try again.' : 'No clear words were recognized. Try speaking closer to the microphone.';
      } else {
        status.textContent = 'Speech added to the question box. Check the words, correct anything needed, then press Send question.';
      }
      message.focus();
    };
    recognition.start();
    voiceLanguage.disabled = true;
    voiceButton.disabled = false;
    voiceButton.textContent = '■ Stop speaking';
    voiceButton.setAttribute('aria-pressed', 'true');
    status.textContent = 'Listening… speak clearly. Your words will appear in the question box.';
    nativeTimer = setTimeout(() => {
      if (!nativeListening || !nativeRecognition) return;
      voiceButton.disabled = true;
      voiceButton.textContent = 'Finishing…';
      status.textContent = 'Voice input reached the one-minute limit. Finishing transcription…';
      try { nativeRecognition.stop(); } catch { try { nativeRecognition.abort(); } catch {} }
    }, 60000);
  };

  const addMessage = (role, text, imageUrl = '') => {
    const bubble = document.createElement('div');
    bubble.className = `medical-chat-message ${role}`;
    bubble.textContent = text;
    if (imageUrl) {
      const image = document.createElement('img');
      image.src = imageUrl;
      image.alt = 'Image shared in this chat';
      image.className = 'medical-chat-inline-image';
      bubble.append(image);
    }
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  };

  const chooseImage = (file) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      status.textContent = 'Choose a JPG, PNG or WebP image up to 5 MB.';
      cameraInput.value = '';
      galleryInput.value = '';
      return;
    }
    if (previousPreviewUrl) URL.revokeObjectURL(previousPreviewUrl);
    selectedImage = file;
    previousPreviewUrl = URL.createObjectURL(file);
    preview.src = previousPreviewUrl;
    filename.textContent = file.name || 'Photo selected';
    attachment.hidden = false;
    imageDataInput.value = '';
    status.textContent = 'Image ready to attach. It will only be sent when you press Send.';
  };

  [cameraInput, galleryInput].forEach((input) => input.addEventListener('change', () => chooseImage(input.files?.[0])));
  const stopCamera = () => {
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    cameraVideo.srcObject = null;
  };
  form.querySelector('[data-take-photo]').addEventListener('click', async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      status.textContent = 'Live camera is unavailable here; opening your device photo picker instead.';
      cameraInput.click();
      return;
    }
    cameraDialog.showModal();
    cameraStatus.textContent = 'Waiting for camera permission…';
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      cameraVideo.srcObject = cameraStream;
      await cameraVideo.play();
      cameraStatus.textContent = 'Camera ready. Frame the photo and press Capture photo.';
    } catch (error) {
      stopCamera();
      cameraDialog.close();
      status.textContent = error.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access or choose a photo from your library.'
        : 'Camera could not open. Choose a photo from your library or try again.';
      cameraInput.click();
    }
  });
  const closeCamera = () => { stopCamera(); if (cameraDialog.open) cameraDialog.close(); };
  cameraDialog.querySelector('[data-close-camera]').addEventListener('click', closeCamera);
  cameraDialog.addEventListener('cancel', stopCamera);
  cameraDialog.querySelector('[data-capture-photo]').addEventListener('click', () => {
    if (!cameraVideo.videoWidth || !cameraVideo.videoHeight) {
      cameraStatus.textContent = 'Wait for the live camera preview, then try again.';
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = cameraVideo.videoWidth;
    canvas.height = cameraVideo.videoHeight;
    canvas.getContext('2d').drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) { cameraStatus.textContent = 'Photo capture failed. Please try again.'; return; }
      chooseImage(new File([blob], `health-photo-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      closeCamera();
      message.focus();
    }, 'image/jpeg', 0.9);
  });
  form.querySelector('[data-choose-photo]').addEventListener('click', () => galleryInput.click());
  form.querySelector('[data-remove-medical-image]').addEventListener('click', () => {
    selectedImage = null;
    imageDataInput.value = '';
    cameraInput.value = '';
    galleryInput.value = '';
    preview.removeAttribute('src');
    if (previousPreviewUrl) URL.revokeObjectURL(previousPreviewUrl);
    previousPreviewUrl = '';
    attachment.hidden = true;
    status.textContent = 'Photo removed.';
  });

  voiceButton.addEventListener('click', async () => {
    if (nativeListening && nativeRecognition) {
      voiceButton.disabled = true;
      voiceButton.textContent = 'Finishing…';
      status.textContent = 'Finishing speech recognition…';
      try { nativeRecognition.stop(); } catch { try { nativeRecognition.abort(); } catch {} }
      return;
    }
    if (recorder?.state === 'recording') {
      clearTimeout(recordingTimer);
      voiceButton.disabled = true;
      voiceButton.textContent = 'Transcribing…';
      recorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      status.textContent = 'Voice recording is not supported in this browser. Open the site in Chrome or Edge over localhost/HTTPS.';
      return;
    }
    if (!form.elements.aiConsent.checked) {
      status.textContent = 'Tick the AI data-sharing consent before using voice transcription.';
      form.elements.aiConsent.focus();
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      try {
        startNativeSpeechRecognition(SpeechRecognition);
      } catch (error) {
        nativeListening = false;
        nativeRecognition = null;
        resetVoiceButton();
        status.textContent = error.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow microphone access for this site, then try again.'
          : 'Speech recognition could not start. Check the voice language and microphone permission, then try again.';
      }
      return;
    }
    voiceButton.disabled = true;
    status.textContent = 'Requesting microphone access…';
    try {
      recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type));
      recorder = mimeType ? new MediaRecorder(recordingStream, { mimeType }) : new MediaRecorder(recordingStream);
      const audioRecorder = recorder;
      const chunks = [];
      audioRecorder.addEventListener('dataavailable', (event) => { if (event.data?.size) chunks.push(event.data); });
      audioRecorder.addEventListener('error', () => {
        recordingStream?.getTracks().forEach((track) => track.stop());
        recordingStream = null;
        recorder = null;
        voiceButton.disabled = false;
        voiceButton.textContent = '🎙 Speak';
        voiceButton.setAttribute('aria-pressed', 'false');
        status.textContent = 'The microphone recording failed. Check microphone access and try again.';
      }, { once: true });
      audioRecorder.addEventListener('stop', async () => {
        recordingStream?.getTracks().forEach((track) => track.stop());
        recordingStream = null;
        recorder = null;
        const audioBlob = new Blob(chunks, { type: audioRecorder.mimeType || 'audio/webm' });
        if (!audioBlob.size) {
          status.textContent = 'No audio was recorded. Check your microphone and try again.';
          voiceButton.disabled = false;
          voiceButton.textContent = '🎙 Speak';
          voiceButton.setAttribute('aria-pressed', 'false');
          return;
        }
        if (audioBlob.size > 5 * 1024 * 1024) {
          status.textContent = 'Recording is too large. Keep it under 5 MB and try again.';
          voiceButton.disabled = false;
          voiceButton.textContent = '🎙 Speak';
          voiceButton.setAttribute('aria-pressed', 'false');
          return;
        }
        status.textContent = 'Converting speech to text…';
        try {
          const audioData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Could not read the voice recording. Please record again.'));
            reader.readAsDataURL(audioBlob);
          });
          const params = new URLSearchParams();
          params.set('_csrf', form.elements._csrf.value);
          params.set('aiConsent', 'yes');
          params.set('language', form.querySelector('[data-voice-language]').value);
          params.set('audioData', audioData);
          const response = await fetch('/api/patient/medical-assistant/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
            body: params.toString(),
            credentials: 'same-origin',
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || 'Voice transcription failed. Please try again.');
          const transcript = String(result.transcript || '').trim();
          if (!transcript) throw new Error('No words were recognized. Speak clearly and try again.');
          const prefix = message.value.trim();
          message.value = `${prefix}${prefix ? ' ' : ''}${transcript}`.slice(0, 4000);
          message.focus();
          status.textContent = 'Your spoken words are in the question box. Review them, then press Send question.';
        } catch (error) {
          status.textContent = error.message || 'Voice transcription failed. Please try again.';
        } finally {
          voiceButton.disabled = false;
          voiceButton.textContent = '🎙 Speak';
          voiceButton.setAttribute('aria-pressed', 'false');
        }
      }, { once: true });
      audioRecorder.start();
      voiceButton.disabled = false;
      voiceButton.textContent = '■ Stop & add text';
      voiceButton.setAttribute('aria-pressed', 'true');
      status.textContent = 'Recording… speak clearly, then press Stop & add text.';
      recordingTimer = setTimeout(() => {
        if (audioRecorder.state === 'recording') {
          status.textContent = 'Recording stopped at the 60-second limit. Transcribing…';
          voiceButton.disabled = true;
          voiceButton.textContent = 'Transcribing…';
          audioRecorder.stop();
        }
      }, 60000);
    } catch (error) {
      recordingStream?.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      recorder = null;
      voiceButton.disabled = false;
      voiceButton.textContent = '🎙 Speak';
      voiceButton.setAttribute('aria-pressed', 'false');
      status.textContent = error.name === 'NotAllowedError'
        ? 'Microphone permission was denied. Allow microphone access for this site, then press Speak again.'
        : error.name === 'NotFoundError'
          ? 'No microphone was found. Connect or enable a microphone, then try again.'
          : 'Could not start voice recording. Check microphone permission and try again.';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = message.value.trim();
    if (!text && !selectedImage) {
      status.textContent = 'Type a question or attach a medical image first.';
      return;
    }
    if (!form.querySelector('[name="aiConsent"]').checked) {
      status.textContent = 'Please confirm the AI data-sharing notice before sending.';
      return;
    }
    sendButton.disabled = true;
    status.textContent = 'Preparing your message…';
    try {
      let imageData = '';
      let imagePreview = '';
      if (selectedImage) {
        imageData = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('The image could not be read. Choose it again.'));
          reader.readAsDataURL(selectedImage);
        });
        imagePreview = preview.src;
      }
      const params = new URLSearchParams();
      params.set('_csrf', form.elements._csrf.value);
      params.set('aiConsent', form.elements.aiConsent.checked ? 'yes' : 'no');
      params.set('message', text);
      params.set('imageData', imageData);
      params.set('history', JSON.stringify(history.slice(-8)));
      addMessage('user', text || 'Please help me understand this image.', imagePreview);
      message.value = '';
      status.textContent = 'Getting a response…';
      const responseBubble = addMessage('assistant', 'Thinking…');

      const response = await fetch('/api/patient/medical-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
        body: params.toString(),
        credentials: 'same-origin',
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'The assistant could not answer. Please try again.');
      const answer = typeof result.answer === 'string' ? result.answer.trim() : '';
      if (!answer) throw new Error('The AI service returned an empty answer. Please try again.');
      responseBubble.textContent = answer;
      log.scrollTop = log.scrollHeight;
      history.push({ role: 'user', content: text || 'Please help me understand this image.' });
      history.push({ role: 'assistant', content: answer });
      status.textContent = 'Response received.';
      selectedImage = null;
      imageDataInput.value = '';
      cameraInput.value = '';
      galleryInput.value = '';
      preview.removeAttribute('src');
      if (previousPreviewUrl) URL.revokeObjectURL(previousPreviewUrl);
      previousPreviewUrl = '';
      attachment.hidden = true;
    } catch (error) {
      const explanation = error.message || 'The assistant is unavailable right now.';
      const lastAssistantMessage = [...log.querySelectorAll('.medical-chat-message.assistant')].at(-1);
      if (lastAssistantMessage?.textContent === 'Thinking…') lastAssistantMessage.textContent = `I couldn't get a response: ${explanation}`;
      log.scrollTop = log.scrollHeight;
      status.textContent = explanation;
      if (text) message.value = text;
    } finally {
      sendButton.disabled = false;
      message.focus();
    }
  });
});
