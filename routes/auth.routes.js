const express = require('express');
const router = express.Router();
const { login, vendorSignup } = require('../controllers/auth.controller');

router.post('/login', login);
router.post('/vendor-signup', vendorSignup);

module.exports = router;