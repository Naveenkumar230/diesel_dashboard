/**
 * DG Monitoring System - Main Server
 * MODIFIED for HTTPS (SSL)
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');

// --- NEW MODULES ---
const https = require('https');
const fs = require('fs');
// --- END NEW ---

// Import modules
const { connectMongoDB, isMongoConnected } = require('./config/database');
const { connectToPLC, readAllSystemData, getSystemData } = require('./services/plcService');
const { startScheduledTasks } = require('./services/schedulerService');
const apiRoutes = require('./routes/api');
const { initializeEmail } = require('./services/emailService'); // Added for initialization

// -------------------- Config --------------------
// --- UPDATED: We now define HTTP and HTTPS ports ---
const httpPort = 3000;  // We'll use this for redirecting
const httpsPort = 3001; // This will be the new SECURE port
// --- END UPDATE ---

// -------------------- Express Setup --------------------
const app = express();
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), { 
  maxAge: '1d', 
  etag: true, 
  lastModified: true 
}));

// Cache control for static assets
app.use((req, res, next) => {
  if (/\.(css|js|png|jpg|jpeg|gif|ico|svg)$/.test(req.url)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
  next();
});

// -------------------- Routes --------------------
app.use('/api', apiRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Added these routes to fix navigation
app.get('/consumption.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'consumption.html'));
});

app.get('/electrical.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'electrical.html'));
});
// ---

// -------------------- Graceful Shutdown --------------------
function gracefulShutdown() {
  console.log('\nShutting down gracefully...');
  try {
    const { closePLC } = require('./services/plcService');
    const mongoose = require('mongoose');
    
    closePLC();
    mongoose.connection.close(() => {
        console.log('MongoDB connection closed.');
        process.exit(0);
    });
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// -------------------- Start Server --------------------
async function startServer() {
  try {
    // Connect to MongoDB
    await connectMongoDB();
    
    // --- NEW: Read SSL Certificate Files ---
    const httpsOptions = {
      key: fs.readFileSync(path.join(__dirname, 'ssl/server.key')),
      cert: fs.readFileSync(path.join(__dirname, 'ssl/server.crt'))
    };
    // --- END NEW ---

    // --- NEW: Create HTTPS Server ---
    const httpsServer = https.createServer(httpsOptions, app);
    
    httpsServer.listen(httpsPort, '0.0.0.0', () => { // Listen on all interfaces
      console.log('\n===========================================');
      console.log(`DG Monitoring System Server Started`);
      console.log(`✅ SECURE SERVER: https://192.168.30.156:${httpsPort}`);
      console.log(`===========================================`);
      console.log(`MongoDB: ${isMongoConnected() ? 'Connected' : 'Disconnected'}`);
      
      // Connect to PLC and start services
      connectToPLC();
      initializeEmail(); // Initialize email service
      startScheduledTasks();
    });
    // --- END NEW ---

    // --- NEW: Create a simple HTTP server to redirect to HTTPS ---
    const httpApp = express();
    httpApp.get('*', (req, res) => {
        // Find the host (e.g., 192.168.30.156) from the request
        const host = req.headers.host.split(':')[0]; 
        res.redirect(`https://${host}:${httpsPort}${req.url}`);
    });
    httpApp.listen(httpPort, '0.0.0.0', () => { // Listen on all interfaces
        console.log(`Redirecting HTTP (${httpPort}) to HTTPS (${httpsPort})...`);
    });
    // --- END NEW ---

  } catch (err) {
    if (err.code === 'ENOENT') { // Corrected error code
      console.error(`[FATAL ERROR] Cannot read SSL certificates.`);
      console.error(`Please run 'openssl' command to create 'ssl/server.key' and 'ssl/server.crt'.`);
    } else {
      console.error('Failed to start server:', err);
    }
    process.exit(1);
  }
}

startServer();