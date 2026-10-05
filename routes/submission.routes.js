const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const { verifyToken, requireRole } = require('../middleware/auth');
const { createSubmission } = require('../controllers/submission.controller');

router.post(
  '/',
  verifyToken,
  requireRole('VENDOR'),
  upload.array('files', 10),
  createSubmission
);

module.exports = router;