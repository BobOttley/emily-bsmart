/**
 * Chat Route Handler
 *
 * Handles text-based chat interactions with Emily.
 * School-specific context is injected via middleware.
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

// Import shared email utility
const { sendNotificationEmail, buildDemoRequestEmail, buildContactEmail } = require('../utils/email');

// Initialize OpenAI client (deferred to allow server to start without API key)
let openai = null;

function getOpenAIClient() {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

// In-memory conversation store (use Redis in production)
const conversations = new Map();

/**
 * POST /api/:schoolId/chat
 *
 * Main chat endpoint for text conversations
 */
router.post('/', async (req, res) => {
  const { message, session_id, family_id, family_context, screen_context } = req.body;
  const school = req.school;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Get or create conversation history
  const sessionId = session_id || `${school.id}-${Date.now()}`;
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, {
      messages: [],
      familyContext: family_context || {},
      schoolId: school.id,
      createdAt: new Date()
    });
  }

  const conversation = conversations.get(sessionId);

  // Store screen context in conversation
  if (screen_context) {
    conversation.screenContext = screen_context;
  }

  try {
    // Load knowledge base
    const knowledgeBase = loadKnowledgeBase(school);

    // Build system prompt with screen awareness
    const systemPrompt = buildChatSystemPrompt(school, conversation.familyContext, knowledgeBase, screen_context);

    // Add user message to history
    conversation.messages.push({
      role: 'user',
      content: message
    });

    // Prepare messages for API
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...conversation.messages.slice(-10) // Keep last 10 messages for context
    ];

    // Call OpenAI
    const completion = await getOpenAIClient().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: apiMessages,
      temperature: 0.7,
      max_tokens: 800,
      functions: [
        {
          name: 'book_demo',
          description: 'IMMEDIATELY book a demo with Bob Ottley. Call this function AS SOON AS you have collected: name, email, school, role, and which products they want. Do NOT ask any more questions after collecting these - just call this function.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Contact name' },
              email: { type: 'string', description: 'Contact email' },
              school: { type: 'string', description: 'School or organisation name' },
              role: { type: 'string', description: 'Their role at the school' },
              interests: { type: 'string', description: 'Which SMART products they want to see' }
            },
            required: ['name', 'email', 'school', 'role', 'interests']
          }
        },
        {
          name: 'contact_us',
          description: 'Send a contact enquiry when someone has a question and wants to be contacted. Collect their name, email, school, and their question.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Contact name' },
              email: { type: 'string', description: 'Contact email' },
              school: { type: 'string', description: 'School or organisation name' },
              question: { type: 'string', description: 'Their question or what they want to discuss' }
            },
            required: ['name', 'email', 'question']
          }
        },
        {
          name: 'show_on_page',
          description: 'Scroll to and highlight a section on the webpage to show the visitor. Use this when they ask "where is..." or "show me..." or when you want to point them to something specific. Available sections: hero, problem, ecosystem, journey, products, product-prospectus, product-chat, product-voice, product-phone, product-crm, product-email, product-booking, deployment, emily, results, cta',
          parameters: {
            type: 'object',
            properties: {
              section: {
                type: 'string',
                description: 'Section ID to show. One of: hero, problem, ecosystem, journey, products, product-prospectus, product-chat, product-voice, product-phone, product-crm, product-email, product-booking, deployment, emily, results, cta',
                enum: ['hero', 'problem', 'ecosystem', 'journey', 'products', 'product-prospectus', 'product-chat', 'product-voice', 'product-phone', 'product-crm', 'product-email', 'product-booking', 'deployment', 'emily', 'results', 'cta']
              },
              action: {
                type: 'string',
                description: 'What to do: scroll_only (just scroll), highlight (scroll and glow)',
                enum: ['scroll_only', 'highlight'],
                default: 'highlight'
              }
            },
            required: ['section']
          }
        }
      ],
      function_call: 'auto'
    });

    let assistantMessage = completion.choices[0].message;
    let response = assistantMessage.content;
    let pageAction = null; // For co-browsing actions

    // Handle function calls
    if (assistantMessage.function_call) {
      const functionName = assistantMessage.function_call.name;
      const functionArgs = JSON.parse(assistantMessage.function_call.arguments);

      if (functionName === 'book_demo') {
        // Log the demo request
        console.log(`Demo request from chat: ${functionArgs.name} (${functionArgs.email}) at ${functionArgs.school}`);

        // Send branded notification email with conversation history
        const emailBody = buildDemoRequestEmail({
          name: functionArgs.name,
          email: functionArgs.email,
          school: functionArgs.school,
          role: functionArgs.role,
          interests: functionArgs.interests,
          conversation: conversation.messages // Include chat history
        }, 'Chat');

        const emailResult = await sendNotificationEmail(
          `Demo Request: ${functionArgs.name} from ${functionArgs.school || 'Unknown School'}`,
          emailBody,
          functionArgs.email // CC the person
        );

        // Send notification and get response
        const demoResult = {
          ok: true,
          email_sent: emailResult.success,
          message: `Thanks ${functionArgs.name}! I've sent your details to Bob Ottley. He'll be in touch shortly to arrange a demo.`
        };

        // Send function result back to get final response
        const functionMessages = [
          ...apiMessages,
          assistantMessage,
          {
            role: 'function',
            name: 'book_demo',
            content: JSON.stringify(demoResult)
          }
        ];

        const followUp = await getOpenAIClient().chat.completions.create({
          model: 'gpt-4o-mini',
          messages: functionMessages,
          temperature: 0.7,
          max_tokens: 1000
        });

        response = followUp.choices[0].message.content;
      } else if (functionName === 'contact_us') {
        // Log the contact request
        console.log(`Contact enquiry from chat: ${functionArgs.name} (${functionArgs.email})`);

        // Send contact enquiry email
        const emailBody = buildContactEmail({
          name: functionArgs.name,
          email: functionArgs.email,
          school: functionArgs.school,
          question: functionArgs.question,
          conversation: conversation.messages
        });

        const emailResult = await sendNotificationEmail(
          `Enquiry: ${functionArgs.name} from ${functionArgs.school || 'Unknown'}`,
          emailBody,
          functionArgs.email // CC the person
        );

        const contactResult = {
          ok: true,
          email_sent: emailResult.success,
          message: `Thanks ${functionArgs.name}! I've sent your enquiry to the team. Someone will be in touch shortly.`
        };

        const functionMessages = [
          ...apiMessages,
          assistantMessage,
          {
            role: 'function',
            name: 'contact_us',
            content: JSON.stringify(contactResult)
          }
        ];

        const followUp = await getOpenAIClient().chat.completions.create({
          model: 'gpt-4o-mini',
          messages: functionMessages,
          temperature: 0.7,
          max_tokens: 1000
        });

        response = followUp.choices[0].message.content;
      } else if (functionName === 'show_on_page') {
        // Handle page navigation/highlighting
        console.log(`Page action from chat: show ${functionArgs.section}`);

        pageAction = {
          type: functionArgs.action === 'scroll_only' ? 'scroll_to' : 'show',
          section: functionArgs.section,
          duration: 5000
        };

        const showResult = {
          ok: true,
          message: `Showing ${functionArgs.section} on the page`
        };

        const functionMessages = [
          ...apiMessages,
          assistantMessage,
          {
            role: 'function',
            name: 'show_on_page',
            content: JSON.stringify(showResult)
          }
        ];

        const followUp = await getOpenAIClient().chat.completions.create({
          model: 'gpt-4o-mini',
          messages: functionMessages,
          temperature: 0.7,
          max_tokens: 500
        });

        response = followUp.choices[0].message.content;
      }
    }

    // Store assistant response
    conversation.messages.push({
      role: 'assistant',
      content: response
    });

    const jsonResponse = {
      success: true,
      response: response,
      session_id: sessionId,
      school: school.shortName
    };

    // Include page action if one was triggered
    if (pageAction) {
      jsonResponse.page_action = pageAction;
    }

    res.json(jsonResponse);

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({
      error: 'Failed to process message',
      message: "I'm sorry, I encountered an error. Please try again."
    });
  }
});

