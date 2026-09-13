require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const multer = require('multer');

const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

// Initialize Prisma with Pg Adapter
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

const { sendDeadlineNotification, sendReviewStatusNotification, sendEmail } = require('./services/emailService');
const { initCronJobs } = require('./services/cronService');

// Middleware Configuration
app.use(cors());
app.use(express.json());

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configure Multer Storage
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const customUpload = require('./middleware/upload'); // Pre-configured upload middleware

// ==========================================
// AUTHENTICATION & AUTHORIZATION MIDDLEWARES
// ==========================================

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required. Please log in.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions.' });
    }
    next();
  };
}

const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'Forbidden: You do not have permission to perform this action.' 
      });
    }
    next();
  };
};

// ==========================================
// BACKGROUND TASKS & UTILITIES
// ==========================================

async function checkAndUpdateOverdueDeadlines() {
  try {
    const now = new Date();
    const overdueDeadlines = await prisma.deadline.findMany({
      where: {
        dueDate: { lt: now },
        status: { in: ['PENDING', 'UPCOMING'] },
      },
    });

    if (overdueDeadlines.length === 0) return;

    const overdueIds = overdueDeadlines.map((d) => d.id);
    const affectedVendorIds = [...new Set(overdueDeadlines.map((d) => d.vendorId))];

    await prisma.$transaction([
      prisma.deadline.updateMany({
        where: { id: { in: overdueIds } },
        data: { status: 'OVERDUE' },
      }),
      prisma.vendor.updateMany({
        where: { id: { in: affectedVendorIds } },
        data: { complianceStatus: 'NON_COMPLIANT' },
      }),
    ]);

    console.log(`⏰ Updated ${overdueIds.length} overdue deadline(s) and flagged vendors.`);
  } catch (error) {
    console.error('❌ Error updating overdue deadlines:', error);
  }
}

async function runComplianceCheck() {
  console.log('Running automated deadline & compliance check...');
  const now = new Date();

  try {
    const deadlines = await prisma.deadline.findMany({
      include: { vendor: true, submissions: true },
    });

    for (const deadline of deadlines) {
      const hasSubmitted = deadline.submissions.length > 0;
      const isPastDue = now > new Date(deadline.dueDate);

      if (!hasSubmitted && isPastDue) {
        let newComplianceStatus = 'WARNING';
        if (deadline.vendor.complianceStatus === 'WARNING') {
          newComplianceStatus = 'COMPLIANCE_ISSUE';
        } else if (deadline.vendor.complianceStatus === 'COMPLIANCE_ISSUE') {
          newComplianceStatus = 'PENALTY_ESCALATED';
        }

        await prisma.vendor.update({
          where: { id: deadline.vendorId },
          data: { complianceStatus: newComplianceStatus },
        });
      }
    }
  } catch (error) {
    console.error('Error during compliance check:', error);
  }
}

// Scheduled Cron Jobs
cron.schedule('0 * * * *', () => {
  console.log('⏰ Running automated hourly compliance deadline check...');
  checkAndUpdateOverdueDeadlines();
});

cron.schedule('0 0 * * *', () => {
  runComplianceCheck();
});

// ==========================================
// SYSTEM & AUTH ROUTES
// ==========================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Vendor Compliance API is running' });
});

// POST: Login Endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Please provide email and password.' });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { vendor: true },
    });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const tokenPayload = {
      userId: user.id,
      id: user.id,
      email: user.email,
      role: user.role,
      vendorId: user.vendorId || null,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '8h' });

    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        vendorId: user.vendorId,
        companyName: user.vendor?.companyName || null,
      },
    });
  } catch (error) {
    console.error('❌ Login Error:', error);
    res.status(500).json({ error: 'An error occurred during authentication.' });
  }
});

