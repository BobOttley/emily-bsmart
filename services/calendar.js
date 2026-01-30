/**
 * Microsoft Graph Calendar Service
 *
 * Handles calendar availability checking and Teams meeting creation for Emily.
 *
 * IMPORTANT RULES:
 * - NEVER reveal calendar availability to users
 * - Make Bob look busy even if calendar is empty
 * - Use polite deflection language ("Bob can squeeze that in", "That slot happens to be free")
 */

// Using native fetch (Node 18+)

// Cache for access token
let accessToken = null;
let tokenExpiry = null;

/**
 * Get Microsoft Graph access token using client credentials flow
 */
async function getAccessToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry - 300000) {
    return accessToken;
  }

  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Microsoft Graph credentials not configured');
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('scope', 'https://graph.microsoft.com/.default');
  params.append('grant_type', 'client_credentials');

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Token error:', error);
    throw new Error('Failed to get access token');
  }

  const data = await response.json();
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);

  return accessToken;
}

/**
 * Get Bob's email from env
 */
function getBobEmail() {
  return process.env.MS_SENDER_EMAIL || 'bob.ottley@bsmart-ai.com';
}

/**
 * Check if a specific time slot is available
 *
 * @param {Date} startTime - Start time of meeting
 * @param {number} durationMinutes - Duration in minutes (default 30)
 * @returns {Object} { available: boolean, busySlots: array }
 */
async function checkAvailability(startTime, durationMinutes = 30) {
  try {
    const token = await getAccessToken();
    const bobEmail = getBobEmail();

    const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

    // Use schedules endpoint to check availability
    const response = await fetch('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        schedules: [bobEmail],
        startTime: {
          dateTime: startTime.toISOString(),
          timeZone: 'GMT Standard Time'
        },
        endTime: {
          dateTime: endTime.toISOString(),
          timeZone: 'GMT Standard Time'
        },
        availabilityViewInterval: durationMinutes
      })
    });

    if (!response.ok) {
      // If schedules endpoint fails, try direct calendar query
      return await checkAvailabilityDirect(startTime, endTime, token, bobEmail);
    }

    const data = await response.json();
    const schedule = data.value?.[0];

    if (!schedule) {
      // No schedule data - assume available
      return { available: true, busySlots: [] };
    }

    // Check if the slot is free
    const available = schedule.availabilityView?.[0] === '0' || !schedule.scheduleItems?.length;

    return {
      available,
      busySlots: schedule.scheduleItems || []
    };

  } catch (err) {
    console.error('Calendar availability check error:', err);
    // On error, return as available and let Bob sort it out
    return { available: true, busySlots: [], error: err.message };
  }
}

/**
 * Direct calendar query fallback
 */
async function checkAvailabilityDirect(startTime, endTime, token, bobEmail) {
  try {
    const url = `https://graph.microsoft.com/v1.0/users/${bobEmail}/calendar/calendarView?` +
      `startDateTime=${startTime.toISOString()}&endDateTime=${endTime.toISOString()}`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      throw new Error(`Calendar query failed: ${response.status}`);
    }

    const data = await response.json();
    const events = data.value || [];

    return {
      available: events.length === 0,
      busySlots: events.map(e => ({
        start: e.start.dateTime,
        end: e.end.dateTime,
        subject: 'Busy' // Don't expose actual meeting titles
      }))
    };

  } catch (err) {
    console.error('Direct calendar query error:', err);
    return { available: true, busySlots: [], error: err.message };
  }
}

/**
 * Find available slots on a given day
 *
 * @param {Date} date - The day to check
 * @param {number} durationMinutes - Meeting duration (default 30)
 * @returns {Array} List of available time slots
 */
