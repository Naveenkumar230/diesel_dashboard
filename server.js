/**
 * DG Monitoring System - Main Server
 * MODIFIED for HTTPS (SSL) and correct graceful shutdown
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const https = require('https');
const fs = require('fs');
const mongoose = require('mongoose'); // Import Mongoose here

// Import modules
const { connectMongoDB, isMongoConnected } = require('./config/database');
const { connectToPLC, closePLC, readAllSystemData, getSystemData } = require('./services/plcService');
const { startScheduledTasks } = require('./services/schedulerService');
const apiRoutes = require('./routes/api');
const { initializeEmail } = require('./services/emailService');

// -------------------- Config --------------------
const httpPort = 3000;  // For redirecting
const httpsPort = 3001; // Your new SECURE port
// ------------------------------------------------

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

app.get('/consumption.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'consumption.html'));
});

app.get('/electrical.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'electrical.html'));
});

// -------------------- Graceful Shutdown (FIXED) --------------------
// This new function uses async/await for a clean shutdown
async function gracefulShutdown() {
  console.log('\nShutting down gracefully...');
  try {
    closePLC(); // Close PLC connection
    await mongoose.connection.close(); // Wait for Mongoose to close
    console.log('MongoDB connection closed.');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
// -----------------------------------------------------------------

// -------------------- Start Server --------------------
async function startServer() {
  try {
    // Connect to MongoDB
    await connectMongoDB();
    
    // Read SSL Certificate Files
    const httpsOptions = {
      key: fs.readFileSync(path.join(__dirname, 'ssl/server.key')),
      cert: fs.readFileSync(path.join(__dirname, 'ssl/server.crt'))
    };

    // Create HTTPS Server
    const httpsServer = https.createServer(httpsOptions, app);
    
    httpsServer.listen(httpsPort, '0.0.0.0', () => { // Listen on all interfaces
      console.log('\n===========================================');
      console.log(`DG Monitoring System Server Started`);
      console.log(`✅ SECURE SERVER: https://192.168.30.156:${httpsPort}`);
      console.log(`===========================================`);
      console.log(`MongoDB: ${isMongoConnected() ? 'Connected' : 'Disconnected'}`);
      
      // Connect to PLC and start services
      connectToPLC();
      initializeEmail();
      startScheduledTasks();
    });

    // Create HTTP server to redirect to HTTPS
    const httpApp = express();
    httpApp.get('*', (req, res) => {
        const host = req.headers.host.split(':')[0]; 
        res.redirect(`https://${host}:${httpsPort}${req.url}`);
    });
    httpApp.listen(httpPort, '0.0.0.0', () => { // Listen on all interfaces
        console.log(`Redirecting HTTP (${httpPort}) to HTTPS (${httpsPort})...`);
    });

  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`[FATAL ERROR] Cannot read SSL certificates.`);
      console.error(`Please run 'openssl' command to create 'ssl/server.key' and 'ssl/server.crt'.`);
    } else {
      console.error('Failed to start server:', err);
    }
    process.exit(1);
  }
}

startServer();