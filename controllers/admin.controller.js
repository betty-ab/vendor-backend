// controllers/admin.controller.js
const prisma = require('../prisma/client');
const {
  sendReviewStatusNotification,
  sendDeadlineNotification,
} = require('../services/emailService');

/**
 * POST /api/admin/deadlines
 * Admin: assign a deadline to a vendor
 */
async function createDeadline(req, res) {
  try {
    const { vendorId, reportType, dueDate } = req.body;

    if (!vendorId || !reportType || !dueDate) {
      return res.status(400).json({ error: 'vendorId, reportType and dueDate are required.' });
    }

    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });

    if (new Date(vendor.contractEndDate) < new Date()) {
      return res.status(400).json({ error: 'Cannot assign deadlines to a vendor with an expired contract.' });
    }

    const deadline = await prisma.deadline.create({
      data: {
        vendorId,
        reportType,
        dueDate: new Date(dueDate),
        status: 'NOT_SUBMITTED',
      },
    });

    // Fire-and-forget email (won't block the response)
    sendDeadlineNotification(
      vendor.contactEmail,
      vendor.companyName,
      reportType,
      deadline.dueDate
    ).catch((e) => console.error('Deadline email failed:', e.message));

    res.status(201).json({ message: 'Deadline assigned.', deadline });
  } catch (err) {
    console.error('createDeadline error:', err);
    res.status(500).json({ error: 'Failed to create deadline.' });
  }
}

/**
 * PATCH /api/admin/submissions/:id/review
 * Admin: approve / return / reject a submission, log it, notify vendor
 */
async function reviewSubmission(req, res) {
  try {
    const { id } = req.params;
    const { status, reviewedByDept, reviewerUserId, reviewComments } = req.body;

    const ALLOWED = ['APPROVED', 'RETURNED_FOR_CORRECTION', 'REJECTED'];
    if (!ALLOWED.includes(status)) {
      return res.status(400).json({ error: 'Invalid review status.' });
    }

    const submission = await prisma.reportSubmission.findUnique({
      where: { id },
      include: { vendor: true },
    });
    if (!submission) return res.status(404).json({ error: 'Submission not found.' });

    const updated = await prisma.$transaction(async (tx) => {
      const sub = await tx.reportSubmission.update({
        where: { id },
        data: { approvalStatus: status },
      });

      await tx.approvalLog.create({
        data: {
          submissionId: id,
          reviewedByDept: reviewedByDept || 'Compliance Ops',
          reviewerUserId: reviewerUserId || req.user.id,
          action: status,
          comments: reviewComments || `Status updated to ${status}`,
        },
      });

      // Adjust vendor compliance status based on outcome
      let newCompliance = submission.vendor.complianceStatus;

      if (status === 'APPROVED') {
        newCompliance = 'OK';
      } else if (status === 'RETURNED_FOR_CORRECTION') {
        newCompliance = 'WARNING';
      } else if (status === 'REJECTED') {
        newCompliance = 'COMPLIANCE_ISSUE';
      }

      if (newCompliance !== submission.vendor.complianceStatus) {
        await tx.vendor.update({
          where: { id: submission.vendorId },
          data: { complianceStatus: newCompliance },
        });
      }

      return sub;
    });

    // Notify vendor
    sendReviewStatusNotification(
      submission.vendor.contactEmail,
      submission.vendor.companyName,
      status,
      reviewComments
    ).catch((e) => console.error('Review email failed:', e.message));

    // Log notification
    await prisma.notificationLog.create({
      data: {
        recipient: submission.vendor.contactEmail,
        subject: `Report Status Update: ${status.replace(/_/g, ' ')}`,
        type: 'REVIEW_STATUS',
        status: 'SENT',
      },
    }).catch(() => {}); // non-fatal

    res.json({ message: 'Review recorded.', submission: updated });
  } catch (err) {
    console.error('reviewSubmission error:', err);
    res.status(500).json({ error: 'Failed to process review.' });
  }
}

/**
 * PATCH /api/admin/vendors/:id/renew-contract
 * Admin: extend a vendor contract end date
 */
async function renewContract(req, res) {
  try {
    const { id } = req.params;
    const { newContractEndDate } = req.body;

    if (!newContractEndDate) {
      return res.status(400).json({ error: 'newContractEndDate is required.' });
    }

    const newDate = new Date(newContractEndDate);
    if (isNaN(newDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format.' });
    }

    const vendor = await prisma.vendor.findUnique({ where: { id } });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });

    if (newDate <= new Date(vendor.contractEndDate)) {
      return res.status(400).json({ error: 'New end date must be after the current end date.' });
    }

    const updated = await prisma.vendor.update({
      where: { id },
      data: {
        contractEndDate: newDate,
        // Contract renewed → restore compliance to OK
        complianceStatus: 'OK',
        lateCount: 0,
      },
    });

    res.json({
      message: 'Contract renewed successfully.',
      vendor: updated,
    });
  } catch (err) {
    console.error('renewContract error:', err);
    res.status(500).json({ error: 'Failed to renew contract.' });
  }
}

/**
 * GET /api/admin/notifications/logs
 * Admin: audit trail of all automated notifications
 */
async function listNotificationLogs(req, res) {
  try {
    const logs = await prisma.notificationLog.findMany({
      orderBy: { sentAt: 'desc' },
      take: 200,
    });
    res.json(logs);
  } catch (err) {
    console.error('listNotificationLogs error:', err);
    res.status(500).json({ error: 'Failed to fetch notification logs.' });
  }
}

module.exports = {
  createDeadline,
  reviewSubmission,
  renewContract,
  listNotificationLogs,
};