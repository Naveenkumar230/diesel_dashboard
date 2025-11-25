/**
 * DG Monitoring System - Main Server
 * TAILSCALE COMPATIBLE VERSION
 * Simpler, Faster, No Redirect Issues.
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const http = require('http'); // Changed from https
const mongoose = require('mongoose');
const os = require('os');

// Import modules
const { connectMongoDB, isMongoConnected } = require('./config/database');
const { connectToPLC, closePLC } = require('./services/plcService');
const { startScheduledTasks } = require('./services/schedulerService');
const apiRoutes = require('./routes/api');
const { initializeEmail } = require('./services/emailService');

// -------------------- Config --------------------
const PORT = 3000;  // Standard HTTP port (Tailscale will map to this)
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

// Cache control
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
    closePLC();
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

// Safety Nets
process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION:', err);
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
    // 1. Connect to MongoDB
    await connectMongoDB();
    
    // 2. Start Simple HTTP Server (No SSL needed internally)
    const server = http.createServer(app);
    
    server.listen(PORT, '0.0.0.0', () => { 
      const ip = getLocalIP();
      console.log('\n===========================================');
      console.log(`DG Monitoring System Server Started`);
      console.log(`✅ LOCAL:  http://${ip}:${PORT}`);
      console.log(`✅ REMOTE: https://dg-monitor... (via Tailscale)`);
      console.log(`===========================================`);
      console.log(`MongoDB: ${isMongoConnected() ? 'Connected' : 'Disconnected'}`);
      
      // 3. Connect to PLC and start services
      connectToPLC();
      initializeEmail();
      startScheduledTasks();
    });

  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();