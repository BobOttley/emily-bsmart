/**
 * Demo Orchestrator - Controls the bSMART AI demo flow
 *
 * This is the conductor that runs the whole show:
 * - Manages demo state/sequence
 * - Tells EMILY what context to use
 * - Fires API calls at the right moments
 * - Handles branching based on user choices
 */

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// Load bSMART knowledge base
const BSMART_KNOWLEDGE = fs.readFileSync(
  path.join(__dirname, '..', 'knowledge-bases', 'bsmart.md'),
  'utf8'
);

// Demo states
const DemoState = {
  WELCOME: 'welcome',
  EMAIL_CAPTURE: 'email_capture',
  CHILD_INFO: 'child_info',               // NEW: Capture child details
  GENERATING_PROSPECTUS: 'generating_prospectus', // NEW: Call prospectus API
  PROSPECTUS_SENT: 'prospectus_sent',     // NEW: Prospectus emailed
  CRM_REVEAL: 'crm_reveal',
  CHOICE_MENU: 'choice_menu',
  BOOKING_OPEN_DAY: 'booking_open_day',
  BOOKING_TOUR: 'booking_tour',
  BOOKING_TASTER: 'booking_taster',
  BOOKING_CONFIRMED: 'booking_confirmed',
  CLOSE: 'close'
};

// In-memory session store (use Redis in production)
const demoSessions = new Map();

/**
 * Demo Session - tracks a prospect's journey through the demo
 */
class DemoSession {
  constructor() {
    this.sessionId = uuidv4();
    this.state = DemoState.WELCOME;
    this.email = null;
    this.name = null;
    this.enquiryId = null;
    this.bookingId = null;
    this.createdAt = new Date();
    this.choicesMade = [];
    this.chatHistory = [];
    // Child info for prospectus
    this.childName = null;
    this.childAge = null;
    this.ageGroup = null;      // '9-11', '11-16', '16-18'
    this.interests = {};       // { sport: true, sciences: true, ... }
    this.prospectusUrl = null;
  }

  toJSON() {
    return {
      session_id: this.sessionId,
      state: this.state,
      email: this.email,
      name: this.name,
      enquiry_id: this.enquiryId,
      booking_id: this.bookingId,
      choices_made: this.choicesMade,
      child_name: this.childName,
      child_age: this.childAge,
      age_group: this.ageGroup,
      interests: this.interests,
      prospectus_url: this.prospectusUrl
    };
  }
}

/**
 * EMILY's scripts for each demo state
 * Focus on REAL actions + clear guidance for user to verify
 */
