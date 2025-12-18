/**
 * Emily AI Assistant - Embeddable Widget
 * Matches More House Emily design - pill-shaped "ASK EMILY" button with voice-first chat
 */

(function() {
  'use strict';

  // Configuration - injected by server
  let schoolConfig = __SCHOOL_CONFIG__;
  const API_BASE_URL = '__API_BASE_URL__';

  // State
  let isOpen = false;
  let isVoiceActive = false;
  let voiceHandler = null;
  let sessionId = null;
  let familyId = null;
  let familyContext = {};

  // =========================================================================
  // INITIALIZATION
  // =========================================================================

  function init() {
    console.log('Emily: init() called');
    const script = document.currentScript || document.querySelector('script[data-school]');
    console.log('Emily: script element found:', !!script);
    if (script) {
      const dataSchool = script.getAttribute('data-school');
      const dataFamilyId = script.getAttribute('data-family-id');
      const dataFamilyContext = script.getAttribute('data-family-context');

      if (dataFamilyId) familyId = dataFamilyId;

      // Try to load family context from localStorage first (same source as prospectus personalisation)
      // Map school IDs to their actual localStorage keys
      const storageKeyMap = {
        'clc': 'clc_prospectus_data',
        'brighton-college': 'bc_prospectus_data',
        'bcpk': 'bcpk_prospectus_data',
        'clifton-college': 'clifton_prospectus_data',
        'strathallan': 'strath_prospectus_data'
      };
      const storageKey = dataSchool ? storageKeyMap[dataSchool] : null;
      const storedData = storageKey ? localStorage.getItem(storageKey) : null;

      if (storedData) {
        try {
          const parsed = JSON.parse(storedData);
          // Map localStorage data to Emily's familyContext format
          // Handle different data structures (CLC vs Brighton College)
          let parentName = '';
          if (parsed.parent) {
            // CLC format
            parentName = `${parsed.parent.title} ${parsed.parent.surname}`;
          } else if (parsed.parents?.parent1) {
            // Brighton College format
            const p1 = parsed.parents.parent1;
            const p2 = parsed.parents.parent2;
            if (p2 && p1.surname === p2.surname) {
              parentName = `${p1.title} and ${p2.title} ${p1.surname}`;
            } else if (p2) {
              parentName = `${p1.title} ${p1.surname} and ${p2.title} ${p2.surname}`;
            } else {
              parentName = `${p1.title} ${p1.surname}`;
            }
          }

          familyContext = {
            parent_name: parentName,
            child_name: parsed.child?.first_name || '',
            entry_point: parsed.child?.entry_point || parsed.entry?.entry_point || '',
            interests: [
              ...(parsed.interests?.academic || []),
              ...(parsed.interests?.extracurricular || []),
              ...(parsed.interests?.sports || [])
            ],
            career_pathway: parsed.futures?.career_areas?.[0] || parsed.personalisation?.career_pathway || parsed.career?.interest || '',
            accommodation: parsed.practical?.accommodation_type || parsed.boarding?.interest || ''
          };
          familyId = parsed.prospectus_id || dataFamilyId;
          console.log('Emily: Loaded family context from localStorage:', familyContext);
        } catch (e) {
          console.warn('Emily: Could not parse localStorage data', e);
        }
      }

      // Fall back to data-family-context attribute if no localStorage data
      if (!familyContext.child_name && dataFamilyContext) {
        try { familyContext = JSON.parse(dataFamilyContext); } catch (e) {}
      }

      if (!schoolConfig || schoolConfig === '__SCHOOL_CONFIG__') {
        if (dataSchool) {
          fetchSchoolConfig(dataSchool);
          return;
        }
      }
    }
    console.log('Emily: About to createWidget(), schoolConfig:', schoolConfig?.id);
    createWidget();
  }

  function fetchSchoolConfig(schoolId) {
    fetch(`${API_BASE_URL}/api/schools/${schoolId}`)
      .then(res => res.json())
      .then(config => {
        schoolConfig = config;
        createWidget();
      })
      .catch(() => {
        schoolConfig = { id: schoolId, name: 'School', shortName: schoolId.toUpperCase(), theme: { primary: '#1A5F5A', secondary: '#C9A962' } };
        createWidget();
      });
  }

  // =========================================================================
  // CREATE WIDGET
  // =========================================================================

  function createWidget() {
    console.log('Emily: createWidget() called');
    injectStyles();

    const container = document.createElement('div');
    container.id = 'emily-widget';
    container.innerHTML = `
      <!-- Welcome Bubble -->
      <div id="emily-welcome-bubble">
        <button id="emily-bubble-close" aria-label="Close">&times;</button>
        <p>Hello${familyContext.parent_name ? ' ' + familyContext.parent_name : ''}! I'm Emily, your personal guide to ${familyContext.child_name ? familyContext.child_name + "'s" : 'the'} prospectus. Click here to start your audio tour!</p>
      </div>

      <!-- ASK EMILY Toggle Button -->
      <div id="emily-toggle" aria-label="Open chat">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2ZM20 16H6L4 18V4H20V16Z" fill="currentColor"/>
          <circle cx="8" cy="10" r="1.5" fill="currentColor"/>
          <circle cx="12" cy="10" r="1.5" fill="currentColor"/>
          <circle cx="16" cy="10" r="1.5" fill="currentColor"/>
        </svg>
        ASK EMILY
      </div>

      <!-- Chat Window -->
      <div id="emily-chatbox" aria-live="polite">
        <div id="emily-resize-handle" title="Drag to resize"></div>

        <!-- Header -->
        <div id="emily-header">
          <h2>Chat with EMILY</h2>
          <button id="emily-start-btn" class="emily-ctl">Start conversation</button>
          <button id="emily-pause-btn" class="emily-ctl emily-hidden">Pause</button>
          <button id="emily-end-btn" class="emily-ctl emily-hidden">End chat</button>
          <button id="emily-close" type="button" aria-label="Close chat">&times;</button>
        </div>

        <!-- Welcome -->
        <div id="emily-welcome">
          Hi! I'm Emily, your AI guide to ${schoolConfig.name || 'the school'}.
          <br><br>
          Click <strong>"Start Audio Tour"</strong> below and I'll narrate your personalised prospectus for you.
        </div>

        <!-- Chat History -->
        <div id="emily-chat-history"></div>

        <!-- Thinking Indicator -->
        <div id="emily-thinking">Thinking</div>

        <!-- Quick Replies -->
        <div id="emily-quick-replies">
          <button class="emily-quick emily-quick--highlight">Start Audio Tour</button>
          ${getQuickRepliesHtml()}
        </div>

        <!-- Input -->
        <div id="emily-input-container">
          <input type="text" id="emily-input" placeholder="Ask a question..." />
          <button id="emily-send">Send</button>
        </div>
      </div>

      <!-- Voice Consent Modal -->
      <div id="emily-voice-consent">
        <div class="emily-consent-panel">
          <h3>Enable EMILY (voice)</h3>
          <p>To chat by voice, we need permission to use your microphone and play audio responses.</p>
          <label>
            <input type="checkbox" id="emily-agree-voice"> I agree to voice processing for this session.
          </label>
          <div class="emily-consent-buttons">
            <button id="emily-cancel-voice">Not now</button>
            <button id="emily-confirm-voice" disabled>Start conversation</button>
          </div>
        </div>
      </div>

      <!-- Hidden audio element -->
      <audio id="emily-audio" autoplay playsinline></audio>
    `;

    document.body.appendChild(container);
    attachEventListeners();
    showWelcomeBubble();
  }

  function showWelcomeBubble() {
    const bubble = document.getElementById('emily-welcome-bubble');
    if (!bubble) return;

    // Show bubble after short delay
    setTimeout(() => {
      bubble.classList.add('visible');
    }, 1500);

    // Auto-hide after 10 seconds
    setTimeout(() => {
      bubble.classList.remove('visible');
    }, 11500);

    // Close on X click
    document.getElementById('emily-bubble-close').addEventListener('click', (e) => {
      e.stopPropagation();
      bubble.classList.remove('visible');
    });

    // Click bubble to open chat and start tour
    bubble.addEventListener('click', () => {
      bubble.classList.remove('visible');
      if (!isOpen) toggleChat();
      showVoiceConsent();
    });
  }

  // =========================================================================
  // EVENT LISTENERS
  // =========================================================================

  function attachEventListeners() {
    // Toggle
    document.getElementById('emily-toggle').addEventListener('click', toggleChat);
    document.getElementById('emily-close').addEventListener('click', toggleChat);

    // Voice controls
    document.getElementById('emily-start-btn').addEventListener('click', showVoiceConsent);
    document.getElementById('emily-pause-btn').addEventListener('click', togglePause);
    document.getElementById('emily-end-btn').addEventListener('click', endVoice);

    // Consent modal
    document.getElementById('emily-agree-voice').addEventListener('change', (e) => {
      document.getElementById('emily-confirm-voice').disabled = !e.target.checked;
    });
    document.getElementById('emily-cancel-voice').addEventListener('click', hideVoiceConsent);
    document.getElementById('emily-confirm-voice').addEventListener('click', startVoice);

    // Text chat
    document.getElementById('emily-send').addEventListener('click', sendMessage);
    document.getElementById('emily-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMessage();
    });

    // Quick replies
    document.querySelectorAll('.emily-quick').forEach(btn => {
      btn.addEventListener('click', () => {
        // Audio Tour button starts voice conversation directly
        if (btn.classList.contains('emily-quick--highlight')) {
          showVoiceConsent();
        } else {
          document.getElementById('emily-input').value = btn.dataset.q;
          sendMessage();
        }
      });
    });

    // Resize handle
    setupResize();
  }

  // =========================================================================
  // CHAT FUNCTIONS
  // =========================================================================

  function toggleChat() {
    isOpen = !isOpen;
    document.getElementById('emily-chatbox').classList.toggle('open', isOpen);
  }

  async function sendMessage() {
    const input = document.getElementById('emily-input');
    const message = input.value.trim();
    if (!message) return;

    input.value = '';
    addMessage('user', message);
    showThinking();

    try {
      const response = await fetch(`${API_BASE_URL}/api/${schoolConfig.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, session_id: sessionId, family_id: familyId, family_context: familyContext })
      });

      const data = await response.json();
      hideThinking();

      if (data.response) {
        addMessage('bot', data.response);
        sessionId = data.session_id || sessionId;
      }
    } catch (err) {
      hideThinking();
      addMessage('bot', "Sorry, I couldn't connect. Please try again.");
    }
  }

  function addMessage(role, text) {
    const history = document.getElementById('emily-chat-history');
    const msg = document.createElement('div');
    msg.className = `emily-msg emily-msg--${role}`;
    msg.innerHTML = `<p>${escapeHtml(text)}</p>`;
    history.appendChild(msg);
    history.scrollTop = history.scrollHeight;
  }

  function showThinking() {
    document.getElementById('emily-thinking').style.display = 'block';
  }

  function hideThinking() {
    document.getElementById('emily-thinking').style.display = 'none';
  }

  // =========================================================================
  // VOICE FUNCTIONS
  // =========================================================================

  function showVoiceConsent() {
    document.getElementById('emily-voice-consent').style.display = 'flex';
  }

  function hideVoiceConsent() {
    document.getElementById('emily-voice-consent').style.display = 'none';
    document.getElementById('emily-agree-voice').checked = false;
    document.getElementById('emily-confirm-voice').disabled = true;
  }

  async function startVoice() {
    hideVoiceConsent();

    // Load voice handler
    if (typeof EmilyVoiceHandler === 'undefined') {
      await loadScript(`${API_BASE_URL}/widget/emily-voice.js`);
    }

    isVoiceActive = true;
    document.getElementById('emily-start-btn').classList.add('emily-hidden');
    document.getElementById('emily-pause-btn').classList.remove('emily-hidden');
    document.getElementById('emily-end-btn').classList.remove('emily-hidden');

    voiceHandler = new EmilyVoiceHandler({
      schoolId: schoolConfig.id,
      apiBaseUrl: API_BASE_URL,
      familyId: familyId,
      familyContext: familyContext,
      onStatusChange: updateVoiceStatus,
      onTranscript: ({ role, text }) => addMessage(role === 'user' ? 'user' : 'bot', text),
      onError: (err) => {
        console.error('Voice error:', err);
        addMessage('bot', "Voice isn't working. You can type instead.");
        endVoice();
      }
    });

    await voiceHandler.start();
  }

  function togglePause() {
    if (voiceHandler) {
      const paused = voiceHandler.togglePause();
      document.getElementById('emily-pause-btn').textContent = paused ? 'Resume' : 'Pause';
    }
  }

  function endVoice() {
    if (voiceHandler) {
      voiceHandler.stop();
      voiceHandler = null;
    }
    isVoiceActive = false;
    document.getElementById('emily-start-btn').classList.remove('emily-hidden');
    document.getElementById('emily-pause-btn').classList.add('emily-hidden');
    document.getElementById('emily-end-btn').classList.add('emily-hidden');
    document.getElementById('emily-pause-btn').textContent = 'Pause';
  }

  function updateVoiceStatus(status) {
    // Could show status indicator
    console.log('Voice status:', status);
  }

  // =========================================================================
  // RESIZE
  // =========================================================================

  function setupResize() {
    const handle = document.getElementById('emily-resize-handle');
    const chatbox = document.getElementById('emily-chatbox');
    let startY, startHeight;

    handle.addEventListener('mousedown', (e) => {
      startY = e.clientY;
      startHeight = chatbox.offsetHeight;
      document.addEventListener('mousemove', resize);
      document.addEventListener('mouseup', stopResize);
    });

    function resize(e) {
      const delta = startY - e.clientY;
      chatbox.style.height = Math.max(400, Math.min(800, startHeight + delta)) + 'px';
    }

    function stopResize() {
      document.removeEventListener('mousemove', resize);
      document.removeEventListener('mouseup', stopResize);
    }
  }

  // =========================================================================
  // UTILITIES
  // =========================================================================

  function getQuickRepliesHtml() {
    // Default quick replies for schools without custom config
    const defaultReplies = [
      { label: 'Fees', query: 'What are the fees?' },
      { label: 'Apply', query: 'How do I apply?' },
      { label: 'Visit', query: 'Can I book a visit?' }
    ];

    const replies = schoolConfig?.quickReplies || defaultReplies;

    return replies.map(r =>
      `<button class="emily-quick" data-q="${escapeHtml(r.query)}">${escapeHtml(r.label)}</button>`
    ).join('');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // =========================================================================
  // STYLES
  // =========================================================================

  function injectStyles() {
    const primary = schoolConfig?.theme?.primary || '#1A5F5A';
    const secondary = schoolConfig?.theme?.secondary || '#C9A962';

    const css = `
      #emily-widget {
        --emily-primary: ${primary};
        --emily-accent: ${secondary};
        --emily-bg: #f9f9f9;
        --emily-border: #e0e0e0;
        --emily-btn-bg: #f0f0f0;
        --emily-btn-fg: #444;
        font-family: Arial, sans-serif;
      }

      /* Welcome Bubble */
      #emily-welcome-bubble {
        position: fixed;
        bottom: 90px;
        right: 20px;
        max-width: 300px;
        padding: 15px 40px 15px 15px;
        background: #fff;
        border: 2px solid var(--emily-primary);
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        z-index: 999999;
        opacity: 0;
        transform: translateY(10px);
        pointer-events: none;
        transition: all 0.3s ease;
        cursor: pointer;
      }
      #emily-welcome-bubble.visible {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      #emily-welcome-bubble::after {
        content: '';
        position: absolute;
        bottom: -10px;
        right: 30px;
        border-width: 10px 10px 0;
        border-style: solid;
        border-color: var(--emily-primary) transparent transparent;
      }
      #emily-welcome-bubble p {
        margin: 0;
        font-size: 14px;
        line-height: 1.4;
        color: #333;
      }
      #emily-bubble-close {
        position: absolute;
        top: 8px;
        right: 10px;
        background: none;
        border: none;
        font-size: 20px;
        color: #999;
        cursor: pointer;
        line-height: 1;
        padding: 0;
      }
      #emily-bubble-close:hover {
        color: #333;
      }

      /* Toggle Button - Pill Shape */
      #emily-toggle {
        position: fixed;
        bottom: 20px;
        right: 20px;
        min-width: 160px;
        height: 56px;
        border-radius: 28px;
        background: var(--emily-primary);
        color: #fff;
        font-size: 16px;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        z-index: 999999;
        padding: 0 20px;
        transition: all 0.2s ease;
      }
      #emily-toggle:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 16px rgba(0,0,0,0.25);
        filter: brightness(1.1);
      }

      /* Chatbox */
      #emily-chatbox {
        display: none;
        flex-direction: column;
        position: fixed;
        bottom: 90px;
        right: 20px;
        width: 380px;
        height: 600px;
        background: #fff;
        border: 1px solid var(--emily-border);
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        z-index: 999998;
        overflow: hidden;
      }
      #emily-chatbox.open {
        display: flex;
        animation: emily-slideUp 0.25s ease-out;
      }
      @keyframes emily-slideUp {
        from { transform: translateY(16px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }

      /* Resize Handle */
      #emily-resize-handle {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 8px;
        cursor: ns-resize;
        z-index: 1001;
        background: transparent;
      }
      #emily-resize-handle:hover { background: rgba(201,169,98,0.3); }
      #emily-resize-handle::after {
        content: '';
        position: absolute;
        top: 3px;
        left: 50%;
        transform: translateX(-50%);
        width: 40px;
        height: 2px;
        background: #ccc;
        border-radius: 2px;
      }

      /* Header */
      #emily-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        background: var(--emily-primary);
        color: #fff;
      }
      #emily-header h2 {
        margin: 0;
        font-size: 16px;
        flex: 1;
      }

      #emily-close {
        background: none;
        border: none;
        color: #fff;
        font-size: 22px;
        cursor: pointer;
        line-height: 1;
        padding: 4px 8px;
        border-radius: 6px;
      }
      #emily-close:hover { background: rgba(255,255,255,0.12); }

      .emily-ctl {
        padding: 6px 10px;
        background: var(--emily-btn-bg);
        color: var(--emily-btn-fg);
        font-size: 12px;
        border-radius: 6px;
        border: 1px solid #ccc;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .emily-ctl:hover {
        background: var(--emily-accent);
        color: #fff;
        border-color: var(--emily-accent);
      }
      .emily-hidden { display: none !important; }

      /* Welcome */
      #emily-welcome {
        padding: 12px 15px;
        background: #f9f9f9;
        color: #333;
        font-size: 14px;
        border-bottom: 1px solid var(--emily-border);
      }

      /* Chat History */
      #emily-chat-history {
        flex: 1;
        padding: 15px;
        overflow-y: auto;
        background: var(--emily-bg);
      }

      .emily-msg {
        margin-bottom: 12px;
        padding: 10px;
        font-size: 14px;
        line-height: 1.4;
        max-width: 85%;
        word-wrap: break-word;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        background: #fff;
        box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      }
      .emily-msg p { margin: 0; }
      .emily-msg--user {
        margin-left: auto;
        text-align: right;
        background: var(--emily-primary);
        color: #fff;
        border-color: var(--emily-primary);
      }
      .emily-msg--bot {
        text-align: left;
        color: #333;
      }
      .emily-msg--bot p::before {
        content: "Emily: ";
        font-weight: bold;
      }

      /* Thinking */
      #emily-thinking {
        display: none;
        padding: 10px 15px;
        font-style: italic;
        color: #777;
      }
      #emily-thinking::after {
        content: "";
        display: inline-block;
        width: 1em;
        animation: emily-dots 1.2s steps(3,end) infinite;
      }
      @keyframes emily-dots {
        0% { content: ""; }
        33% { content: "."; }
        66% { content: ".."; }
        100% { content: "..."; }
      }

      /* Quick Replies */
      #emily-quick-replies {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 10px;
        background: #f1f1f1;
        border-top: 1px solid #ddd;
        border-bottom: 1px solid #ddd;
      }
      .emily-quick {
        padding: 6px 12px;
        background: var(--emily-btn-bg);
        color: var(--emily-btn-fg);
        font-size: 12px;
        border-radius: 20px;
        border: 1px solid #ccc;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .emily-quick:hover {
        background: var(--emily-accent);
        color: #fff;
        border-color: var(--emily-accent);
      }
      .emily-quick--highlight {
        background: var(--emily-primary);
        color: #fff;
        border-color: var(--emily-primary);
      }
      .emily-quick--highlight:hover {
        filter: brightness(1.1);
      }

      /* Input */
      #emily-input-container {
        display: flex;
        padding: 10px;
        background: #fff;
      }
      #emily-input {
        flex: 1;
        padding: 10px;
        border: 1px solid var(--emily-border);
        border-radius: 5px;
        font-size: 14px;
        outline: none;
      }
      #emily-input:focus { border-color: var(--emily-primary); }
      #emily-send {
        margin-left: 8px;
        padding: 10px 16px;
        background: var(--emily-primary);
        color: #fff;
        border: none;
        border-radius: 5px;
        font-size: 14px;
        cursor: pointer;
        transition: background 0.2s ease;
      }
      #emily-send:hover { filter: brightness(1.1); }

      /* Voice Consent Modal */
      #emily-voice-consent {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.55);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 9999999;
      }
      .emily-consent-panel {
        background: #fff;
        padding: 20px;
        border-radius: 12px;
        max-width: 420px;
        width: 92%;
        box-shadow: 0 8px 30px rgba(0,0,0,0.2);
      }
      .emily-consent-panel h3 { margin: 0 0 10px; color: var(--emily-primary); }
      .emily-consent-panel p { margin: 0 0 12px; font-size: 14px; color: #555; }
      .emily-consent-panel label { display: block; margin: 12px 0; font-size: 14px; }
      .emily-consent-buttons {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 16px;
      }
      .emily-consent-buttons button {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 14px;
        cursor: pointer;
      }
      #emily-cancel-voice {
        background: #f0f0f0;
        border: 1px solid #ccc;
        color: #444;
      }
      #emily-confirm-voice {
        background: var(--emily-primary);
        border: none;
        color: #fff;
      }
      #emily-confirm-voice:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Mobile */
      @media (max-width: 480px) {
        #emily-toggle {
          min-width: 140px;
          height: 50px;
          font-size: 14px;
          bottom: 10px;
          right: 10px;
        }
        #emily-chatbox {
          width: calc(100vw - 20px);
          height: 70vh;
          bottom: 70px;
          right: 10px;
        }
      }
    `;

    const style = document.createElement('style');
    style.id = 'emily-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // =========================================================================
  // INIT
  // =========================================================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
