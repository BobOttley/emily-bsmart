/**
 * Prospectus Section Function
 *
 * OpenAI function definition for retrieving prospectus sections during audio tours.
 */

/**
 * Function definition for OpenAI tools
 */
const prospectusFunction = {
  name: "get_prospectus_section",
  description: "Retrieves content from a section of the family's personalised prospectus for audio narration. Use this when a parent asks about a topic covered in the prospectus, or when offering an audio tour.",
  parameters: {
    type: "object",
    properties: {
      section: {
        type: "string",
        description: "The prospectus section ID to retrieve (e.g., 'sixth_form', 'boarding_life', 'music')"
      },
      reason: {
        type: "string",
        description: "Brief note on why this section is relevant to the conversation"
      }
    },
    required: ["section"]
  }
};

/**
 * Section mapping - maps common questions/topics to prospectus sections
 */
const sectionMapping = {
  // Academic
  'sixth form': 'sixth_form',
  'a-levels': 'sixth_form',
  'a levels': 'sixth_form',
  'pre-university': 'sixth_form',
  'ib': 'ib_programme',
  'international baccalaureate': 'ib_programme',
  'academics': 'academic_excellence',
  'results': 'academic_excellence',
  'grades': 'academic_excellence',
  'gcse': 'upper_college',
  'curriculum': 'academic_excellence',
  'careers': 'career_pathway',
  'university': 'career_pathway',
  'futures': 'career_pathway',

  // Life
  'boarding': 'boarding_life',
  'houses': 'boarding_life',
  'living at school': 'boarding_life',
  'day girl': 'day_girl_experience',
  'day pupil': 'day_girl_experience',
  'not boarding': 'day_girl_experience',
  'commuting': 'day_girl_experience',
  'pastoral': 'pastoral_care',
  'wellbeing': 'pastoral_care',
  'support': 'pastoral_care',
  'care': 'pastoral_care',

  // Activities
  'sport': 'sport',
  'sports': 'sport',
  'hockey': 'sport',
  'tennis': 'sport',
  'athletics': 'sport',
  'music': 'music',
  'orchestra': 'music',
  'singing': 'music',
  'choir': 'music',
  'drama': 'drama_dance',
  'theatre': 'drama_dance',
  'dance': 'drama_dance',
  'art': 'art',
  'creative': 'art',
  'clubs': 'clubs_enrichment',
  'activities': 'clubs_enrichment',
  'extra-curricular': 'clubs_enrichment',

  // Admissions
  'scholarships': 'scholarships',
  'awards': 'scholarships',
  'bursaries': 'bursaries',
  'fees': 'bursaries',
  'financial help': 'bursaries',
  'apply': 'how_to_apply',
  'application': 'how_to_apply',
  'register': 'how_to_apply',
  'visit': 'visit_us',
  'tour': 'visit_us',
  'open day': 'visit_us',

  // Location
  'where': 'location',
  'location': 'location',
  'campus': 'location',

  // General
  'about': 'why_clc',
  'overview': 'why_clc',
  'special': 'why_clc'
};

/**
 * Get section ID from a query/topic
 * @param {string} query - User query or topic
 * @returns {string|null} Section ID or null
 */
function getSectionFromQuery(query) {
  const queryLower = query.toLowerCase();

  for (const [keyword, section] of Object.entries(sectionMapping)) {
    if (queryLower.includes(keyword)) {
      return section;
    }
  }

  return null;
}

/**
 * Get all available section IDs for a school
 * @param {Object} school - School configuration
 * @returns {string[]} Array of section IDs
 */
function getAvailableSections(school) {
  return school.prospectusModules || [];
}

/**
 * Function handler for get_prospectus_section
 * @param {Object} args - Function arguments { section, reason }
 * @param {Object} context - Context { schoolId, familyId, apiBaseUrl }
 * @returns {Promise<Object>} Section data
 */
async function handleGetProspectusSection(args, context) {
  const { section } = args;
  const { schoolId, familyId, apiBaseUrl } = context;

  try {
    const url = `${apiBaseUrl}/api/${schoolId}/audio-tour/section/${section}${familyId ? `?family_id=${familyId}` : ''}`;

    const response = await fetch(url);

    if (!response.ok) {
      return {
        error: 'Section not found',
        section: section
      };
    }

    return await response.json();

  } catch (error) {
    console.error('Error fetching prospectus section:', error);
    return {
      error: 'Failed to retrieve section',
      message: error.message
    };
  }
}

module.exports = {
  prospectusFunction,
  sectionMapping,
  getSectionFromQuery,
  getAvailableSections,
  handleGetProspectusSection
};