// POST: Register Vendor User
app.post('/api/auth/register-vendor', async (req, res) => {
  try {
    const { companyName, contactPersonName, contactEmail, password, contactPhone } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { email: contactEmail } });
    if (existingUser) {
      return res.status(400).json({ error: 'Email is already registered.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.create({
        data: {
          companyName,
          contactPersonName,
          contactEmail,
          contactPhone,
          contractStartDate: new Date(),
          contractEndDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          reportingFrequency: 'MONTHLY',
        },
      });

      const user = await tx.user.create({
        data: {
          email: contactEmail,
          password: hashedPassword,
          role: 'VENDOR',
          vendorId: vendor.id,
        },
      });

      return { vendor, user };
    });

    res.status(201).json({ message: 'Vendor registered successfully!', data: result });
  } catch (error) {
    console.error('❌ Vendor Signup Error Detailed Stack:', error);
    res.status(500).json({
      error: 'Failed to complete vendor registration',
      details: error.message,
    });
  }
});

// POST: Full Vendor Signup Route
app.post('/api/auth/vendor-signup', async (req, res) => {
  try {
    const { 
      companyName, 
      companyDetails, 
      contactPersonName, 
      contactEmail, 
      contactPhone, 
      password,
      contractStartDate, 
      contractEndDate, 
      reportingFrequency 
    } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { email: contactEmail } });
    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.create({
        data: {
          companyName,
          companyDetails,
          contactPersonName,
          contactEmail,
          contactPhone,
          contractStartDate: new Date(contractStartDate),
          contractEndDate: new Date(contractEndDate),
          reportingFrequency,
          complianceStatus: 'OK',
        },
      });

      const user = await tx.user.create({
        data: {
          email: contactEmail,
          password: hashedPassword,
          role: 'VENDOR',
          vendorId: vendor.id,
        },
      });

      return { vendor, user };
    });

    res.status(201).json({ message: 'Vendor registered successfully.', vendorId: result.vendor.id });
  } catch (error) {
    console.error('Vendor signup error:', error);
    res.status(500).json({ error: 'Failed to complete vendor registration.' });
  }
});

// ==========================================
// VENDOR & ADMIN SPECIFIC ROUTES
// ==========================================

// GET /api/vendors
app.get('/api/vendors', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
  try {
    const vendors = await prisma.vendor.findMany({
      include: {
        submissions: {
          include: { attachments: true }
        },
        deadlines: {
          orderBy: { dueDate: 'desc' }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(vendors);
  } catch (error) {
    console.error('Error fetching vendors:', error);
    res.status(500).json({ error: 'Failed to fetch vendors list.' });
  }
});

// POST: Direct Vendor Registration (No User Account)
app.post('/api/vendors', async (req, res) => {
  try {
    const {
      companyName,
      contactPersonName,
      contactEmail,
      contactPhone,
      contractStartDate,
      contractEndDate,
      reportingFrequency,
    } = req.body;

    const existingVendor = await prisma.vendor.findUnique({ where: { contactEmail } });
    if (existingVendor) {
      return res.status(400).json({ error: 'Vendor with this email already exists.' });
    }

    const newVendor = await prisma.vendor.create({
      data: {
        companyName,
        contactPersonName,
        contactEmail,
        contactPhone,
        contractStartDate: new Date(contractStartDate),
        contractEndDate: new Date(contractEndDate),
        reportingFrequency: reportingFrequency || 'WEEKLY',
      },
    });

    res.status(201).json({ message: 'Vendor registered successfully!', vendor: newVendor });
  } catch (error) {
    console.error('Error creating vendor:', error);
    res.status(500).json({ error: 'Failed to register vendor.' });
  }
});

// GET: Vendor Details by ID
app.get('/api/vendors/:id/details', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const vendor = await prisma.vendor.findUnique({
      where: { id },
      include: {
        submissions: {
          include: { attachments: true, approvalLogs: true },
          orderBy: { submittedAt: 'desc' },
        },
      },
    });

    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    res.json(vendor);
  } catch (error) {
    console.error('SERVER ERROR in /api/vendors/:id/details:', error);
    res.status(500).json({ error: 'Failed to retrieve vendor details.', details: error.message });
  }
});

// GET: Logged-in Vendor Profile
app.get('/api/vendor/my-profile', authenticateToken, authorizeRoles('VENDOR'), async (req, res) => {
  try {
    const vendorData = await prisma.vendor.findUnique({
      where: { id: req.user.vendorId },
      include: { submissions: true },
    });
    res.json(vendorData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH: Vendor Self-Service Update Contact Details
app.patch('/api/vendor/profile', authenticateToken, authorizeRoles('VENDOR'), async (req, res) => {
  try {
    const { contactPersonName, contactPhone, companyDetails } = req.body;
    const vendorId = req.user.vendorId;

    if (!vendorId) {
      return res.status(400).json({ error: 'Vendor profile not found for this user.' });
    }

    const updatedVendor = await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        contactPersonName,
        contactPhone,
        companyDetails
      }
    });

    res.json({ message: 'Profile details updated successfully!', vendor: updatedVendor });
  } catch (error) {
    console.error('Error updating vendor profile:', error);
    res.status(500).json({ error: 'Failed to update profile details.' });
  }
});

// PATCH: Vendor Self-Service Password Reset
app.patch('/api/vendor/change-password', authenticateToken, authorizeRoles('VENDOR'), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Please provide both current and new passwords.' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Incorrect current password.' });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedNewPassword }
    });

    res.json({ message: 'Password changed successfully!' });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

