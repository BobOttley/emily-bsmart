/**
 * Emily - bSMART AI Assistant Server
 *
 * Emily is the AI assistant for bSMART AI, demonstrating what the SMART products can do.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

// SMART Campaign database connection (shared with More House)
const campaignPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test campaign database connection
campaignPool.query('SELECT NOW()')
  .then(() => console.log('SMART Campaign database connected'))
  .catch(err => console.error('Campaign DB connection error:', err.message));

// Import shared email utility
const { sendNotificationEmail, logEmailStatus, buildDemoRequestEmail } = require('./utils/email');

// Log email configuration status
logEmailStatus();

// Import routes
const chatRoutes = require('./routes/chat');
const audioTourRoutes = require('./routes/audio-tour');
const healthRoutes = require('./routes/health');
const demoRoutes = require('./routes/demo');

// Import config
const { schools, getSchool, getSchoolIds, detectSchoolFromUrl } = require('./config/schools');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3030;

// Middleware
app.use(cors({
  origin: '*', // Allow all origins for widget embedding
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-School-Id', 'X-Family-Id']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files for widget
app.use('/widget', express.static(path.join(__dirname, 'widget')));

// Serve static files for demo
app.use('/static', express.static(path.join(__dirname, 'static')));

// Serve the main prospectus static files from parent directory (all school folders)
app.use(express.static(path.join(__dirname, '..')));

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// School detection middleware - extracts school ID from various sources
app.use((req, res, next) => {
  // Priority: 1) URL param, 2) Header, 3) Query param, 4) Detect from referer
  let schoolId = req.params.schoolId ||
                 req.headers['x-school-id'] ||
                 req.query.school;

  // Try to detect from referer URL
  if (!schoolId && req.headers.referer) {
    schoolId = detectSchoolFromUrl(req.headers.referer);
  }

  // Validate school exists
  if (schoolId && getSchool(schoolId)) {
    req.schoolId = schoolId;
    req.school = getSchool(schoolId);
  }

  next();
});

// ============================================================================
// API ROUTES
// ============================================================================

// Health check
app.use('/api/health', healthRoutes);

// Demo routes (no school ID required)
app.use('/api/demo', demoRoutes);

// School-specific API routes
app.use('/api/:schoolId/chat', (req, res, next) => {
  const school = getSchool(req.params.schoolId);
  if (!school) {
    return res.status(404).json({ error: 'School not found', schoolId: req.params.schoolId });
  }
  req.school = school;
  req.schoolId = req.params.schoolId;
  next();
}, chatRoutes);

app.use('/api/:schoolId/audio-tour', (req, res, next) => {
  const school = getSchool(req.params.schoolId);
  if (!school) {
    return res.status(404).json({ error: 'School not found', schoolId: req.params.schoolId });
  }
  req.school = school;
  req.schoolId = req.params.schoolId;
  next();
}, audioTourRoutes);

// Realtime voice session endpoint
app.post('/api/:schoolId/realtime/session', async (req, res) => {
  const school = getSchool(req.params.schoolId);
  if (!school) {
    return res.status(404).json({ error: 'School not found' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  const body = req.body || {};
  const sessionId = uuidv4();
  const familyId = body.family_id;
  const language = (body.language || 'en').toLowerCase();
  const voice = body.voice || school.emilyPersonality?.voice || 'coral'; // Female voice

  // Load knowledge base for system prompt
  let knowledgeBase = '';
  try {
    const kbPath = path.join(__dirname, 'knowledge-bases', school.knowledgeBase);
    knowledgeBase = fs.readFileSync(kbPath, 'utf8');
  } catch (err) {
    console.error(`Failed to load knowledge base for ${school.id}:`, err);
  }

  // Build system instructions
  const instructions = buildSystemPrompt(school, body, knowledgeBase, language);

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview',
        voice: voice,  // Use configured voice (vale = British English)
        modalities: ['text', 'audio'],
        output_audio_format: 'pcm16',
        temperature: 0.6,
        max_response_output_tokens: 1500,
        turn_detection: {
          type: 'server_vad',
          threshold: 0.6,
          prefix_padding_ms: 500,
          silence_duration_ms: 2000
        },
        input_audio_transcription: {
          model: 'whisper-1'
        },
        instructions: instructions,
        tools: [
          {
            type: 'function',
            name: 'kb_search',
            description: 'Search the bSMART AI knowledge base for information about SMART products, pricing, implementation, or how bSMART works.',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query about bSMART products or services'
                }
              },
              required: ['query']
            }
          },
          {
            type: 'function',
            name: 'book_demo',
            description: 'ONLY use this when someone explicitly says they do NOT want to book a specific time and just want Bob to contact them later. This sends an email but does NOT book a meeting. For actual demo bookings with a calendar invite, you MUST use schedule_meeting instead after asking: 1) Teams or in-person, 2) What week, 3) What time.',
            parameters: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Contact name'
                },
                email: {
                  type: 'string',
                  description: 'Contact email address'
                },
                school: {
                  type: 'string',
                  description: 'School or organisation name'
                },
                role: {
                  type: 'string',
                  description: 'Their role at the school'
                },
                interests: {
                  type: 'string',
                  description: 'Which SMART products they want to see'
                }
              },
              required: ['name', 'email', 'school', 'role', 'interests']
            }
          },
          {
            type: 'function',
            name: 'schedule_meeting',
            description: 'Schedule a Teams call with Bob Ottley. Use this when someone wants to book a demo call. First ask what time suits them, then call this function. ALWAYS suggest Teams as the default.',
            parameters: {
              type: 'object',
              properties: {
                requested_time: {
                  type: 'string',
                  description: 'The time the user requested, e.g. "tomorrow at 2pm", "next Tuesday 10am"'
                },
                attendee_name: {
                  type: 'string',
                  description: 'Name of the person booking'
                },
                attendee_email: {
                  type: 'string',
                  description: 'Email address for the calendar invite'
                },
                topic: {
                  type: 'string',
                  description: 'What they want to discuss'
                }
              },
              required: ['requested_time', 'attendee_name', 'attendee_email']
            }
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI Realtime API error:', errorText);
      return res.status(response.status).json({ error: 'Failed to create realtime session' });
    }

    const data = await response.json();

    res.json({
      session_id: sessionId,
      school_id: school.id,
      ...data
    });

  } catch (err) {
    console.error('Realtime session error:', err);
    res.status(500).json({ error: 'Failed to create realtime session' });
  }
});

// Live open days scraping tool endpoint
app.post('/api/:schoolId/realtime/tool/get_open_days', async (req, res) => {
  const school = getSchool(req.params.schoolId);
  if (!school) {
    return res.status(404).json({ ok: false, error: 'School not found' });
  }

  if (!school.openDaysUrl) {
    return res.json({ ok: true, answer: 'Open day information is not available online. Please contact admissions directly.', source: 'fallback' });
  }

  try {
    const fetch = require('node-fetch');
    const cheerio = require('cheerio');

    const response = await fetch(school.openDaysUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EmilyBot/1.0)' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract text content - look for dates, events, open mornings
    let content = '';

    // Try common patterns for event/date content
    $('main, .content, .events, .open-days, .visits, article, .entry-content').each((i, el) => {
      content += $(el).text() + ' ';
    });

    // If no content found, get body text
    if (!content.trim()) {
      content = $('body').text();
    }

    // Clean up whitespace
    content = content.replace(/\\s+/g, ' ').trim().substring(0, 3000);

    // Use OpenAI to extract open day info
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extract open day/visit/tour dates from the following webpage content for ${school.name}. List the events with dates in a clear format. If no dates are found, say so. Be concise.`
        },
        {
          role: 'user',
          content: content
        }
      ],
      temperature: 0.3,
      max_tokens: 400
    });

    const answer = completion.choices[0].message.content;

    res.json({
      ok: true,
      answer: answer,
      source: 'live_website',
      url: school.openDaysUrl,
      school: school.shortName
    });

  } catch (err) {
    console.error('Open days scrape error:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch open days' });
  }
});

// Knowledge base search tool endpoint
app.post('/api/:schoolId/realtime/tool/kb_search', async (req, res) => {
  const school = getSchool(req.params.schoolId);
  if (!school) {
    return res.status(404).json({ ok: false, error: 'School not found' });
  }

  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ ok: false, error: 'Query required' });
  }

  try {
    // Load knowledge base
    const kbPath = path.join(__dirname, 'knowledge-bases', school.knowledgeBase);
    const knowledgeBase = fs.readFileSync(kbPath, 'utf8');

    // Use OpenAI to answer based on knowledge base
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are Emily, a helpful assistant for bSMART AI. Answer questions about SMART products using ONLY the knowledge base below. Be concise (2-3 sentences). Use British English.\n\nKNOWLEDGE BASE:\n${knowledgeBase}`
        },
        {
          role: 'user',
          content: query
        }
      ],
      temperature: 0.3,
      max_tokens: 300
    });

    const answer = completion.choices[0].message.content;

    res.json({
      ok: true,
      answer: answer,
      source: 'knowledge_base',
      school: school.shortName
    });

  } catch (err) {
    console.error('KB search error:', err);
    res.status(500).json({ ok: false, error: 'Search failed' });
  }
});

// Book demo tool endpoint - sends email notification to Bob
app.post('/api/:schoolId/realtime/tool/book_demo', async (req, res) => {
  const { name, email, school, role, interests } = req.body;

  if (!name || !email) {
    return res.status(400).json({ ok: false, error: 'Name and email required' });
  }

  console.log(`Demo request from ${name} (${email}) at ${school}`);

  // Send branded notification email
  const emailBody = buildDemoRequestEmail({ name, email, school, role, interests }, 'Voice');

  const emailResult = await sendNotificationEmail(
    `Demo Request: ${name} from ${school || 'Unknown School'}`,
    emailBody,
    email // CC the person
  );

  res.json({
    ok: true,
    message: `Thanks ${name}! I've sent your details to Bob Ottley. He'll be in touch shortly to arrange a demo.`,
    email_sent: emailResult.success
  });
});

// Schedule meeting tool endpoint - books Teams meetings directly
const calendarService = require('./services/calendar');

app.post('/api/:schoolId/realtime/tool/schedule_meeting', async (req, res) => {
  const { requested_time, attendee_name, attendee_email, topic } = req.body;

  if (!requested_time || !attendee_name || !attendee_email) {
    return res.status(400).json({
      ok: false,
      error: 'Required: requested_time, attendee_name, attendee_email'
    });
  }

  console.log(`Meeting request from ${attendee_name} (${attendee_email}) for ${requested_time}`);

  try {
    // Parse the requested time
    const requestedTime = calendarService.parseTimeRequest(requested_time);

    if (!requestedTime) {
      return res.json({
        ok: true,
        booked: false,
        needs_clarification: true,
        message: "I couldn't quite work out the time. Could you be more specific? For example, tomorrow at 2pm."
      });
    }

    // Check availability silently
    const availability = await calendarService.checkAvailability(requestedTime);

    if (availability.available) {
      // Book the meeting
      const meetingResult = await calendarService.createTeamsMeeting({
        subject: `bSMART AI Demo - ${attendee_name}`,
        startTime: requestedTime,
        durationMinutes: 60,
        attendeeEmail: attendee_email,
        attendeeName: attendee_name,
        description: `<p>Demo call with ${attendee_name}</p><p>Topic: ${topic || 'bSMART AI Platform'}</p><p>Booked by Emily (Voice Assistant)</p>`
      });

      if (meetingResult.success) {
        const busyPhrase = calendarService.getRandomPhrase('available');
        return res.json({
          ok: true,
          booked: true,
          busy_phrase: busyPhrase,
          formatted_time: `${calendarService.formatDate(requestedTime)} at ${calendarService.formatTimeSlot(requestedTime)}`,
          teams_link: meetingResult.teamsLink,
          message: `${busyPhrase}! I've booked a Teams call for ${calendarService.formatDate(requestedTime)} at ${calendarService.formatTimeSlot(requestedTime)}. A calendar invite has been sent to ${attendee_email}.`
        });
      } else {
        // Fallback to demo request
        const emailBody = buildDemoRequestEmail({
          name: attendee_name,
          email: attendee_email,
          school: 'Unknown',
          role: 'Unknown',
          interests: topic || 'Full demo',
          preferred_time: requested_time
        }, 'Voice');

        await sendNotificationEmail(
          `Demo Request: ${attendee_name} - Requested ${requested_time}`,
          emailBody,
          attendee_email
        );

        return res.json({
          ok: true,
          booked: false,
          fallback: true,
          message: `I've sent your meeting request to Bob. He'll confirm the time with you directly at ${attendee_email}.`
        });
      }
    } else {
      // Slot is busy - suggest alternatives
      // IMPORTANT: Always include the FULL DATE so Emily doesn't lose context
      const alternatives = await calendarService.suggestAlternatives(requestedTime);
      const busyPhrase = calendarService.getRandomPhrase('busy');

      let alternativeText = '';
      if (alternatives.length > 0) {
        // Use fullDateTime which includes the day (e.g., "14:30 on Monday, 3 February")
        alternativeText = alternatives.map(a => a.fullDateTime).join(', or ');
      }

      return res.json({
        ok: true,
        booked: false,
        busy: true,
        busy_phrase: busyPhrase,
        alternatives: alternatives,
        requested_day: calendarService.formatDate(requestedTime),
        message: `${busyPhrase}. How about ${alternativeText}?`
      });
    }

  } catch (err) {
    console.error('Schedule meeting error:', err);

    // Fallback to demo request email
    const emailBody = buildDemoRequestEmail({
      name: attendee_name,
      email: attendee_email,
      school: 'Unknown',
      role: 'Unknown',
      interests: topic || 'Full demo',
      preferred_time: requested_time
    }, 'Voice');

    await sendNotificationEmail(
      `Demo Request: ${attendee_name} - Requested ${requested_time}`,
      emailBody,
      attendee_email
    );

    res.json({
      ok: true,
      booked: false,
      fallback: true,
      message: `I've sent your request to Bob. He'll get back to you to confirm the time.`
    });
  }
});

// ============================================================================
// WIDGET SERVING
// ============================================================================

// Serve school-themed widget JavaScript
app.get('/widget/:schoolId/emily.js', (req, res) => {
  const school = getSchool(req.params.schoolId);
  if (!school) {
    return res.status(404).send('// School not found');
  }

  // Read the base widget and inject school config
  const widgetPath = path.join(__dirname, 'widget', 'emily-widget.js');
  let widgetCode = fs.readFileSync(widgetPath, 'utf8');

  // Inject school configuration
  const schoolConfig = JSON.stringify({
    id: school.id,
    name: school.name,
    shortName: school.shortName,
    theme: school.theme,
    contact: school.contact,
    personality: school.emilyPersonality,
    quickReplies: school.quickReplies,
    contextualReplies: school.contextualReplies
  });

  widgetCode = widgetCode.replace('__SCHOOL_CONFIG__', schoolConfig);
  widgetCode = widgetCode.replace('__API_BASE_URL__', process.env.API_BASE_URL || `http://localhost:${PORT}`);

  res.type('application/javascript');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.send(widgetCode);
});

// Serve widget CSS
app.get('/widget/:schoolId/emily.css', (req, res) => {
  const school = getSchool(req.params.schoolId);
  if (!school) {
    return res.status(404).send('/* School not found */');
  }

  // Read base CSS and inject theme colours
  const cssPath = path.join(__dirname, 'widget', 'emily-widget.css');
  let css = fs.readFileSync(cssPath, 'utf8');

  // Replace CSS variables with school theme
  css = css.replace(/var\(--emily-primary\)/g, school.theme.primary);
  css = css.replace(/var\(--emily-secondary\)/g, school.theme.secondary);
  css = css.replace(/var\(--emily-accent\)/g, school.theme.accent);

  res.type('text/css');
  res.send(css);
});

