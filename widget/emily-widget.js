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

      <!-- Proactive Speech Bubble (appears above toggle) -->
      <div id="emily-bubble" class="emily-bubble-hidden">
        <div id="emily-bubble-text"></div>
        <button id="emily-bubble-close" aria-label="Close">&times;</button>
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
          Hello! I'm Emily from bSMART AI. I help schools transform their admissions with AI. Ask me about our 7 SMART products, or book a demo!
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

    // Open Emily and send a message (e.g., for "Book a Demo" buttons)
    window.openEmilyWithMessage = function(message) {
      if (!isOpen) {
        toggleChat();
      }
      // Wait for chat to open, then send the message
      setTimeout(() => {
        const input = document.getElementById('emily-input');
        if (input) {
          input.value = message;
          sendMessage();
        }
      }, 400);
    };

    // Shortcut for booking demos - opens Emily ready to book
    window.bookDemoWithEmily = function() {
      window.openEmilyWithMessage("I'd like to book a demo with Bob");
    };

    // Shortcut for discussing options
    window.discussOptionsWithEmily = function() {
      window.openEmilyWithMessage("I'd like to discuss which products might be right for my school");
    };

    // See Emily in Action - demo mode with More House as example
    window.seeEmilyInAction = function() {
      window.openEmilyWithMessage("I'd like to see Emily in action - can you show me a demo?");
    };
  }

  // =========================================================================
  // PROACTIVE ENGAGEMENT SYSTEM
  // =========================================================================

  function setupProactiveEngagement() {
    const bubble = document.getElementById('emily-bubble');
    const bubbleClose = document.getElementById('emily-bubble-close');

    // Show contextual bubble after 8 seconds based on what section they're viewing
    setTimeout(() => {
      if (!isOpen && !hasAutoOpened) {
        hasAutoOpened = true;
        showContextualBubble();
      }
    }, 8000);

    // Clicking bubble opens chat
    bubble.addEventListener('click', (e) => {
      if (e.target !== bubbleClose) {
        hideBubble();
        toggleChat();
      }
    });

    // Close button hides bubble
    bubbleClose.addEventListener('click', (e) => {
      e.stopPropagation();
      hideBubble();
    });

    console.log('Emily: Proactive bubble enabled');
  }

  // Contextual messages based on which section they're viewing
  const sectionMessages = {
    'hero': "Looking for a smarter way to handle admissions? I can show you how it all works!",
    'ecosystem': "That's our connected ecosystem - every product shares one database. Want me to explain how it fits together?",
    'product-prospectus': "SMART Prospectus creates a unique, personalised experience for every family. Want to know more?",
    'product-chat': "That's me! I answer parent questions 24/7 and capture leads automatically. Shall I tell you more?",
    'product-voice': "SMART Voice lets families have natural spoken conversations in 100+ languages. Interested?",
    'product-crm': "SMART CRM is your admissions command centre - see every family's complete journey. Want details?",
    'product-email': "SMART Email makes every message personal, not generic templates. Want to see how?",
    'product-booking': "SMART Booking handles open days, tours, and taster days with automated follow-ups. Need more info?",
    'products': "I see you're browsing our products. Want me to explain how they work together?",
    'deployment': "Wondering whether to start small or go all-in? I can help you decide what's right for your school.",
    'emily': "That's me! I power all the conversations - chat, voice, everything. Want to see what I can do?",
    'default': "Hi! I noticed you're exploring. Want me to help you find what you're looking for?"
  };

  // Page-level messages based on URL
  const pageMessages = {
    'booking': "I see you're learning about SMART Booking! It handles open days, tours, taster days - everything automated. Any questions?",
    'prospectus': "Exploring SMART Prospectus? It creates a unique, personalised digital prospectus for every family. Want to know how?",
    'chatbot': "You're looking at SMART Chat - that's me! I answer questions 24/7 and never miss an enquiry. What would you like to know?",
    'voice': "SMART Voice lets families talk naturally with me in over 100 languages. Want to hear more about it?",
    'crm': "SMART CRM is the heart of the system - every interaction, every signal, one complete picture. Questions?",
    'email': "SMART Email makes every message genuinely personal - no more 'Dear Parent/Guardian'. Interested?",
    'contact': "Ready to get in touch? I can answer questions right here, or help you book a demo with Bob!",
    'analytics': "SMART Analytics gives you insights across the entire family journey. Want to know what you can measure?"
  };

  // Detect current page from URL
  function detectCurrentPage() {
    const path = window.location.pathname.toLowerCase();
    const filename = path.split('/').pop().replace('.html', '');
    return filename || 'index';
  }

  function showContextualBubble() {
    let message = sectionMessages['default'];

    // First check which PAGE we're on
    const currentPage = detectCurrentPage();
    console.log('Emily: Current page:', currentPage);

    if (pageMessages[currentPage]) {
      // We're on a specific product/feature page
      message = pageMessages[currentPage];
      console.log('Emily: Using page-level message for:', currentPage);
    } else {
      // We're on index or unknown page - check sections
      // Try to get current section from page if we don't have it
      if (!currentViewingSection && typeof window.emilyGetContext === 'function') {
        const context = window.emilyGetContext();
        if (context && context.currentSection) {
          currentViewingSection = {
            sectionId: context.currentSection,
            label: context.currentLabel,
            description: context.currentDescription
          };
        }
      }

      if (currentViewingSection) {
        const sectionId = currentViewingSection.sectionId || '';
        console.log('Emily: Showing contextual bubble for section:', sectionId);
        // Check for exact match first, then partial matches
        if (sectionMessages[sectionId]) {
          message = sectionMessages[sectionId];
        } else if (sectionId.startsWith('product-')) {
          message = sectionMessages['products'];
        }
      } else {
        console.log('Emily: No section detected, showing default message');
      }
    }

    showBubble(message);
  }

  function showBubble(text) {
    const bubble = document.getElementById('emily-bubble');
    const bubbleText = document.getElementById('emily-bubble-text');
    if (bubble && bubbleText) {
      bubbleText.textContent = text;
      bubble.classList.remove('emily-bubble-hidden');
    }
  }

  function hideBubble() {
    const bubble = document.getElementById('emily-bubble');
    if (bubble) {
      bubble.classList.add('emily-bubble-hidden');
    }
  }

  function addProactiveMessage(text) {
    const history = document.getElementById('emily-chat-history');
    if (!history) return;

    const msg = document.createElement('div');
    msg.className = 'emily-msg emily-msg--bot emily-proactive';
    msg.innerHTML = `<p>${text}</p>`;
    history.appendChild(msg);
    history.scrollTop = history.scrollHeight;
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

    // Always add smart contextual buttons after bot messages
    if (role === 'bot') {
      const smartButtons = getSmartButtons(text);
      if (smartButtons.length > 0) {
        const buttonsDiv = document.createElement('div');
        buttonsDiv.className = 'emily-context-buttons';
        buttonsDiv.innerHTML = smartButtons.map(btn => {
          if (btn.type === 'form') {
            return `<button class="emily-context-btn emily-form-trigger" data-form="${btn.form}">${escapeHtml(btn.label)}</button>`;
          }
          if (btn.type === 'time-picker') {
            return `<button class="emily-context-btn emily-time-trigger">${escapeHtml(btn.label)}</button>`;
          }
          return `<button class="emily-context-btn" data-q="${escapeHtml(btn.query)}">${escapeHtml(btn.label)}</button>`;
        }).join('');
        history.appendChild(buttonsDiv);

        // Attach click handlers
        buttonsDiv.querySelectorAll('.emily-context-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            if (btn.classList.contains('emily-form-trigger')) {
              showBookingForm(btn.dataset.form);
            } else if (btn.classList.contains('emily-time-trigger')) {
              showTimePicker();
            } else {
              document.getElementById('emily-input').value = btn.dataset.q;
              sendMessage();
            }
          });
        });
      }
    }

    history.scrollTop = history.scrollHeight;
  }

  // Smart contextual buttons based on conversation state
  // VERSION 2.0 - 30 Jan 2026
  function getSmartButtons(responseText) {
    const text = responseText.toLowerCase();
    const buttons = [];

    console.log('EMILY BUTTONS v2.0 - checking:', text.substring(0, 50));

    // Demo request - offer voice or chat experience
    if (text.includes('demo') && (text.includes('voice') || text.includes('chat') || text.includes('try') ||
        text.includes('show') || text.includes('experience') || text.includes('action'))) {
      buttons.push(
        { label: 'Try Voice Demo', query: "I'd like to try the voice demo with a real school example" },
        { label: 'Try Chat Demo', query: "I'd like to try the chat demo with a real school example" },
        { label: 'Book a Call Instead', query: "Actually, I'd prefer to book a call with Bob" }
      );
      return buttons;
    }

    // FIRST: Check if Emily is asking about meeting type (Teams vs In-Person)
    // This takes priority over date/time questions
    const isAskingMeetingType = text.includes('teams or in person') ||
                                 text.includes('teams or in-person') ||
                                 text.includes('teams video call, or') ||
                                 text.includes('prefer a teams') ||
                                 text.includes('meet in person') ||
                                 text.includes('would you like to meet');

    if (isAskingMeetingType) {
      buttons.push(
        { label: 'Teams Call', query: "I'd like a Teams video call" },
        { label: 'Visit In Person', query: "I'd prefer to meet in person" }
      );
      return buttons;
    }

    // Emily asking about PRODUCTS - show ALL product options
    if (text.includes('which products') || text.includes('what products') ||
        text.includes('interested in discussing') || text.includes('products are you interested')) {
      buttons.push(
        { label: 'SMART Prospectus', query: 'SMART Prospectus' },
        { label: 'SMART CRM', query: 'SMART CRM' },
        { label: 'SMART Chat', query: 'SMART Chat' },
        { label: 'SMART Voice', query: 'SMART Voice' },
        { label: 'SMART Booking', query: 'SMART Booking' },
        { label: 'SMART Email', query: 'SMART Email' },
        { label: 'Full Platform', query: 'I want to see the full platform - all products' }
      );
      return buttons;
    }

    // Emily asking about TIME specifically - show time picker
    const isAskingTime = (text.includes('what time') || text.includes('time preference') ||
                          text.includes('preferred time') || text.includes('time of day') ||
                          text.includes('time would suit') || text.includes('time works')) &&
                         !text.includes('date') && !text.includes('week') && !text.includes('day');

    if (isAskingTime) {
      buttons.push({ label: 'Pick a Time', type: 'time-picker' });
      return buttons;
    }

    // Emily asking about DATE/WEEK - show week selection buttons
    const isAskingDate = text.includes('what date') || text.includes('what day') ||
                         text.includes('when would') || text.includes('which week') ||
                         text.includes('suit you') || text.includes('when suits') ||
                         text.includes('when works') || text.includes('works best');

    if (isAskingDate) {
      const weekButtons = getWeekButtons();
      weekButtons.forEach(btn => buttons.push(btn));
      return buttons;
    }

    // Asking for contact details - show form button
    if ((text.includes('name') && text.includes('email')) ||
        text.includes('share your') || text.includes('your details') ||
        text.includes('could you please share')) {
      buttons.push({ label: 'Fill in my details', type: 'form', form: 'booking' });
      return buttons;
    }

    // Alternative time offered
    if (text.includes('how about') && (text.includes('am') || text.includes('pm') || text.includes(':'))) {
      buttons.push(
        { label: 'That works', query: 'Yes, that works for me' },
        { label: 'Different time', query: 'Can we try a different time?' }
      );
      return buttons;
    }

    // Mentioned products - offer to learn more
    if (text.includes('7 smart products') || text.includes('seven smart')) {
      buttons.push(
        { label: 'SMART Prospectus', query: 'Tell me about SMART Prospectus' },
        { label: 'SMART Chat', query: 'Tell me about SMART Chat' },
        { label: 'SMART CRM', query: 'Tell me about SMART CRM' },
        { label: 'Book a Demo', query: "I'd like to book a demo" }
      );
      return buttons;
    }


    // In-person meeting - need to ask location
    if (text.includes('in person') || text.includes('in-person') || text.includes('meet you') || text.includes('visit')) {
      if (text.includes('where') || text.includes('location')) {
        // Emily is asking for location - no buttons needed, they type
      } else if (!text.includes('booked')) {
        buttons.push(
          { label: 'At my school', query: 'Can you come to my school?' },
          { label: 'At your office', query: 'I can visit your office' },
          { label: 'Actually, Teams is fine', query: "Actually let's do a Teams call instead" }
        );
        return buttons;
      }
    }

    // Successfully booked - DON'T show any buttons
    // The booking is complete, no need for more options
    if (text.includes('booked') && text.includes('calendar invite')) {
      return buttons; // Return empty - no buttons needed after booking confirmed
    }

    // Pricing mentioned
    if (text.includes('pricing') || text.includes('cost') || text.includes('price')) {
      buttons.push(
        { label: 'Book pricing call', query: 'Can I book a call to discuss pricing?' },
        { label: 'What affects price?', query: 'What factors affect the pricing?' }
      );
      return buttons;
    }

    // General conversation - offer main actions (but NOT if we're mid-booking)
    if (buttons.length === 0 && text.length > 50) {
      // Don't show generic buttons if Emily is asking for specific info
      const isAskingForInfo = text.includes('could you') || text.includes('please share') ||
                              text.includes('please specify') || text.includes('what time') ||
                              text.includes('which day') || text.includes('your name') ||
                              text.includes('your email');
      if (!isAskingForInfo) {
        buttons.push(
          { label: 'Book a Demo', query: "I'd like to book a demo with Bob" },
          { label: 'See Products', query: 'What are the 7 SMART products?' }
        );
      }
    }

    return buttons;
  }

  // Show inline booking form
  function showBookingForm(formType) {
    const history = document.getElementById('emily-chat-history');

    // Remove any existing form
    const existingForm = document.getElementById('emily-booking-form');
    if (existingForm) existingForm.remove();

    const formHtml = `
      <div id="emily-booking-form" class="emily-booking-form">
        <div class="emily-form-title">Your Details</div>
        <input type="text" id="emily-form-name" placeholder="Your name" class="emily-form-input" />
        <input type="email" id="emily-form-email" placeholder="Email address" class="emily-form-input" />
        <input type="text" id="emily-form-school" placeholder="School name" class="emily-form-input" />
        <input type="text" id="emily-form-role" placeholder="Your role (e.g. Head of Admissions)" class="emily-form-input" />
        <div class="emily-form-buttons">
          <button id="emily-form-cancel" class="emily-form-btn emily-form-btn--cancel">Cancel</button>
          <button id="emily-form-submit" class="emily-form-btn emily-form-btn--submit">Submit</button>
        </div>
      </div>
    `;

    history.insertAdjacentHTML('beforeend', formHtml);
    history.scrollTop = history.scrollHeight;

    // Focus first input
    document.getElementById('emily-form-name').focus();

    // Attach handlers
    document.getElementById('emily-form-cancel').addEventListener('click', () => {
      document.getElementById('emily-booking-form').remove();
    });

    document.getElementById('emily-form-submit').addEventListener('click', submitBookingForm);

    // Allow Enter to move between fields, submit on last field
    const inputs = document.querySelectorAll('.emily-form-input');
    inputs.forEach((input, idx) => {
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (idx < inputs.length - 1) {
            inputs[idx + 1].focus();
          } else {
            submitBookingForm();
          }
        }
      });
    });
  }

  function submitBookingForm() {
    const name = document.getElementById('emily-form-name').value.trim();
    const email = document.getElementById('emily-form-email').value.trim();
    const school = document.getElementById('emily-form-school').value.trim();
    const role = document.getElementById('emily-form-role').value.trim();

    if (!name || !email) {
      alert('Please enter at least your name and email');
      return;
    }

    // Remove the form
    document.getElementById('emily-booking-form').remove();

    // Send as a message
    const detailsMessage = `${name}, ${email}, ${school || 'Not specified'}, ${role || 'Not specified'}`;
    document.getElementById('emily-input').value = detailsMessage;
    sendMessage();
  }

  // Get week selection buttons for the next 3 weeks
  function getWeekButtons() {
    const buttons = [];
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, ... 5 = Friday, 6 = Saturday

    // Calculate next Monday
    let daysUntilNextMonday = (8 - dayOfWeek) % 7;
    if (daysUntilNextMonday === 0) daysUntilNextMonday = 7; // If today is Monday, go to next Monday

    // If it's Thursday or Friday, skip "this week" - not enough working days
    // Start from next week instead
    let startOffset = 0;
    if (dayOfWeek >= 4 && dayOfWeek <= 6) { // Thursday, Friday, Saturday
      startOffset = 0; // Will start from next Monday anyway
    } else if (dayOfWeek >= 1 && dayOfWeek <= 3) { // Mon-Wed: can offer this week
      // Actually offer "this week" - calculate the Monday of this week
      const thisMonday = new Date(today);
      thisMonday.setDate(today.getDate() - (dayOfWeek - 1));

      const formattedThisWeek = formatWeekCommencing(thisMonday);
      buttons.push({
        label: `This week (w/c ${formattedThisWeek})`,
        query: `This week, week commencing ${formattedThisWeek}`
      });
    }

    // Add next 3 weeks starting from next Monday
    for (let i = 0; i < 3; i++) {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() + daysUntilNextMonday + (i * 7));

      const formatted = formatWeekCommencing(weekStart);
      const weekLabel = i === 0 ? 'Next week' : (i === 1 ? 'Week after' : 'In 3 weeks');

      buttons.push({
        label: `${weekLabel} (w/c ${formatted})`,
        query: `Week commencing ${formatted}`
      });
    }

    // Limit to 3 buttons max
    return buttons.slice(0, 3);
  }

  // Format date as "3rd February"
  function formatWeekCommencing(date) {
    const day = date.getDate();
    const suffix = getDaySuffix(day);
    const month = date.toLocaleDateString('en-GB', { month: 'long' });
    return `${day}${suffix} ${month}`;
  }

  function getDaySuffix(day) {
    if (day >= 11 && day <= 13) return 'th';
    switch (day % 10) {
      case 1: return 'st';
      case 2: return 'nd';
      case 3: return 'rd';
      default: return 'th';
    }
  }

  // Show time picker UI
  function showTimePicker() {
    const history = document.getElementById('emily-chat-history');

    // Remove any existing picker
    const existingPicker = document.getElementById('emily-time-picker');
    if (existingPicker) existingPicker.remove();

    const timeSlots = [
      { label: '9:00 AM', value: '9:00 AM' },
      { label: '9:30 AM', value: '9:30 AM' },
      { label: '10:00 AM', value: '10:00 AM' },
      { label: '10:30 AM', value: '10:30 AM' },
      { label: '11:00 AM', value: '11:00 AM' },
      { label: '11:30 AM', value: '11:30 AM' },
      { label: '12:00 PM', value: '12:00 PM' },
      { label: '12:30 PM', value: '12:30 PM' },
      { label: '1:00 PM', value: '1:00 PM' },
      { label: '1:30 PM', value: '1:30 PM' },
      { label: '2:00 PM', value: '2:00 PM' },
      { label: '2:30 PM', value: '2:30 PM' },
      { label: '3:00 PM', value: '3:00 PM' },
      { label: '3:30 PM', value: '3:30 PM' },
      { label: '4:00 PM', value: '4:00 PM' },
      { label: '4:30 PM', value: '4:30 PM' },
      { label: '5:00 PM', value: '5:00 PM' }
    ];

    const morningSlots = timeSlots.filter(s => s.value.includes('AM') || s.value === '12:00 PM' || s.value === '12:30 PM');
    const afternoonSlots = timeSlots.filter(s => s.value.includes('PM') && !s.value.includes('12:'));

    const pickerHtml = `
      <div id="emily-time-picker" class="emily-time-picker">
        <div class="emily-picker-title">Select a Time</div>
        <div class="emily-time-sections">
          <div class="emily-time-section">
            <div class="emily-time-section-title">Morning</div>
            <div class="emily-time-grid">
              ${morningSlots.map(s => `<button class="emily-time-slot" data-time="${s.value}">${s.label}</button>`).join('')}
            </div>
          </div>
          <div class="emily-time-section">
            <div class="emily-time-section-title">Afternoon</div>
            <div class="emily-time-grid">
              ${afternoonSlots.map(s => `<button class="emily-time-slot" data-time="${s.value}">${s.label}</button>`).join('')}
            </div>
          </div>
        </div>
        <button id="emily-time-cancel" class="emily-form-btn emily-form-btn--cancel">Cancel</button>
      </div>
    `;

    history.insertAdjacentHTML('beforeend', pickerHtml);
    history.scrollTop = history.scrollHeight;

    // Attach click handlers
    document.querySelectorAll('.emily-time-slot').forEach(btn => {
      btn.addEventListener('click', () => {
        const time = btn.dataset.time;
        document.getElementById('emily-time-picker').remove();
        document.getElementById('emily-input').value = time;
        sendMessage();
      });
    });

    document.getElementById('emily-time-cancel').addEventListener('click', () => {
      document.getElementById('emily-time-picker').remove();
    });
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

      // Track sections viewed
      sectionsViewed.add(sectionId);
    });

    console.log('Emily: Screen awareness enabled');
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
      { label: 'See All Products', query: 'What are the 7 SMART products?' },
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

      /* Proactive Speech Bubble */
      #emily-bubble {
        position: fixed;
        bottom: 90px;
        right: 20px;
        max-width: 280px;
        padding: 14px 40px 14px 16px;
        background: #fff;
        color: #333;
        border-radius: 16px 16px 4px 16px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        z-index: 999999;
        font-size: 14px;
        line-height: 1.4;
        cursor: pointer;
        animation: emily-bubbleIn 0.3s ease-out;
        border: 2px solid var(--emily-primary);
      }
      #emily-bubble.emily-bubble-hidden {
        display: none;
      }
      #emily-bubble-close {
        position: absolute;
        top: 8px;
        right: 8px;
        background: none;
        border: none;
        color: #999;
        font-size: 18px;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #emily-bubble-close:hover {
        color: #333;
      }
      @keyframes emily-bubbleIn {
        from { transform: translateY(10px) scale(0.95); opacity: 0; }
        to { transform: translateY(0) scale(1); opacity: 1; }
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

      /* Contextual Buttons (after bot messages) - SOLID FILLED style, different from outline quick replies */
      .emily-context-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 10px 12px;
        margin-bottom: 8px;
      }
      .emily-context-btn {
        padding: 10px 16px;
        background: #2c3e50;
        color: #fff;
        font-size: 13px;
        font-weight: 500;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        transition: all 0.2s ease;
        white-space: nowrap;
        box-shadow: 0 2px 4px rgba(0,0,0,0.15);
      }
      .emily-context-btn:hover {
        background: #1a252f;
        transform: translateY(-1px);
        box-shadow: 0 3px 8px rgba(0,0,0,0.2);
      }
      .emily-context-btn:active {
        transform: translateY(0);
        box-shadow: 0 1px 2px rgba(0,0,0,0.15);
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

      /* Proactive message styling */
      .emily-msg.emily-proactive {
        background: linear-gradient(135deg, rgba(255,159,28,0.1) 0%, rgba(255,184,77,0.1) 100%);
        border-color: rgba(255,159,28,0.3);
      }

      /* Inline Booking Form */
      .emily-booking-form {
        background: #fff;
        border: 2px solid var(--emily-primary);
        border-radius: 12px;
        padding: 16px;
        margin: 12px 0;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      }
      .emily-form-title {
        font-weight: 600;
        color: var(--emily-primary);
        margin-bottom: 12px;
        font-size: 14px;
      }
      .emily-form-input {
        width: 100%;
        padding: 10px 12px;
        margin-bottom: 8px;
        border: 1px solid #ddd;
        border-radius: 6px;
        font-size: 14px;
        box-sizing: border-box;
      }
      .emily-form-input:focus {
        outline: none;
        border-color: var(--emily-primary);
        box-shadow: 0 0 0 2px rgba(26, 95, 90, 0.1);
      }
      .emily-form-buttons {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }
      .emily-form-btn {
        flex: 1;
        padding: 10px;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
      }
      .emily-form-btn--cancel {
        background: #f5f5f5;
        border: 1px solid #ddd;
        color: #666;
      }
      .emily-form-btn--cancel:hover {
        background: #eee;
      }
      .emily-form-btn--submit {
        background: var(--emily-primary);
        border: none;
        color: #fff;
      }
      .emily-form-btn--submit:hover {
        filter: brightness(1.1);
      }

      /* Time Picker */
      .emily-time-picker {
        background: #fff;
        border: 2px solid var(--emily-primary);
        border-radius: 12px;
        padding: 16px;
        margin: 12px 0;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      }
      .emily-picker-title {
        font-weight: 600;
        color: var(--emily-primary);
        margin-bottom: 12px;
        font-size: 14px;
        text-align: center;
      }
      .emily-time-sections {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .emily-time-section {
        padding: 8px;
        background: #f8f9fa;
        border-radius: 8px;
      }
      .emily-time-section-title {
        font-size: 12px;
        font-weight: 600;
        color: #666;
        margin-bottom: 8px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .emily-time-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
      }
      .emily-time-slot {
        padding: 8px 4px;
        background: #fff;
        border: 1px solid #ddd;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
        color: #333;
      }
      .emily-time-slot:hover {
        background: var(--emily-primary);
        border-color: var(--emily-primary);
        color: #fff;
        transform: scale(1.02);
      }
      .emily-time-picker .emily-form-btn--cancel {
        width: 100%;
        margin-top: 12px;
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
