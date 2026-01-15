/**
 * Demo Routes - API endpoints for the demo orchestrator
 *
 * These endpoints power the bSMART AI demo experience.
 */

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const { orchestrator, DemoState } = require('../demo/orchestrator');
const crmClient = require('../demo/crm-client');

// Initialize OpenAI
let openai = null;
function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

/**
 * POST /api/demo/start
 * Start a new demo session
 */
router.post('/start', (req, res) => {
  const session = orchestrator.createSession();
  const context = orchestrator.getEmilyContext(session);

  res.json({
    success: true,
    session_id: session.sessionId,
    state: session.state,
    emily_context: context
  });
});

/**
 * GET /api/demo/session/:sessionId
 * Get current demo session state
 */
router.get('/session/:sessionId', (req, res) => {
  const session = orchestrator.getSession(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  const context = orchestrator.getEmilyContext(session);

  res.json({
    success: true,
    session: session.toJSON(),
    emily_context: context
  });
});

/**
 * POST /api/demo/chat
 * Main chat endpoint - processes user input and generates EMILY response
 */
router.post('/chat', async (req, res) => {
  const { session_id, message } = req.body;

  if (!session_id) {
    return res.status(400).json({ success: false, error: 'session_id is required' });
  }

  const session = orchestrator.getSession(session_id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  console.log(`[DEMO] Chat - State: ${session.state}, Message: "${message}"`);

  // Store user message in chat history
  if (message) {
    session.chatHistory.push({ role: 'user', content: message });
  }

  // Process user input - may advance state
  const processResult = orchestrator.processInput(session, message || '');

  // Get updated context
  let context = orchestrator.getEmilyContext(session);
  let actionResult = null;

  // Check if there's an action to execute
  if (context.action) {
    console.log(`[DEMO] Executing action: ${context.action}`);
    actionResult = await orchestrator.executeAction(session, context.action, crmClient);
    console.log(`[DEMO] Action result:`, actionResult);

    // Refresh context after action
    context = orchestrator.getEmilyContext(session);

    // Chain actions if needed (e.g., reveal_crm after create_enquiry)
    if (context.action && context.action !== processResult.nextContext?.action) {
      console.log(`[DEMO] Chaining action: ${context.action}`);
      const chainedResult = await orchestrator.executeAction(session, context.action, crmClient);
      if (chainedResult.action === 'reveal_crm') {
        actionResult = chainedResult;
      }
      context = orchestrator.getEmilyContext(session);
    }
  }

  // Generate EMILY's response using OpenAI
  let emilyResponse;
  try {
    const systemPrompt = buildDemoSystemPrompt(session, context, actionResult);

    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...session.chatHistory.slice(-6),
        { role: 'user', content: message || 'Start the demo' }
      ],
      max_tokens: 400,
      temperature: 0.7
    });

    emilyResponse = completion.choices[0].message.content;
  } catch (err) {
    console.error('[DEMO] OpenAI error:', err.message);
    // Fallback to scripted response
    emilyResponse = extractScriptedResponse(context.context);
  }

  // Store assistant response
  session.chatHistory.push({ role: 'assistant', content: emilyResponse });

  // Build suggestion buttons based on state
  const { suggestions, queryMap } = getSuggestionsForState(session.state);

  res.json({
    success: true,
    response: emilyResponse,
    session_id: session.sessionId,
    state: session.state,
    enquiry_id: session.enquiryId,
    booking_id: session.bookingId,
    child_name: session.childName,
    child_age: session.childAge,
    interests: session.interests,
    prospectus_url: session.prospectusUrl,
    action_result: actionResult,
    suggestions,
    query_map: queryMap
  });
});

/**
 * POST /api/demo/advance
 * Manually advance to a specific state (for debugging/testing)
 */
