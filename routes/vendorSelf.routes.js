// Separate router for /api/vendor/* (self-service)
const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/vendor.controller');

router.patch('/profile', verifyToken, requireRole('VENDOR'), ctrl.updateProfile);
router.patch('/change-password', verifyToken, requireRole('VENDOR'), ctrl.changePassword);

module.exports = router;