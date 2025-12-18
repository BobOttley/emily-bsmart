/**
 * Email Utility Module
 *
 * Shared email functionality using Microsoft Graph API.
 * Used by both voice/realtime and chat endpoints.
 */

// Microsoft Graph API Email configuration
const MS_TENANT_ID = process.env.MS_TENANT_ID;
const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const MS_SENDER_EMAIL = process.env.MS_SENDER_EMAIL || process.env.EMAIL_FROM;
const NOTIFICATION_EMAILS = process.env.NOTIFICATION_EMAILS || 'bob.ottley@bsmart-ai.com,info@bsmart-ai.com';

/**
 * Check if email is configured
 */
function isEmailConfigured() {
  return !!(MS_TENANT_ID && MS_CLIENT_ID && MS_CLIENT_SECRET && MS_SENDER_EMAIL);
}

/**
 * Get Microsoft Graph access token
 * @returns {Promise<string|null>} Access token or null if failed
 */
async function getMsGraphToken() {
  const tokenUrl = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append('client_id', MS_CLIENT_ID);
  params.append('client_secret', MS_CLIENT_SECRET);
  params.append('scope', 'https://graph.microsoft.com/.default');
  params.append('grant_type', 'client_credentials');

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to get Microsoft Graph token:', response.status, errorText);
      return null;
    }

    const data = await response.json();

    if (!data.access_token) {
      console.error('Microsoft Graph token response missing access_token:', data);
      return null;
    }

    return data.access_token;
  } catch (err) {
    console.error('Error fetching Microsoft Graph token:', err);
    return null;
  }
}

/**
 * Send notification email via Microsoft Graph
 * @param {string} subject - Email subject (will be prefixed with [bSMART Emily])
 * @param {string} body - HTML email body
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendNotificationEmail(subject, body) {
  if (!isEmailConfigured()) {
    console.log('Microsoft Graph not configured - would send:', subject);
    return { success: false, error: 'Email not configured' };
  }

  try {
    const token = await getMsGraphToken();

    if (!token) {
      return { success: false, error: 'Failed to obtain access token' };
    }

    const emailData = {
      message: {
        subject: `[bSMART Emily] ${subject}`,
        body: {
          contentType: 'HTML',
          content: body
        },
        toRecipients: NOTIFICATION_EMAILS.split(',').map(email => ({
          emailAddress: { address: email.trim() }
        }))
      },
      saveToSentItems: false
    };

    const response = await fetch(
      `https://graph.microsoft.com/v1.0/users/${MS_SENDER_EMAIL}/sendMail`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailData)
      }
    );

    if (response.ok || response.status === 202) {
      console.log('Notification email sent via Microsoft Graph:', subject);
      return { success: true };
    } else {
      const err = await response.text();
      console.error('Microsoft Graph email error:', response.status, err);
      return { success: false, error: err };
    }
  } catch (err) {
    console.error('Email error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Log email configuration status on startup
 */
function logEmailStatus() {
  if (isEmailConfigured()) {
    console.log('Email notifications enabled (Microsoft Graph)');
  } else {
    console.log('Email notifications disabled - Microsoft Graph not configured');
  }
}

/**
 * Generate branded HTML email for demo requests
 * @param {Object} details - Demo request details
 * @param {string} details.name - Contact name
 * @param {string} details.email - Contact email
 * @param {string} details.school - School name
 * @param {string} details.role - Contact role
 * @param {string} details.interests - Products interested in
 * @param {Array} details.conversation - Chat history array [{role, content}]
 * @param {string} source - Where the lead came from (e.g. 'Chat', 'Voice')
 * @returns {string} HTML email body
 */