const EMILY_SCRIPTS = {
  [DemoState.WELCOME]: {
    context: `You are EMILY running a LIVE demo of bSMART AI.

Welcome the prospect and explain you'll create a personalised prospectus for them - they'll play the role of a parent enquiring.

Say something like:
"Hello! I'm EMILY, and I'm about to show you something special.

Let's pretend you're a parent looking at a school for your child. I'll create a personalised prospectus tailored to their interests, send it to your real inbox, and you'll see exactly what parents experience.

To start, just tell me your name and email address!"

Keep it brief and friendly.`,
    awaitInput: 'email',
    nextState: DemoState.EMAIL_CAPTURE
  },

  [DemoState.EMAIL_CAPTURE]: {
    context: `The prospect shared: {name} ({email})

Now ask about the child they're "enquiring" for. This will personalise the prospectus.

Say:
"Thanks {name}! Now, tell me about the child you're enquiring for.

What's their name, how old are they, and what are they interested in? For example: 'My son Tom is 10, loves rugby and science'"

Wait for their response about the child.`,
    awaitInput: 'child_info',
    nextState: DemoState.CHILD_INFO
  },

  [DemoState.CHILD_INFO]: {
    context: `Great! We have the child's info: {childName}, age {childAge}, interested in {interestsList}.

Confirm you're creating their personalised prospectus NOW.

Say:
"{childName} sounds wonderful! Let me create a personalised prospectus just for them...

I'm generating content tailored to their interests in {interestsList}. This takes just a moment..."

The system will now call the prospectus API.`,
    action: 'generate_prospectus',
    nextState: DemoState.GENERATING_PROSPECTUS
  },

  [DemoState.GENERATING_PROSPECTUS]: {
    context: `Prospectus is being generated. Keep them engaged while we wait.

This is a holding state - the action is running in the background.`,
    nextState: DemoState.PROSPECTUS_SENT
  },

  [DemoState.PROSPECTUS_SENT]: {
    context: `Prospectus generated and email sent!

Tell them to CHECK THEIR INBOX immediately.

Say:
"Done! Check your inbox at {email} - I've just sent {childName}'s personalised prospectus.

Open it and you'll see content tailored to {interestsList}. This is exactly what parents receive - beautiful, personalised, and delivered in seconds.

While you check that, I'm loading the CRM so you can see the enquiry from the admissions perspective..."`,
    action: 'reveal_crm',
    nextState: DemoState.CRM_REVEAL
  },

  [DemoState.CRM_REVEAL]: {
    context: `The CRM is now visible. Guide them to find their enquiry.

IMPORTANT: Give clear instructions on what to do.

Say:
"The CRM has loaded on the left. Click on the ENQUIRIES tab and you'll see your name right there - {name}, enquiring about {childName}.

That's real data, created just now. Everything you told me - {childName}'s age, their interests in {interestsList} - it's all captured.

Now let's try a booking! Would you like to:
- Book an Open Day
- Schedule a Private Tour
- Arrange a Taster Day"`,
    action: 'show_choices',
    nextState: DemoState.CHOICE_MENU
  },

  [DemoState.CHOICE_MENU]: {
    context: `Wait for them to choose a booking type.

If they haven't chosen yet, remind them:
"Which would you like to try - Open Day, Private Tour, or Taster Day?"`,
    awaitInput: 'choice',
    choices: ['open_day', 'private_tour', 'taster_day']
  },

  [DemoState.BOOKING_OPEN_DAY]: {
    context: `They chose Open Day. Create the booking and tell them to CHECK THEIR EMAIL.

Say:
"Open Day it is! Creating your booking now...

Done! I've registered you for an Open Day. CHECK YOUR INBOX - a real confirmation email is on its way to {email}.

In the CRM, click the EVENTS tab to see your booking in the attendance list. This is exactly how schools manage their Open Days."`,
    action: 'book_open_day',
    nextState: DemoState.BOOKING_CONFIRMED
  },

  [DemoState.BOOKING_TOUR]: {
    context: `They chose Private Tour. Create booking and tell them to CHECK THEIR EMAIL.

Say:
"Private Tour - great choice! Creating your booking...

Done! You're booked for a private tour. CHECK YOUR EMAIL at {email} - the confirmation is arriving now.

The admissions team can see this in the system and assign a tour guide. Everything syncs automatically."`,
    action: 'book_tour',
    nextState: DemoState.BOOKING_CONFIRMED
  },

  [DemoState.BOOKING_TASTER]: {
    context: `They chose Taster Day. Create booking and tell them to CHECK THEIR EMAIL.

Say:
"Taster Day - excellent! Creating your booking...

Done! Taster Day booked. CHECK YOUR INBOX at {email} - you'll get all the details parents receive: what to bring, schedule, everything.

The school sees this instantly and can prepare the class for the visit."`,
    action: 'book_taster',
    nextState: DemoState.BOOKING_CONFIRMED
  },

  [DemoState.BOOKING_CONFIRMED]: {
    context: `Booking done. Wrap up and offer next steps.

Say:
"That's the magic of bSMART AI! From enquiry to booking, everything happened for real:
- Your enquiry is in the database
- Your booking is confirmed
- Real emails in your inbox

Would you like to:
- See more features like Smart Reply or Analytics
- Talk to Bob about getting this for your school
- Keep exploring the CRM

What interests you?"`,
    awaitInput: 'next_action',
    nextState: DemoState.CLOSE
  },

  [DemoState.CLOSE]: {
    context: `Demo wrapping up. Based on their interest, guide them.

If they want to talk to Bob:
"I'll arrange that! Bob would love to discuss how bSMART AI could work for your school.

The emails in your inbox are yours to keep as examples of what parents experience. Thanks for taking the demo!"

If they want to explore:
"Feel free to click around the CRM - it's all real data. The emails in your inbox show exactly what parents receive.

Any questions, just ask!"`,
    action: 'close_demo'
  }
};

