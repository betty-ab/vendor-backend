const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/vendor.controller');

router.get('/', verifyToken, requireRole('ADMIN'), ctrl.listVendors);
router.get('/:id/details', verifyToken, ctrl.getVendorDetails);

module.exports = router;