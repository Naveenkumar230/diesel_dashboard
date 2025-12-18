/**
 * MongoDB Schemas with Optimized Indexes
 * REPLACES: models/schemas.js
 * FIXED: Removed duplicate index definitions
 */

const mongoose = require('mongoose');

// ========================================
// DIESEL CONSUMPTION SCHEMA
// ========================================
const DieselConsumptionSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  
  dg1: {
    level: { type: Number, required: true },
    consumption: { type: Number, default: 0 },
    isRunning: { type: Boolean, default: false },
    // ✅ NEW FIELDS
    adjustedForNoise: { type: Boolean, default: false }, // Was this reading normalized?
    noiseAmount: { type: Number, default: 0 }, // How much noise was detected?
    refillDetected: { type: Boolean, default: false } // Was refill detected?
  },
  
  dg2: {
    level: { type: Number, required: true },
    consumption: { type: Number, default: 0 },
    isRunning: { type: Boolean, default: false },
    // ✅ NEW FIELDS
    adjustedForNoise: { type: Boolean, default: false },
    noiseAmount: { type: Number, default: 0 },
    refillDetected: { type: Boolean, default: false }
  },
  
  dg3: {
    level: { type: Number, required: true },
    consumption: { type: Number, default: 0 },
    isRunning: { type: Boolean, default: false },
    // ✅ NEW FIELDS
    adjustedForNoise: { type: Boolean, default: false },
    noiseAmount: { type: Number, default: 0 },
    refillDetected: { type: Boolean, default: false }
  },
  
  total: {
    level: { type: Number, required: true },
    consumption: { type: Number, default: 0 }
  },
  
  date: { type: String, required: true },
  hour: { type: Number },
  minute: { type: Number }
}, {
  autoIndex: false
});

// ✅ Define indexes explicitly
DieselConsumptionSchema.index({ date: 1, timestamp: -1 }, { name: 'date_timestamp_idx' });
DieselConsumptionSchema.index({ timestamp: -1 }, { name: 'timestamp_desc_idx' });

// ========================================
// ELECTRICAL READING SCHEMA
// ========================================
const ElectricalReadingSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  dg: { 
    type: String, 
    required: true, 
    enum: ['dg1', 'dg2', 'dg3', 'dg4']
  },
  voltageR: { type: Number, default: 0 },
  voltageY: { type: Number, default: 0 },
  voltageB: { type: Number, default: 0 },
  currentR: { type: Number, default: 0 },
  currentY: { type: Number, default: 0 },
  currentB: { type: Number, default: 0 },
  frequency: { type: Number, default: 0 },
  powerFactor: { type: Number, default: 0 },
  activePower: { type: Number, default: 0 },
  reactivePower: { type: Number, default: 0 },
  energyMeter: { type: Number, default: 0 },
  runningHours: { type: Number, default: 0 },
  windingTemp: { type: Number, default: 0 },
  date: { type: String, required: true },
  hour: { type: Number }
}, {
  autoIndex: false
});

// ✅ Define indexes explicitly
ElectricalReadingSchema.index(
  { dg: 1, date: 1, activePower: 1, timestamp: 1 },
  { name: 'dg_date_power_timestamp_idx' }
);
ElectricalReadingSchema.index(
  { dg: 1, timestamp: -1 },
  { name: 'dg_timestamp_desc_idx' }
);

// ========================================
// DAILY SUMMARY SCHEMA
// ========================================
const DailySummarySchema = new mongoose.Schema({
  date: { 
    type: String, 
    required: true
  },
  dg1: {
    startLevel: { type: Number, required: true },
    endLevel: { type: Number, required: true },
    totalConsumption: { type: Number, default: 0 },
    runningHours: { type: Number, default: 0 }
  },
  dg2: {
    startLevel: { type: Number, required: true },
    endLevel: { type: Number, required: true },
    totalConsumption: { type: Number, default: 0 },
    runningHours: { type: Number, default: 0 }
  },
  dg3: {
    startLevel: { type: Number, required: true },
    endLevel: { type: Number, required: true },
    totalConsumption: { type: Number, default: 0 },
    runningHours: { type: Number, default: 0 }
  },
  total: {
    startLevel: { type: Number, required: true },
    endLevel: { type: Number, required: true },
    totalConsumption: { type: Number, default: 0 }
  },
  timestamp: { type: Date, default: Date.now }
}, {
  autoIndex: false
});

// ✅ Define unique index
DailySummarySchema.index({ date: 1 }, { name: 'date_unique_idx', unique: true });

// ========================================
// DEPRECATED: DIESEL READING SCHEMA
// ========================================
const DieselReadingSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  dg1: { type: Number, required: true },
  dg2: { type: Number, required: true },
  dg3: { type: Number, required: true },
  total: { type: Number, required: true },
  dg1_change: { type: Number, default: 0 },
  dg2_change: { type: Number, default: 0 },
  dg3_change: { type: Number, default: 0 },
  hour: { type: Number },
  date: { type: String }
}, {
  autoIndex: false
});

DieselReadingSchema.index({ date: 1, timestamp: 1 });
DieselReadingSchema.index({ timestamp: -1 });

// ========================================
// CREATE MODELS
// ========================================
const DieselReading = mongoose.model('DieselReading', DieselReadingSchema);
const DieselConsumption = mongoose.model('DieselConsumption', DieselConsumptionSchema);
const DailySummary = mongoose.model('DailySummary', DailySummarySchema);
const ElectricalReading = mongoose.model('ElectricalReading', ElectricalReadingSchema);

module.exports = {
  DieselReading,
  DieselConsumption,
  DailySummary,
  ElectricalReading
};