async function findAvailableSlots(date, durationMinutes = 30) {
  try {
    const token = await getAccessToken();
    const bobEmail = getBobEmail();

    // Set business hours (9am - 6pm UK time)
    const dayStart = new Date(date);
    dayStart.setHours(9, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(18, 0, 0, 0);

    // Get existing events
    const url = `https://graph.microsoft.com/v1.0/users/${bobEmail}/calendar/calendarView?` +
      `startDateTime=${dayStart.toISOString()}&endDateTime=${dayEnd.toISOString()}`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      throw new Error(`Calendar query failed: ${response.status}`);
    }

    const data = await response.json();
    const events = data.value || [];

    // Build list of busy periods
    const busyPeriods = events.map(e => ({
      start: new Date(e.start.dateTime + 'Z'),
      end: new Date(e.end.dateTime + 'Z')
    }));

    // Find free slots (30-min increments)
    const availableSlots = [];
    let current = new Date(dayStart);

    while (current < dayEnd) {
      const slotEnd = new Date(current.getTime() + durationMinutes * 60000);

      // Check if this slot overlaps any busy period
      const isOverlapping = busyPeriods.some(busy =>
        (current < busy.end && slotEnd > busy.start)
      );

      if (!isOverlapping) {
        availableSlots.push({
          start: new Date(current),
          end: slotEnd,
          formatted: formatTimeSlot(current)
        });
      }

      // Move to next 30-min slot
      current = new Date(current.getTime() + 30 * 60000);
    }

    return availableSlots;

  } catch (err) {
    console.error('Find available slots error:', err);
    return [];
  }
}

/**
 * Format time slot for display
 */
function formatTimeSlot(date) {
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/London'
  });
}

/**
 * Create a Teams meeting and calendar event
 *
 * @param {Object} params - Meeting parameters
 * @param {string} params.subject - Meeting subject
 * @param {Date} params.startTime - Start time
 * @param {number} params.durationMinutes - Duration (default 30)
 * @param {string} params.attendeeEmail - Attendee's email
 * @param {string} params.attendeeName - Attendee's name
 * @param {string} params.description - Meeting description
 * @returns {Object} Meeting details with Teams link
 */
