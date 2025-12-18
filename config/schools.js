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
      primary: '#FF9F1C',      // bSMART gold
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
      greeting: "Hello! I'm Emily from bSMART AI. How can I help you today?"
    },
    quickReplies: [
      { label: 'Products', query: 'What products do you offer?' },
      { label: 'How it Works', query: 'How does bSMART work?' },
      { label: 'Book Demo', query: 'I\'d like to book a demo' },
      { label: 'Pricing', query: 'How much does it cost?' },
      { label: 'Contact', query: 'How can I contact you?' }
    ]
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
