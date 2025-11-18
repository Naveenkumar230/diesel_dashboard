/**
 * DG Monitoring System - Main Server
 * FINAL VERSION: Secure, Cleaned, and Robust Error Handling
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const https = require('https');
const fs = require('fs');
const mongoose = require('mongoose');
const os = require('os'); // Added to detect IP automatically

// Import modules
const { connectMongoDB, isMongoConnected } = require('./config/database');
// Removed unused imports (readAllSystemData, getSystemData) to keep code clean
const { connectToPLC, closePLC } = require('./services/plcService');
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

app.get('/consumption.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'consumption.html'));
});

app.get('/electrical.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'electrical.html'));
});

// -------------------- Graceful Shutdown --------------------
async function gracefulShutdown() {
  console.log('\nShutting down gracefully...');
  try {
    closePLC(); // Close PLC connection
    if (mongoose.connection.readyState === 1) {
        await mongoose.connection.close();
        console.log('MongoDB connection closed.');
    }
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ✅ SAFETY NET: Global Error Handlers (Prevents crashes from random timeouts)
process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION:', err);
    // Optional: gracefulShutdown(); // Don't exit immediately for minor errors
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ UNHANDLED REJECTION:', reason);
});

// -------------------- Helper: Get Local IP --------------------
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

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
    
    httpsServer.listen(httpsPort, '0.0.0.0', () => { 
      const ip = getLocalIP();
      console.log('\n===========================================');
      console.log(`DG Monitoring System Server Started`);
      console.log(`✅ SECURE SERVER: https://${ip}:${httpsPort}`);
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
    httpApp.listen(httpPort, '0.0.0.0', () => { 
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