/**
 * POST /api/:schoolId/chat/start
 *
 * Start a new chat session with optional family context
 */
router.post('/start', (req, res) => {
  const { family_id, family_context } = req.body;
  const school = req.school;

  const sessionId = `${school.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  conversations.set(sessionId, {
    messages: [],
    familyContext: family_context || {},
    familyId: family_id,
    schoolId: school.id,
    createdAt: new Date()
  });

  // Generate welcome message
  const familyName = family_context?.parent_name || family_context?.child_name;
  let greeting = school.emilyPersonality?.greeting || `Hello! I'm Emily, your guide to ${school.name}.`;

  if (familyName) {
    greeting = `Hello ${familyName}! I'm Emily, your guide to ${school.name}. How can I help you today?`;
  }

  res.json({
    success: true,
    session_id: sessionId,
    school: {
      id: school.id,
      name: school.name,
      shortName: school.shortName,
      theme: school.theme
    },
    greeting: greeting
  });
});

/**
 * GET /api/:schoolId/chat/history/:sessionId
 *
 * Get chat history for a session
 */
router.get('/history/:sessionId', (req, res) => {
  const conversation = conversations.get(req.params.sessionId);

  if (!conversation) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Verify session belongs to this school
  if (conversation.schoolId !== req.school.id) {
    return res.status(403).json({ error: 'Session belongs to different school' });
  }

  res.json({
    session_id: req.params.sessionId,
    messages: conversation.messages,
    createdAt: conversation.createdAt
  });
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function loadKnowledgeBase(school) {
  try {
    const kbPath = path.join(__dirname, '..', 'knowledge-bases', school.knowledgeBase);
    return fs.readFileSync(kbPath, 'utf8');
  } catch (err) {
    console.error(`Failed to load knowledge base for ${school.id}:`, err);
    return '';
  }
}

function buildChatSystemPrompt(school, familyContext, knowledgeBase, screenContext) {
  // bSMART-specific prompt
  let prompt = `You are Emily, the AI assistant for bSMART AI. You're here to answer questions about the apps, explain how they work, discuss security, outline the benefits, book demos, or contact the company on behalf of visitors by email. You ARE the product - a demonstration of what bSMART AI can do for schools.

VOICE AND ACCENT (CRITICAL):
- You MUST have a BRITISH ACCENT at all times - speak like a well-educated English woman
- Use British vocabulary: lovely, brilliant, enquiry, marvellous, rather, quite
- ALWAYS use British spelling: colour, centre, organise, personalise, favourite, behaviour

PERSONALITY:
- Warm, professional, knowledgeable about school admissions
- Concise and enthusiastic about how bSMART helps schools
- Consultative - understand their needs before pitching

YOUR ROLE:
- You ARE SMART Chat - demonstrate the product by being helpful
- Answer questions about bSMART AI's 7 products
- Help visitors understand how everything connects together
- Gently guide conversations toward booking a demo with Bob Ottley
- Capture contact details naturally through conversation

THE 7 SMART PRODUCTS:
1. SMART Prospectus - Interactive personalised digital prospectus with 70+ personalisation points
2. SMART Chat - 24/7 AI assistant (that's you!) for questions, tour bookings, enquiry capture
3. SMART Voice - Natural voice conversations and audio tours in 100+ languages
4. SMART CRM - Admissions command centre with complete family journey view
5. SMART Email - Personalised communications, not generic templates
6. SMART Booking - Visit management for open days and tours
7. Analytics - Data insights across the entire family journey

KEY SELLING POINTS:
- Everything connects - chat, calls, prospectus views, visits all in one CRM
- Emily (the AI) never makes things up - only uses verified school data
- Built specifically for school admissions, not generic software adapted
- 100+ languages supported
- 4-8 weeks to implement
- Most schools start with Chat + CRM, add more as needed

CONTACT:
- Email: info@bsmart-ai.com
- Bob Ottley (Founder): bob.ottley@bsmart-ai.com

KNOWLEDGE BASE:
${knowledgeBase || ''}

DEMO BOOKING / CONTACT RULES (CRITICAL):
- BE EFFICIENT. Ask for MULTIPLE pieces of information at once, not one at a time.
- Example: "Lovely! Could you share your name, email, school and role?"
- If they've ALREADY MENTIONED a product (e.g. "discuss the prospectus"), DO NOT ask again which products interest them - you already know!
- Read their messages carefully - extract any info they've already given (name, email, phone, school, product interest)
- Required for demo: name, email, school, role, interests (but interests can be inferred from conversation)
- Required for contact: name, email, question (school is optional)
- Once you have what you need, IMMEDIATELY call the function. No more questions.

SALES APPROACH:
- Be helpful first, sales second
- If they ask about pricing, explain it varies by school size - suggest a demo
- Gently suggest demos after answering questions

GENERAL RULES:
- Never make up information
- Keep responses SHORT - under 50 words ideally
- ABSOLUTELY NO ASTERISKS. NO ** EVER. NO * EVER. NO MARKDOWN. NO BOLD. NO FORMATTING. PLAIN TEXT ONLY.
- Never use numbered lists with periods (1. 2. 3.) - use natural sentences instead
- NEVER repeat yourself or ask for info already provided
- Be enthusiastic but not pushy
`;

  // Add screen awareness context if available
  if (screenContext) {
    prompt += `

SCREEN AWARENESS (CRITICAL - You can see what the visitor is looking at!):
You have the ability to see which section of the website the visitor is currently viewing. This is a key feature to demonstrate!

CURRENT VIEWING CONTEXT:
- Currently viewing: ${screenContext.currentSection ? `"${screenContext.currentLabel || screenContext.currentSection}" - ${screenContext.currentDescription || 'No description'}` : 'Unknown section'}
- Recent browsing history: ${screenContext.sectionHistory?.length > 0 ? screenContext.sectionHistory.join(' → ') : 'Just arrived'}

CO-BROWSING ACTIONS (USE THESE!):
You can scroll the page to sections and highlight them with a glowing effect. Use the show_on_page function when:
1. The visitor asks "where is..." or "show me..." something
2. You want to direct their attention to a relevant section
3. They seem interested in a topic and you want to show them that section

Available sections to show:
- hero: Main landing area
- problem: The problem section (generic communications)
- ecosystem: How all 8 products connect together
- journey: Before/after comparison
- products: Overview of all 8 products
- product-prospectus, product-chat, product-voice, product-phone, product-crm, product-email, product-booking: Individual product cards
- deployment: Start small or enterprise options
- emily: About Emily (that's you!)
- results: Key metrics and outcomes
- cta: Book a demo call-to-action

SCREEN AWARENESS BEHAVIOURS:
1. If they're viewing a section, you can naturally reference it: "I see you're looking at the CRM section - that's the heart of the system!"
2. If they ask about something not on screen, offer to show them: "Want me to scroll you to that section? I can highlight it for you."
3. Use this to demonstrate SMART Chat's intelligence - "See how I know what you're looking at? This is exactly what SMART Chat does for schools."
4. Don't overdo it - mention screen awareness once or twice, not every message
`;
  }

  return prompt;
}

async function getProspectusSection(school, sectionId, familyContext) {
  // Get section metadata
  const meta = school.sectionMeta?.[sectionId] || {
    title: sectionId.replace(/_/g, ' '),
    intro: `Let me tell you about ${sectionId.replace(/_/g, ' ')}`,
    followUp: []
  };

  // Try to load actual prospectus content
  let content = {
    title: meta.title,
    fullText: `Information about ${meta.title} at ${school.name}.`
  };

  try {
    // Load prospectus HTML
    const prospectusPath = path.join(__dirname, '..', '..', school.id, 'prospectus.html');
    if (fs.existsSync(prospectusPath)) {
      const cheerio = require('cheerio');
      const html = fs.readFileSync(prospectusPath, 'utf8');
      const $ = cheerio.load(html);

      const sectionEl = $(`[data-module="${sectionId}"]`);
      if (sectionEl.length) {
        content = {
          title: sectionEl.find('.module__title').text().trim() || meta.title,
          paragraphs: [],
          highlights: [],
          fullText: sectionEl.text().replace(/\s+/g, ' ').trim().substring(0, 2000)
        };

        sectionEl.find('p').each((i, el) => {
          const text = $(el).text().trim();
          if (text && text.length > 10) {
            content.paragraphs.push(text);
          }
        });
      }
    }
  } catch (err) {
    console.error(`Failed to load prospectus section ${sectionId}:`, err);
  }

  return {
    school: {
      name: school.name,
      shortName: school.shortName
    },
    section: sectionId,
    meta: meta,
    content: content,
    family: familyContext || {}
  };
}

module.exports = router;
