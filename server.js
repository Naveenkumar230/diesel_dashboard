/**
 * DG Monitoring System - Main Server
 * Modular architecture with separated concerns
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');

// Import modules
const { connectMongoDB, isMongoConnected } = require('./config/database');
const { connectToPLC, readAllSystemData, getSystemData } = require('./services/plcService');
const { startScheduledTasks } = require('./services/schedulerService');
const apiRoutes = require('./routes/api');

// -------------------- Config --------------------
const webServerPort = parseInt(process.env.PORT) || 3000;

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

app.get('/dashboard/:dg', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// -------------------- Graceful Shutdown --------------------
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  try {
    const { closePLC } = require('./services/plcService');
    const mongoose = require('mongoose');
    
    closePLC();
    await mongoose.connection.close();
    console.log('Connections closed');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM, shutting down...');
  try {
    const { closePLC } = require('./services/plcService');
    const mongoose = require('mongoose');
    
    closePLC();
    await mongoose.connection.close();
    console.log('Connections closed');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
});

// -------------------- Start Server --------------------
async function startServer() {
  try {
    // Connect to MongoDB
    await connectMongoDB();
    
    // Start Express server
    app.listen(webServerPort, () => {
      console.log(`\n===========================================`);
      console.log(`DG Monitoring System Server Started`);
      console.log(`Web Server: http://localhost:${webServerPort}`);
      console.log(`MongoDB: ${isMongoConnected() ? 'Connected' : 'Disconnected'}`);
      console.log(`===========================================\n`);
      
      // Connect to PLC and start reading
      connectToPLC();
      
      // Start scheduled tasks (consumption tracking, daily reports)
      startScheduledTasks();
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();