function buildDemoRequestEmail(details, source = 'Website') {
  const { name, email, school, role, interests, conversation } = details;

  // Build conversation HTML if provided
  let conversationHtml = '';
  if (conversation && conversation.length > 0) {
    const messages = conversation.map(msg => {
      const isUser = msg.role === 'user';
      const bgColor = isUser ? '#e8f4f8' : '#fff8e8';
      const label = isUser ? '👤 Visitor' : '🤖 Emily';
      const borderColor = isUser ? '#034674' : '#FF9F1C';
      return `
        <div style="margin-bottom: 10px; padding: 12px; background-color: ${bgColor}; border-left: 3px solid ${borderColor}; border-radius: 4px;">
          <div style="font-size: 11px; color: #666; margin-bottom: 4px; font-weight: bold;">${label}</div>
          <div style="font-size: 14px; color: #333; line-height: 1.4;">${msg.content}</div>
        </div>
      `;
    }).join('');

    conversationHtml = `
      <!-- Conversation History -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 30px;">
        <tr>
          <td>
            <h3 style="margin: 0 0 15px; color: #091825; font-size: 16px; border-bottom: 2px solid #FF9F1C; padding-bottom: 8px;">
              💬 Conversation History
            </h3>
            <div style="max-height: 400px; overflow-y: auto; padding: 10px; background-color: #fafafa; border-radius: 8px;">
              ${messages}
            </div>
          </td>
        </tr>
      </table>
    `;
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4; padding: 20px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #091825 0%, #0d2a3d 100%); padding: 30px 40px; text-align: center;">
              <h1 style="margin: 0; color: #FF9F1C; font-size: 28px; font-weight: bold;">bSMART</h1>
              <p style="margin: 5px 0 0; color: #ffffff; font-size: 14px; letter-spacing: 1px;">AI-POWERED ADMISSIONS</p>
            </td>
          </tr>

          <!-- Alert Banner -->
          <tr>
            <td style="background-color: #FF9F1C; padding: 15px 40px; text-align: center;">
              <p style="margin: 0; color: #091825; font-size: 16px; font-weight: bold;">
                🎯 New Demo Request via ${source}
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="margin: 0 0 20px; color: #333; font-size: 16px; line-height: 1.5;">
                A potential customer has requested a demo through Emily. Here are their details:
              </p>

              <!-- Details Card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8f9fa; border-radius: 8px; border-left: 4px solid #FF9F1C;">
                <tr>
                  <td style="padding: 25px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e9ecef;">
                          <span style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Name</span><br>
                          <span style="color: #091825; font-size: 18px; font-weight: bold;">${name || 'Not provided'}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e9ecef;">
                          <span style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Email</span><br>
                          <a href="mailto:${email}" style="color: #FF9F1C; font-size: 16px; text-decoration: none;">${email || 'Not provided'}</a>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e9ecef;">
                          <span style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">School</span><br>
                          <span style="color: #091825; font-size: 16px;">${school || 'Not provided'}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e9ecef;">
                          <span style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Role</span><br>
                          <span style="color: #091825; font-size: 16px;">${role || 'Not provided'}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0;">
                          <span style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Interested In</span><br>
                          <span style="color: #FF9F1C; font-size: 16px; font-weight: bold;">${interests || 'Not specified'}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 30px;">
                <tr>
                  <td align="center">
                    <a href="mailto:${email}?subject=bSMART%20Demo%20Follow-up&body=Hi%20${encodeURIComponent(name || '')},%0A%0AThank%20you%20for%20your%20interest%20in%20bSMART%20AI.%20I'd%20love%20to%20arrange%20a%20demo%20for%20you.%0A%0ABest%20regards,%0ABob"
                       style="display: inline-block; background-color: #FF9F1C; color: #091825; padding: 14px 40px; font-size: 16px; font-weight: bold; text-decoration: none; border-radius: 6px;">
                      Reply to ${name?.split(' ')[0] || 'Lead'}
                    </a>
                  </td>
                </tr>
              </table>

              ${conversationHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #091825; padding: 25px 40px; text-align: center;">
              <p style="margin: 0 0 10px; color: #FF9F1C; font-size: 14px; font-weight: bold;">
                bSMART AI
              </p>
              <p style="margin: 0; color: #888; font-size: 12px;">
                This lead was captured by Emily, your AI assistant.<br>
                <a href="https://www.bsmart-ai.com" style="color: #FF9F1C; text-decoration: none;">www.bsmart-ai.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

module.exports = {
  sendNotificationEmail,
  isEmailConfigured,
  logEmailStatus,
  buildDemoRequestEmail
};
