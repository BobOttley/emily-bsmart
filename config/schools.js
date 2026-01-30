/**
 * bSMART AI - Emily Configuration
 */

const schools = {
  'bsmart': {
    id: 'bsmart',
    name: 'bSMART AI',
    shortName: 'bSMART',
    type: 'company',
    knowledgeBase: 'bsmart.md',
    theme: {
      primary: '#FF9F1C',      // bSMART gold/orange
      secondary: '#091825',    // bSMART navy
      accent: '#FF9F1C',
      background: '#FAFAFA',
      text: '#2C3E50'
    },
    contact: {
      email: 'info@bsmart-ai.com',
      phone: '+44 7867 803275',
      website: 'www.bsmart-ai.com'
    },
    principal: 'Bob Ottley',
    emilyPersonality: {
      voice: 'coral',
      accent: 'British',
      tone: 'warm, professional, knowledgeable',
      greeting: "Hello! I'm Emily from bSMART AI. I help schools transform their admissions with AI. How can I help you today?"
    },
    // Initial quick replies - guide people into the demo experience
    quickReplies: [
      { label: 'Show Me How It Works', query: 'Show me how Emily works for schools', highlight: true },
      { label: 'Book a Call', query: 'I\'d like to book a demo with Bob' },
      { label: 'What Is This?', query: 'What is bSMART AI?' }
    ],
    // Contextual follow-up buttons based on topics
    contextualReplies: {
      // After showing all products
      products: [
        { label: 'SMART Prospectus', query: 'Tell me more about SMART Prospectus' },
        { label: 'SMART Chat', query: 'How does SMART Chat work?' },
        { label: 'SMART Voice', query: 'What can SMART Voice do?' },
        { label: 'SMART CRM', query: 'What makes SMART CRM different?' },
        { label: 'SMART Email', query: 'How does SMART Email personalise?' },
        { label: 'SMART Booking', query: 'Tell me about SMART Booking' },
        { label: 'Analytics', query: 'What insights does Analytics provide?' }
      ],
      // After discussing a specific product
      productDeep: [
        { label: 'See a Demo', query: 'Can I see a demo of this?' },
        { label: 'Pricing', query: 'How much does this cost?' },
        { label: 'Implementation', query: 'How long does implementation take?' },
        { label: 'Other Products', query: 'What other products do you have?' }
      ],
      // After discussing integration/connection
      integration: [
        { label: 'Data Security', query: 'How do you protect our data?' },
        { label: 'Existing Systems', query: 'Can it integrate with our existing MIS?' },
        { label: 'Book a Demo', query: 'I\'d like to see this in action' },
        { label: 'Case Studies', query: 'Do you have any case studies?' }
      ],
      // After discussing security
      security: [
        { label: 'GDPR Compliance', query: 'Are you GDPR compliant?' },
        { label: 'Data Storage', query: 'Where is data stored?' },
        { label: 'Staff Training', query: 'Do you provide staff training?' },
        { label: 'Book a Demo', query: 'I\'d like to discuss this further' }
      ],
      // After discussing pricing
      pricing: [
        { label: 'What\'s Included', query: 'What\'s included in the price?' },
        { label: 'Contract Length', query: 'How long are the contracts?' },
        { label: 'Support', query: 'What support do you provide?' },
        { label: 'Book a Demo', query: 'Let\'s arrange a demo to discuss' }
      ],
      // After booking intent
      booking: [
        { label: 'Best Time', query: 'What times work for demos?' },
        { label: 'What to Expect', query: 'What happens in a demo?' },
        { label: 'Who Should Attend', query: 'Who from our school should join?' },
        { label: 'Prepare Questions', query: 'What should we prepare?' }
      ],
      // After implementation discussion
      implementation: [
        { label: 'Timeline', query: 'What\'s the typical timeline?' },
        { label: 'Data Migration', query: 'How does data migration work?' },
        { label: 'Training', query: 'What training do you provide?' },
        { label: 'Go Live Support', query: 'What support at go-live?' }
      ],
      // General follow-ups
      general: [
        { label: 'See Products', query: 'Show me the products again' },
        { label: 'Pricing', query: 'How does pricing work?' },
        { label: 'Book a Demo', query: 'I\'d like to book a demo' },
        { label: 'Contact Us', query: 'How can I contact bSMART?' }
      ]
    }
  }
};

function getSchool(schoolId) {
  return schools['bsmart'];
}

function getSchoolIds() {
  return ['bsmart'];
}

function detectSchoolFromUrl(url) {
  return 'bsmart';
}

module.exports = {
  schools,
  getSchool,
  getSchoolIds,
  detectSchoolFromUrl
};
