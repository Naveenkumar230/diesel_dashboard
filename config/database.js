/**
 * MongoDB Database Configuration - FIXED
 */

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/dieselDB';
const MAX_RETRY_ATTEMPTS = 5; // Increased retries

let isMongoConnected = false;
let connectionAttempts = 0;

const mongooseOptions = {
  serverSelectionTimeoutMS: 30000, // Increased to 30 seconds
  socketTimeoutMS: 45000,
  connectTimeoutMS: 30000, // Increased to 30 seconds
  maxPoolSize: 10,
  minPoolSize: 2,
  retryWrites: true,
  retryReads: true,
  bufferCommands: true, // ✅ CHANGED TO TRUE - allows queuing before connection
  autoIndex: false // Prevent auto-indexing on startup
};

async function connectMongoDB() {
  connectionAttempts++;
  try {
    console.log(`MongoDB connection attempt ${connectionAttempts}/${MAX_RETRY_ATTEMPTS}...`);
    await mongoose.connect(MONGODB_URI, mongooseOptions);
    console.log('✅ MongoDB Connected Successfully');
    isMongoConnected = true;
    connectionAttempts = 0;
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    if (connectionAttempts < MAX_RETRY_ATTEMPTS) {
      console.log(`⏳ Retrying in 10 seconds...`);
      setTimeout(connectMongoDB, 10000);
    } else {
      console.log('⚠️ MongoDB unavailable. Server running with limited functionality.');
    }
    isMongoConnected = false;
  }
}

// Event handlers
mongoose.connection.on('connected', () => {
  isMongoConnected = true;
  console.log('✅ MongoDB connection established');
});

mongoose.connection.on('disconnected', () => {
  isMongoConnected = false;
  console.log('⚠️ MongoDB disconnected');
  if (connectionAttempts < MAX_RETRY_ATTEMPTS) {
    console.log('⏳ Attempting reconnection...');
    setTimeout(connectMongoDB, 10000);
  }
});

mongoose.connection.on('error', (err) => {
  isMongoConnected = false;
  console.error('❌ MongoDB error:', err.message);
});

module.exports = {
  connectMongoDB,
  isMongoConnected: () => isMongoConnected
};