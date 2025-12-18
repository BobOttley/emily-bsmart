/**
 * Emily Multi-School AI Assistant Server
 *
 * A single Emily instance that serves all schools in the personalised prospectus platform.
 * Each school's prospectus loads Emily configured with the correct theme and knowledge base.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

// Email configuration (Microsoft 365)
const EMAIL_USER = process.env.EMAIL_USER || 'bob.ottley@bsmart-ai.com';
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'bob.ottley@bsmart-ai.com';

// Email transporter - Microsoft 365
let emailTransporter = null;
if (EMAIL_PASSWORD) {
  emailTransporter = nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASSWORD
    },
    tls: {
      ciphers: 'SSLv3'
    }
  });
  console.log('Email notifications enabled (Microsoft 365)');
} else {
  console.log('Email notifications disabled - no EMAIL_PASSWORD set');
}

// Send notification email to Bob
async function sendNotificationEmail(subject, body) {
  if (!emailTransporter) {
    console.log('Email not configured - would send:', subject);
    return { success: false, error: 'Email not configured' };
  }

  try {
    await emailTransporter.sendMail({
      from: GMAIL_USER,
      to: NOTIFICATION_EMAIL,
      subject: `[bSMART Emily] ${subject}`,
      html: body
    });
    console.log('Notification email sent:', subject);
    return { success: true };
  } catch (err) {
    console.error('Email error:', err);
    return { success: false, error: err.message };
  }
}

// Import routes
const chatRoutes = require('./routes/chat');
const audioTourRoutes = require('./routes/audio-tour');
const healthRoutes = require('./routes/health');

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
            description: 'Book a demo with Bob Ottley. Use this when someone wants to see a demo, arrange a meeting, or learn more about pricing. Collect their name, email, school name, and role first.',
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
                  description: 'Their role (e.g. Registrar, Head, Marketing)'
                },
                interests: {
                  type: 'string',
                  description: 'Which SMART products they are interested in'
                }
              },
              required: ['name', 'email', 'school']
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

  // Send notification email to Bob
  const emailBody = `
    <h2>New Demo Request from bSMART Website</h2>
    <p><strong>Name:</strong> ${name}</p>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>School:</strong> ${school || 'Not provided'}</p>
    <p><strong>Role:</strong> ${role || 'Not provided'}</p>
    <p><strong>Interested in:</strong> ${interests || 'Not specified'}</p>
    <hr>
    <p><em>This lead was captured by Emily on the bSMART website.</em></p>
  `;

  const emailResult = await sendNotificationEmail(
    `Demo Request: ${name} from ${school || 'Unknown School'}`,
    emailBody
  );

  res.json({
    ok: true,
    message: `Thanks ${name}! I've sent your details to Bob Ottley. He'll be in touch shortly to arrange a demo.`,
    email_sent: emailResult.success
  });
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
    quickReplies: school.quickReplies
  });

  widgetCode = widgetCode.replace('__SCHOOL_CONFIG__', schoolConfig);
  widgetCode = widgetCode.replace('__API_BASE_URL__', process.env.API_BASE_URL || `http://localhost:${PORT}`);

  res.type('application/javascript');
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
  let prompt = `You are Emily, the friendly AI sales assistant for bSMART AI.

VOICE AND ACCENT:
- You have a BRITISH ACCENT - speak like a well-educated English woman
- Use British pronunciation: "schedule" as "shed-yool", "can't" as "cahnt"
- Use British vocabulary: lovely, brilliant, enquiry, marvellous, rather, quite

PERSONALITY:
- Warm, professional, helpful
- British English spelling (colour, centre, organise)
- Concise and clear
- Never pushy

YOUR ROLE:
- Answer questions about bSMART AI products
- Help visitors understand how SMART products work
- Offer to arrange demos with Bob Ottley
- Capture contact details naturally

PRODUCTS (7 SMART products):
1. SMART Prospectus - Interactive personalised digital prospectus
2. SMART Chat - AI chat widget (what you are!)
3. SMART Voice - Voice conversations on website
4. SMART Phone - AI telephone answering
5. SMART Email - Personalised email communications
6. SMART CRM - Admissions command centre
7. SMART Booking - Tour and event booking

CONTACT:
- Email: hello@bsmart-ai.com
- Bob Ottley: bob.ottley@bsmart-ai.com

RULES:
- Never make up information
- For pricing, say it varies by school size - best discussed in a demo
- Keep responses concise
- No markdown formatting
- Be helpful even if they're not ready to buy

KNOWLEDGE BASE:
${knowledgeBase || ''}
`;

  return prompt;
}

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🎓 Emily Multi-School AI Assistant                       ║
║   ─────────────────────────────────────────────────────    ║
║   Server running on port ${PORT}                             ║
║                                                            ║
║   Available schools:                                       ║
${getSchoolIds().map(id => `║   • ${getSchool(id).name.padEnd(45)}║`).join('\n')}
║                                                            ║
║   Widget: /widget/{schoolId}/emily.js                      ║
║   API:    /api/{schoolId}/chat                             ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
