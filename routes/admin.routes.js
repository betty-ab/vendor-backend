const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/admin.controller');

router.use(verifyToken, requireRole('ADMIN'));

router.post('/deadlines', ctrl.createDeadline);
router.patch('/submissions/:id/review', ctrl.reviewSubmission);
router.patch('/vendors/:id/renew-contract', ctrl.renewContract);
router.get('/notifications/logs', ctrl.listNotificationLogs);

module.exports = router;