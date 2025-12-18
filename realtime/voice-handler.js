/**
 * OpenAI Realtime Voice Handler
 *
 * Handles WebRTC-based voice conversations using OpenAI's Realtime API.
 * This is a client-side handler that connects browsers to the OpenAI Realtime API.
 */

/**
 * Voice Handler Class
 *
 * Manages WebRTC connection and voice conversation state
 */
class EmilyVoiceHandler {
  constructor(config) {
    this.schoolId = config.schoolId;
    this.apiBaseUrl = config.apiBaseUrl || '';
    this.familyId = config.familyId;
    this.familyContext = config.familyContext || {};
    this.language = config.language || 'en';
    this.voice = config.voice || 'coral'; // Female voice

    // State
    this.pc = null;           // RTCPeerConnection
    this.dc = null;           // DataChannel
    this.micStream = null;    // MediaStream
    this.started = false;
    this.isPaused = false;
    this.sessionId = null;
    this.hasGreeted = false;

    // Callbacks
    this.onStatusChange = config.onStatusChange || (() => {});
    this.onTranscript = config.onTranscript || (() => {});
    this.onResponse = config.onResponse || (() => {});
    this.onError = config.onError || (() => {});
    this.onFunctionCall = config.onFunctionCall || (() => {});

    // Fallback timer
    this.fallbackTimer = null;
    this.FALLBACK_TIMEOUT_MS = 5000;

    // Language to voice mapping
    this.voiceByLang = {
      en: 'coral',   // Female voice
      fr: 'alloy',
      es: 'verse',
      de: 'luna',
      zh: 'alloy',
      it: 'verse'
    };
  }