// ============================================================================
// SCHOOL INFO ENDPOINTS
// ============================================================================

// List all available schools
app.get('/api/schools', (req, res) => {
  const schoolList = getSchoolIds().map(id => {
    const school = getSchool(id);
    return {
      id: school.id,
      name: school.name,
      shortName: school.shortName,
      type: school.type
    };
  });
  res.json({ schools: schoolList });
});

// Get school configuration
app.get('/api/schools/:schoolId', (req, res) => {
  const school = getSchool(req.params.schoolId);
  if (!school) {
    return res.status(404).json({ error: 'School not found' });
  }
  res.json({
    id: school.id,
    name: school.name,
    shortName: school.shortName,
    type: school.type,
    theme: school.theme,
    contact: school.contact,
    prospectusModules: school.prospectusModules
  });
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function buildSystemPrompt(school, familyData, knowledgeBase, language) {
  let prompt = `You are Emily, the AI assistant for bSMART AI. You're here to answer questions about the apps, explain how they work, discuss security, outline the benefits, book demos, or contact the company on behalf of visitors by email. You ARE the product - a demonstration of what bSMART AI can do for schools.

VOICE AND ACCENT (CRITICAL):
- You MUST have a BRITISH ACCENT at all times - speak like a well-educated English woman
- Use British pronunciation: "schedule" as "shed-yool", "can't" as "cahnt"
- Use British vocabulary: lovely, brilliant, enquiry, marvellous, rather, quite
- ALWAYS use British spelling: colour, centre, organise, personalise, favourite, behaviour

PERSONALITY:
- Warm, professional, knowledgeable about school admissions
- Concise and enthusiastic about how bSMART helps schools
- Consultative - understand their needs before pitching

YOUR ROLE:
- You ARE SMART Voice - demonstrate the product by being helpful
- Answer questions about bSMART AI's 7 products
- Help visitors understand how everything connects together
- Gently guide conversations toward booking a demo with Bob Ottley
- Capture contact details naturally through conversation

THE 7 SMART PRODUCTS:
1. SMART Prospectus - Interactive personalised digital prospectus with 70+ personalisation points
2. SMART Chat - 24/7 AI assistant for questions, tour bookings, enquiry capture
3. SMART Voice - Natural voice conversations (that's you!) and audio tours in 100+ languages
4. SMART CRM - Admissions command centre with complete family journey view
5. SMART Email - Personalised communications, not generic templates
6. SMART Booking - Visit management for open days and tours
7. Analytics - Data insights across the entire family journey

KEY SELLING POINTS:
- Everything connects - chat, calls, prospectus views, visits all in one CRM
- Emily never makes things up - only uses verified school data
- Built specifically for school admissions
- 100+ languages supported
- 4-8 weeks to implement

CONTACT:
- Email: info@bsmart-ai.com
- Bob Ottley (Founder): bob.ottley@bsmart-ai.com

DEMO BOOKING FLOW (CRITICAL - FOLLOW THESE STEPS IN ORDER):

STEP 1: COLLECT CONTACT DETAILS
- Ask for name, email, school, and role together in ONE question
- Example: "Could you share your name, email, school and role?"

STEP 2: ASK WHICH PRODUCTS
- "Which SMART products are you most interested in?"
- SKIP if they already mentioned a specific product

STEP 3: ASK TEAMS OR IN-PERSON
- "Would you prefer a Teams video call, or to meet in person?"
- If in-person, ask WHERE: "Shall Bob come to your school?"

STEP 4: ASK WHAT WEEK
- "What week works best for you?"

STEP 5: ASK WHICH DAY
- "Which day that week - Monday, Tuesday, Wednesday, Thursday or Friday?"

STEP 6: ASK WHAT TIME
- "And what time suits you?"

STEP 7: BOOK THE MEETING
- Call schedule_meeting with the FULL DATE they specified
- requested_time MUST include actual date like "Monday 10th February at 2pm"
- NEVER call book_demo - that only sends email without booking

STEP 8: CONFIRM
- State FULL DATE AND TIME: "That's booked for Monday, 10 February at 14:00. Calendar invite sent!"
- DO NOT show any meeting links or URLs - they're in the calendar invite
- Keep it SHORT

RULES:
- If slot is FREE, book it and confirm positively - "That works, booked!"
- If slot is BUSY, suggest alternatives - "That one's taken, how about 2:30pm instead?"
- Only say Bob is busy if he ACTUALLY is busy - don't pretend

GENERAL RULES:
- Never make up information
- For pricing, say it varies by school size - suggest a demo
- Keep responses SHORT and concise (this is voice!)
- Be professional and helpful but not overly enthusiastic - no "Lovely!" or "Perfect!" exclamations
- NEVER repeat yourself or ask for info already provided
- ABSOLUTELY NO ASTERISKS. NO ** EVER. NO * EVER. NO MARKDOWN. NO BOLD. NO FORMATTING. PLAIN TEXT ONLY.
- When confirming a booking, ALWAYS state the FULL DATE AND TIME clearly, e.g. "Wednesday, 5 February at 10:00"

KNOWLEDGE BASE:
${knowledgeBase || ''}
`;

  return prompt;
}

// ============================================================================
// SMART CAMPAIGN TRACKING ROUTES
// ============================================================================

// Track prospectus click and redirect
app.get('/track/p/:campaign_id/:recipient_id', async (req, res) => {
  const { campaign_id, recipient_id } = req.params;
  console.log(`[TRACKING] Prospectus click: campaign=${campaign_id}, recipient=${recipient_id}`);

  try {
    const campaignResult = await campaignPool.query(
      'SELECT prospectus_url FROM campaigns WHERE id = $1',
      [campaign_id]
    );

    if (campaignResult.rows.length === 0) {
      console.log(`[TRACKING] Campaign not found: ${campaign_id}`);
      return res.status(404).send('Campaign not found');
    }

    const prospectusUrl = campaignResult.rows[0].prospectus_url;

    const userAgent = (req.headers['user-agent'] || '').substring(0, 500);
    await campaignPool.query(
      `INSERT INTO prospectus_events (campaign_id, recipient_id, user_agent, ip_hash, event_type)
       VALUES ($1, $2, $3, $4, 'prospectus')`,
      [campaign_id, recipient_id, userAgent, '']
    );

    console.log(`[TRACKING] Logged prospectus view, redirecting to: ${prospectusUrl}`);
    res.redirect(302, prospectusUrl);

  } catch (err) {
    console.error('[TRACKING] Error:', err.message);
    res.status(500).send('Error processing request');
  }
});

// Track enquiry form click and redirect
app.get('/track/e/:campaign_id/:recipient_id', async (req, res) => {
  const { campaign_id, recipient_id } = req.params;
  console.log(`[TRACKING] Enquiry click: campaign=${campaign_id}, recipient=${recipient_id}`);

  try {
    const campaignResult = await campaignPool.query(
      'SELECT enquiry_url FROM campaigns WHERE id = $1',
      [campaign_id]
    );

    if (campaignResult.rows.length === 0) {
      console.log(`[TRACKING] Campaign not found: ${campaign_id}`);
      return res.status(404).send('Campaign not found');
    }

    const enquiryUrl = campaignResult.rows[0].enquiry_url;

    const userAgent = (req.headers['user-agent'] || '').substring(0, 500);
    await campaignPool.query(
      `INSERT INTO prospectus_events (campaign_id, recipient_id, user_agent, ip_hash, event_type)
       VALUES ($1, $2, $3, $4, 'enquiry')`,
      [campaign_id, recipient_id, userAgent, '']
    );

    console.log(`[TRACKING] Logged enquiry view, redirecting to: ${enquiryUrl}`);
    res.redirect(302, enquiryUrl);

  } catch (err) {
    console.error('[TRACKING] Error:', err.message);
    res.status(500).send('Error processing request');
  }
});

// One-click unsubscribe
app.get('/unsubscribe/:recipient_id', async (req, res) => {
  const { recipient_id } = req.params;
  console.log(`[UNSUBSCRIBE] Request for recipient: ${recipient_id}`);

  try {
    const result = await campaignPool.query(
      'UPDATE recipients SET opted_out = TRUE WHERE id = $1 RETURNING email',
      [recipient_id]
    );

    if (result.rows.length > 0) {
      console.log(`[UNSUBSCRIBE] Opted out: ${result.rows[0].email}`);
    }

    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Unsubscribed</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f8fafc; color: #334155;">
    <div style="text-align: center; padding: 40px; max-width: 500px;">
        <div style="font-size: 48px; margin-bottom: 20px;">&#10003;</div>
        <h1 style="font-size: 24px; margin-bottom: 15px; color: #22c55e;">Unsubscribed</h1>
        <p style="font-size: 16px; line-height: 1.6;">You will no longer receive emails from me.</p>
        <p style="margin-top: 20px; font-size: 14px; color: #64748b;">You can close this window.</p>
    </div>
</body>
</html>`);

  } catch (err) {
    console.error('[UNSUBSCRIBE] Error:', err.message);
    res.status(500).send('Error processing request');
  }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🎓 Emily - bSMART AI Assistant                           ║
║   ─────────────────────────────────────────────────────    ║
║   Server running on port ${PORT}                             ║
║                                                            ║
║   Demo:   http://localhost:${PORT}/static/demo.html          ║
║   API:    /api/demo/start, /api/demo/chat                  ║
║                                                            ║
║   Widget: /widget/{schoolId}/emily.js                      ║
║   Chat:   /api/{schoolId}/chat                             ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
