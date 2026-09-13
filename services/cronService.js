const cron = require('node-cron');
const { sendEmail } = require('./emailService');

// Helper to log notifications into the database audit trail
async function logNotification(prisma, recipient, subject, type, status = 'SENT', errorMessage = null) {
  try {
    await prisma.notificationLog.create({
      data: { recipient, subject, type, status, errorMessage }
    });
  } catch (err) {
    console.error('Failed to record notification log:', err.message);
  }
}

function initCronJobs(prisma) {
  // Runs every day at midnight ('0 0 * * *')
  cron.schedule('0 0 * * *', async () => {
    console.log('⏰ Executing Automated Reminder Schedule Check...');
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Fetch all deadlines that haven't been completed yet
      const pendingDeadlines = await prisma.deadline.findMany({
        where: { status: { in: ['NOT_SUBMITTED', 'PENDING', 'UPCOMING'] } },
        include: { vendor: true },
      });

      for (const deadline of pendingDeadlines) {
        const vendor = deadline.vendor;
        if (!vendor || !vendor.contactEmail) continue;

        const dueDate = new Date(deadline.dueDate);
        dueDate.setHours(0, 0, 0, 0);

        // Difference in full days
        const diffDays = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));

        // 1. THREE DAYS BEFORE DEADLINE: Reminder
        if (diffDays === 3) {
          const subject = `🔔 Reminder: ${deadline.reportType || 'Compliance Report'} Due in 3 Days`;
          const html = `
            <p>Dear <strong>${vendor.companyName}</strong>,</p>
            <p>This is a reminder that your upcoming <strong>${deadline.reportType}</strong> report is due in 3 days on <strong>${dueDate.toLocaleDateString()}</strong>.</p>
            <p>Please log in to the portal to upload your files.</p>
          `;
          
          await sendEmail({ to: vendor.contactEmail, subject, html });
          await logNotification(prisma, vendor.contactEmail, subject, 'REMINDER');
        }

        // 2. ON DEADLINE DAY: Due notification
        if (diffDays === 0) {
          const subject = `🚨 Due Today: ${deadline.reportType || 'Compliance Report'}`;
          const html = `
            <p>Dear <strong>${vendor.companyName}</strong>,</p>
            <p>Your compliance report for <strong>${deadline.reportType}</strong> is <strong>due today</strong> (${dueDate.toLocaleDateString()}).</p>
            <p>Please submit your document before the cut-off time to maintain compliance status.</p>
          `;

          await sendEmail({ to: vendor.contactEmail, subject, html });
          await logNotification(prisma, vendor.contactEmail, subject, 'DUE_TODAY');
        }

        // 3. AFTER DEADLINE: Overdue alert
        if (diffDays < 0) {
          // Update deadline status to OVERDUE
          await prisma.deadline.update({
            where: { id: deadline.id },
            data: { status: 'OVERDUE' }
          });

          // Flag vendor compliance status as NON_COMPLIANT
          await prisma.vendor.update({
            where: { id: vendor.id },
            data: { complianceStatus: 'NON_COMPLIANT' }
          });

          const subject = `⚠️ Overdue Alert: ${deadline.reportType || 'Compliance Report'}`;
          const html = `
            <p>Dear <strong>${vendor.companyName}</strong>,</p>
            <p>Your report due on <strong>${dueDate.toLocaleDateString()}</strong> is now <strong style="color: red;">overdue</strong>.</p>
            <p>Your vendor status has been flagged as <strong>NON_COMPLIANT</strong>. Please submit your documentation immediately.</p>
          `;

          await sendEmail({ to: vendor.contactEmail, subject, html });
          await logNotification(prisma, vendor.contactEmail, subject, 'OVERDUE_ALERT');
        }
      }
    } catch (error) {
      console.error('❌ Error executing reminder cron schedule:', error.message);
    }
  });

  console.log('⏰ Automated Reminder Schedule Engine Initialized.');
}

module.exports = { initCronJobs };