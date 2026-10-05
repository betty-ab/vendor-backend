// controllers/vendor.controller.js
const bcrypt = require('bcryptjs');
const prisma = require('../prisma/client');

/**
 * GET /api/vendors
 * Admin: list all vendors with submissions + deadlines for the directory
 */
async function listVendors(req, res) {
  try {
    const vendors = await prisma.vendor.findMany({
      include: {
        submissions: {
          orderBy: { submittedAt: 'desc' },
        },
        deadlines: {
          orderBy: { dueDate: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(vendors);
  } catch (err) {
    console.error('listVendors error:', err);
    res.status(500).json({ error: 'Failed to fetch vendors.' });
  }
}

/**
 * GET /api/vendors/:id/details
 * Used by admin (modal), and by vendor (own profile / my submissions)
 * Vendors can only access their own record.
 */
async function getVendorDetails(req, res) {
  try {
    const { id } = req.params;

    // Vendors can only view their own profile
    if (req.user.role === 'VENDOR' && req.user.vendorId !== id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const vendor = await prisma.vendor.findUnique({
      where: { id },
      include: {
        submissions: {
          include: {
            attachments: true,
            approvalLogs: {
              orderBy: { reviewedAt: 'desc' },
            },
          },
          orderBy: { submittedAt: 'desc' },
        },
        deadlines: {
          orderBy: { dueDate: 'asc' },
        },
      },
    });

    if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });

    res.json(vendor);
  } catch (err) {
    console.error('getVendorDetails error:', err);
    res.status(500).json({ error: 'Failed to fetch vendor details.' });
  }
}

/**
 * PATCH /api/vendor/profile
 * Vendor: update contact person, phone, company details
 * (email and company name are locked — matches your UI)
 */
async function updateProfile(req, res) {
  try {
    if (!req.user.vendorId) {
      return res.status(400).json({ error: 'No vendor linked to this account.' });
    }

    const { contactPersonName, contactPhone, companyDetails } = req.body;

    const updated = await prisma.vendor.update({
      where: { id: req.user.vendorId },
      data: {
        contactPersonName: contactPersonName?.trim() || undefined,
        contactPhone: contactPhone?.trim() || null,
        companyDetails: companyDetails?.trim() || null,
      },
    });

    res.json({ message: 'Profile updated successfully.', vendor: updated });
  } catch (err) {
    console.error('updateProfile error:', err);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
}

/**
 * PATCH /api/vendor/change-password
 * Vendor: verify current password, set new one
 */
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Both current and new passwords are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashed },
    });

    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('changePassword error:', err);
    res.status(500).json({ error: 'Failed to change password.' });
  }
}

module.exports = {
  listVendors,
  getVendorDetails,
  updateProfile,
  changePassword,
};