// GET: Admin - All Vendors Compliance Statuses
app.get('/api/admin/vendors', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
  try {
    const allVendors = await prisma.vendor.findMany({
      include: { user: true, submissions: true },
    });
    res.json(allVendors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// SUBMISSIONS & REPORT ROUTES
// ==========================================

// GET: Single Report Details
app.get('/api/reports/:id', authenticateToken, authorizeRoles('ADMIN', 'VENDOR'), async (req, res) => {
  res.json({ message: 'Viewing report details' });
});

// POST: Submit Vendor Report with Attachments (Multi-file)
app.post('/api/submissions', authenticateToken, customUpload.array('files', 5), async (req, res) => {
  try {
    const { vendorId, deadlineId, reportType, notes } = req.body;
    const activeVendorId = vendorId || req.user.vendorId;

    if (!activeVendorId) {
      return res.status(400).json({ error: 'No associated vendor ID provided.' });
    }

    let submissionStatus = 'ON_TIME';
    if (deadlineId) {
      const deadline = await prisma.deadline.findUnique({ where: { id: deadlineId } });
      if (deadline && new Date() > new Date(deadline.dueDate)) {
        submissionStatus = 'LATE';
      }
    }

    const submission = await prisma.reportSubmission.create({
      data: {
        vendorId: activeVendorId,
        deadlineId: deadlineId || null,
        reportType: reportType || 'FINANCIAL',
        submissionStatus,
        notes,
      },
    });

    if (req.files && req.files.length > 0) {
      const attachmentData = req.files.map((file) => ({
        submissionId: submission.id,
        fileName: file.originalname,
        filePath: file.path,
        fileType: path.extname(file.originalname).replace('.', ''),
      }));

      await prisma.attachment.createMany({ data: attachmentData });
    }

    res.status(201).json({ message: 'Report submitted successfully!', submission });
  } catch (error) {
    console.error('Error submitting report:', error);
    res.status(500).json({ error: 'Failed to submit report.' });
  }
});

// POST: Vendor Single File Report Submission
app.post(
  '/api/reports/submit',
  authenticateToken,
  authorizeRoles('VENDOR'),
  customUpload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Please select a document to upload.' });
      }

      const { title, period, comments } = req.body;
      const vendorId = req.user.vendorId;

      if (!vendorId) {
        return res.status(400).json({ error: 'No associated vendor account found for this user.' });
      }

      const submission = await prisma.$transaction(async (tx) => {
        return await tx.reportSubmission.create({
          data: {
            title: title || 'Compliance Report',
            period: period || 'MONTHLY',
            status: 'PENDING',
            comments: comments || null,
            vendorId: vendorId,
            attachments: {
              create: {
                fileName: req.file.originalname,
                filePath: `/uploads/${req.file.filename}`,
                fileType: req.file.mimetype,
                fileSize: req.file.size,
              },
            },
          },
          include: { attachments: true },
        });
      });

      res.status(201).json({ message: 'Report submitted successfully!', submission });
    } catch (error) {
      console.error('❌ Report submission error:', error);
      res.status(500).json({ error: 'Failed to upload report submission.', details: error.message });
    }
  }
);

