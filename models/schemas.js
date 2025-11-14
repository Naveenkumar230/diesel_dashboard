/**
 * MongoDB Schemas for DG Monitoring System
 */

const mongoose = require('mongoose');

// Diesel Reading Schema (Hourly snapshots)
const DieselReadingSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now, index: true },
  dg1: { type: Number, required: true },
  dg2: { type: Number, required: true },
  dg3: { type: Number, required: true },
  total: { type: Number, required: true },
  dg1_change: { type: Number, default: 0 },
  dg2_change: { type: Number, default: 0 },
  dg3_change: { type: Number, default: 0 },
  hour: { type: Number, index: true },
  date: { type: String, index: true }
});

// Diesel Consumption Schema (30-minute intervals)
const DieselConsumptionSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now, index: true },
  dg1: {
    level: { type: Number, required: true },
    consumption: { type: Number, default: 0 },
    isRunning: { type: Boolean, default: false }
  },
  dg2: {
    level: { type: Number, required: true },
    consumption: { type: Number, default: 0 },
    isRunning: { type: Boolean, default: false }
  },
  dg3: {
    level: { type: Number, required: true },
    consumption: { type: Number, default: 0 },
    isRunning: { type: Boolean, default: false }
  },
  total: {
    level: { type: Number, required: true },
    consumption: { type: Number, default: 0 }
  },
  date: { type: String, index: true },
  hour: { type: Number },
  minute: { type: Number }
});

// Daily Summary Schema
const DailySummarySchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true, index: true },
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
});

// Electrical Parameters Schema (Real-time data)
const ElectricalReadingSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now, index: true },
  dg: { type: String, required: true, enum: ['dg1', 'dg2', 'dg3', 'dg4'], index: true },
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
  date: { type: String, index: true },
  hour: { type: Number }
});

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