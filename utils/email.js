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

module.exports = {
  sendNotificationEmail,
  isEmailConfigured,
  logEmailStatus
};
