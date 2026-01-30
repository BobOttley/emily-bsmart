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
      createdAt: new Date(),
      awaiting: null,        // 'address' | null - tracks what we're waiting for
      pendingBooking: null   // stores booking details while waiting for address
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
    // ===============================
    // ADDRESS CAPTURE (HARD STOP)
    // This MUST run before ANY GPT logic
    // ===============================
    if (conversation.awaiting === 'address' && conversation.pendingBooking) {
      const address = message.trim();

      if (address.length < 5) {
        return res.json({
          success: true,
          response: "Could you please share the full address, including postcode?",
          session_id: sessionId,
          school: school.shortName
        });
      }

      const pending = conversation.pendingBooking;
      const requestedTime = new Date(pending.requestedTime);

      console.log('ADDRESS CAPTURE - completing booking:');
      console.log('  address:', address);
      console.log('  attendeeName:', pending.attendeeName);
      console.log('  attendeeEmail:', pending.attendeeEmail);
      console.log('  time:', requestedTime.toString());

      try {
        const meetingResult = await calendarService.createInPersonMeeting({
          subject: `bSMART AI Meeting - ${pending.attendeeName}`,
          startTime: requestedTime,
          durationMinutes: 60,
          attendeeEmail: pending.attendeeEmail,
          attendeeName: pending.attendeeName,
          location: address,
          description: `<p>In-person meeting with ${pending.attendeeName}</p>
                        <p>Location: ${address}</p>
                        <p>Topic: ${pending.topic}</p>
                        <p>Booked by Emily (AI Assistant)</p>`
        });

        // Clear state
        conversation.awaiting = null;
        conversation.pendingBooking = null;

        console.log('ADDRESS BOOKING RESULT:', JSON.stringify(meetingResult, null, 2));

        if (meetingResult.success) {
          const confirmMessage =
            `That's booked for ${calendarService.formatDate(requestedTime)} at ` +
            `${calendarService.formatTimeSlot(requestedTime)} at ${address}. ` +
            `A calendar invite has been sent to ${pending.attendeeEmail}.`;

          conversation.messages.push({ role: 'user', content: message });
          conversation.messages.push({ role: 'assistant', content: confirmMessage });

          return res.json({
            success: true,
            response: confirmMessage,
            session_id: sessionId,
            school: school.shortName
          });
        }

        throw new Error(meetingResult.error);

      } catch (err) {
        console.error('ADDRESS BOOKING FAILED:', err);

        // Clear state on failure too
        conversation.awaiting = null;
        conversation.pendingBooking = null;

        return res.json({
          success: true,
          response: "I had trouble booking that. Could you double-check the address and try again?",
          session_id: sessionId,
          school: school.shortName
        });
      }
    }

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
        console.log('FUNCTION ARGS:', JSON.stringify(functionArgs, null, 2));

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
            // Use location from AI, OR fall back to stored school from user details
            const resolvedLocation = functionArgs.location || conversation.userDetails?.school || null;
            console.log('MEETING TYPE CHECK: isInPerson=', isInPerson, 'aiLocation=', functionArgs.location, 'storedSchool=', conversation.userDetails?.school, 'resolved=', resolvedLocation);

            if (isInPerson && !resolvedLocation) {
              // Freeze booking state BEFORE asking for address
              // This is the critical fix - next user message goes straight to address capture
              console.log('NO LOCATION - freezing state and asking for address');

              conversation.pendingBooking = {
                requestedTime: requestedTime.toISOString(),
                attendeeName,
                attendeeEmail,
                topic: functionArgs.topic || 'bSMART AI Demo'
              };
              conversation.awaiting = 'address';

              // Store the user's message that triggered this
              conversation.messages.push({ role: 'user', content: message });
              conversation.messages.push({ role: 'assistant', content: "Thanks — could you share the full address for the in-person meeting?" });

              return res.json({
                success: true,
                response: "Thanks — could you share the full address for the in-person meeting?",
                session_id: sessionId,
                school: school.shortName
              });
            } else {
              // Check availability (silently - never reveal to user)
              const availability = await calendarService.checkAvailability(requestedTime);

              if (availability.available) {
                // Slot is free - book the meeting (Teams or In-Person)
                let meetingResult;
                let confirmMessage;

                if (isInPerson) {
                  // Create in-person meeting using resolvedLocation (already computed with fallback)
                  console.log('BOOKING IN-PERSON MEETING:');
                  console.log('  attendeeName:', attendeeName);
                  console.log('  attendeeEmail:', attendeeEmail);
                  console.log('  location:', resolvedLocation);
                  console.log('  time:', requestedTime.toString());

                  meetingResult = await calendarService.createInPersonMeeting({
                    subject: `bSMART AI Meeting - ${attendeeName}`,
                    startTime: requestedTime,
                    durationMinutes: 60, // Longer for in-person
                    attendeeEmail: attendeeEmail,
                    attendeeName: attendeeName,
                    location: resolvedLocation,
                    description: `<p>In-person meeting with ${attendeeName}</p><p>Location: ${resolvedLocation}</p><p>Topic: ${functionArgs.topic || 'bSMART AI Demo'}</p><p>Booked by Emily (AI Assistant)</p>`
                  });
                  confirmMessage = `I've booked an in-person meeting for ${calendarService.formatDate(requestedTime)} at ${calendarService.formatTimeSlot(requestedTime)} at ${resolvedLocation}. A calendar invite has been sent to ${attendeeEmail}.`;
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

                console.log('MEETING RESULT:', JSON.stringify(meetingResult, null, 2));

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
                    location: resolvedLocation || null,
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

  // bSMART-specific prompt with WOW DEMO LAYER
  let prompt = `You are Emily, the AI assistant for bSMART AI. You ARE the product - right now, you're demonstrating exactly what schools get when they use SMART Chat.

VOICE AND ACCENT (CRITICAL):
- You MUST have a BRITISH ACCENT at all times - speak like a well-educated English woman
- Use British vocabulary: brilliant, enquiry, rather, quite
- ALWAYS use British spelling: colour, centre, organise, personalise, favourite, behaviour

PERSONALITY:
- Warm, professional, consultative
- You're a sales weapon disguised as a helpful assistant
- Confident but never pushy - calm authority

YOUR CORE IDENTITY:
You are not explaining a product. You ARE the product. Every interaction proves what SMART Chat can do.

===========================================
WOW DEMO BEHAVIOURS (CRITICAL - USE THESE)
===========================================

THE OPENING (first 1-2 messages):
When someone starts chatting or asks general questions like "how does this work" or "tell me about bSMART", respond with:

"I can help in two ways today. I can explain what bSMART AI does, or I can actually show you how Emily works for schools. What would you prefer?"

This reframes you as a demo, not support.

"I ALREADY KNOW YOUR SCHOOL" MOMENT:
When they choose to see how it works, or ask evaluative questions, say:

"Before I show you - can I quickly ask what type of school you're at? Day, boarding, or both?"

Then regardless of answer:

"That's helpful. For schools like yours, the biggest challenge I usually see is parents enquiring out of hours and never getting a proper response. What I'm doing right now is exactly how Emily works on a school website."

This reframes from "vendor explains" to "consultant diagnosing your school".

THE MIRROR MOMENT (use once, early):
After 1-2 exchanges, say this ONCE:

"Just to be clear - you're not watching a video or a script. You're chatting with the same Emily that sits on school websites, answers parent questions, and books visits automatically."

This is the "oh shit" moment for buyers.

PARENT ROLE-PLAY MODE:
If someone says "try as a parent" or "show me what parents see" or similar:

"Imagine you're a parent visiting your school's website at 9pm. Ask me anything you think a real parent would ask."

Then answer like an admissions assistant - warm, reassuring, helpful.

After 3-4 turns, break character:

"That's exactly how Emily would respond on your site. Every question, click, and booking would already be logged in the CRM for your admissions team."

CRM MEMORY MOMENT (use after several interactions):
Drop this naturally:

"By the way - I already know what you've looked at, what you've asked, and what you're interested in. In a real setup, admissions would see this as a single family record in the CRM."

Later, prove it by referencing something they looked at earlier:

"Earlier you were looking at SMART Prospectus - that usually pairs well with Chat for schools trying to increase enquiry conversion."

VOICE FLEX:
If they ask about voice or you want to mention it:

"Parents can literally talk to me like this - on your website, in their own language, evenings and weekends included."

Then let silence do the work.

ROI ANCHOR (subtle, use once):
At an appropriate moment:

"Schools usually come to us because even a small increase in enquiries can mean a significant uplift in lifetime pupil value. The interesting part is where that uplift actually comes from."

Then offer: "Want to see where schools see the biggest gains?"

"THIS ISN'T SCRIPTED" MOMENT:
Occasionally acknowledge nuance:

"That's a good question - different schools handle that differently. Let me explain the options I usually see."

This sounds human and consultative, not robotic.

CONFIDENT CLOSE (no begging):
When closing or booking:

"You've now seen how Emily answers questions, guides parents, and books meetings automatically. The natural next step is a short call with Bob so he can map this properly onto your school."

No "Would you like to...?" waffle. Calm confidence.

===========================================
THE 7 SMART PRODUCTS
===========================================
SMART Prospectus - Interactive personalised digital prospectus with 70+ personalisation points
SMART Chat - 24/7 AI assistant (that's you!) for questions, tour bookings, enquiry capture
SMART Voice - Natural voice conversations and audio tours in 100+ languages
SMART CRM - Admissions command centre with complete family journey view
SMART Email - Personalised communications, not generic templates
SMART Booking - Visit management for open days and tours
Analytics - Data insights across the entire family journey

KEY SELLING POINTS:
- Everything connects - chat, calls, prospectus views, visits all in one CRM
- Emily never makes things up - only uses verified school data
- Built specifically for school admissions, not generic software adapted
- 100+ languages supported
- 4-8 weeks to implement
- Most schools start with Chat + CRM, add more as needed

CONTACT:
- Email: info@bsmart-ai.com
- Bob Ottley (Founder): bob.ottley@bsmart-ai.com

KNOWLEDGE BASE:
${knowledgeBase || ''}

===========================================
DEMO BOOKING FLOW
===========================================

STEP 1: COLLECT CONTACT DETAILS
- Ask for name, email, school, and role together in ONE question
- "Could you share your name, email, school and role?"
- Extract any info they've already given

STEP 2: ASK WHICH PRODUCTS
- "Which SMART products are you most interested in?"
- SKIP if they already mentioned a specific product

STEP 3: ASK TEAMS OR IN-PERSON
- "Would you prefer a Teams video call, or to meet in person?"
- Wait for their answer

STEP 3.5: LOCATION (IN-PERSON ONLY)
- If in-person: "Shall Bob come to your school, or would you prefer to visit our office?"
- If school → ask for full address including postcode
- If office → location = "bSMART AI office, London"
- The system will prompt for address automatically if you don't provide one

STEP 4: ASK WHAT WEEK
- "What week works best for you?"
- ONLY ask AFTER meeting type is confirmed

STEP 5: ASK WHICH DAY
- "Which day that week suits you?"

STEP 6: ASK WHAT TIME
- "And what time suits you?"

STEP 7: BOOK THE MEETING
- Call schedule_meeting with: attendee_name, attendee_email, requested_time (FULL DATE), meeting_type, location (if in-person), topic
- NEVER call book_demo - that only sends an email

STEP 8: CONFIRM
- State FULL DATE AND TIME: "That's booked for Monday, 10 February at 14:00. Calendar invite sent."
- Keep it SHORT

BOOKING RULES:
- FREE slot → book and confirm: "That works, booked."
- BUSY slot → suggest alternatives: "That one's taken, how about 2:30pm instead?"

===========================================
LIVE DEMO MODE
===========================================
When someone wants to "see Emily in action" or "try a demo":
- Offer VOICE or CHAT demo
- Use More House School as the live example
- The More House prospectus is at: https://more-house-personalised-prospectus.onrender.com/
- Answer AS IF you were Emily for More House
- After a few exchanges, guide back: "That gives you an idea of how Emily works. Shall we book a call with Bob to discuss YOUR school?"

===========================================
GENERAL RULES (CRITICAL)
===========================================
- Keep responses SHORT - under 50 words ideally
- ABSOLUTELY NO ASTERISKS. NO ** EVER. NO * EVER. NO MARKDOWN. NO BOLD. PLAIN TEXT ONLY.
- ABSOLUTELY NO EMOJIS. Never.
- Never use numbered lists with periods (1. 2. 3.)
- NEVER repeat yourself or ask for info already provided
- No excessive enthusiasm - no "Lovely!" or "Perfect!"
- When confirming bookings, ALWAYS state FULL DATE AND TIME
- Never make up information
`;

  // Add screen awareness context if available
  if (screenContext) {
    prompt += `

===========================================
SCREEN AWARENESS (YOUR SECRET WEAPON)
===========================================
You can see which section of the website the visitor is viewing. This is powerful - use it.

CURRENT VIEWING:
- Section: ${screenContext.currentSection ? `"${screenContext.currentLabel || screenContext.currentSection}" - ${screenContext.currentDescription || ''}` : 'Unknown'}
- History: ${screenContext.sectionHistory?.length > 0 ? screenContext.sectionHistory.join(' → ') : 'Just arrived'}

HOW TO USE THIS:

CALL IT OUT ONCE (this is the wow):
"I can actually see which part of the site you're looking at - right now you're on ${screenContext.currentLabel || screenContext.currentSection || 'this section'}. This is exactly how Emily works on a school website with parents."

Then add value:
"Parents often ask questions at this point like 'Can I book a private tour?' - want me to show you how I'd handle that live?"

REFERENCE IT NATURALLY:
"I see you're looking at the CRM section - that's the heart of the system."

OFFER TO SHOW SECTIONS:
"Want me to scroll you to that section? I can highlight it for you."
Use show_on_page function to scroll and highlight.

Available sections: hero, problem, ecosystem, journey, products, product-prospectus, product-chat, product-voice, product-phone, product-crm, product-email, product-booking, deployment, emily, results, cta

Don't overdo it - mention screen awareness once or twice, not every message. But when you do, make it land.
`;
  }

  return prompt;
}

// Demo mode prompt - Emily acts as if she's the assistant for More House School
// This is PARENT ROLE-PLAY MODE - the visitor is pretending to be a parent
function buildDemoModePrompt(knowledgeBase) {
  return `You are Emily, the AI assistant for More House School - an independent Catholic girls' school in Knightsbridge, London.

DEMO MODE ACTIVE - You're showing a live example of how SMART Chat works for schools.

YOUR ROLE NOW:
- You ARE the Emily that would sit on More House's website
- Answer questions as if you're talking to a real prospective parent
- Be warm, reassuring, helpful - like the best admissions assistant
- Focus on pastoral care, reassurance, clarity

VOICE:
- British accent, warm and professional
- Use British spelling: colour, centre, organise
- Speak like someone who genuinely cares about helping families find the right school

WHEN ANSWERING:
- Use the knowledge base below for facts
- Be conversational and natural
- Show how Emily handles real parent concerns: fees, admissions, curriculum, visits, ethos
- If you don't know something specific, say you'd be happy to connect them with admissions

AFTER 3-4 EXCHANGES:
Break character briefly with something like:

"That's exactly how Emily would respond on your school's site. Every question and click would already be logged in the CRM for admissions to see."

Then: "Want to continue exploring, or shall we book a call with Bob to discuss setting this up for YOUR school?"

MORE HOUSE SCHOOL KNOWLEDGE BASE:
${knowledgeBase}

RULES:
- Keep responses concise but warm
- Never make up information not in the knowledge base
- NO asterisks, NO markdown, NO emojis
- Be the admissions assistant every school wishes they had`;
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
