/**
 * Audio Tour Route Handler
 *
 * Provides endpoints for retrieving prospectus sections for audio narration.
 * Parses prospectus HTML and extracts structured content.
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

/**
 * GET /api/:schoolId/audio-tour/sections
 *
 * List all available prospectus sections for this school
 */
router.get('/sections', (req, res) => {
  const school = req.school;

  const sections = school.prospectusModules.map(moduleId => {
    const meta = school.sectionMeta?.[moduleId] || {
      title: moduleId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      intro: `Learn about ${moduleId.replace(/_/g, ' ')}`
    };

    return {
      id: moduleId,
      title: meta.title,
      intro: meta.intro,
      followUp: meta.followUp || []
    };
  });

  res.json({
    school: {
      id: school.id,
      name: school.name,
      shortName: school.shortName
    },
    sections: sections,
    count: sections.length
  });
});

/**
 * GET /api/:schoolId/audio-tour/section/:sectionId
 *
 * Get structured content from a specific prospectus section
 */
router.get('/section/:sectionId', async (req, res) => {
  const school = req.school;
  const sectionId = req.params.sectionId;
  const familyId = req.query.family_id;

  // Get section metadata
  const meta = school.sectionMeta?.[sectionId];
  if (!meta) {
    return res.status(404).json({
      error: 'Section not found',
      section: sectionId,
      available: school.prospectusModules
    });
  }

  try {
    // Try to load prospectus HTML - use school config path if available
    const prospectusFile = school.prospectusFile || 'prospectus.html';
    const prospectusPath = path.join(__dirname, '..', '..', school.id, prospectusFile);

    if (!fs.existsSync(prospectusPath)) {
      return res.json({
        success: true,
        school: { name: school.name, shortName: school.shortName },
        section: sectionId,
        meta: meta,
        content: {
          title: meta.title,
          fullText: `Information about ${meta.title} at ${school.name}. Please see the prospectus for full details.`,
          paragraphs: [],
          highlights: []
        },
        family: {}
      });
    }

    // Parse prospectus HTML
    const html = fs.readFileSync(prospectusPath, 'utf8');
    const $ = cheerio.load(html);

    // Find the section by data-module attribute
    const sectionEl = $(`[data-module="${sectionId}"]`);

    if (!sectionEl.length) {
      return res.status(404).json({
        error: 'Section not found in prospectus',
        section: sectionId
      });
    }

    // Extract structured content
    const content = extractSectionContent($, sectionEl);

    // Get family context if familyId provided (would come from database in production)
    const familyContext = {
      // In production, fetch from database using familyId
    };

    res.json({
      success: true,
      school: {
        name: school.name,
        shortName: school.shortName
      },
      section: sectionId,
      meta: meta,
      content: content,
      family: familyContext
    });

  } catch (err) {
    console.error(`Error loading section ${sectionId}:`, err);
    res.status(500).json({
      error: 'Failed to load section',
      message: err.message
    });
  }
});

/**
 * POST /api/:schoolId/audio-tour/narrate
 *
 * Generate a personalised audio narration for a section
 */
router.post('/narrate', async (req, res) => {
  const school = req.school;
  const { section_id, family_context } = req.body;

  if (!section_id) {
    return res.status(400).json({ error: 'section_id is required' });
  }

  // Get section metadata
  const meta = school.sectionMeta?.[section_id];
  if (!meta) {
    return res.status(404).json({ error: 'Section not found' });
  }

  try {
    // Load section content - use school config path if available
    const prospectusFile = school.prospectusFile || 'prospectus.html';
    const prospectusPath = path.join(__dirname, '..', '..', school.id, prospectusFile);
    let sectionContent = { fullText: `Information about ${meta.title} at ${school.name}.` };

    if (fs.existsSync(prospectusPath)) {
      const html = fs.readFileSync(prospectusPath, 'utf8');
      const $ = cheerio.load(html);
      const sectionEl = $(`[data-module="${section_id}"]`);

      if (sectionEl.length) {
        sectionContent = extractSectionContent($, sectionEl);
      }
    }

    // Generate narration using OpenAI
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const childName = family_context?.child_name || 'your child';
    const interests = family_context?.interests?.join(', ') || '';

    const prompt = `Based on this prospectus content, create a warm, conversational audio narration for a parent.
The narration should:
- Be for ${school.name}
- Reference the child as "${childName}"
- ${interests ? `Emphasise content relevant to their interests: ${interests}` : ''}
- Be conversational, not robotic
- Take about 45-60 seconds to read aloud
- End by offering to continue or move to a related topic

PROSPECTUS SECTION: ${meta.title}
CONTENT: ${sectionContent.fullText?.substring(0, 1500)}

Generate the narration:`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are Emily, a warm British assistant helping families learn about a school. Generate natural, conversational narration. Use British English. Never use asterisks or markdown.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 500
    });

    const narration = completion.choices[0].message.content;

    res.json({
      success: true,
      section: section_id,
      title: meta.title,
      narration: narration,
      followUp: meta.followUp || []
    });

  } catch (err) {
    console.error('Narration generation error:', err);
    res.status(500).json({
      error: 'Failed to generate narration',
      message: err.message
    });
  }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extract structured content from a prospectus section element
 */
function extractSectionContent($, sectionEl) {
  // Get basic elements
  const eyebrow = sectionEl.find('.module__eyebrow').text().trim();
  const title = sectionEl.find('.module__title').text().trim() ||
                sectionEl.find('h2').first().text().trim();
  const subtitle = sectionEl.find('.module__subtitle').text().trim();

  // Get paragraphs
  const paragraphs = [];
  sectionEl.find('p, .lead').each((i, el) => {
    const text = $(el).text().trim();
    if (text && text.length > 10) {
      paragraphs.push(text);
    }
  });

  // Get highlights (headings, feature titles, stat numbers)
  const highlights = [];
  sectionEl.find('.feature-list__title, .stat__number, h3, h4').each((i, el) => {
    const text = $(el).text().trim();
    if (text) {
      highlights.push(text);
    }
  });

  // Get statistics
  const stats = [];
  sectionEl.find('.stat').each((i, el) => {
    const number = $(el).find('.stat__number').text().trim();
    const label = $(el).find('.stat__label').text().trim();
    if (number && label) {
      stats.push({ number, label });
    }
  });

  // Get list items
  const listItems = [];
  sectionEl.find('li').each((i, el) => {
    const text = $(el).text().trim();
    if (text && text.length > 5) {
      listItems.push(text);
    }
  });

  // Create clean full text for narration
  const fullText = sectionEl.text()
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 3000);

  return {
    eyebrow,
    title: title || 'Section',
    subtitle,
    paragraphs: paragraphs.slice(0, 10),
    highlights: highlights.slice(0, 10),
    stats,
    listItems: listItems.slice(0, 15),
    fullText
  };
}

module.exports = router;