// GET: Admin - Fetch All Submissions
app.get('/api/admin/submissions', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
  try {
    const submissions = await prisma.reportSubmission.findMany({
      include: {
        vendor: {
          select: { id: true, companyName: true, contactPersonName: true, contactEmail: true },
        },
        attachments: true,
        approvalLogs: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json(submissions);
  } catch (error) {
    console.error('❌ Error fetching submissions:', error);
    res.status(500).json({ error: 'Failed to retrieve report submissions.' });
  }
});

// SECTION 8: APPROVAL WORKFLOW ENDPOINT
app.patch(
  '/api/admin/submissions/:id/review',
  authenticateToken,
  authorizeRoles('ADMIN'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, reviewComments, reviewedByDept, reviewerUserId } = req.body;

      const validStatuses = ['APPROVED', 'REJECTED', 'REVISION_REQUESTED', 'RETURNED_FOR_CORRECTION'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        });
      }

      const existingSubmission = await prisma.reportSubmission.findUnique({
        where: { id },
        include: { vendor: true },
      });

      if (!existingSubmission) {
        return res.status(404).json({ error: 'Report submission not found.' });
      }

      const updatedSubmission = await prisma.$transaction(async (tx) => {
        const submission = await tx.reportSubmission.update({
          where: { id },
          data: {
            approvalStatus: status,
            notes: reviewComments || existingSubmission.notes,
          },
          include: { vendor: true, attachments: true },
        });

        await tx.approvalLog.create({
          data: {
            submissionId: id,
            reviewedByDept: reviewedByDept || req.user?.dept || 'Finance',
            reviewerUserId: reviewerUserId || req.user?.userId || req.user?.id || 'usr_admin',
            action: status,
            comments: reviewComments || `Processed review as ${status}`,
          },
        });

        if (status === 'APPROVED') {
          await tx.vendor.update({
            where: { id: existingSubmission.vendorId },
            data: { complianceStatus: 'COMPLIANT' },
          });

          await tx.deadline.updateMany({
            where: {
              vendorId: existingSubmission.vendorId,
              reportType: existingSubmission.reportType,
              status: { in: ['PENDING', 'OVERDUE'] },
            },
            data: { status: 'COMPLETED' },
          });
        } else if (status === 'REJECTED') {
          await tx.vendor.update({
            where: { id: existingSubmission.vendorId },
            data: { complianceStatus: 'NON_COMPLIANT' },
          });
        }

        return submission;
      });

      // Notify Vendor via Email & Record Notification Activity Log Entry
      if (updatedSubmission.vendor?.contactEmail) {
        const vendorEmail = updatedSubmission.vendor.contactEmail;
        const emailSubject = `Report Status Update: ${status.replace(/_/g, ' ')}`;

        if (typeof sendReviewStatusNotification === 'function') {
          sendReviewStatusNotification(
            vendorEmail,
            updatedSubmission.vendor.companyName,
            status,
            reviewComments
          );
        } else if (typeof sendEmail === 'function') {
          await sendEmail({
            to: vendorEmail,
            subject: emailSubject,
            html: `<p>Your ${updatedSubmission.reportType} report review has been updated to <strong>${status}</strong>.</p><p>Feedback: ${reviewComments || 'N/A'}</p>`
          });
        }

        // Write log entry to Prisma for Admin Activity Log tab
        try {
          await prisma.notificationLog.create({
            data: {
              recipient: vendorEmail,
              subject: emailSubject,
              type: 'REVIEW_STATUS',
              status: 'SENT'
            }
          });
        } catch (logErr) {
          console.error('Failed to log notification entry:', logErr);
        }
      }

      res.status(200).json({
        message: 'Submission status updated successfully.',
        submission: updatedSubmission,
      });
    } catch (error) {
      console.error('❌ Review status update error:', error);
      res.status(500).json({ error: 'Failed to update submission review status.', details: error.message });
    }
  }
);

// Alias patch route for legacy compatibility
app.patch('/api/submissions/:id/review', authenticateToken, requireRole('ADMIN'), async (req, res) => {
  req.url = `/api/admin/submissions/${req.params.id}/review`;
  app.handle(req, res);
});


// ==========================================
// RENEW / EXTEND VENDOR CONTRACT ENDPOINT
// ==========================================

