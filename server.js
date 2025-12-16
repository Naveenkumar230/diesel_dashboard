/**
 * DG Monitoring System - Main Server
 * FINAL VERSION: Tailscale Compatible
 * Fix: Serves Dashboard directly on HTTP Port 3005 (No Redirects)
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const https = require('https');
const http = require('http'); // Required for the HTTP server
const fs = require('fs');
const mongoose = require('mongoose');
const os = require('os'); 


// Import modules
const { connectMongoDB, isMongoConnected } = require('./config/database');
const { connectToPLC, closePLC } = require('./services/plcService');
const { startScheduledTasks } = require('./services/schedulerService');
const apiRoutes = require('./routes/api');
const { initializeEmail } = require('./services/emailService');
const rateLimit = require('express-rate-limit');


// -------------------- Config --------------------
// ✅ Uses .env PORT (3005) or defaults to 3005
const httpPort = process.env.PORT || 3005; 
const httpsPort = 3001; // Internal Secure Port
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

// ✅ SAFETY NET: Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ UNHANDLED REJECTION:', reason);
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100 // 100 requests per minute
});

app.use('/api/', apiLimiter);

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
    // 1. Connect to MongoDB
    await connectMongoDB();
    
    const ip = getLocalIP();
    console.log('\n===========================================');
    console.log(`DG Monitoring System Starting...`);

    // 2. Start HTTP Server (Primary for Tailscale)
    // We serve the 'app' directly here so Tailscale can reach it.
    const httpServer = http.createServer(app);
    httpServer.listen(httpPort, '0.0.0.0', () => {
        console.log(`✅ HTTP SERVER (Tailscale Ready): http://0.0.0.0:${httpPort}`);
    });

    // 3. Start HTTPS Server (Optional/Local Secure Access)
    // We try to start this, but if certs fail, we don't crash the whole app.
    try {
        const httpsOptions = {
          key: fs.readFileSync(path.join(__dirname, 'ssl/server.key')),
          cert: fs.readFileSync(path.join(__dirname, 'ssl/server.crt'))
        };
        const httpsServer = https.createServer(httpsOptions, app);
        httpsServer.listen(httpsPort, '0.0.0.0', () => { 
          console.log(`✅ SECURE SERVER (Local): https://${ip}:${httpsPort}`);
        });
    } catch (sslErr) {
        console.warn(`⚠️ HTTPS not started (SSL certs missing), but HTTP is running fine.`);
    }

    console.log(`===========================================`);
    console.log(`MongoDB: ${isMongoConnected() ? 'Connected' : 'Disconnected'}`);
    
    // 4. Connect to PLC and start services
    connectToPLC();
    initializeEmail();
    startScheduledTasks();

  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();