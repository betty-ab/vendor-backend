require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const prisma = require('./prisma/client');
const errorHandler = require('./middleware/errorHandler');
const { initCronJobs } = require('./services/cronService');

const authRoutes = require('./routes/auth.routes');
const vendorRoutes = require('./routes/vendor.routes');
const vendorSelfRoutes = require('./routes/vendorSelf.routes');
const submissionRoutes = require('./routes/submission.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api/auth', authRoutes);
app.use('/api/vendors', vendorRoutes);   // note: prefix matches frontend
app.use('/api/vendor', vendorSelfRoutes); // self-service — singular
app.use('/api/submissions', submissionRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use(errorHandler);

initCronJobs(prisma);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));