/**
 * Demo Orchestrator class
 */
class DemoOrchestrator {
  /**
   * Create a new demo session
   */
  createSession() {
    const session = new DemoSession();
    demoSessions.set(session.sessionId, session);
    console.log(`[DEMO] Created session: ${session.sessionId}`);
    return session;
  }

  /**
   * Get an existing session
   */
  getSession(sessionId) {
    return demoSessions.get(sessionId);
  }

  /**
   * Get EMILY's context for the current state
   */
  getEmilyContext(session) {
    const script = EMILY_SCRIPTS[session.state] || {};

    // Build interests list for display
    const interestsList = Object.keys(session.interests || {})
      .filter(k => session.interests[k])
      .map(k => this._formatInterest(k))
      .join(', ') || 'various subjects';

    // Fill in placeholders
    let context = script.context || '';
    context = context
      .replace(/{email}/g, session.email || '[email]')
      .replace(/{name}/g, session.name || 'there')
      .replace(/{enquiryId}/g, session.enquiryId || '[id]')
      .replace(/{childName}/g, session.childName || 'your child')
      .replace(/{childAge}/g, session.childAge || '')
      .replace(/{interestsList}/g, interestsList);

    // Build full context with product knowledge
    const fullContext = `You are EMILY, the AI assistant for bSMART AI.

PRODUCT KNOWLEDGE:
${BSMART_KNOWLEDGE}

DEMO FLOW CONTEXT:
${context}

IMPORTANT: You are demoing the bSMART AI platform. Use the product knowledge above to answer any questions about what bSMART AI does.

RULES:
- Keep responses concise (2-4 sentences usually)
- Be enthusiastic and professional
- Use British English
- NO asterisks, NO markdown formatting, plain text only`;

    return {
      state: session.state,
      context: fullContext,
      awaitInput: script.awaitInput,
      choices: script.choices,
      action: script.action,
      session: session.toJSON()
    };
  }

  /**
   * Process user input and advance the demo state
   */
  processInput(session, userInput) {
    const script = EMILY_SCRIPTS[session.state] || {};
    const result = { actions: [], nextContext: null };

    // Handle email capture (welcome state)
    if (session.state === DemoState.WELCOME && userInput.includes('@')) {
      session.email = this._extractEmail(userInput);
      session.name = this._extractName(userInput) || 'there';
      session.state = DemoState.EMAIL_CAPTURE;
      result.actions.push({ type: 'email_captured', email: session.email, name: session.name });
      console.log(`[DEMO] Email captured: ${session.email}, name: ${session.name}`);
    }

    // Handle child info capture (email_capture state)
    else if (session.state === DemoState.EMAIL_CAPTURE) {
      const childInfo = this._parseChildInfo(userInput);
      session.childName = childInfo.name;
      session.childAge = childInfo.age;
      session.ageGroup = childInfo.ageGroup;
      session.interests = childInfo.interests;
      session.state = DemoState.CHILD_INFO;
      result.actions.push({ type: 'child_info_captured', ...childInfo });
      console.log(`[DEMO] Child info captured: ${childInfo.name}, age ${childInfo.age}, interests:`, childInfo.interests);
    }

    // Handle choice selection
    else if (session.state === DemoState.CHOICE_MENU) {
      const choice = this._parseChoice(userInput);
      if (choice === 'open_day') {
        session.state = DemoState.BOOKING_OPEN_DAY;
        session.choicesMade.push('open_day');
      } else if (choice === 'private_tour') {
        session.state = DemoState.BOOKING_TOUR;
        session.choicesMade.push('private_tour');
      } else if (choice === 'taster_day') {
        session.state = DemoState.BOOKING_TASTER;
        session.choicesMade.push('taster_day');
      }
      result.actions.push({ type: 'choice_made', choice });
      console.log(`[DEMO] Choice made: ${choice}`);
    }

    // Handle booking states - auto-advance after action
    else if ([DemoState.BOOKING_OPEN_DAY, DemoState.BOOKING_TOUR, DemoState.BOOKING_TASTER].includes(session.state)) {
      session.state = DemoState.BOOKING_CONFIRMED;
    }

    // Get next context
    result.nextContext = this.getEmilyContext(session);
    return result;
  }