/**
 * PATCH /api/admin/vendors/:id/renew-contract
 * Extends/renews a vendor's contract end date and resets compliance status.
 * Accessible by ADMIN role only.
 */
app.patch(
  '/api/admin/vendors/:id/renew-contract',
  authenticateToken,
  authorizeRoles('ADMIN'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { newContractEndDate } = req.body;

      if (!newContractEndDate) {
        return res.status(400).json({ error: 'Please provide a valid new contract end date.' });
      }

      // Check if vendor exists
      const vendor = await prisma.vendor.findUnique({ where: { id } });
      if (!vendor) {
        return res.status(404).json({ error: 'Vendor not found.' });
      }

      const parsedDate = new Date(newContractEndDate);
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date format provided.' });
      }

      // Update vendor contract end date and restore compliance status
      const updatedVendor = await prisma.vendor.update({
        where: { id },
        data: {
          contractEndDate: parsedDate,
          complianceStatus: 'OK', // Reset compliance flag upon renewal
        },
      });

      console.log(`✅ Contract extended for vendor ${updatedVendor.companyName} until ${parsedDate.toLocaleDateString()}`);

      res.status(200).json({
        message: 'Contract extended successfully!',
        vendor: updatedVendor,
      });
    } catch (error) {
      console.error('❌ Failed to extend vendor contract:', error);
      res.status(500).json({
        error: 'Failed to update vendor contract date.',
        details: error.message,
      });
    }
  }
);

// GET: Fetch Admin Notification Activity Logs
// ==========================================
// NOTIFICATION LOGS ROUTE
// ==========================================

/**
 * GET /api/admin/notifications/logs
 * Fetches the latest 50 activity logs for dispatched automated/manual email notifications.
 * Accessible by ADMIN role only.
 */
app.get(
  '/api/admin/notifications/logs',
  authenticateToken,
  authorizeRoles('ADMIN'),
  async (req, res) => {
    try {
      // Retrieve the 50 most recent email notification activity records
      const logs = await prisma.notificationLog.findMany({
        orderBy: {
          sentAt: 'desc',
        },
        take: 50,
      });

      res.status(200).json(logs);
    } catch (error) {
      console.error('❌ Error in /api/admin/notifications/logs:', error);
      res.status(500).json({
        error: 'Failed to retrieve notification activity logs.',
        details: error.message,
      });
    }
  }
);

// SECTION 9: REPORTING & ANALYTICS ENDPOINT
// SECTION 9: REPORTING & ANALYTICS ENDPOINT
app.get('/api/admin/analytics', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
  try {
    const vendors = await prisma.vendor.findMany({
      include: { submissions: true, deadlines: true }
    });

    const performanceReport = vendors.map(v => {
      const totalSubmissions = v.submissions.length;
      const lateSubmissions = v.submissions.filter(s => s.submissionStatus === 'LATE').length;
      const onTimeSubmissions = totalSubmissions - lateSubmissions;

      const totalDeadlines = v.deadlines.length;
      const overdueDeadlines = v.deadlines.filter(d => d.status === 'OVERDUE').length;

      let score = 100;

      if (totalDeadlines > 0) {
        // Calculate percentage based on assigned deadlines completed on time
        const successfulSubmissions = totalSubmissions - lateSubmissions;
        score = Math.round((successfulSubmissions / totalDeadlines) * 100);
      } else if (totalSubmissions > 0) {
        score = Math.round((onTimeSubmissions / totalSubmissions) * 100);
      }

      // Penalty override if vendor status is explicitly non-compliant or flagged with an issue
      const hasComplianceIssue = ['COMPLIANCE_ISSUE', 'NON_COMPLIANT', 'PENALTY_ESCALATED', 'WARNING'].includes(v.complianceStatus);
      if (hasComplianceIssue && score === 100) {
        score = totalSubmissions === 0 ? 0 : Math.max(0, score - 50);
      }

      // Ensure score stays within 0% - 100% bounds
      score = Math.max(0, Math.min(100, score));

      return {
        vendorName: v.companyName,
        totalSubmissions,
        lateSubmissions,
        complianceScore: `${score}%`,
        status: v.complianceStatus
      };
    });

    // Sort vendors by score in descending order
    performanceReport.sort((a, b) => parseInt(b.complianceScore) - parseInt(a.complianceScore));

    res.json({ performanceReport });
  } catch (error) {
    console.error('Analytics endpoint error:', error);
    res.status(500).json({ error: 'Failed to compile reporting analytics.' });
  }
});