async function createTeamsMeeting(params) {
  const {
    subject,
    startTime,
    durationMinutes = 60,
    attendeeEmail,
    attendeeName,
    description = ''
  } = params;

  try {
    const token = await getAccessToken();
    const bobEmail = getBobEmail();

    const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

    // Create event with Teams meeting
    const eventData = {
      subject: subject || `bSMART AI Demo with ${attendeeName}`,
      body: {
        contentType: 'HTML',
        content: description || `<p>Demo call with ${attendeeName} from bSMART AI</p><p>Booked by Emily (AI Assistant)</p>`
      },
      start: {
        dateTime: startTime.toISOString().replace('Z', ''),
        timeZone: 'GMT Standard Time'
      },
      end: {
        dateTime: endTime.toISOString().replace('Z', ''),
        timeZone: 'GMT Standard Time'
      },
      location: {
        displayName: 'Microsoft Teams Meeting'
      },
      attendees: [
        {
          emailAddress: {
            address: attendeeEmail,
            name: attendeeName
          },
          type: 'required'
        }
      ],
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness'
    };

    const response = await fetch(`https://graph.microsoft.com/v1.0/users/${bobEmail}/events`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(eventData)
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Create meeting error:', error);
      throw new Error(`Failed to create meeting: ${response.status}`);
    }

    const meeting = await response.json();

    return {
      success: true,
      eventId: meeting.id,
      teamsLink: meeting.onlineMeeting?.joinUrl || meeting.webLink,
      startTime: meeting.start.dateTime,
      endTime: meeting.end.dateTime,
      subject: meeting.subject
    };

  } catch (err) {
    console.error('Create Teams meeting error:', err);
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Parse user's requested time into a Date object
 * Handles various formats: "tomorrow at 2pm", "next Tuesday 10am", "3pm", etc.
 *
 * @param {string} timeRequest - User's time request
 * @returns {Date|null} Parsed date or null if couldn't parse
 */
function parseTimeRequest(timeRequest) {
  const now = new Date();
  const text = timeRequest.toLowerCase().trim();

  console.log('CALENDAR: Parsing time request:', text);

  // Extract time (look for patterns like 2pm, 14:00, 2:30pm)
  let hours = null;
  let minutes = 0;

  // Match "2pm", "2:30pm", "14:00", "1:30 pm"
  const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    hours = parseInt(timeMatch[1]);
    minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const ampm = timeMatch[3]?.toLowerCase();

    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
  }

  // Determine the day
  let targetDate = new Date(now);
  let dateFound = false;

  // First, try to parse actual dates like "9th February", "February 10", "10/02", "10 Feb"
  const months = ['january', 'february', 'march', 'april', 'may', 'june',
                  'july', 'august', 'september', 'october', 'november', 'december'];
  const monthsShort = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  // Match "9th February", "9 February", "February 9th", "February 9"
  const datePatterns = [
    /(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)/i,  // 9th February, 9 of February
    /([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?/i,            // February 9th, February 9
  ];

  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (match) {
      let day, monthStr;
      if (/^\d/.test(match[1])) {
        day = parseInt(match[1]);
        monthStr = match[2].toLowerCase();
      } else {
        monthStr = match[1].toLowerCase();
        day = parseInt(match[2]);
      }

      let monthIndex = months.findIndex(m => m.startsWith(monthStr));
      if (monthIndex === -1) monthIndex = monthsShort.findIndex(m => monthStr.startsWith(m));

      if (monthIndex !== -1 && day >= 1 && day <= 31) {
        targetDate = new Date(now.getFullYear(), monthIndex, day);
        // If the date is in the past, assume next year
        if (targetDate < now) {
          targetDate = new Date(now.getFullYear() + 1, monthIndex, day);
        }
        dateFound = true;
        console.log('CALENDAR: Parsed date:', targetDate.toDateString());
        break;
      }
    }
  }

  // If no date found, try other patterns
  if (!dateFound) {
    if (text.includes('tomorrow')) {
      targetDate.setDate(targetDate.getDate() + 1);
      dateFound = true;
    } else if (text.includes('next week')) {
      targetDate.setDate(targetDate.getDate() + 7);
      dateFound = true;
    } else {
      // Check for day names
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      for (let i = 0; i < days.length; i++) {
        if (text.includes(days[i])) {
          const currentDay = now.getDay();
          let daysUntil = i - currentDay;
          if (daysUntil <= 0) daysUntil += 7; // Next occurrence
          if (text.includes('next')) daysUntil += 7; // "next Tuesday"
          targetDate.setDate(targetDate.getDate() + daysUntil);
          dateFound = true;
          console.log('CALENDAR: Parsed day name to:', targetDate.toDateString());
          break;
        }
      }
    }
  }

  // Set the time
  if (hours !== null) {
    targetDate.setHours(hours, minutes, 0, 0);
  } else {
    // Default to 10am if no time specified
    targetDate.setHours(10, 0, 0, 0);
  }

  // If no date found and time has passed today, move to tomorrow
  if (!dateFound && targetDate <= now) {
    targetDate.setDate(targetDate.getDate() + 1);
    console.log('CALENDAR: No date found, defaulting to tomorrow');
  }

  console.log('CALENDAR: Final parsed date/time:', targetDate.toString());
  return targetDate;
}

/**
 * Suggest alternative times when requested slot is busy
 * Returns 2-3 alternatives, phrased to make Bob look busy
 * IMPORTANT: Always includes the full date so Emily doesn't lose context
 *
 * @param {Date} requestedTime - The time that was requested
 * @returns {Array} Alternative time suggestions
 */
async function suggestAlternatives(requestedTime) {
  // Find available slots on the SAME DAY as requested (not today!)
  const sameDay = await findAvailableSlots(requestedTime);
  const nextDay = new Date(requestedTime);
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDaySlots = await findAvailableSlots(nextDay);

  const alternatives = [];

  // Try to find slots near the requested time ON THE SAME DAY
  const requestedHour = requestedTime.getHours();

  // Look for slots within 2 hours of requested time on the same day
  for (const slot of sameDay) {
    const slotHour = slot.start.getHours();
    if (Math.abs(slotHour - requestedHour) <= 2 && alternatives.length < 2) {
      alternatives.push({
        time: slot.start,
        formatted: slot.formatted,
        day: formatDate(requestedTime), // ALWAYS include the full date
        fullDateTime: `${slot.formatted} on ${formatDate(requestedTime)}` // Full string for Emily to use
      });
    }
  }

  // Add a morning slot from next day if needed
  if (alternatives.length < 3 && nextDaySlots.length > 0) {
    const morningSlot = nextDaySlots.find(s => s.start.getHours() >= 9 && s.start.getHours() <= 11);
    if (morningSlot) {
      alternatives.push({
        time: morningSlot.start,
        formatted: morningSlot.formatted,
        day: formatDate(nextDay),
        fullDateTime: `${morningSlot.formatted} on ${formatDate(nextDay)}`
      });
    }
  }

  return alternatives;
}

/**
 * Format date for display
 */
function formatDate(date) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];

  const dayName = days[date.getDay()];
  const dayNum = date.getDate();
  const month = months[date.getMonth()];

  return `${dayName}, ${dayNum} ${month}`;
}