  /**
   * Start voice session
   */
  async start() {
    if (this.started) {
      console.log('Voice session already started');
      return;
    }

    this.onStatusChange('connecting');

    try {
      // Create realtime session via our API
      const sessionRes = await fetch(`${this.apiBaseUrl}/api/${this.schoolId}/realtime/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-realtime-preview',
          voice: this.voiceByLang[this.language] || this.voice,
          language: this.language,
          family_id: this.familyId,
          ...this.familyContext
        })
      });

      if (!sessionRes.ok) {
        throw new Error('Failed to create realtime session: ' + await sessionRes.text());
      }

      const session = await sessionRes.json();
      this.sessionId = session.session_id;

      // Extract ephemeral token
      const token = session.token ||
                   (session.session?.client_secret?.value || session.session?.client_secret) ||
                   (session.client_secret?.value || session.client_secret) ||
                   session.value;

      if (!token) {
        throw new Error('No ephemeral token returned from session');
      }

      // Set up WebRTC
      this.pc = new RTCPeerConnection();

      // Handle incoming audio
      this.pc.ontrack = (e) => {
        const audio = document.getElementById('emily-audio') || this.createAudioElement();
        audio.srcObject = e.streams[0];
        audio.play().catch(err => console.warn('Audio play error:', err));
        this.cancelFallbackTimer();
      };

      // Set up data channel for events
      this.dc = this.pc.createDataChannel('oai-events');
      this.dc.onopen = () => this.handleDataChannelOpen();
      this.dc.onmessage = (evt) => this.handleDataChannelMessage(evt);

      // Get microphone access
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      // Add mic to peer connection
      this.micStream.getTracks().forEach(track => {
        this.pc.addTrack(track, this.micStream);
      });

      // Create offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // Send SDP to OpenAI Realtime API
      const sdpRes = await fetch('https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/sdp'
        },
        body: offer.sdp
      });

      if (!sdpRes.ok) {
        throw new Error('Realtime SDP error: ' + await sdpRes.text());
      }

      // Set remote description
      const answer = {
        type: 'answer',
        sdp: await sdpRes.text()
      };
      await this.pc.setRemoteDescription(answer);

      this.started = true;
      this.onStatusChange('connected');

    } catch (err) {
      console.error('Voice start error:', err);
      this.onError(err);
      this.onStatusChange('error');
      this.stop();
    }
  }

  /**
   * Handle data channel open - send greeting
   */
  handleDataChannelOpen() {
    if (!this.hasGreeted) {
      // Request initial greeting
      this.sendEvent({
        type: 'response.create',
        response: {
          instructions: `Greet the user warmly. ${this.familyContext.parent_name ? `Address them as ${this.familyContext.parent_name}.` : ''} Let them know you can help with questions about the school and offer audio tours of the prospectus.`
        }
      });
      this.hasGreeted = true;
      this.resetFallbackTimer();
    }
    this.onStatusChange('ready');
  }

  /**
   * Handle incoming data channel messages
   */
  handleDataChannelMessage(evt) {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }

    // Handle function calls
    if (msg.type === 'response.function_call_arguments.done') {
      this.handleFunctionCall(msg);
      return;
    }

    // Handle transcript
    if (msg.type === 'conversation.item.input_audio_transcription.completed') {
      this.onTranscript({ role: 'user', text: msg.transcript });
    }

    // Handle response text
    if (msg.type === 'response.audio_transcript.done') {
      this.onTranscript({ role: 'assistant', text: msg.transcript });
    }

    // Handle status changes
    switch (msg.type) {
      case 'input_audio_buffer.speech_started':
        this.onStatusChange('listening');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.onStatusChange('thinking');
        this.resetFallbackTimer();
        break;
      case 'response.audio.started':
        this.onStatusChange('speaking');
        this.cancelFallbackTimer();
        break;
      case 'response.audio.done':
        this.onStatusChange('ready');
        this.cancelFallbackTimer();
        break;
    }
  }

  /**
   * Handle function calls from the AI
   */
  async handleFunctionCall(msg) {
    const functionName = msg.name;
    const callId = msg.call_id;
    let args = {};

    try {
      args = JSON.parse(msg.arguments || '{}');
    } catch (e) {
      console.error('Failed to parse function arguments:', e);
    }

    console.log(`Function call: ${functionName}`, args);

    // Handle get_prospectus_section
    if (functionName === 'get_prospectus_section') {
      this.onStatusChange('loading');

      try {
        const response = await fetch(
          `${this.apiBaseUrl}/api/${this.schoolId}/audio-tour/section/${args.section}`
        );
        const data = await response.json();

        // Send result back to AI
        this.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(data)
          }
        });
        this.sendEvent({ type: 'response.create' });

        this.onFunctionCall({ name: functionName, args, result: data });

      } catch (err) {
        console.error('Function call error:', err);
        this.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({ error: 'Failed to retrieve section' })
          }
        });
        this.sendEvent({ type: 'response.create' });
      }
      return;
    }

    // Handle kb_search
    if (functionName === 'kb_search') {
      this.onStatusChange('searching');

      try {
        const response = await fetch(`${this.apiBaseUrl}/api/${this.schoolId}/realtime/tool/kb_search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: args.query, session_id: this.sessionId })
        });
        const data = await response.json();

        this.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(data)
          }
        });
        this.sendEvent({ type: 'response.create' });

        this.onFunctionCall({ name: functionName, args, result: data });

      } catch (err) {
        console.error('KB search error:', err);
        this.sendEvent({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({ error: 'Search failed' })
          }
        });
        this.sendEvent({ type: 'response.create' });
      }
    }
  }

  /**
   * Send event to data channel
   */
  sendEvent(event) {
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify(event));
    }
  }

  /**
   * Pause/unpause the conversation
   */
  togglePause() {
    this.isPaused = !this.isPaused;

    if (this.micStream) {
      const track = this.micStream.getAudioTracks()[0];
      if (track) {
        track.enabled = !this.isPaused;
      }
    }

    const audio = document.getElementById('emily-audio');
    if (audio) {
      audio.muted = this.isPaused;
    }

    this.onStatusChange(this.isPaused ? 'paused' : 'ready');
    return this.isPaused;
  }

  /**
   * Stop voice session
   */
  stop() {
    this.cancelFallbackTimer();

    try {
      this.micStream?.getTracks().forEach(t => t.stop());
    } catch {}

    try {
      this.pc?.close();
    } catch {}

    this.micStream = null;
    this.pc = null;
    this.dc = null;
    this.started = false;
    this.isPaused = false;

    this.onStatusChange('disconnected');
  }

  /**
   * Fallback timer management
   */
  resetFallbackTimer() {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = setTimeout(() => {
      console.warn('No response from Emily, sending fallback');
      this.sendEvent({
        type: 'response.create',
        response: {
          instructions: "Sorry, I didn't catch that - could you repeat the question?"
        }
      });
    }, this.FALLBACK_TIMEOUT_MS);
  }

  cancelFallbackTimer() {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  /**
   * Create hidden audio element for AI voice
   */
  createAudioElement() {
    let audio = document.getElementById('emily-audio');
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'emily-audio';
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    return audio;
  }
}

// Export for use in browser and Node
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EmilyVoiceHandler;
}

// Make available globally in browser
if (typeof window !== 'undefined') {
  window.EmilyVoiceHandler = EmilyVoiceHandler;
}