// ==========================================
// DEADLINE ROUTES
// ==========================================

// POST: Create Deadline (Admin)
// POST: Create Deadline (Admin)
// POST: Create Deadline (Admin)
app.post('/api/admin/deadlines', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
  try {
    const { dueDate, vendorId, reportType, period } = req.body;

    if (!dueDate || !vendorId) {
      return res.status(400).json({ error: 'dueDate and vendorId are required.' });
    }

    // 1. Fetch vendor to verify contract status
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found.' });
    }

    // 2. Reject deadline creation if contract has expired
    if (new Date(vendor.contractEndDate) < new Date()) {
      return res.status(400).json({
        error: `Cannot assign deadline: ${vendor.companyName}'s contract expired on ${new Date(vendor.contractEndDate).toLocaleDateString()}. Please renew their contract first.`
      });
    }

    // 3. Create deadline if contract is active
    const deadline = await prisma.deadline.create({
      data: {
        dueDate: new Date(dueDate),
        vendorId,
        reportType: reportType || 'FINANCIAL',
        period: period || 'MONTHLY',
      },
    });

    if (vendor.contactEmail && typeof sendDeadlineNotification === 'function') {
      sendDeadlineNotification(vendor.contactEmail, vendor.companyName, reportType || 'Compliance Report', dueDate);
    }

    res.status(201).json({ message: 'Deadline assigned successfully.', deadline });
  } catch (error) {
    console.error('❌ Error creating deadline:', error);
    res.status(500).json({ error: 'Failed to assign deadline.' });
  }
});

// POST: Direct Deadline Creation
app.post('/api/deadlines', async (req, res) => {
  try {
    const { vendorId, reportType, dueDate } = req.body;

    const deadline = await prisma.deadline.create({
      data: {
        vendorId,
        reportType,
        dueDate: new Date(dueDate),
      },
    });

    res.status(201).json({ message: 'Deadline created successfully', deadline });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create deadline.' });
  }
});

// GET: Fetch Vendor Deadlines
app.get('/api/vendor/deadlines', authenticateToken, authorizeRoles('VENDOR'), async (req, res) => {
  try {
    await checkAndUpdateOverdueDeadlines();

    const deadlines = await prisma.deadline.findMany({
      where: { vendorId: req.user.vendorId },
      orderBy: { dueDate: 'asc' },
    });

    res.status(200).json(deadlines);
  } catch (error) {
    console.error('❌ Error fetching deadlines:', error);
    res.status(500).json({ error: 'Failed to retrieve deadlines.' });
  }
});

// POST: Trigger Manual Compliance Check
app.post('/api/compliance/run-check', async (req, res) => {
  await runComplianceCheck();
  res.json({ message: 'Compliance and deadline check executed successfully.' });
});

