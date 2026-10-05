// controllers/auth.controller.js
const bcrypt = require('bcryptjs');
const prisma = require('../prisma/client');
const { signToken } = require('../utils/jwt');

/**
 * POST /api/auth/login
 */
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { vendor: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = signToken({
      id: user.id,
      email: user.email,
      role: user.role,
      vendorId: user.vendorId,
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        vendorId: user.vendorId,
        companyName: user.vendor?.companyName || null,
        contractEndDate: user.vendor?.contractEndDate || null,
      },
    });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Server error during login.' });
  }
}

/**
 * POST /api/auth/vendor-signup
 * Creates Vendor + User account in one transaction.
 */
async function vendorSignup(req, res) {
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
      reportingFrequency,
      requiredReportTypes,
    } = req.body;

    // Required fields
    if (!companyName || !contactPersonName || !contactEmail || !password) {
      return res.status(400).json({ error: 'Missing required signup fields.' });
    }

    const email = contactEmail.toLowerCase().trim();

    const existing = await prisma.vendor.findUnique({ where: { contactEmail: email } });
    if (existing) {
      return res.status(409).json({ error: 'A vendor with this email already exists.' });
    }

    const hashed = await bcrypt.hash(password, 10);

    const result = await prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.create({
        data: {
          companyName: companyName.trim(),
          companyDetails: companyDetails?.trim() || null,
          contactPersonName: contactPersonName.trim(),
          contactEmail: email,
          contactPhone: contactPhone?.trim() || null,
          contractStartDate: contractStartDate ? new Date(contractStartDate) : new Date(),
          contractEndDate: contractEndDate
            ? new Date(contractEndDate)
            : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          reportingFrequency: reportingFrequency || 'WEEKLY',
          registrationStatus: 'APPROVED', // auto-approve for now; flip to PENDING if you add admin review
          complianceStatus: 'OK',
        },
      });

      const user = await tx.user.create({
        data: {
          email,
          password: hashed,
          role: 'VENDOR',
          vendorId: vendor.id,
        },
      });

      return { vendor, user };
    });

    res.status(201).json({
      message: 'Vendor registered successfully. Please sign in.',
      vendorId: result.vendor.id,
    });
  } catch (err) {
    console.error('vendorSignup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
}

module.exports = { login, vendorSignup };