// controllers/submission.controller.js
const path = require('path');
const prisma = require('../prisma/client');
const { sendReviewStatusNotification } = require('../services/emailService');

/**
 * POST /api/submissions
 * Vendor submits a report with attachments.
 * Multer has already saved files into /uploads and populated req.files.
 */
async function createSubmission(req, res) {
  try {
    const { vendorId, reportType, notes } = req.body;

    if (!vendorId || !reportType) {
      return res.status(400).json({ error: 'vendorId and reportType are required.' });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'At least one file must be attached.' });
    }

    // Vendor can only submit for their own vendor record
    if (req.user.role === 'VENDOR' && req.user.vendorId !== vendorId) {
      return res.status(403).json({ error: 'You can only submit for your own account.' });
    }

    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });

    // Block expired contracts
    if (new Date(vendor.contractEndDate) < new Date()) {
      return res.status(400).json({ error: 'Contract expired. Submission blocked.' });
    }

    // Find the nearest active deadline for this vendor + report type (optional)
    const deadline = await prisma.deadline.findFirst({
      where: {
        vendorId,
        reportType,
        status: { in: ['NOT_SUBMITTED', 'PENDING', 'UPCOMING', 'OVERDUE'] },
      },
      orderBy: { dueDate: 'asc' },
    });

    // Determine submission status (on-time vs late)
    const now = new Date();
    let submissionStatus = 'ON_TIME';
    if (deadline && new Date(deadline.dueDate) < now) {
      submissionStatus = 'LATE';
    }

    // Create submission + attachments in a transaction
    const submission = await prisma.$transaction(async (tx) => {
      const created = await tx.reportSubmission.create({
        data: {
          vendorId,
          deadlineId: deadline?.id || null,
          reportType,
          notes: notes || null,
          submissionStatus,
          approvalStatus: 'PENDING_REVIEW',
        },
      });

      await tx.attachment.createMany({
        data: req.files.map((file) => ({
          submissionId: created.id,
          fileName: file.originalname,
          filePath: file.path,
          fileType: file.mimetype,
        })),
      });

      // If a deadline exists, mark it as submitted
      if (deadline) {
        await tx.deadline.update({
          where: { id: deadline.id },
          data: { status: submissionStatus === 'LATE' ? 'LATE' : 'ON_TIME' },
        });
      }

      // If vendor was NON_COMPLIANT, restore to OK on successful submission
      if (vendor.complianceStatus === 'NON_COMPLIANT' && submissionStatus === 'ON_TIME') {
        await tx.vendor.update({
          where: { id: vendorId },
          data: { complianceStatus: 'OK' },
        });
      }

      return created;
    });

    res.status(201).json({
      message: 'Report submitted successfully.',
      submission,
    });
  } catch (err) {
    console.error('createSubmission error:', err);
    res.status(500).json({ error: 'Failed to submit report.' });
  }
}

module.exports = { createSubmission };