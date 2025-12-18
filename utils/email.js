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
    const firstName = name ? name.split(' ')[0] : 'Visitor';
    const messages = conversation.map(msg => {
      const isUser = msg.role === 'user';
      const label = isUser ? firstName : 'Emily';
      const textColor = isUser ? '#034674' : '#091825';
      return `
        <div style="margin-bottom: 8px; padding: 8px 0; border-bottom: 1px solid #eee;">
          <span style="font-size: 11px; color: #999; text-transform: uppercase;">${label}</span><br>
          <span style="font-size: 13px; color: ${textColor}; line-height: 1.4;">${msg.content}</span>
        </div>
      `;
    }).join('');

    conversationHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 25px;">
        <tr>
          <td>
            <p style="margin: 0 0 10px; font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 1px;">Conversation</p>
            <div style="padding: 15px; background-color: #f9f9f9; border-radius: 4px;">
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
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 30px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color: #ffffff;">

          <!-- Header -->
          <tr>
            <td style="background-color: #091825; padding: 25px 30px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="color: #FF9F1C; font-size: 22px; font-weight: bold;">bSMART</span>
                  </td>
                  <td style="text-align: right;">
                    <span style="color: #888; font-size: 12px;">New Demo Request</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 30px;">
              <p style="margin: 0 0 20px; color: #333; font-size: 14px;">
                Demo request received via <strong>${source}</strong>:
              </p>

              <!-- Details -->
              <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e0e0e0;">
                <tr>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0; width: 100px; background-color: #fafafa;">
                    <span style="color: #666; font-size: 12px;">Name</span>
                  </td>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0;">
                    <strong style="color: #091825;">${name || '-'}</strong>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0; background-color: #fafafa;">
                    <span style="color: #666; font-size: 12px;">Email</span>
                  </td>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0;">
                    <a href="mailto:${email}" style="color: #034674; text-decoration: none;">${email || '-'}</a>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0; background-color: #fafafa;">
                    <span style="color: #666; font-size: 12px;">School</span>
                  </td>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0;">
                    <span style="color: #091825;">${school || '-'}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0; background-color: #fafafa;">
                    <span style="color: #666; font-size: 12px;">Role</span>
                  </td>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0;">
                    <span style="color: #091825;">${role || '-'}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 15px; background-color: #fafafa;">
                    <span style="color: #666; font-size: 12px;">Products</span>
                  </td>
                  <td style="padding: 12px 15px;">
                    <span style="color: #FF9F1C; font-weight: bold;">${interests || '-'}</span>
                  </td>
                </tr>
              </table>

              <!-- Reply Button -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 25px;">
                <tr>
                  <td>
                    <a href="mailto:${email}?subject=bSMART%20Demo&body=Hi%20${encodeURIComponent(name || '')},%0A%0AThank%20you%20for%20your%20interest%20in%20bSMART.%20I'd%20be%20happy%20to%20arrange%20a%20demo.%0A%0ABest,%0ABob"
                       style="display: inline-block; background-color: #FF9F1C; color: #091825; padding: 10px 25px; font-size: 14px; font-weight: bold; text-decoration: none;">
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
            <td style="background-color: #091825; padding: 15px 30px;">
              <span style="color: #666; font-size: 11px;">Captured by Emily | <a href="https://www.bsmart-ai.com" style="color: #FF9F1C; text-decoration: none;">bsmart-ai.com</a></span>
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

/**
 * Generate email for contact enquiries
 */
function buildContactEmail(details) {
  const { name, email, school, question, conversation } = details;

  let conversationHtml = '';
  if (conversation && conversation.length > 0) {
    const firstName = name ? name.split(' ')[0] : 'Visitor';
    const messages = conversation.map(msg => {
      const isUser = msg.role === 'user';
      const label = isUser ? firstName : 'Emily';
      const textColor = isUser ? '#034674' : '#091825';
      return `
        <div style="margin-bottom: 8px; padding: 8px 0; border-bottom: 1px solid #eee;">
          <span style="font-size: 11px; color: #999; text-transform: uppercase;">${label}</span><br>
          <span style="font-size: 13px; color: ${textColor}; line-height: 1.4;">${msg.content}</span>
        </div>
      `;
    }).join('');

    conversationHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 25px;">
        <tr>
          <td>
            <p style="margin: 0 0 10px; font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 1px;">Conversation</p>
            <div style="padding: 15px; background-color: #f9f9f9; border-radius: 4px;">
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
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 30px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color: #ffffff;">

          <tr>
            <td style="background-color: #091825; padding: 25px 30px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="color: #FF9F1C; font-size: 22px; font-weight: bold;">bSMART</span>
                  </td>
                  <td style="text-align: right;">
                    <span style="color: #888; font-size: 12px;">Contact Enquiry</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding: 30px;">
              <p style="margin: 0 0 20px; color: #333; font-size: 14px;">
                New enquiry received:
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e0e0e0;">
                <tr>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0; width: 100px; background-color: #fafafa;">
                    <span style="color: #666; font-size: 12px;">Name</span>
                  </td>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0;">
                    <strong style="color: #091825;">${name || '-'}</strong>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0; background-color: #fafafa;">
                    <span style="color: #666; font-size: 12px;">Email</span>
                  </td>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0;">
                    <a href="mailto:${email}" style="color: #034674; text-decoration: none;">${email || '-'}</a>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0; background-color: #fafafa;">
                    <span style="color: #666; font-size: 12px;">School</span>
                  </td>
                  <td style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0;">
                    <span style="color: #091825;">${school || '-'}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 15px; background-color: #fafafa; vertical-align: top;">
                    <span style="color: #666; font-size: 12px;">Question</span>
                  </td>
                  <td style="padding: 12px 15px;">
                    <span style="color: #091825;">${question || '-'}</span>
                  </td>
                </tr>
              </table>

              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 25px;">
                <tr>
                  <td>
                    <a href="mailto:${email}?subject=Re:%20Your%20bSMART%20Enquiry&body=Hi%20${encodeURIComponent(name || '')},%0A%0AThank%20you%20for%20getting%20in%20touch.%0A%0A"
                       style="display: inline-block; background-color: #FF9F1C; color: #091825; padding: 10px 25px; font-size: 14px; font-weight: bold; text-decoration: none;">
                      Reply to ${name?.split(' ')[0] || 'Enquiry'}
                    </a>
                  </td>
                </tr>
              </table>

              ${conversationHtml}
            </td>
          </tr>

          <tr>
            <td style="background-color: #091825; padding: 15px 30px;">
              <span style="color: #666; font-size: 11px;">Captured by Emily | <a href="https://www.bsmart-ai.com" style="color: #FF9F1C; text-decoration: none;">bsmart-ai.com</a></span>
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
  buildDemoRequestEmail,
  buildContactEmail
};
