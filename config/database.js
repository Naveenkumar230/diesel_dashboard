/**
 * MongoDB Database Configuration and Connection
 */

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/dieselDB';
const MAX_RETRY_ATTEMPTS = 3;

let isMongoConnected = false;
let connectionAttempts = 0;

const mongooseOptions = {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  maxPoolSize: 10,
  minPoolSize: 2,
  retryWrites: true,
  retryReads: true,
  bufferCommands: false,
  autoIndex: true
};

async function connectMongoDB() {
  connectionAttempts++;
  try {
    console.log(`MongoDB connection attempt ${connectionAttempts}/${MAX_RETRY_ATTEMPTS}...`);
    await mongoose.connect(MONGODB_URI, mongooseOptions);
    console.log('MongoDB Connected Successfully');
    isMongoConnected = true;
    connectionAttempts = 0;
  } catch (err) {
    console.error('MongoDB Connection Error:', err.message);
    if (connectionAttempts < MAX_RETRY_ATTEMPTS) {
      setTimeout(connectMongoDB, 5000);
    } else {
      console.log('MongoDB unavailable after multiple attempts. Running without persistence.');
    }
    isMongoConnected = false;
  }
}

// Event handlers
mongoose.connection.on('connected', () => {
  isMongoConnected = true;
  console.log('MongoDB connection established');
});

mongoose.connection.on('disconnected', () => {
  isMongoConnected = false;
  console.log('MongoDB disconnected, attempting reconnection...');
  setTimeout(connectMongoDB, 5000);
});

mongoose.connection.on('error', (err) => {
  isMongoConnected = false;
  console.error('MongoDB error:', err);
});

module.exports = {
  connectMongoDB,
  isMongoConnected: () => isMongoConnected
};