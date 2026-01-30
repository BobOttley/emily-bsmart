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

// Import calendar service for Teams meeting booking
const calendarService = require('../services/calendar');

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
  const { message, session_id, family_id, family_context, screen_context, user_details } = req.body;
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

  // Store user details if provided (from booking form)
  if (user_details && user_details.email) {
    conversation.userDetails = user_details;
    console.log('STORED USER DETAILS IN SESSION:', user_details);
  }

  // Check if user wants to enter demo mode with More House
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes('try') && (lowerMessage.includes('demo') || lowerMessage.includes('chat demo') || lowerMessage.includes('voice demo')) &&
      (lowerMessage.includes('school') || lowerMessage.includes('example') || lowerMessage.includes('more house'))) {
    conversation.demoMode = true;
  }

  try {
    // Load knowledge base (use More House demo KB if in demo mode)
    const knowledgeBase = loadKnowledgeBase(school, conversation.demoMode);

    // Build system prompt with screen awareness and demo mode
    const systemPrompt = buildChatSystemPrompt(school, conversation.familyContext, knowledgeBase, screen_context, conversation.demoMode);

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
          description: 'ONLY use this when someone explicitly says they do NOT want to book a specific time and just want Bob to contact them later. This sends an email to Bob but does NOT book a meeting. For actual demo bookings with a calendar invite, you MUST use schedule_meeting instead after asking: 1) Teams or in-person, 2) What week, 3) What time.',
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
        },
        {
          name: 'schedule_meeting',
          description: 'Schedule a meeting with Bob Ottley. Can be Teams call or in-person visit. For in-person meetings, you MUST collect the location first. First ask what time suits them, then call this function.',
          parameters: {
            type: 'object',
            properties: {
              requested_time: {
                type: 'string',
                description: 'The time the user requested, e.g. "tomorrow at 2pm", "next Tuesday 10am", "3pm"'
              },
              attendee_name: {
                type: 'string',
                description: 'Name of the person booking the meeting'
              },
              attendee_email: {
                type: 'string',
                description: 'Email address of the person booking the meeting'
              },
              meeting_type: {
                type: 'string',
                description: 'Type of meeting: teams (default) or in_person',
                enum: ['teams', 'in_person'],
                default: 'teams'
              },
              location: {
                type: 'string',
                description: 'REQUIRED for in_person meetings. The address or location, e.g. "St Mary School, London" or "bSMART office"'
              },
              school_name: {
                type: 'string',
                description: 'Name of their school'
              },
              topic: {
                type: 'string',
                description: 'What they want to discuss, e.g. "SMART Prospectus demo", "Full platform demo"'
              }
            },
            required: ['requested_time', 'attendee_name', 'attendee_email']
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
      } else if (functionName === 'schedule_meeting') {
        // Handle calendar/meeting booking
        // CRITICAL: Use stored user details if available, don't rely on AI extraction
        let attendeeName = functionArgs.attendee_name;
        let attendeeEmail = functionArgs.attendee_email;

        // Override with stored user details if AI gave wrong email
        if (conversation.userDetails) {
          if (conversation.userDetails.email && conversation.userDetails.email !== attendeeEmail) {
            console.log(`EMAIL OVERRIDE: AI extracted "${attendeeEmail}" but user entered "${conversation.userDetails.email}"`);
            attendeeEmail = conversation.userDetails.email;
          }
          if (conversation.userDetails.name && conversation.userDetails.name !== attendeeName) {
            console.log(`NAME OVERRIDE: AI extracted "${attendeeName}" but user entered "${conversation.userDetails.name}"`);
            attendeeName = conversation.userDetails.name;
          }
        }

        console.log(`Meeting request from chat: ${attendeeName} (${attendeeEmail}) - ${functionArgs.requested_time}`);

        try {
          // Parse the requested time
          const requestedTime = calendarService.parseTimeRequest(functionArgs.requested_time);

          if (!requestedTime) {
            // Couldn't parse time - ask for clarification
            const scheduleResult = {
              ok: false,
              needs_clarification: true,
              message: "I couldn't quite work out the time. Could you be a bit more specific? For example, 'tomorrow at 2pm' or 'next Tuesday at 10am'?"
            };

            const functionMessages = [
              ...apiMessages,
              assistantMessage,
              { role: 'function', name: 'schedule_meeting', content: JSON.stringify(scheduleResult) }
            ];

            const followUp = await getOpenAIClient().chat.completions.create({
              model: 'gpt-4o-mini',
              messages: functionMessages,
              temperature: 0.7,
              max_tokens: 500
            });

            response = followUp.choices[0].message.content;
          } else {
            // Check if in-person meeting needs location
            const isInPerson = functionArgs.meeting_type === 'in_person';
            if (isInPerson && !functionArgs.location) {
              // Need location for in-person meeting
              const scheduleResult = {
                ok: false,
                needs_location: true,
                message: "For an in-person meeting, I need to know where. Shall Bob come to your school, or would you prefer to visit us?"
              };

              const functionMessages = [
                ...apiMessages,
                assistantMessage,
                { role: 'function', name: 'schedule_meeting', content: JSON.stringify(scheduleResult) }
              ];

              const followUp = await getOpenAIClient().chat.completions.create({
                model: 'gpt-4o-mini',
                messages: functionMessages,
                temperature: 0.7,
                max_tokens: 500
              });

              response = followUp.choices[0].message.content;
            } else {
              // Check availability (silently - never reveal to user)
              const availability = await calendarService.checkAvailability(requestedTime);

              if (availability.available) {
                // Slot is free - book the meeting (Teams or In-Person)
                let meetingResult;
                let confirmMessage;

                if (isInPerson) {
                  // Create in-person meeting
                  // Use location from function args, OR fall back to stored school name from user details
                  const meetingLocation = functionArgs.location || conversation.userDetails?.school || 'Location to be confirmed';

                  meetingResult = await calendarService.createInPersonMeeting({
                    subject: `bSMART AI Meeting - ${attendeeName}`,
                    startTime: requestedTime,
                    durationMinutes: 60, // Longer for in-person
                    attendeeEmail: attendeeEmail,
                    attendeeName: attendeeName,
                    location: meetingLocation,
                    description: `<p>In-person meeting with ${attendeeName}</p><p>Location: ${meetingLocation}</p><p>Topic: ${functionArgs.topic || 'bSMART AI Demo'}</p><p>Booked by Emily (AI Assistant)</p>`
                  });
                  confirmMessage = `I've booked an in-person meeting for ${calendarService.formatDate(requestedTime)} at ${calendarService.formatTimeSlot(requestedTime)} at ${meetingLocation}. A calendar invite has been sent to ${attendeeEmail}.`;
                } else {
                  // Create Teams meeting
                  meetingResult = await calendarService.createTeamsMeeting({
                    subject: `bSMART AI Demo - ${attendeeName}`,
                    startTime: requestedTime,
                    durationMinutes: 60,
                    attendeeEmail: attendeeEmail,
                    attendeeName: attendeeName,
                    description: `<p>Demo call with ${attendeeName}</p><p>School: ${functionArgs.school_name || 'Not specified'}</p><p>Topic: ${functionArgs.topic || 'bSMART AI Platform Demo'}</p><p>Booked by Emily (AI Assistant)</p>`
                  });
                  confirmMessage = `I've booked a Teams call for ${calendarService.formatDate(requestedTime)} at ${calendarService.formatTimeSlot(requestedTime)}. A calendar invite has been sent to ${attendeeEmail}.`;
                }

                if (meetingResult.success) {
                  // Use "busy Bob" language to make it seem like we got lucky
                  const busyPhrase = calendarService.getRandomPhrase('available');

                  const scheduleResult = {
                    ok: true,
                    booked: true,
                    meeting_type: isInPerson ? 'in_person' : 'teams',
                    busy_phrase: busyPhrase,
                    meeting_time: requestedTime.toISOString(),
                    formatted_time: `${calendarService.formatDate(requestedTime)} at ${calendarService.formatTimeSlot(requestedTime)}`,
                    // DO NOT include teams_link - it should only be in the calendar invite email
                    location: functionArgs.location || null,
                    message: `${busyPhrase}! ${confirmMessage}`,
                    instructions: 'DO NOT show any meeting links or URLs in your response. Just confirm the date, time, and that a calendar invite has been sent.'
                  };

                const functionMessages = [
                  ...apiMessages,
                  assistantMessage,
                  { role: 'function', name: 'schedule_meeting', content: JSON.stringify(scheduleResult) }
                ];

                const followUp = await getOpenAIClient().chat.completions.create({
                  model: 'gpt-4o-mini',
                  messages: functionMessages,
                  temperature: 0.7,
                  max_tokens: 500
                });

                response = followUp.choices[0].message.content;
              } else {
                // Meeting creation failed - fallback to demo request email
                console.error('Meeting creation failed:', meetingResult.error);

                const emailBody = buildDemoRequestEmail({
                  name: attendeeName,
                  email: attendeeEmail,
                  school: functionArgs.topic || 'Unknown',
                  role: 'Unknown',
                  interests: functionArgs.topic || 'Full demo',
                  conversation: conversation.messages,
                  preferred_time: functionArgs.requested_time
                }, 'Chat');

                await sendNotificationEmail(
                  `Demo Request: ${attendeeName} - Requested ${functionArgs.requested_time}`,
                  emailBody,
                  attendeeEmail
                );

                const scheduleResult = {
                  ok: true,
                  booked: false,
                  fallback: true,
                  message: `I've sent your request to Bob. He'll get back to you shortly to confirm ${functionArgs.requested_time}.`
                };

                const functionMessages = [
                  ...apiMessages,
                  assistantMessage,
                  { role: 'function', name: 'schedule_meeting', content: JSON.stringify(scheduleResult) }
                ];

                const followUp = await getOpenAIClient().chat.completions.create({
                  model: 'gpt-4o-mini',
                  messages: functionMessages,
                  temperature: 0.7,
                  max_tokens: 500
                });

                response = followUp.choices[0].message.content;
              }
            } else {
              // Slot is busy - suggest alternatives with "busy Bob" language
              // IMPORTANT: Always include the FULL DATE in alternatives so Emily doesn't lose context
              const alternatives = await calendarService.suggestAlternatives(requestedTime);
              const busyPhrase = calendarService.getRandomPhrase('busy');
              const altPhrase = calendarService.getRandomPhrase('alternative');

              let alternativeText = '';
              if (alternatives.length > 0) {
                // Use fullDateTime which includes the day (e.g., "14:30 on Monday, 3 February")
                alternativeText = alternatives.map(a => a.fullDateTime).join(', or ');
              }

              const scheduleResult = {
                ok: true,
                booked: false,
                busy: true,
                busy_phrase: busyPhrase,
                alternatives: alternatives,
                requested_day: calendarService.formatDate(requestedTime), // Include original day for context
                message: `${busyPhrase}. ${altPhrase} ${alternativeText}?`
              };

              const functionMessages = [
                ...apiMessages,
                assistantMessage,
                { role: 'function', name: 'schedule_meeting', content: JSON.stringify(scheduleResult) }
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
          }
        } catch (calendarErr) {
          console.error('Calendar error:', calendarErr);

          // Fallback - send as demo request
          const emailBody = buildDemoRequestEmail({
            name: attendeeName,
            email: attendeeEmail,
            school: 'Unknown',
            role: 'Unknown',
            interests: functionArgs.topic || 'Full demo',
            conversation: conversation.messages,
            preferred_time: functionArgs.requested_time
          }, 'Chat');

          await sendNotificationEmail(
            `Demo Request: ${attendeeName} - Requested ${functionArgs.requested_time}`,
            emailBody,
            attendeeEmail
          );

          const scheduleResult = {
            ok: true,
            booked: false,
            fallback: true,
            message: `I've sent your meeting request to Bob. He'll confirm the time with you directly.`
          };

          const functionMessages = [
            ...apiMessages,
            assistantMessage,
            { role: 'function', name: 'schedule_meeting', content: JSON.stringify(scheduleResult) }
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

function loadKnowledgeBase(school, demoMode = false) {
  try {
    // If demo mode, load More House demo knowledge base
    const kbFile = demoMode ? 'more-house-demo.md' : school.knowledgeBase;
    const kbPath = path.join(__dirname, '..', 'knowledge-bases', kbFile);
    return fs.readFileSync(kbPath, 'utf8');
  } catch (err) {
    console.error(`Failed to load knowledge base for ${school.id}:`, err);
    return '';
  }
}

function buildChatSystemPrompt(school, familyContext, knowledgeBase, screenContext, demoMode = false) {
  // Check if we're in demo mode (showing More House as an example)
  if (demoMode) {
    return buildDemoModePrompt(knowledgeBase);
  }

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

DEMO BOOKING FLOW (CRITICAL - FOLLOW THESE STEPS IN ORDER):

STEP 1: COLLECT CONTACT DETAILS
- Ask for name, email, school, and role together in ONE question
- Example: "Could you share your name, email, school and role?"
- Read their messages - extract any info they've already given

STEP 2: ASK WHICH PRODUCTS
- "Which SMART products are you most interested in?"
- SKIP this if they already mentioned a specific product
- Options: Prospectus, CRM, Chat, Voice, Booking, Email, or Full Platform

STEP 3: ASK TEAMS OR IN-PERSON
- "Would you prefer a Teams video call, or to meet in person?"
- Wait for their answer before proceeding

STEP 3.5: LOCATION (ONLY FOR IN-PERSON MEETINGS - MANDATORY)
- If they chose in-person in step 3, you MUST ask for location BEFORE asking about dates
- "Shall Bob come to your school, or would you prefer to visit our office?"
- DO NOT skip this step for in-person meetings
- DO NOT ask about weeks or days until you have the location
- REMEMBER their answer - you will need it when calling schedule_meeting!
- If they say "school" or "my school":
  * If you already have their school name, use it (e.g., "St Mary's School, London")
  * If you don't have their school name yet, ask: "Which school shall Bob visit?"
  * Store this for the location parameter in schedule_meeting
- If they say "office" or "your office" → location = "bSMART AI office, London"
- DO NOT proceed to Step 4 until you have a specific location stored!

STEP 4: ASK WHAT WEEK
- "What week works best for you?"
- Let THEM choose the week
- ONLY ask this AFTER you have the meeting type (and location if in-person)

STEP 5: ASK WHICH DAY
- "Which day that week suits you best - Monday, Tuesday, Wednesday, Thursday or Friday?"
- Let THEM pick the specific day

STEP 6: ASK WHAT TIME
- "And what time suits you?"
- Let THEM specify the time

STEP 7: BOOK THE MEETING
- Call schedule_meeting with ALL required parameters:
  * attendee_name: their name
  * attendee_email: their email
  * requested_time: FULL DATE like "Monday 10th February at 2pm" (not just "2pm")
  * meeting_type: "teams" or "in_person"
  * location: REQUIRED FOR IN-PERSON! Use the location they gave in Step 3.5
    - If they said "school" → use their school name or "their school at [address]"
    - If they said "office" → use "bSMART AI office, London"
  * topic: what they want to discuss
- CRITICAL: For in-person meetings, you MUST include the location parameter or the booking will fail!
- NEVER call book_demo - that only sends an email without booking

STEP 8: CONFIRM
- State the FULL DATE AND TIME: "That's booked for Monday, 10 February at 14:00. Calendar invite sent!"
- DO NOT show the Teams meeting link in the chat - it's in the calendar invite
- Keep confirmation SHORT - just date, time, and "calendar invite sent"

IMPORTANT RULES:
- If slot is FREE, book it and confirm positively - "That works, booked!"
- If slot is BUSY, suggest alternatives - "That one's taken, how about 2:30pm instead?"
- Only say Bob is busy if he ACTUALLY is busy - don't pretend

SALES APPROACH:
- Be helpful first, sales second
- If they ask about pricing, explain it varies by school size - suggest a demo
- Gently suggest demos after answering questions

LIVE DEMO REQUESTS:
When someone wants to "see Emily in action" or try a demo:
1. Ask if they'd prefer to try VOICE or CHAT
2. Explain you can show them a LIVE example using More House School (a real client)
3. For CHAT demo: Offer to show them asking school-specific questions
4. For VOICE demo: Explain they can click the "Start conversation" button to talk with you
5. The More House prospectus is live at: https://more-house-personalised-prospectus.onrender.com/
6. You can answer questions AS IF you were Emily for More House - an independent Catholic girls' school in London
7. After the demo, guide them back to booking a proper call with Bob to discuss their own school

GENERAL RULES:
- Never make up information
- Keep responses SHORT - under 50 words ideally
- ABSOLUTELY NO ASTERISKS. NO ** EVER. NO * EVER. NO MARKDOWN. NO BOLD. NO FORMATTING. PLAIN TEXT ONLY.
- ABSOLUTELY NO EMOJIS. Never use emojis in any response.
- Never use numbered lists with periods (1. 2. 3.) - use natural sentences instead
- NEVER repeat yourself or ask for info already provided
- Be professional and helpful but not overly enthusiastic - no "Lovely!" or "Perfect!" exclamations
- When confirming a booking, ALWAYS state the FULL DATE AND TIME clearly, e.g. "Wednesday, 5 February at 10:00"
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

// Demo mode prompt - Emily acts as if she's the assistant for More House School
function buildDemoModePrompt(knowledgeBase) {
  return `You are Emily, demonstrating how SMART Chat works for schools. You're now showing a LIVE DEMO using More House School as an example.

DEMO MODE ACTIVE - You are now acting as the Emily assistant for More House School, an independent Catholic girls' school in Knightsbridge, London.

IMPORTANT DEMO RULES:
1. Answer questions about More House School using the knowledge base below
2. Be warm, helpful, and knowledgeable - just as you would be for any school
3. If asked about admissions, fees, curriculum, etc. - answer using the More House information
4. You can offer to book visits, but explain this is a demo - real bookings would go to More House admissions
5. After a few exchanges, remind them "This is a demo - imagine this is YOUR school's information!"
6. Guide them back to booking a call with Bob to discuss implementing this for their school

VOICE AND PERSONALITY:
- British accent, warm and professional
- Use British spelling: colour, centre, organise
- Be enthusiastic about the school

WHEN ASKED QUESTIONS:
- Answer about More House using the knowledge base
- Show how Emily can handle fees, admissions, events, curriculum questions
- Demonstrate the natural conversation flow

TO EXIT DEMO MODE:
When they've seen enough, say something like: "That gives you an idea of how Emily works for schools. Shall we book a call with Bob to discuss setting this up for YOUR school?"

MORE HOUSE SCHOOL KNOWLEDGE BASE:
${knowledgeBase}

GENERAL RULES:
- Keep responses concise but helpful
- Never make up information not in the knowledge base
- NO asterisks, NO markdown formatting
- Be conversational and natural`;
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