router.post('/advance', (req, res) => {
  const { session_id, state } = req.body;

  if (!session_id) {
    return res.status(400).json({ success: false, error: 'session_id is required' });
  }

  const session = orchestrator.getSession(session_id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  if (state && Object.values(DemoState).includes(state)) {
    session.state = state;
  }

  const context = orchestrator.getEmilyContext(session);

  res.json({
    success: true,
    session: session.toJSON(),
    emily_context: context
  });
});

/**
 * POST /api/demo/action
 * Execute a specific demo action
 */
router.post('/action', async (req, res) => {
  const { session_id, action } = req.body;

  if (!session_id || !action) {
    return res.status(400).json({ success: false, error: 'session_id and action are required' });
  }

  const session = orchestrator.getSession(session_id);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  const result = await orchestrator.executeAction(session, action, crmClient);
  const context = orchestrator.getEmilyContext(session);

  res.json({
    success: result.success,
    result,
    session: session.toJSON(),
    emily_context: context
  });
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function buildDemoSystemPrompt(session, context, actionResult) {
  // Build interests string for context
  const interestsStr = Object.keys(session.interests || {})
    .filter(k => session.interests[k])
    .join(', ') || 'various subjects';

  return `You are EMILY, running a LIVE DEMO for a prospective school software customer.

CURRENT DEMO STATE: ${session.state}
PROSPECT NAME: ${session.name || 'there'}
PROSPECT EMAIL: ${session.email || 'not yet captured'}
CHILD NAME: ${session.childName || 'not yet captured'}
CHILD AGE: ${session.childAge || 'not yet captured'}
INTERESTS: ${interestsStr}
ENQUIRY ID: ${session.enquiryId || 'not yet created'}
PROSPECTUS URL: ${session.prospectusUrl || 'not yet generated'}
BOOKING ID: ${session.bookingId || 'not yet created'}

YOUR INSTRUCTIONS FOR THIS STATE:
${context.context}

IMPORTANT GUIDELINES:
- You're showing off bSMART AI's school admissions platform
- Be enthusiastic, professional, and impressive
- Guide the prospect through the demo naturally
- When they make choices, acknowledge and narrate what's happening
- Make them feel like they're experiencing real magic
- Keep responses concise but engaging (2-4 sentences usually)
- If they ask off-topic questions, briefly answer then guide back to demo
- Use British English spelling (colour, centre, organise)
- NO asterisks, NO markdown, plain text only

${actionResult ? `ACTION JUST COMPLETED: ${JSON.stringify(actionResult)}` : ''}`;
}

function extractScriptedResponse(context) {
  // Try to extract the suggested dialogue from the context
  if (context.includes('Say something like:')) {
    const parts = context.split('Say something like:');
    if (parts[1]) {
      return parts[1].trim().replace(/^["']|["']$/g, '').split('\n\n')[0];
    }
  }
  return "I'm here to guide you through the demo. How can I help?";
}

function getSuggestionsForState(state) {
  const suggestions = [];
  const queryMap = {};

  switch (state) {
    case DemoState.WELCOME:
      // Example button to help users get started
      suggestions.push('Use my details: Bob, bob@example.com');
      queryMap['Use my details: Bob, bob@example.com'] = 'Bob Ottley, bob.ottley@bsmart-ai.com';
      break;

    case DemoState.EMAIL_CAPTURE:
      // Suggest example child info (More House is an all-girls school)
      suggestions.push('Try: "Sophie, 11, loves drama and science"');
      queryMap['Try: "Sophie, 11, loves drama and science"'] = 'My daughter Sophie is 11, loves drama and science';
      break;

    case DemoState.CHILD_INFO:
    case DemoState.GENERATING_PROSPECTUS:
      // Processing - no buttons needed
      break;

    case DemoState.PROSPECTUS_SENT:
      suggestions.push('I checked my inbox!', 'Tell me about the prospectus');
      queryMap['I checked my inbox!'] = 'I received the prospectus email, it looks great!';
      queryMap['Tell me about the prospectus'] = 'Tell me more about how the prospectus personalisation works';
      break;

    case DemoState.CRM_REVEAL:
      suggestions.push('Show me booking options', 'Tell me about the CRM', 'What else can Emily do?');
      queryMap['Show me booking options'] = 'Show me the booking options';
      queryMap['Tell me about the CRM'] = 'Tell me more about the CRM features';
      queryMap['What else can Emily do?'] = 'What else can Emily do for schools?';
      break;

    case DemoState.CHOICE_MENU:
      suggestions.push('Book an Open Day', 'Schedule a Private Tour', 'Arrange a Taster Day');
      queryMap['Book an Open Day'] = "I'd like to book an Open Day";
      queryMap['Schedule a Private Tour'] = "I'd like to schedule a Private Tour";
      queryMap['Arrange a Taster Day'] = "I'd like to arrange a Taster Day";
      break;

    case DemoState.BOOKING_OPEN_DAY:
    case DemoState.BOOKING_TOUR:
    case DemoState.BOOKING_TASTER:
      // Processing booking - no buttons
      break;

    case DemoState.BOOKING_CONFIRMED:
      suggestions.push('Show more features', 'Talk to Bob', 'Book another event');
      queryMap['Show more features'] = 'Show me more features like Smart Reply and Analytics';
      queryMap['Talk to Bob'] = "I'd like to talk to Bob about getting this for my school";
      queryMap['Book another event'] = "Let me try booking another type of event";
      break;

    case DemoState.CLOSE:
      suggestions.push('Book a call with Bob', 'Send me info pack', 'Restart demo');
      queryMap['Book a call with Bob'] = 'Please arrange a call with Bob to discuss further';
      queryMap['Send me info pack'] = 'Send me an information pack about bSMART AI';
      queryMap['Restart demo'] = 'Can I start the demo again from the beginning?';
      break;
  }

  return { suggestions, queryMap };
}

module.exports = router;
