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

  // Screen awareness state
  let currentViewingSection = null;
  let sectionChangeTimeout = null;
  let lastProactiveHint = 0;
  const PROACTIVE_HINT_COOLDOWN = 20000; // 20 seconds between proactive hints

  // Engagement tracking
  let sectionsViewed = new Set();
  let pageLoadTime = Date.now();
  let hasAutoOpened = false;
  let hasShownWelcome = false;
  let lastBubbleTime = 0;
  let bubbleQueue = [];
  let exitIntentShown = false;
  let engagementScore = 0;

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
          Hello! I'm Emily from bSMART AI. I help schools transform their admissions with AI. Ask me about our 8 SMART products, or book a demo!
        </div>

        <!-- Chat History -->
        <div id="emily-chat-history"></div>

        <!-- Thinking Indicator -->
        <div id="emily-thinking">Thinking</div>

        <!-- Quick Replies -->
        <div id="emily-quick-replies">
          ${getQuickRepliesHtml()}
        </div>

        <!-- Input -->
        <div id="emily-input-container">
          <input type="text" id="emily-input" placeholder="Ask a question..." />
          <button id="emily-send">Send</button>
        </div>

        <!-- Privacy Footer -->
        <div id="emily-privacy-footer">
          <a href="https://s3.eu-west-2.amazonaws.com/bsmart-ai.com/privacy.html" target="_blank">Privacy Policy</a>
          <span>•</span>
          <span>Powered by bSMART AI</span>
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

      <!-- Proactive Bubble (appears outside chat) -->
      <div id="emily-proactive-bubble" class="emily-bubble-hidden">
        <button id="emily-bubble-close" aria-label="Dismiss">&times;</button>
        <div id="emily-bubble-content">
          <div id="emily-bubble-typing">
            <span></span><span></span><span></span>
          </div>
          <div id="emily-bubble-text"></div>
        </div>
        <div id="emily-bubble-actions"></div>
      </div>
    `;

    document.body.appendChild(container);
    attachEventListeners();
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

    // Screen awareness (co-browsing)
    setupScreenAwareness();

    // Proactive engagement features
    setupProactiveEngagement();

    // Expose global function to open chat programmatically
    window.openEmilyChat = function() {
      if (!isOpen) {
        toggleChat();
      }
      // Focus the input
      setTimeout(() => {
        const input = document.getElementById('emily-input');
        if (input) input.focus();
      }, 300);
    };

    // Also expose a close function
    window.closeEmilyChat = function() {
      if (isOpen) {
        toggleChat();
      }
    };
  }

  // =========================================================================
  // PROACTIVE ENGAGEMENT SYSTEM
  // =========================================================================

  function setupProactiveEngagement() {
    // Close bubble button
    document.getElementById('emily-bubble-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      hideBubble();
    });

    // Clicking bubble opens chat
    document.getElementById('emily-proactive-bubble')?.addEventListener('click', (e) => {
      if (e.target.id !== 'emily-bubble-close') {
        hideBubble();
        if (!isOpen) toggleChat();
      }
    });

    // Initial welcome after 2 seconds
    setTimeout(() => {
      if (!isOpen && !hasShownWelcome) {
        showWelcomeBubble();
      }
    }, 2000);

    // After 15 seconds, if on a specific section, show screen awareness demo
    setTimeout(() => {
      if (!isOpen && currentViewingSection && sectionsViewed.size >= 1) {
        const sectionLabel = currentViewingSection.label || currentViewingSection.sectionId;
        showBubble(
          `I noticed you're looking at "${sectionLabel}" — I can see which parts of the page interest you! This is exactly how I work for schools. Want me to show you around?`,
          [
            { label: "That's clever! Show me", action: 'open', message: "Show me how the screen awareness works" },
            { label: "Maybe later", action: 'dismiss' }
          ],
          'section'
        );
      }
    }, 18000);

    // Auto-open chat after 45 seconds if not interacted
    setTimeout(() => {
      if (!isOpen && !hasAutoOpened && sectionsViewed.size >= 2) {
        hasAutoOpened = true;
        showBubble(
          "You've been exploring for a while! Want me to help you find what you're looking for?",
          [
            { label: "Yes, let's chat", action: 'open' },
            { label: "Just browsing", action: 'dismiss' }
          ],
          'wave'
        );
      }
    }, 45000);

    // Exit intent detection
    document.addEventListener('mouseout', (e) => {
      if (e.clientY < 10 && !exitIntentShown && !isOpen && sectionsViewed.size >= 1) {
        exitIntentShown = true;
        showBubble(
          "Before you go — I can answer any questions about SMART AI, or book you a quick demo with Bob!",
          [
            { label: "Book a demo", action: 'open', message: "I'd like to book a demo" },
            { label: "Ask a question", action: 'open' }
          ],
          'exit'
        );
      }
    });

    // Track scroll depth for engagement
    let maxScrollDepth = 0;
    window.addEventListener('scroll', () => {
      const scrollPercent = (window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100;
      if (scrollPercent > maxScrollDepth) {
        maxScrollDepth = scrollPercent;

        // If they've scrolled 80%+ of the page, offer help
        if (maxScrollDepth > 80 && !isOpen && Date.now() - lastBubbleTime > 30000) {
          showBubble(
            "You've seen most of what we offer! Ready to see it in action? I can arrange a personalised demo.",
            [
              { label: "Book a demo", action: 'open', message: "I'd like to book a demo please" },
              { label: "Tell me more first", action: 'open' }
            ],
            'scroll'
          );
        }
      }
    });

    console.log('Emily: Proactive engagement enabled');
  }

  function showWelcomeBubble() {
    hasShownWelcome = true;
    showBubble(
      "Hello! I'm Emily. I can tell you about any of our SMART products, answer questions, or help book a demo. Just click to chat!",
      [{ label: "Let's chat!", action: 'open' }],
      'welcome'
    );
  }

  function showBubble(message, actions = [], type = 'default') {
    if (isOpen) return; // Don't show if chat is open
    if (Date.now() - lastBubbleTime < 10000) return; // Rate limit

    lastBubbleTime = Date.now();
    const bubble = document.getElementById('emily-proactive-bubble');
    const textEl = document.getElementById('emily-bubble-text');
    const typingEl = document.getElementById('emily-bubble-typing');
    const actionsEl = document.getElementById('emily-bubble-actions');

    if (!bubble || !textEl) return;

    // Reset and show bubble with typing animation
    textEl.textContent = '';
    textEl.style.display = 'none';
    typingEl.style.display = 'flex';
    actionsEl.innerHTML = '';
    actionsEl.style.display = 'none';

    bubble.className = 'emily-bubble-visible emily-bubble-' + type;

    // Add pulse to toggle button
    const toggle = document.getElementById('emily-toggle');
    if (toggle) toggle.classList.add('emily-has-bubble');

    // After "typing" delay, show the message
    setTimeout(() => {
      typingEl.style.display = 'none';
      textEl.style.display = 'block';
      typeText(textEl, message, () => {
        // After text is typed, show action buttons
        if (actions.length > 0) {
          actionsEl.style.display = 'flex';
          actions.forEach(action => {
            const btn = document.createElement('button');
            btn.className = 'emily-bubble-btn';
            btn.textContent = action.label;
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              hideBubble();
              if (action.action === 'open') {
                if (!isOpen) toggleChat();
                if (action.message) {
                  setTimeout(() => {
                    document.getElementById('emily-input').value = action.message;
                    sendMessage();
                  }, 500);
                }
              }
            });
            actionsEl.appendChild(btn);
          });
        }
      });
    }, 1500);

    // Auto-hide after 15 seconds
    setTimeout(() => {
      if (bubble.classList.contains('emily-bubble-visible')) {
        hideBubble();
      }
    }, 15000);
  }

  function typeText(element, text, callback) {
    let i = 0;
    const speed = 30; // ms per character
    function type() {
      if (i < text.length) {
        element.textContent += text.charAt(i);
        i++;
        setTimeout(type, speed);
      } else if (callback) {
        setTimeout(callback, 300);
      }
    }
    type();
  }

  function hideBubble() {
    const bubble = document.getElementById('emily-proactive-bubble');
    if (bubble) {
      bubble.className = 'emily-bubble-hidden';
    }
    // Remove pulse from toggle
    const toggle = document.getElementById('emily-toggle');
    if (toggle) toggle.classList.remove('emily-has-bubble');
  }

  // =========================================================================
  // CHAT FUNCTIONS
  // =========================================================================

  function toggleChat() {
    isOpen = !isOpen;
    document.getElementById('emily-chatbox').classList.toggle('open', isOpen);

    // Hide any proactive bubble when chat opens
    if (isOpen) {
      hideBubble();
    }
  }

  async function sendMessage() {
    const input = document.getElementById('emily-input');
    const message = input.value.trim();
    if (!message) return;

    input.value = '';
    addMessage('user', message);
    showThinking();

    try {
      // Include screen context in the request
      const screenContext = getScreenContext();

      const response = await fetch(`${API_BASE_URL}/api/${schoolConfig.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          session_id: sessionId,
          family_id: familyId,
          family_context: familyContext,
          screen_context: screenContext
        })
      });

      const data = await response.json();
      hideThinking();

      if (data.response) {
        addMessage('bot', data.response, false); // Disabled contextual buttons - causing issues
        sessionId = data.session_id || sessionId;

        // Execute any page actions returned by Emily
        if (data.page_action) {
          setTimeout(() => {
            executePageAction(data.page_action);
          }, 500); // Slight delay so user sees the message first
        }
      }
    } catch (err) {
      hideThinking();
      addMessage('bot', "Sorry, I couldn't connect. Please try again.");
    }
  }

  function addMessage(role, text, showContextButtons = false) {
    const history = document.getElementById('emily-chat-history');
    const msg = document.createElement('div');
    msg.className = `emily-msg emily-msg--${role}`;

    // Format the message with better structure
    const formattedText = formatMessage(text);
    msg.innerHTML = formattedText;
    history.appendChild(msg);

    // Add contextual quick replies after bot messages
    if (role === 'bot' && showContextButtons) {
      const contextButtons = getContextualButtons(text);
      if (contextButtons.length > 0) {
        const buttonsDiv = document.createElement('div');
        buttonsDiv.className = 'emily-context-buttons';
        buttonsDiv.innerHTML = contextButtons.map(btn =>
          `<button class="emily-context-btn" data-q="${escapeHtml(btn.query)}">${escapeHtml(btn.label)}</button>`
        ).join('');
        history.appendChild(buttonsDiv);

        // Attach click handlers
        buttonsDiv.querySelectorAll('.emily-context-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            document.getElementById('emily-input').value = btn.dataset.q;
            sendMessage();
          });
        });
      }
    }

    history.scrollTop = history.scrollHeight;
  }

  function formatMessage(text) {
    // Convert numbered lists to formatted HTML
    let formatted = escapeHtml(text);

    // Convert patterns like "1. SMART Prospectus - description" to formatted items
    formatted = formatted.replace(/(\d+)\.\s+(SMART\s+\w+)\s*[-–]\s*([^.!?]+[.!?]?)/g,
      '<div class="emily-product-item"><span class="emily-product-num">$1.</span> <strong>$2</strong> - $3</div>');

    // Convert remaining numbered items
    formatted = formatted.replace(/(\d+)\.\s+([^.!?\n]+[.!?]?)/g,
      '<div class="emily-list-item"><span class="emily-item-num">$1.</span> $2</div>');

    // Wrap non-list content in paragraphs
    if (!formatted.includes('emily-product-item') && !formatted.includes('emily-list-item')) {
      formatted = `<p>${formatted}</p>`;
    }

    return formatted;
  }

  function getContextualButtons(responseText) {
    const contextReplies = schoolConfig?.contextualReplies || {};
    const text = responseText.toLowerCase();

    // Detect topic from response and return relevant buttons
    if (text.includes('8 smart products') || text.includes('eight smart') ||
        (text.includes('smart prospectus') && text.includes('smart chat') && text.includes('smart voice'))) {
      return contextReplies.products || [];
    }

    if (text.includes('connects') || text.includes('integration') || text.includes('shared database') ||
        text.includes('seamless') || text.includes('touchpoint')) {
      return contextReplies.integration || [];
    }

    if (text.includes('security') || text.includes('gdpr') || text.includes('data protection') ||
        text.includes('encrypted') || text.includes('compliant')) {
      return contextReplies.security || [];
    }

    if (text.includes('pricing') || text.includes('cost') || text.includes('price') ||
        text.includes('£') || text.includes('per pupil')) {
      return contextReplies.pricing || [];
    }

    if (text.includes('demo') || text.includes('bob') || text.includes('meeting') ||
        text.includes('arrange') || text.includes('book')) {
      return contextReplies.booking || [];
    }

    if (text.includes('implementation') || text.includes('weeks') || text.includes('timeline') ||
        text.includes('go live') || text.includes('migration')) {
      return contextReplies.implementation || [];
    }

    // Check for individual product mentions (deep dive)
    const products = ['prospectus', 'chat', 'voice', 'phone', 'crm', 'email', 'booking', 'analytics'];
    const mentionedProducts = products.filter(p => text.includes(`smart ${p}`));
    if (mentionedProducts.length === 1) {
      return contextReplies.productDeep || [];
    }

    // Default to general follow-ups
    return contextReplies.general || [];
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
  // SCREEN AWARENESS & CO-BROWSING
  // =========================================================================

  function setupScreenAwareness() {
    // Listen for section changes from the page
    window.addEventListener('emily:section-change', (e) => {
      const { sectionId, label, description, previousSection } = e.detail;
      currentViewingSection = { sectionId, label, description };

      // Track sections viewed for engagement scoring
      if (!sectionsViewed.has(sectionId)) {
        sectionsViewed.add(sectionId);
        engagementScore += 10;

        // Celebrate milestones
        if (sectionsViewed.size === 5 && !isOpen) {
          setTimeout(() => {
            showBubble(
              "You're really exploring! You've checked out " + sectionsViewed.size + " sections. I'd love to answer any questions!",
              [{ label: "I have a question", action: 'open' }],
              'milestone'
            );
          }, 2000);
        }
      }

      // Clear any pending timeout
      if (sectionChangeTimeout) clearTimeout(sectionChangeTimeout);

      // Show section-specific bubble if lingering (and chat is closed)
      sectionChangeTimeout = setTimeout(() => {
        if (!isOpen && canShowProactiveHint()) {
          showSectionBubble(sectionId, label, description);
        } else if (isOpen && canShowProactiveHint()) {
          showProactiveHint(sectionId, label, description);
        }
      }, 4000); // Wait 4 seconds before offering help
    });

    console.log('Emily: Screen awareness enabled');
  }

  function showSectionBubble(sectionId, label, description) {
    // Section-specific contextual messages
    const sectionMessages = {
      'hero': {
        message: "Welcome to SMART AI! I can give you a quick tour of what we do, or answer specific questions. What interests you most?",
        actions: [
          { label: "Give me a tour", action: 'open', message: "Give me a quick tour of what SMART AI does" },
          { label: "I have questions", action: 'open' }
        ]
      },
      'problem': {
        message: "I see you're reading about the problems we solve. Does your school struggle with generic communications too?",
        actions: [
          { label: "Yes, tell me more", action: 'open', message: "Tell me more about how you solve generic communications" },
          { label: "Just browsing", action: 'dismiss' }
        ]
      },
      'ecosystem': {
        message: "This is where the magic happens! All 8 products connect through one CRM. Want me to explain how data flows between them?",
        actions: [
          { label: "Explain it to me", action: 'open', message: "Explain how the ecosystem works and how data flows" },
          { label: "Show me a product", action: 'open', message: "Tell me about the different products" }
        ]
      },
      'products': {
        message: "Looking at our products? I can tell you more about any of them — I'm actually demonstrating SMART Chat right now!",
        actions: [
          { label: "Tell me about Chat", action: 'open', message: "Tell me more about SMART Chat" },
          { label: "See all products", action: 'open', message: "What are all 8 SMART products?" }
        ]
      },
      'product-prospectus': {
        message: "SMART Prospectus creates personalised digital prospectuses with 70+ personalisation points. Want to see an example?",
        actions: [
          { label: "Show me an example", action: 'open', message: "Show me an example of SMART Prospectus" },
          { label: "How does it work?", action: 'open', message: "How does SMART Prospectus personalise content?" }
        ]
      },
      'product-chat': {
        message: "You're looking at me! I'm SMART Chat. I answer questions 24/7, book tours, and capture enquiries. How am I doing so far?",
        actions: [
          { label: "Pretty impressive!", action: 'open', message: "I'm impressed! Tell me more about SMART Chat" },
          { label: "I have questions", action: 'open' }
        ]
      },
      'product-voice': {
        message: "SMART Voice lets me speak! Parents can have natural voice conversations in 100+ languages. Want to try it?",
        actions: [
          { label: "Let's try voice", action: 'open', message: "I'd like to try SMART Voice" },
          { label: "Tell me more", action: 'open', message: "Tell me more about SMART Voice" }
        ]
      },
      'product-crm': {
        message: "The CRM is the heart of everything — every chat, call, prospectus view, and visit in one place. It's quite powerful!",
        actions: [
          { label: "Show me how it works", action: 'open', message: "How does the SMART CRM work?" },
          { label: "Book a demo", action: 'open', message: "I'd like to see the CRM in a demo" }
        ]
      },
      'product-email': {
        message: "SMART Email means no more 'Dear Parent/Guardian'. Every email references what you actually know about each family.",
        actions: [
          { label: "Show me an example", action: 'open', message: "Show me an example of a personalised email" },
          { label: "How does it work?", action: 'open', message: "How does SMART Email personalise communications?" }
        ]
      },
      'deployment': {
        message: "Most schools start with Chat + CRM, then add more. There's no pressure to buy everything at once!",
        actions: [
          { label: "What should we start with?", action: 'open', message: "What products should a school start with?" },
          { label: "Discuss pricing", action: 'open', message: "Can you tell me about pricing?" }
        ]
      },
      'emily': {
        message: "That's me they're talking about! I power all the conversations — chat, voice, and phone. Want to see what I can do?",
        actions: [
          { label: "Impress me!", action: 'open', message: "Show me what you can do Emily!" },
          { label: "Book a demo", action: 'open', message: "I'd like to book a demo" }
        ]
      },
      'results': {
        message: "Zero generic emails. 100% contextual follow-ups. 24/7 availability. These aren't just numbers — it's a transformation!",
        actions: [
          { label: "Tell me more", action: 'open', message: "Tell me more about the results schools see" },
          { label: "Book a demo", action: 'open', message: "I'm interested in seeing a demo" }
        ]
      },
      'cta': {
        message: "Ready to see SMART AI in action? I can book you a personalised demo with Bob right now — takes 30 seconds!",
        actions: [
          { label: "Book my demo", action: 'open', message: "I'd like to book a demo please" },
          { label: "I have questions first", action: 'open' }
        ]
      },
      'journey': {
        message: "See the difference? 'Dear Parent/Guardian' vs actually knowing who they are. Which would you prefer to receive?",
        actions: [
          { label: "The personalised one!", action: 'open', message: "Tell me how you make communications so personal" },
          { label: "Show me more", action: 'open' }
        ]
      }
    };

    const config = sectionMessages[sectionId];
    if (config) {
      lastProactiveHint = Date.now();
      showBubble(config.message, config.actions, 'section');
    }
  }

  function canShowProactiveHint() {
    return Date.now() - lastProactiveHint > PROACTIVE_HINT_COOLDOWN;
  }

  function showProactiveHint(sectionId, label, description) {
    // Don't interrupt if user is typing
    const input = document.getElementById('emily-input');
    if (input && input.value.trim().length > 0) return;

    // Don't show if thinking
    const thinking = document.getElementById('emily-thinking');
    if (thinking && thinking.style.display !== 'none') return;

    // Map sections to helpful prompts
    const sectionHints = {
      'ecosystem': "I see you're looking at our ecosystem diagram. Want me to explain how everything connects?",
      'products': "Looking at our products? I can tell you more about any specific one - just ask!",
      'product-prospectus': "SMART Prospectus creates personalised digital prospectuses. Shall I show you an example?",
      'product-chat': "That's me! SMART Chat. I'm demonstrating it right now by chatting with you.",
      'product-voice': "SMART Voice lets parents have natural conversations. Want to try it?",
      'product-phone': "SMART Phone handles your admissions calls 24/7. Curious how the warm handoff works?",
      'product-crm': "The CRM is where everything comes together. Want to see how it tracks a family's journey?",
      'product-email': "SMART Email personalises every communication. I can explain how it avoids those generic templates.",
      'product-booking': "SMART Booking manages visits. Shall I explain the automated follow-ups?",
      'deployment': "Thinking about how to get started? Most schools begin with Chat and CRM.",
      'emily': "That's me they're talking about! I power all the conversations - chat, voice, and phone.",
      'results': "Those results are real. Want me to explain how we achieve them?",
      'cta': "Ready to see it in action? I can help you book a demo with Bob.",
      'journey': "This shows the before and after. Want me to walk you through a real example?"
    };

    const hint = sectionHints[sectionId];
    if (hint) {
      lastProactiveHint = Date.now();

      // Add a subtle hint message
      const history = document.getElementById('emily-chat-history');
      if (history) {
        const hintDiv = document.createElement('div');
        hintDiv.className = 'emily-proactive-hint';
        hintDiv.innerHTML = `
          <p>${hint}</p>
          <div class="emily-hint-actions">
            <button class="emily-hint-yes" data-section="${sectionId}">Tell me more</button>
            <button class="emily-hint-dismiss">Not now</button>
          </div>
        `;
        history.appendChild(hintDiv);
        history.scrollTop = history.scrollHeight;

        // Attach event listeners
        hintDiv.querySelector('.emily-hint-yes').addEventListener('click', (e) => {
          const section = e.target.dataset.section;
          hintDiv.remove();
          document.getElementById('emily-input').value = `Tell me more about ${label || section}`;
          sendMessage();
        });

        hintDiv.querySelector('.emily-hint-dismiss').addEventListener('click', () => {
          hintDiv.remove();
        });

        // Auto-dismiss after 10 seconds
        setTimeout(() => {
          if (hintDiv.parentNode) hintDiv.remove();
        }, 10000);
      }
    }
  }

  // Get current screen context for API calls
  function getScreenContext() {
    if (typeof window.emilyGetContext === 'function') {
      return window.emilyGetContext();
    }
    return {
      currentSection: currentViewingSection?.sectionId || null,
      currentLabel: currentViewingSection?.label || null,
      currentDescription: currentViewingSection?.description || null,
      visibleSections: [],
      sectionHistory: [],
      availableSections: []
    };
  }

  // Execute page actions from Emily's response
  function executePageAction(action) {
    if (!action || !action.type) return false;

    switch (action.type) {
      case 'scroll_to':
        if (typeof window.emilyScrollTo === 'function') {
          return window.emilyScrollTo(action.section);
        }
        break;
      case 'highlight':
        if (typeof window.emilyHighlight === 'function') {
          return window.emilyHighlight(action.section, action.duration || 5000);
        }
        break;
      case 'show':
        if (typeof window.emilyShow === 'function') {
          return window.emilyShow(action.section, action.duration || 5000);
        }
        break;
      case 'clear_highlight':
        if (typeof window.emilyClearHighlight === 'function') {
          return window.emilyClearHighlight();
        }
        break;
    }
    return false;
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
    // Default quick replies for bSMART sales
    const defaultReplies = [
      { label: 'See All Products', query: 'What are the 8 SMART products?' },
      { label: 'Book a Demo', query: 'I\'d like to book a demo with Bob' },
      { label: 'Contact Us', query: 'I have a question and would like someone to contact me' },
      { label: 'How It Works', query: 'How does bSMART connect everything together?' }
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
        background: #e8e8e8;
        color: #333;
        border-color: #ddd;
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
        background: #fff;
        color: var(--emily-primary);
        font-size: 12px;
        border-radius: 20px;
        border: 1px solid var(--emily-primary);
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .emily-quick:hover {
        background: var(--emily-primary);
        color: #fff;
        border-color: var(--emily-primary);
      }
      .emily-quick--highlight {
        background: var(--emily-primary);
        color: #fff;
        border-color: var(--emily-primary);
      }
      .emily-quick--highlight:hover {
        filter: brightness(1.1);
      }

      /* Contextual Buttons (after bot messages) */
      .emily-context-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px 12px;
        margin-bottom: 8px;
      }
      .emily-context-btn {
        padding: 6px 12px;
        background: #fff;
        color: var(--emily-primary);
        font-size: 11px;
        border-radius: 16px;
        border: 1px solid var(--emily-primary);
        cursor: pointer;
        transition: all 0.2s ease;
        white-space: nowrap;
      }
      .emily-context-btn:hover {
        background: var(--emily-primary);
        color: #fff;
      }

      /* Formatted Message Content */
      .emily-product-item,
      .emily-list-item {
        display: flex;
        gap: 6px;
        padding: 6px 0;
        line-height: 1.4;
      }
      .emily-product-num,
      .emily-item-num {
        color: var(--emily-primary);
        font-weight: bold;
        min-width: 20px;
      }
      .emily-product-item strong {
        color: var(--emily-primary);
      }
      .emily-msg--bot .emily-product-item,
      .emily-msg--bot .emily-list-item {
        border-bottom: 1px solid #eee;
      }
      .emily-msg--bot .emily-product-item:last-child,
      .emily-msg--bot .emily-list-item:last-child {
        border-bottom: none;
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

      /* Privacy Footer */
      #emily-privacy-footer {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 8px;
        padding: 8px;
        background: #f5f5f5;
        border-top: 1px solid #e0e0e0;
        font-size: 11px;
        color: #888;
      }
      #emily-privacy-footer a {
        color: #666;
        text-decoration: none;
      }
      #emily-privacy-footer a:hover {
        color: var(--emily-primary);
        text-decoration: underline;
      }

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

      /* ===== PROACTIVE BUBBLE (Outside Chat) ===== */
      #emily-proactive-bubble {
        position: fixed;
        bottom: 90px;
        right: 20px;
        max-width: 320px;
        background: #fff;
        border-radius: 16px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.15), 0 2px 8px rgba(0,0,0,0.1);
        z-index: 999998;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        border: 2px solid var(--emily-primary);
        transition: all 0.3s ease;
      }
      #emily-proactive-bubble::after {
        content: '';
        position: absolute;
        bottom: -12px;
        right: 30px;
        border-width: 12px 12px 0;
        border-style: solid;
        border-color: var(--emily-primary) transparent transparent;
      }
      .emily-bubble-hidden {
        opacity: 0;
        transform: translateY(20px) scale(0.9);
        pointer-events: none;
        visibility: hidden;
        display: none;
      }
      .emily-bubble-visible {
        display: flex;
        visibility: visible;
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
        animation: emily-bubble-bounce 0.5s ease-out;
      }
      @keyframes emily-bubble-bounce {
        0% { opacity: 0; transform: translateY(30px) scale(0.8); }
        50% { transform: translateY(-5px) scale(1.02); }
        100% { opacity: 1; transform: translateY(0) scale(1); }
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
        padding: 4px;
        border-radius: 50%;
        transition: all 0.2s;
      }
      #emily-bubble-close:hover {
        background: #f0f0f0;
        color: #333;
      }

      #emily-bubble-content {
        flex: 1;
        min-height: 40px;
      }

      #emily-bubble-text {
        font-size: 14px;
        line-height: 1.5;
        color: #333;
      }

      /* Typing indicator */
      #emily-bubble-typing {
        display: flex;
        gap: 4px;
        padding: 8px 0;
      }
      #emily-bubble-typing span {
        width: 8px;
        height: 8px;
        background: var(--emily-primary);
        border-radius: 50%;
        animation: emily-typing-dot 1.4s infinite ease-in-out;
      }
      #emily-bubble-typing span:nth-child(1) { animation-delay: 0s; }
      #emily-bubble-typing span:nth-child(2) { animation-delay: 0.2s; }
      #emily-bubble-typing span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes emily-typing-dot {
        0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
        40% { transform: scale(1); opacity: 1; }
      }

      #emily-bubble-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 4px;
      }

      .emily-bubble-btn {
        padding: 8px 16px;
        border-radius: 20px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        border: none;
        background: var(--emily-primary);
        color: #fff;
      }
      .emily-bubble-btn:hover {
        filter: brightness(1.1);
        transform: translateY(-1px);
      }
      .emily-bubble-btn:nth-child(2) {
        background: #f0f0f0;
        color: #333;
      }
      .emily-bubble-btn:nth-child(2):hover {
        background: #e0e0e0;
      }

      /* Bubble type variations */
      .emily-bubble-welcome {
        border-color: var(--emily-primary);
      }
      .emily-bubble-section {
        border-color: #4CAF50;
      }
      .emily-bubble-section::after {
        border-color: #4CAF50 transparent transparent;
      }
      .emily-bubble-exit {
        border-color: #FF5722;
      }
      .emily-bubble-exit::after {
        border-color: #FF5722 transparent transparent;
      }
      .emily-bubble-milestone {
        border-color: #9C27B0;
      }
      .emily-bubble-milestone::after {
        border-color: #9C27B0 transparent transparent;
      }
      .emily-bubble-scroll {
        border-color: #2196F3;
      }
      .emily-bubble-scroll::after {
        border-color: #2196F3 transparent transparent;
      }

      /* Pulse animation on toggle button when bubble is shown */
      #emily-toggle.emily-has-bubble {
        animation: emily-toggle-pulse 2s infinite;
      }
      @keyframes emily-toggle-pulse {
        0%, 100% { box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        50% { box-shadow: 0 4px 20px rgba(255,159,28,0.5), 0 0 0 8px rgba(255,159,28,0.1); }
      }

      /* Proactive Hints (inside chat) */
      .emily-proactive-hint {
        background: linear-gradient(135deg, rgba(255,159,28,0.1) 0%, rgba(255,184,77,0.1) 100%);
        border: 1px solid rgba(255,159,28,0.3);
        border-radius: 10px;
        padding: 12px;
        margin-bottom: 12px;
        animation: emily-hint-appear 0.3s ease-out;
      }
      @keyframes emily-hint-appear {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .emily-proactive-hint p {
        margin: 0 0 10px 0;
        font-size: 13px;
        color: #333;
        line-height: 1.4;
      }
      .emily-proactive-hint p::before {
        content: "💡 ";
      }
      .emily-hint-actions {
        display: flex;
        gap: 8px;
      }
      .emily-hint-yes {
        background: var(--emily-primary);
        color: #fff;
        border: none;
        padding: 6px 12px;
        border-radius: 15px;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s;
      }
      .emily-hint-yes:hover {
        filter: brightness(1.1);
      }
      .emily-hint-dismiss {
        background: transparent;
        color: #666;
        border: 1px solid #ccc;
        padding: 6px 12px;
        border-radius: 15px;
        font-size: 12px;
        cursor: pointer;
      }
      .emily-hint-dismiss:hover {
        background: #f0f0f0;
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
        #emily-proactive-bubble {
          right: 10px;
          left: 10px;
          max-width: none;
          bottom: 70px;
        }
        #emily-proactive-bubble::after {
          right: 20px;
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