/**
 * Generate "busy Bob" language for responses
 * These phrases make Bob look busy without revealing actual availability
 */
const busyBobPhrases = {
  available: [
    "That works perfectly",
    "That's available",
    "Perfect, that works",
    "Great, that time is free",
    "Lovely, that works"
  ],
  busy: [
    "Bob's in back-to-back meetings then",
    "That slot's already taken I'm afraid",
    "Bob's diary is packed at that time",
    "That one's gone unfortunately"
  ],
  alternative: [
    "How about",
    "I could do",
    "There's a slot at",
    "Bob has a gap at"
  ]
};

function getRandomPhrase(type) {
  const phrases = busyBobPhrases[type];
  return phrases[Math.floor(Math.random() * phrases.length)];
}

/**
 * Create an in-person meeting (calendar event without Teams)
 *
 * @param {Object} params - Meeting parameters
 * @param {string} params.subject - Meeting subject
 * @param {Date} params.startTime - Start time
 * @param {number} params.durationMinutes - Duration (default 60 for in-person)
 * @param {string} params.attendeeEmail - Attendee's email
 * @param {string} params.attendeeName - Attendee's name
 * @param {string} params.location - Meeting location (required)
 * @param {string} params.description - Meeting description
 * @returns {Object} Meeting details
 */
async function createInPersonMeeting(params) {
  const {
    subject,
    startTime,
    durationMinutes = 60, // Longer default for in-person
    attendeeEmail,
    attendeeName,
    location,
    description = ''
  } = params;

  try {
    const token = await getAccessToken();
    const bobEmail = getBobEmail();

    const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

    // Create event without Teams meeting
    const eventData = {
      subject: subject || `bSMART AI Meeting with ${attendeeName}`,
      body: {
        contentType: 'HTML',
        content: description || `<p>In-person meeting with ${attendeeName}</p><p>Location: ${location}</p><p>Booked by Emily (AI Assistant)</p>`
      },
      start: {
        dateTime: startTime.toISOString().replace('Z', ''),
        timeZone: 'GMT Standard Time'
      },
      end: {
        dateTime: endTime.toISOString().replace('Z', ''),
        timeZone: 'GMT Standard Time'
      },
      location: {
        displayName: location
      },
      attendees: [
        {
          emailAddress: {
            address: attendeeEmail,
            name: attendeeName
          },
          type: 'required'
        }
      ],
      isOnlineMeeting: false // No Teams link
    };

    const response = await fetch(`https://graph.microsoft.com/v1.0/users/${bobEmail}/events`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(eventData)
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Create in-person meeting error:', error);
      throw new Error(`Failed to create meeting: ${response.status}`);
    }

    const meeting = await response.json();

    return {
      success: true,
      eventId: meeting.id,
      location: location,
      startTime: meeting.start.dateTime,
      endTime: meeting.end.dateTime,
      subject: meeting.subject
    };

  } catch (err) {
    console.error('Create in-person meeting error:', err);
    return {
      success: false,
      error: err.message
    };
  }
}

module.exports = {
  checkAvailability,
  findAvailableSlots,
  createTeamsMeeting,
  createInPersonMeeting,
  parseTimeRequest,
  suggestAlternatives,
  getRandomPhrase,
  formatDate,
  formatTimeSlot
};
