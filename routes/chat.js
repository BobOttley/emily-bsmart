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

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory conversation store (use Redis in production)
const conversations = new Map();

// Microsoft Graph API Email configuration
const MS_TENANT_ID = process.env.MS_TENANT_ID;
const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const MS_SENDER_EMAIL = process.env.MS_SENDER_EMAIL || process.env.EMAIL_FROM;
const NOTIFICATION_EMAILS = process.env.NOTIFICATION_EMAILS || 'bob.ottley@bsmart-ai.com,info@bsmart-ai.com';

// Get Microsoft Graph access token
async function getMsGraphToken() {
  const tokenUrl = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append('client_id', MS_CLIENT_ID);
  params.append('client_secret', MS_CLIENT_SECRET);
  params.append('scope', 'https://graph.microsoft.com/.default');
  params.append('grant_type', 'client_credentials');

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  const data = await response.json();
  return data.access_token;
}

// Send notification email via Microsoft Graph
async function sendNotificationEmail(subject, body) {
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    console.log('Microsoft Graph not configured - would send:', subject);
    return { success: false, error: 'Email not configured' };
  }

  try {
    const token = await getMsGraphToken();

    const emailData = {
      message: {
        subject: `[bSMART Emily] ${subject}`,
        body: {
          contentType: 'HTML',
          content: body
        },
        toRecipients: NOTIFICATION_EMAILS.split(',').map(email => ({
          emailAddress: { address: email.trim() }
        }))
      },
      saveToSentItems: false
    };

    const response = await fetch(
      `https://graph.microsoft.com/v1.0/users/${MS_SENDER_EMAIL}/sendMail`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailData)
      }
    );

    if (response.ok || response.status === 202) {
      console.log('Notification email sent via Microsoft Graph:', subject);
      return { success: true };
    } else {
      const err = await response.text();
      console.error('Microsoft Graph email error:', err);
      return { success: false, error: err };
    }
  } catch (err) {
    console.error('Email error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * POST /api/:schoolId/chat
 *
 * Main chat endpoint for text conversations
 */
router.post('/', async (req, res) => {
  const { message, session_id, family_id, family_context } = req.body;
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

  try {
    // Load knowledge base
    const knowledgeBase = loadKnowledgeBase(school);

    // Build system prompt
    const systemPrompt = buildChatSystemPrompt(school, conversation.familyContext, knowledgeBase);

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
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: apiMessages,
      temperature: 0.7,
      max_tokens: 800,
      functions: [
        {
          name: 'book_demo',
          description: 'Book a demo with Bob Ottley. Use when someone wants a demo, meeting, or pricing info. Collect their name, email, and school first.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Contact name' },
              email: { type: 'string', description: 'Contact email' },
              school: { type: 'string', description: 'School or organisation' },
              role: { type: 'string', description: 'Their role' },
              interests: { type: 'string', description: 'Which SMART products' }
            },
            required: ['name', 'email', 'school']
          }
        }
      ],
      function_call: 'auto'
    });

    let assistantMessage = completion.choices[0].message;
    let response = assistantMessage.content;

    // Handle function calls
    if (assistantMessage.function_call) {
      const functionName = assistantMessage.function_call.name;
      const functionArgs = JSON.parse(assistantMessage.function_call.arguments);

      if (functionName === 'book_demo') {
        // Log the demo request
        console.log(`Demo request from chat: ${functionArgs.name} (${functionArgs.email}) at ${functionArgs.school}`);

        // Send notification email to Bob via Microsoft Graph
        const emailBody = `
          <h2>New Demo Request from bSMART Website (Chat)</h2>
          <p><strong>Name:</strong> ${functionArgs.name}</p>
          <p><strong>Email:</strong> ${functionArgs.email}</p>
          <p><strong>School:</strong> ${functionArgs.school || 'Not provided'}</p>
          <p><strong>Role:</strong> ${functionArgs.role || 'Not provided'}</p>
          <p><strong>Interested in:</strong> ${functionArgs.interests || 'Not specified'}</p>
          <hr>
          <p><em>This lead was captured by Emily via text chat on the bSMART website.</em></p>
        `;

        const emailResult = await sendNotificationEmail(
          `Demo Request: ${functionArgs.name} from ${functionArgs.school || 'Unknown School'}`,
          emailBody
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

        const followUp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: functionMessages,
          temperature: 0.7,
          max_tokens: 1000
        });

        response = followUp.choices[0].message.content;
      }
    }

    // Store assistant response
    conversation.messages.push({
      role: 'assistant',
      content: response
    });

    res.json({
      success: true,
      response: response,
      session_id: sessionId,
      school: school.shortName
    });

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

function buildChatSystemPrompt(school, familyContext, knowledgeBase) {
  // bSMART-specific prompt
  let prompt = `You are Emily, the friendly AI sales assistant for bSMART AI. You demonstrate what bSMART can do - you ARE the product!

VOICE AND ACCENT:
- British accent - speak like a well-educated English woman
- Use British vocabulary: lovely, brilliant, enquiry, marvellous, rather, quite

PERSONALITY:
- Warm, professional, knowledgeable about school admissions
- British English spelling (colour, centre, organise)
- Concise and enthusiastic about how bSMART helps schools
- Consultative - understand their needs before pitching

YOUR ROLE:
- You ARE SMART Chat - demonstrate the product by being helpful
- Answer questions about bSMART AI's 8 products
- Help visitors understand how everything connects together
- Gently guide conversations toward booking a demo with Bob Ottley
- Capture contact details naturally through conversation

THE 8 SMART PRODUCTS:
1. SMART Prospectus - Interactive personalised digital prospectus with 70+ personalisation points
2. SMART Chat - 24/7 AI assistant (that's you!) for questions, tour bookings, enquiry capture
3. SMART Voice - Natural voice conversations and audio tours in 100+ languages
4. SMART Phone - AI telephone answering with warm handoff to staff
5. SMART CRM - Admissions command centre with complete family journey view
6. SMART Email - Personalised communications, not generic templates
7. SMART Booking - Visit management for open days and tours
8. Analytics - Data insights across the entire family journey

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

DEMO BOOKING RULES:
- When someone wants to book a demo, ask for their details ONE TIME ONLY
- Request: name, email, school name, and role
- NEVER repeat the same question if they've already answered it
- If they give incomplete info, ask only for the missing pieces
- Once you have name, email, and school - call the book_demo function immediately
- Interests are optional - don't wait for them

SALES APPROACH:
- Be helpful first, sales second
- If they ask about pricing, explain it varies by school size and products - suggest a demo to discuss their specific needs
- Offer to book a demo after explaining products or answering questions
- If they seem interested but haven't asked for a demo, gently suggest one

GENERAL RULES:
- Never make up information
- Keep responses under 100 words
- No markdown formatting (no asterisks, no bullet points)
- NEVER repeat yourself - check conversation history
- Be enthusiastic but not pushy
`;

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