  /**
   * Execute a demo action (API call)
   */
  async executeAction(session, action, crmClient) {
    console.log(`[DEMO] Executing action: ${action}`);

    if (action === 'generate_prospectus') {
      // Call prospectus API with child info - this also creates the enquiry
      const result = await crmClient.generateProspectus(session);
      if (result.success) {
        session.enquiryId = result.enquiryId;
        session.prospectusUrl = result.prospectusUrl;
        session.state = DemoState.PROSPECTUS_SENT;
      }
      return result;
    }

    if (action === 'create_enquiry') {
      const result = await crmClient.createEnquiry(session);
      if (result.success) {
        session.enquiryId = result.enquiryId;
        session.state = DemoState.CREATING_ENQUIRY;
      }
      return result;
    }

    if (action === 'reveal_crm') {
      session.state = DemoState.CRM_REVEAL;
      return { success: true, action: 'reveal_crm', enquiryId: session.enquiryId };
    }

    if (action === 'show_choices') {
      session.state = DemoState.CHOICE_MENU;
      return { success: true, action: 'show_choices' };
    }

    if (action === 'book_open_day') {
      const result = await crmClient.createBooking(session, 'open_day', 1);
      if (result.success) {
        session.bookingId = result.bookingId;
      }
      return result;
    }

    if (action === 'book_tour') {
      const result = await crmClient.createBooking(session, 'private_tour', 3);
      if (result.success) {
        session.bookingId = result.bookingId;
      }
      return result;
    }

    if (action === 'book_taster') {
      const result = await crmClient.createBooking(session, 'taster_day', 5);
      if (result.success) {
        session.bookingId = result.bookingId;
      }
      return result;
    }

    if (action === 'close_demo') {
      return { success: true, action: 'close_demo' };
    }

    return { success: false, error: `Unknown action: ${action}` };
  }

  /**
   * Extract email from user input
   */
  _extractEmail(text) {
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const match = text.match(emailPattern);
    return match ? match[0].toLowerCase() : text.trim();
  }

  /**
   * Extract name from user input
   */
  _extractName(text) {
    const textLower = text.toLowerCase();

    // Handle "Name, email" format
    if (text.includes(',') && text.includes('@')) {
      const parts = text.split(',');
      const namePart = parts[0].trim();
      if (!namePart.includes('@') && namePart) {
        return this._titleCase(namePart);
      }
    }

    // Patterns like "I'm John" or "My name is John"
    const patterns = ["i'm ", "im ", "i am ", "my name is ", "this is ", "call me "];
    for (const pattern of patterns) {
      if (textLower.includes(pattern)) {
        const idx = textLower.indexOf(pattern) + pattern.length;
        const rest = text.substring(idx).trim();
        const name = rest.split(/[\s,@]/)[0];
        if (name && !name.includes('@')) {
          return this._titleCase(name);
        }
      }
    }

    return null;
  }

  /**
   * Parse user's choice
   */
  _parseChoice(text) {
    const textLower = text.toLowerCase();

    if (['1', 'open day', 'open-day', 'openday'].some(x => textLower.includes(x))) {
      return 'open_day';
    }
    if (['2', 'tour', 'private tour'].some(x => textLower.includes(x))) {
      return 'private_tour';
    }
    if (['3', 'taster', 'taster day'].some(x => textLower.includes(x))) {
      return 'taster_day';
    }

    // Default to open day if unclear
    return 'open_day';
  }

