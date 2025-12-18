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
          name: 'get_prospectus_section',
          description: 'Retrieve content from a specific section of the prospectus',
          parameters: {
            type: 'object',
            properties: {
              section: {
                type: 'string',
                description: 'The section ID to retrieve'
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

    // Handle function calls
    if (assistantMessage.function_call) {
      const functionName = assistantMessage.function_call.name;
      const functionArgs = JSON.parse(assistantMessage.function_call.arguments);

      if (functionName === 'get_prospectus_section') {
        // Get section content
        const sectionData = await getProspectusSection(school, functionArgs.section, conversation.familyContext);

        // Send function result back to get final response
        const functionMessages = [
          ...apiMessages,
          assistantMessage,
          {
            role: 'function',
            name: 'get_prospectus_section',
            content: JSON.stringify(sectionData)
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
  let prompt = `You are Emily, a warm and knowledgeable AI assistant for ${school.name}.
You help prospective families learn about the school through friendly conversation.

PERSONALITY:
- Warm, professional, and genuinely helpful
- Use British English (lovely, brilliant, enquiry, etc.)
- Keep responses concise but informative
- Be conversational, not formal

SCHOOL: ${school.name} (${school.shortName})
- Type: ${school.type === 'girls' ? 'Girls school' : school.type === 'co-ed' ? 'Co-educational' : school.type}
- Email: ${school.contact.email}
- Phone: ${school.contact.phone}
- Website: ${school.contact.website}

`;

  if (familyContext && (familyContext.parent_name || familyContext.child_name)) {
    prompt += `
FAMILY CONTEXT:
${familyContext.parent_name ? `- Parent: ${familyContext.parent_name}` : ''}
${familyContext.child_name ? `- Child: ${familyContext.child_name}` : ''}
${familyContext.entry_point ? `- Interested in: ${familyContext.entry_point}` : ''}
${familyContext.interests ? `- Interests: ${familyContext.interests.join(', ')}` : ''}

Personalise your responses using their names and interests where appropriate.
IMPORTANT: Use the EXACT parent name provided above - do NOT assume or add additional family members like "Mr & Mrs".
`;
  }

  if (knowledgeBase) {
    prompt += `
SCHOOL INFORMATION:
${knowledgeBase.substring(0, 5000)}

Use this information to answer questions accurately. If you don't know something, offer to connect them with admissions.
`;
  }

  prompt += `
CAPABILITIES:
- Answer questions about the school
- Offer audio tours of prospectus sections (use get_prospectus_section function)
- Help with admissions enquiries
- Book visits or open days

FORMAT:
- Keep responses under 150 words unless detail is needed
- Never use markdown formatting
- Speak naturally and conversationally
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
