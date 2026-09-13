const nodemailer = require('nodemailer');

let transporter;

// Helper to initialize or reuse the Nodemailer transporter
async function getTransporter() {
  if (transporter) return transporter;

  // 1. Use environment credentials if available
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.ethereal.email',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  } else {
    // 2. Fallback: Auto-generate Ethereal test credentials for local testing
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
    console.log('📧 Ethereal fallback initialized. Test Account:', testAccount.user);
  }

  return transporter;
}

// Core send function
async function sendEmail({ to, subject, html }) {
  try {
    const mailer = await getTransporter();
    const info = await mailer.sendMail({
      from: `"Vendor Compliance System" <${process.env.SMTP_FROM || 'noreply@compliance.com'}>`,
      to,
      subject,
      html,
    });

    console.log(`✉️ Email sent successfully to: ${to}`);
    
    // Output preview link when using Ethereal
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`🔗 Ethereal Mail Preview URL: ${previewUrl}`);
    }
    return info;
  } catch (error) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);
    // Return null instead of throwing so calling scripts don't break
    return null;
  }
}

// Helper wrapper for review status updates
async function sendReviewStatusNotification(to, companyName, status, reviewComments) {
  const emailSubject = `Report Status Update: ${status.replace(/_/g, ' ')}`;
  const htmlContent = `
    <div style="font-family: sans-serif; padding: 20px;">
      <h2 style="color: #1e3a8a;">Vendor Report Status Update</h2>
      <p>Hello <strong>${companyName}</strong>,</p>
      <p>Your submitted report has been reviewed. The status is now: <strong style="color: #2563eb;">${status}</strong>.</p>
      <p><strong>Feedback/Comments:</strong> ${reviewComments || 'No additional comments provided.'}</p>
      <hr />
      <p style="font-size: 0.8rem; color: #64748b;">This is an automated notification from the Vendor Compliance Management System.</p>
    </div>
  `;

  return sendEmail({ to, subject: emailSubject, html: htmlContent });
}

// Helper wrapper for assigned deadlines (includes Date and Time)
async function sendDeadlineNotification(to, companyName, reportType, dueDate) {
  // Use toLocaleString to include both date and time
  const formattedDateTime = new Date(dueDate).toLocaleString('en-US', {
    dateStyle: 'short',   // Displays MM/DD/YYYY
    timeStyle: 'short',   // Displays HH:MM AM/PM
  });

  const emailSubject = ` New Deadline Assigned: ${reportType}`;
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
      <p>Dear <strong>${companyName}</strong>,</p>
      <p>A new deadline for <strong>${reportType}</strong> has been set for <strong>${formattedDateTime}</strong>.</p>
    </div>
  `;

  return sendEmail({ to, subject: emailSubject, html: htmlContent });
}

module.exports = {
  sendEmail,
  sendReviewStatusNotification,
  sendDeadlineNotification,
};