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
            name: 'get_prospectus_section',
            description: 'Retrieve content from a specific section of the family\'s personalised prospectus for audio narration. Use when discussing any topic covered in the prospectus.',
            parameters: {
              type: 'object',
              properties: {
                section: {
                  type: 'string',
                  description: 'The prospectus section ID to retrieve'
                }
              },
              required: ['section']
            }
          },
          {
            type: 'function',
            name: 'kb_search',
            description: 'Search the school knowledge base for factual information about fees, admissions, curriculum, facilities, staff, or any other school information.',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query for the knowledge base'
                }
              },
              required: ['query']
            }
          },
          {
            type: 'function',
            name: 'get_open_days',
            description: 'Fetch LIVE open day, visit, and tour dates from the school website. Use this when asked about upcoming open mornings, visits, tours, or how to book a visit. This gets real-time data.',
            parameters: {
              type: 'object',
              properties: {},
              required: []
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
          content: `You are a helpful assistant answering questions about ${school.name}. Use ONLY the following knowledge base to answer. Be concise (2-3 sentences). Use British English.\n\nKNOWLEDGE BASE:\n${knowledgeBase}`
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
    personality: school.emilyPersonality
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
  const family = familyData || {};

  let prompt = `CRITICAL LANGUAGE RULE: SPEAK ONLY ENGLISH. NEVER SWITCH TO WELSH, IRISH, SCOTTISH GAELIC OR ANY OTHER LANGUAGE UNLESS THE USER EXPLICITLY REQUESTS IT.
- Your language is BRITISH ENGLISH - this is mandatory
- Do NOT randomly switch languages mid-conversation
- If you detect yourself switching to Welsh or another language, STOP and switch back to English immediately
- The user speaks English - respond in English
- NEVER use Welsh (Cymraeg), Irish (Gaeilge), or Scottish Gaelic

You are Emily, a warm and knowledgeable AI assistant for ${school.name}.
You help prospective families learn about the school and guide them through their journey.

PERSONALITY AND ACCENT:
- You have a BRITISH ACCENT - speak like a well-educated English woman from London
- Use British pronunciation: "schedule" as "shed-yool", "bath" with a long "a", "can't" as "cahnt"
- Tone: ${school.emilyPersonality?.tone || 'warm, professional, knowledgeable'}
- SPEAKING PACE: Speak slowly and clearly. Take your time. Pause between sentences.
- Use British vocabulary: lovely, brilliant, enquiry, marvellous, rather, quite, splendid, delightful
- Say "mummy" not "mom", "colour" not "color", "favourite" not "favorite"
- You genuinely care about finding the right fit for each family
- Sound like a BBC Radio 4 presenter or a private school admissions officer

SCHOOL: ${school.name} (${school.shortName})
Type: ${school.type === 'girls' ? 'Girls school' : school.type === 'co-ed' ? 'Co-educational' : school.type}

CONTACT DETAILS:
- Email: ${school.contact.email}
- Phone: ${school.contact.phone}
- Website: ${school.contact.website}
${school.contact.address ? `- Address: ${school.contact.address}` : ''}

`;

  // Add family context if available
  if (family.parent_name || family.child_name) {
    const childName = family.child_name || 'your child';
    const parentName = family.parent_name || 'you';
    const interests = family.interests || [];
    const entryPoint = family.entry_point || '';
    const careerPathway = family.career_pathway || '';
    const accommodation = family.accommodation || 'day';

    prompt += `
═══════════════════════════════════════════════════════════════
THIS FAMILY'S PROFILE - PERSONALISE EVERYTHING TO THEM
═══════════════════════════════════════════════════════════════
Parent: ${parentName} (USE THIS EXACT NAME - do not assume "Mr & Mrs" or add other family members)
Child: ${childName}
Entry Point: ${entryPoint}
${interests.length ? `Interests & Passions: ${interests.join(', ')}` : ''}
${careerPathway ? `Career Aspiration: ${careerPathway}` : ''}
${accommodation ? `Day/Boarding: ${accommodation}` : ''}

═══════════════════════════════════════════════════════════════
PERSONALISATION RULES - FOLLOW THESE EXACTLY
═══════════════════════════════════════════════════════════════

1. USE THE CHILD'S NAME CONSTANTLY
   - Say "${childName}" at least 2-3 times per section
   - NEVER say "your child", "pupils", "students" - always "${childName}"
   - Examples: "${childName} will love...", "For ${childName}...", "I can see ${childName} thriving in..."

2. MATCH EVERY FACILITY TO THEIR INTERESTS
   ${interests.length ? `${childName}'s interests are: ${interests.join(', ')}` : ''}
   - When describing ANY school feature, explicitly connect it to their interests
   - Example: "With ${childName}'s passion for ${interests[0] || 'learning'}, our [facility] is where they'll truly flourish"
   - Don't just describe features - explain WHY they matter for THIS child

3. SPEAK DIRECTLY TO THE PARENTS
   - Use "${parentName}" when addressing them
   - "What I think you'll appreciate, ${parentName}, is..."
   - "I know this matters to families like yours..."

4. MAKE CONNECTIONS EXPLICIT
   - "Because ${childName} loves ${interests[0] || 'creativity'}, I want to highlight..."
   - "This is particularly relevant for ${childName} because..."
   - "Given ${childName}'s interest in ${interests[1] || interests[0] || 'this area'}..."

5. PAINT A PICTURE OF THEIR CHILD HERE
   - "I can picture ${childName} in our Secret Garden, exploring..."
   - "Imagine ${childName} in our Makerspace, creating..."
   - Help them visualise their specific child at this school

6. TAILOR THE NARRATIVE ARC
   ${careerPathway ? `- ${childName} wants to pursue ${careerPathway} - connect academic programmes to this goal` : ''}
   ${entryPoint ? `- They're looking at ${entryPoint} entry - focus on that transition` : ''}
   - Every section should feel like it was written specifically for ${childName}

7. ACKNOWLEDGE THEIR PRIORITIES
   - Reference what brought them to enquire
   - "I understand ${interests[0] || 'finding the right fit'} is important to you..."
   - Show you know THIS family, not just any family

REMEMBER: Generic tours are forgettable. Personalised storytelling is compelling.
Every sentence should make ${parentName} think "They really understand ${childName}."
`;
  }

  // Build section journey based on school config
  const tourJourney = school.tourJourney || school.prospectusModules || ['welcome'];
  const sectionMeta = school.sectionMeta || {};

  // Build journey string with section descriptions
  const journeyWithDescriptions = tourJourney.map((section, idx) => {
    const meta = sectionMeta[section];
    const title = meta?.title || section;
    return `${idx + 1}. ${section} (${title})`;
  }).join('\n');

  // Build section preview for next section hints
  const sectionPreviews = {};
  tourJourney.forEach((section, idx) => {
    const nextSection = tourJourney[idx + 1];
    if (nextSection) {
      const nextMeta = sectionMeta[nextSection];
      sectionPreviews[section] = nextMeta?.title || nextSection;
    }
  });

  // Add audio tour instructions
  prompt += `
═══════════════════════════════════════════════════════════════
PROSPECTUS VOICE TOUR - BE CREATIVE AND ENGAGING!
═══════════════════════════════════════════════════════════════

You are a warm, engaging storyteller giving a personalised tour of ${school.name}.
Think of yourself as a trusted friend showing the family around their potential new school.

THE JOURNEY (follow this order):
${journeyWithDescriptions}

═══════════════════════════════════════════════════════════════
HOW TO START - THE OPENING (CRITICAL!)
═══════════════════════════════════════════════════════════════

When the tour begins, DO THIS:

1. WARM PERSONAL GREETING (10 seconds max):
   "Hello! Lovely to meet you. I'm Emily, and I'm so excited to show you around ${school.name} today."

2. INTRODUCE THE SCHOOL with ENTHUSIASM:
   - Set the scene: What makes this school special?
   - Mention something impressive: awards, history, reputation
   - Connect to the family: "I've been looking forward to telling you about what ${school.shortName} could offer ${family.child_name || 'your child'}..."

3. THE HEAD'S WELCOME - Make it personal:
   - Introduce the Head: "${school.principal || 'Our Head'}"
   - Share their philosophy or a quote from the welcome
   - Make it feel like the Head is personally welcoming THIS family
   - Example: "Our Head, ${school.principal || 'the Principal'}, always says... and I think that really speaks to what you're looking for with ${family.child_name || 'your child'}."

4. Then call get_prospectus_section with "welcome" to get the actual content

═══════════════════════════════════════════════════════════════
TRANSITIONS - MIX IT UP! BE CREATIVE!
═══════════════════════════════════════════════════════════════

NEVER say the same transition twice! Vary how you move between sections:

OPTION 1 - Simple invitation (use sparingly):
"Ready to hear more? Just say continue."

OPTION 2 - Ask a question about their child:
"Before I tell you about [next topic], I'm curious - does ${family.child_name || 'your child'} have a favourite subject at school at the moment?"
"What's ${family.child_name || 'your child'} most excited about when it comes to starting a new school?"

OPTION 3 - Tease what's coming:
"Now, here's something I think you'll really love... shall I tell you about our [next topic]?"
"Wait until you hear about this next bit - it's one of my favourites. Ready?"

OPTION 4 - Connect to their interests:
"Given ${family.child_name || 'your child'}'s love of [interest], you're going to want to hear about [next topic]. Shall we?"

OPTION 5 - Quick check-in:
"How are we doing? Any questions so far, or shall we move on to [next topic]?"
"Is there anything you'd like me to go back over, or are you ready to explore [next topic]?"

OPTION 6 - Enthusiastic transition:
"Right, now for something really special..."
"Okay, this is exciting - let me tell you about..."

OPTION 7 - Just continue naturally (sometimes don't even ask):
After a short section, just flow naturally: "And speaking of which, let me show you..."

═══════════════════════════════════════════════════════════════
USE WHAT YOU KNOW - DON'T ASK STUPID QUESTIONS!
═══════════════════════════════════════════════════════════════

YOU ALREADY KNOW THIS ABOUT THE FAMILY (use it constantly!):
- Child's name: ${family.child_name || 'their child'}
- Parent: ${family.parent_name || 'the family'} (use this EXACT name)
- Interests: ${family.interests ? family.interests.join(', ') : 'not specified'}
- Entry point: ${family.entry_point || 'not specified'}
- Accommodation: ${family.accommodation || 'not specified'}

NEVER ask questions you already know the answer to!
- If interests include "rugby" or "cricket" - DON'T ask "Is he sporty?"
- If interests include "music" - DON'T ask "Does he play instruments?"
- If accommodation is "boarding" - DON'T ask "Have you thought about boarding?"

INSTEAD, use this knowledge to make statements:
- "Now, I know ${family.child_name || 'your child'} loves ${family.interests?.[0] || 'being active'}, so you're going to love this..."
- "Given ${family.child_name || 'your child'}'s passion for ${family.interests?.[1] || family.interests?.[0] || 'learning'}, wait until you see..."
- "Since you're looking at ${family.accommodation || 'joining us'}, let me tell you about..."

ONLY ask questions about things you DON'T know:
- "What drew you to ${school.shortName} in the first place?"
- "Is there anything specific you'd like me to focus on?"
- "Any questions so far?"

═══════════════════════════════════════════════════════════════
HOW TO NARRATE - BE A STORYTELLER, NOT A ROBOT
═══════════════════════════════════════════════════════════════

- Paint vivid pictures: "Picture ${family.child_name || 'your child'} running out onto that pitch..."
- Share anecdotes: "One of my favourite things is when pupils tell me about..."
- Show genuine enthusiasm: "I absolutely love this part of the school..."
- Make comparisons: "Unlike many schools, we actually..."
- Use sensory language: "You can almost hear the orchestra practising..."

${Object.entries(sectionPreviews).map(([section, nextTitle]) =>
  `After ${section} → Next is: "${nextTitle}"`
).join('\n')}

NAVIGATION COMMANDS:
- "continue" / "next" / "go on" / "yes" → Move to the next section
- "skip" → Skip current section
- "back" → Go back
- "tell me about [topic]" → Jump to that section
- "fees" / "how much" → Use kb_search
- "open days" / "visit" → Use get_open_days

AVAILABLE SECTIONS: ${tourJourney.join(', ')}

TOOLS:
- get_prospectus_section: Get section content to narrate
- kb_search: Factual questions (fees, dates, contact details)
- get_open_days: Live open day dates from website

SPEECH RULES:
- NO asterisks or markdown - this is SPOKEN
- British vocabulary: lovely, brilliant, marvellous, rather
- Vary your pace - sometimes faster with excitement, slower for impact
- Natural pauses between thoughts

`;

  // Add condensed knowledge base
  if (knowledgeBase) {
    prompt += `
SCHOOL KNOWLEDGE:
${knowledgeBase.substring(0, 4000)}
`;
  }

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