// GET: Dashboard Stats & Live Vendor Non-Compliance Feed
app.get('/api/admin/dashboard-stats', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
  try {
    const totalVendors = await prisma.vendor.count();
    const allDeadlines = await prisma.deadline.findMany();
    const totalDeadlines = allDeadlines.length || 1;

    const submittedCount = allDeadlines.filter(d => d.status === 'ON_TIME').length;
    const lateCount = allDeadlines.filter(d => d.status === 'LATE').length;
    const missingCount = allDeadlines.filter(d => d.status === 'NOT_SUBMITTED').length;

    const vendorDashboardList = await prisma.vendor.findMany({
      include: {
        deadlines: {
          orderBy: { dueDate: 'desc' },
          take: 1,
        },
      },
    });

    res.json({
      metrics: {
        totalVendors,
        submitted: { count: submittedCount, percentage: Math.round((submittedCount / totalDeadlines) * 100) },
        late: { count: lateCount, percentage: Math.round((lateCount / totalDeadlines) * 100) },
        missing: { count: missingCount, percentage: Math.round((missingCount / totalDeadlines) * 100) },
        complianceRate: `${Math.round((submittedCount / totalDeadlines) * 100)}%`,
      },
      vendors: vendorDashboardList,
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard metrics.' });
  }
});

// Configure multer storage for license uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage });

// ==========================================
// 1. VENDOR SIGNUP WITH LICENSE UPLOAD
// ==========================================
// 1. STEP 1: INITIAL VENDOR SIGNUP (Credentials only)
// ==========================================
app.post('/api/auth/vendor-signup', async (req, res) => {
  try {
    const { companyName, contactEmail, password, contractEndDate } = req.body;

    if (!companyName || !contactEmail || !password) {
      return res.status(400).json({ error: 'Company name, email, and password are required.' });
    }

    const existingUser = await prisma.vendor.findUnique({ where: { contactEmail } });
    if (existingUser) {
      return res.status(400).json({ error: 'Email is already registered.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Create vendor with a pre-license state so they can log in to upload their license
    const newVendor = await prisma.vendor.create({
      data: {
        companyName,
        contactEmail,
        password: hashedPassword,
        registrationStatus: 'PENDING_LICENSE', // Not yet sent for admin review
        contractEndDate: new Date(contractEndDate || Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });

    res.status(201).json({
      message: 'Account created! Please log in to upload your business license.',
      vendorId: newVendor.id,
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Failed to register vendor account.' });
  }
});

// ==========================================
// 2. STEP 2: UPLOAD LICENSE ENDPOINT
// ==========================================
app.post('/api/vendor/upload-license', authenticateToken, upload.single('licenseFile'), async (req, res) => {
  try {
    const vendorId = req.user.id; // From JWT authentication middleware
    const licenseUrl = req.file ? req.file.filename : null;

    if (!licenseUrl) {
      return res.status(400).json({ error: 'Please select and upload a valid business license file.' });
    }

    // Update vendor with license file and change status to PENDING for admin review
    const updatedVendor = await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        licenseUrl,
        registrationStatus: 'PENDING', // Now visible to admin!
      },
    });

    res.status(200).json({
      message: 'License submitted successfully! Your account is now pending admin approval.',
      vendor: updatedVendor,
    });
  } catch (error) {
    console.error('License upload error:', error);
    res.status(500).json({ error: 'Failed to upload license file.' });
  }
});

// ==========================================
// 3. ADMIN: GET ONLY VENDORS WHO UPLOADED LICENSE
// ==========================================
app.get('/api/admin/vendors/pending', authenticateToken, authorizeRoles('ADMIN'), async (req, res) => {
  try {
    const pendingVendors = await prisma.vendor.findMany({
      where: { 
        registrationStatus: 'PENDING',
        licenseUrl: { not: null } // Ensure they actually sent their license
      },
      select: { id: true, companyName: true, contactEmail: true, licenseUrl: true, contractEndDate: true },
    });
    res.status(200).json(pendingVendors);
  } catch (error) {
    console.error('Error fetching pending vendors:', error);
    res.status(500).json({ error: 'Failed to fetch pending vendors.' });
  }
});

// ==========================================
// DATABASE SEEDING & INITIALIZATION
// ==========================================

async function seedAdmin() {
  try {
    if (!prisma.user) {
      console.error('❌ "prisma.user" is undefined.');
      return;
    }

    const adminEmail = 'admin@compliance.com';
    const hashedPassword = await bcrypt.hash('Admin@12345', 10);

    const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });

    if (!existingAdmin) {
      await prisma.user.create({
        data: {
          email: adminEmail,
          password: hashedPassword,
          role: 'ADMIN',
        },
      });
      console.log('✅ Default Admin created: admin@compliance.com / Admin@12345');
    } else {
      await prisma.user.update({
        where: { email: adminEmail },
        data: { password: hashedPassword }
      });
      console.log('🔑 Admin password reset successfully to: Admin@12345');
    }
  } catch (error) {
    console.error('Error during admin seeding:', error.message);
  }
}

prisma.$connect()
  .then(() => seedAdmin())
  .catch((err) => console.error('Database connection failed:', err.message));

// Start Express Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  if (typeof initCronJobs === 'function') {
    initCronJobs(prisma);
  }
});

module.exports = { prisma };