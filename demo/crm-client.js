/**
 * CRM Client - Makes API calls to CRM, Booking, and Prospectus systems
 *
 * Handles creating enquiries, bookings, and prospectuses during the demo flow.
 */

const CRM_URL = process.env.CRM_URL || 'http://localhost:3001';
const BOOKING_URL = process.env.BOOKING_APP_URL || 'http://localhost:3002';
const PROSPECTUS_URL = process.env.PROSPECTUS_URL || 'http://localhost:3000';
const SCHOOL_ID = parseInt(process.env.DEMO_SCHOOL_ID || '55', 10);

/**
 * Create an enquiry in the CRM for this demo prospect
 */
async function createEnquiry(session) {
  try {
    console.log(`[CRM] Creating enquiry for ${session.name} (${session.email})`);

    const response = await fetch(`${CRM_URL}/api/dashboard-enquiry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: session.name || 'Demo',
        familySurname: 'Prospect',
        parentEmail: session.email,
        parentName: session.name || 'Demo Prospect',
        contactNumber: '07000 000000',
        ageGroup: '11-13',
        entryYear: '2025',
        hearAboutUs: 'Demo Platform',
        school_id: SCHOOL_ID,
        createProspectus: false
      })
    });

    console.log(`[CRM] Enquiry response status: ${response.status}`);

    if (response.ok) {
      const data = await response.json();
      const enquiryId = data.id || data.inquiryId || `demo-${session.sessionId.substring(0, 8)}`;
      console.log(`[CRM] Created enquiry: ${enquiryId}`);
      return { success: true, enquiryId, method: 'api' };
    } else {
      const errorText = await response.text();
      console.error(`[CRM] Failed: ${response.status} - ${errorText}`);
      return { success: false, error: `CRM API returned ${response.status}` };
    }
  } catch (err) {
    console.error(`[CRM] Error creating enquiry:`, err.message);
    // Return a mock enquiry ID for demo purposes if CRM is unavailable
    const mockId = `demo-${Date.now()}`;
    console.log(`[CRM] Using mock enquiry ID: ${mockId}`);
    return { success: true, enquiryId: mockId, method: 'mock' };
  }
}

/**
 * Create a booking for the demo prospect
 */
async function createBooking(session, bookingType, eventId) {
  try {
    console.log(`[BOOKING] Creating ${bookingType} booking for ${session.email}`);

    const bookingData = {
      school_id: SCHOOL_ID,
      event_id: bookingType === 'open_day' ? eventId : null,
      inquiry_id: session.enquiryId,
      parent_first_name: session.name || 'Demo',
      parent_last_name: 'Prospect',
      email: session.email,
      phone: '07000 000000',
      student_first_name: 'Demo',
      student_last_name: 'Child',
      num_attendees: 2,
      booking_type: bookingType,
      source: 'demo_platform'
    };

    const response = await fetch(`${BOOKING_URL}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bookingData)
    });

    console.log(`[BOOKING] Response status: ${response.status}`);

    if (response.ok) {
      const data = await response.json();
      const bookingId = data.id || data.booking?.id;
      console.log(`[BOOKING] Created booking: ${bookingId}`);
      return { success: true, bookingId, type: bookingType, method: 'api' };
    } else {
      const errorText = await response.text();
      console.error(`[BOOKING] Failed: ${response.status} - ${errorText}`);
      return { success: false, error: `Booking API returned ${response.status}` };
    }
  } catch (err) {
    console.error(`[BOOKING] Error creating booking:`, err.message);
    // Return a mock booking ID for demo purposes if booking system is unavailable
    const mockId = Math.floor(Math.random() * 10000);
    console.log(`[BOOKING] Using mock booking ID: ${mockId}`);
    return { success: true, bookingId: mockId, type: bookingType, method: 'mock' };
  }
}

/**
 * Generate a personalised prospectus for the demo prospect
 * This calls the prospectus app API which:
 * 1. Creates the enquiry in the database
 * 2. Generates the personalised prospectus HTML
 * 3. Sends the prospectus email to the parent
 */
async function generateProspectus(session) {
  try {
    console.log(`[PROSPECTUS] Generating prospectus for ${session.childName} (parent: ${session.email})`);

    // Build the request payload matching prospectus API expectations
    const prospectusData = {
      // Parent info
      parentName: session.name || 'Demo Prospect',
      parentEmail: session.email,
      contactNumber: '07000 000000',
      hearAboutUs: 'bSMART AI Demo',

      // Child info
      firstName: session.childName || 'Demo',
      familySurname: 'Prospect',
      ageGroup: session.ageGroup || '11-16',
      entryYear: '2025',

      // Interests - spread the boolean flags
      ...session.interests,

      // Demo flag
      school_id: SCHOOL_ID
    };

    console.log(`[PROSPECTUS] Request payload:`, JSON.stringify(prospectusData, null, 2));

    const response = await fetch(`${PROSPECTUS_URL}/api/inquiry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prospectusData)
    });

    console.log(`[PROSPECTUS] Response status: ${response.status}`);

    if (response.ok) {
      const data = await response.json();
      console.log(`[PROSPECTUS] Response:`, JSON.stringify(data, null, 2));

      const enquiryId = data.id || data.inquiryId || `demo-${session.sessionId.substring(0, 8)}`;
      const prospectusUrl = data.prospectusUrl || data.prospectus_url;

      console.log(`[PROSPECTUS] Created enquiry: ${enquiryId}, prospectus: ${prospectusUrl}`);

      return {
        success: true,
        enquiryId,
        prospectusUrl,
        method: 'api'
      };
    } else {
      const errorText = await response.text();
      console.error(`[PROSPECTUS] Failed: ${response.status} - ${errorText}`);

      // Fall back to creating just the enquiry
      console.log(`[PROSPECTUS] Falling back to CRM enquiry only`);
      const crmResult = await createEnquiry(session);

      return {
        success: crmResult.success,
        enquiryId: crmResult.enquiryId,
        prospectusUrl: null,
        method: 'crm_fallback',
        error: `Prospectus API returned ${response.status}`
      };
    }
  } catch (err) {
    console.error(`[PROSPECTUS] Error generating prospectus:`, err.message);

    // Return a mock result for demo purposes
    const mockId = `demo-${Date.now()}`;
    console.log(`[PROSPECTUS] Using mock enquiry ID: ${mockId}`);

    return {
      success: true,
      enquiryId: mockId,
      prospectusUrl: null,
      method: 'mock',
      error: err.message
    };
  }
}

module.exports = {
  createEnquiry,
  createBooking,
  generateProspectus,
  CRM_URL,
  BOOKING_URL,
  PROSPECTUS_URL,
  SCHOOL_ID
};