  /**
   * Title case a string
   */
  _titleCase(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
  }

  /**
   * Parse child info from natural language
   * E.g., "My son Tom is 10, loves rugby and science"
   */
  _parseChildInfo(text) {
    const textLower = text.toLowerCase();
    const result = {
      name: 'Child',
      age: null,
      ageGroup: '11-16',  // default
      interests: {}
    };

    // Extract child's name
    // Patterns: "my son Tom", "my daughter Emma", "Tom is 10", "called Tom"
    const namePatterns = [
      /my (?:son|daughter|child)(?: is)? (\w+)/i,
      /(\w+) is (\d+)/i,
      /(?:called|named) (\w+)/i,
      /^(\w+)[,\s]/i  // First word before comma/space
    ];

    for (const pattern of namePatterns) {
      const match = text.match(pattern);
      if (match && match[1] && !['my', 'is', 'he', 'she', 'the', 'a', 'an'].includes(match[1].toLowerCase())) {
        result.name = this._titleCase(match[1]);
        break;
      }
    }

    // Extract age
    const ageMatch = text.match(/(\d+)\s*(?:years?\s*old|yrs?|y\.?o\.?)?/i) || text.match(/age[d]?\s*(\d+)/i);
    if (ageMatch) {
      result.age = parseInt(ageMatch[1], 10);
      // Map age to age group
      if (result.age <= 11) {
        result.ageGroup = '9-11';
      } else if (result.age <= 16) {
        result.ageGroup = '11-16';
      } else {
        result.ageGroup = '16-18';
      }
    }

    // Extract interests - map to prospectus API boolean fields
    const interestKeywords = {
      // Sports
      sport: ['sport', 'sports', 'rugby', 'football', 'soccer', 'tennis', 'swimming', 'athletics', 'hockey', 'netball', 'basketball', 'cricket', 'pe', 'physical education', 'gym'],
      // Sciences
      sciences: ['science', 'sciences', 'biology', 'chemistry', 'physics', 'stem'],
      // Mathematics
      mathematics: ['math', 'maths', 'mathematics', 'numbers'],
      // English
      english: ['english', 'reading', 'writing', 'literature', 'books'],
      // Languages
      languages: ['language', 'languages', 'french', 'spanish', 'german', 'mandarin', 'latin'],
      // Drama
      drama: ['drama', 'theatre', 'theater', 'acting', 'performance'],
      // Music
      music: ['music', 'singing', 'instrument', 'piano', 'guitar', 'violin', 'orchestra', 'choir', 'band'],
      // Art
      art: ['art', 'drawing', 'painting', 'creative', 'design', 'photography'],
      // Humanities
      humanities: ['history', 'geography', 'humanities', 'social studies'],
      // Leadership
      leadership: ['leadership', 'leader', 'debating', 'public speaking'],
      // Outdoor
      outdoor_education: ['outdoor', 'camping', 'nature', 'adventure', 'hiking']
    };

    for (const [field, keywords] of Object.entries(interestKeywords)) {
      if (keywords.some(kw => textLower.includes(kw))) {
        result.interests[field] = true;
      }
    }

    // Default: if no interests found, add a general one
    if (Object.keys(result.interests).length === 0) {
      result.interests.academic_excellence = true;
    }

    return result;
  }

  /**
   * Format interest key for display
   */
  _formatInterest(key) {
    const map = {
      sport: 'Sport',
      sciences: 'Science',
      mathematics: 'Mathematics',
      english: 'English',
      languages: 'Languages',
      drama: 'Drama',
      music: 'Music',
      art: 'Art',
      humanities: 'Humanities',
      leadership: 'Leadership',
      outdoor_education: 'Outdoor Education',
      academic_excellence: 'Academic Excellence'
    };
    return map[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
}

// Export singleton instance
const orchestrator = new DemoOrchestrator();

module.exports = {
  orchestrator,
  DemoState,
  DemoSession
};
