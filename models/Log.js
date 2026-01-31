/**
 * models/Log.js
 * Combined Schema: Stores both 'Events' and detailed 'Electrical Logs'
 */
const mongoose = require('mongoose');

// 1. Electrical Data Schema (Nested)
const ElectricalSchema = new mongoose.Schema({
    // Standard Parameters
    voltageR: { type: Number, default: 0 },
    voltageY: { type: Number, default: 0 },
    voltageB: { type: Number, default: 0 },
    currentR: { type: Number, default: 0 },
    currentY: { type: Number, default: 0 },
    currentB: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 },
    powerFactor: { type: Number, default: 0 },
    activePower: { type: Number, default: 0 },
    runningHours: { type: Number, default: 0 },

    // ✅ NEW: CALCULATED FIELDS (Stored Permanently)
    fuelRate: { type: Number, default: 0 },     // Liters/Hour
    estCost: { type: Number, default: 0 },      // Rupees/Hour
    loadPct: { type: Number, default: 0 }       // % Load
}, { _id: false });

// 2. Main Log Schema
const LogSchema = new mongoose.Schema({
    timestamp: { 
        type: Date, 
        default: Date.now,
        index: true 
    },

    // A. Diesel Levels
    dg1: { type: Number, default: 0 },
    dg2: { type: Number, default: 0 },
    dg3: { type: Number, default: 0 },
    
    // B. Electrical Data (All DGs)
    electrical: {
        dg1: ElectricalSchema,
        dg2: ElectricalSchema,
        dg3: ElectricalSchema,
        dg4: ElectricalSchema
    },

    // C. Events (Optional - for your "DG Stopped" logs)
    event: { type: String },
    startLevel: { type: Number },
    endLevel: { type: Number },
    consumption: { type: Number },
    duration: { type: Number }
});

// Index for fast analytics
LogSchema.index({ timestamp: -1 });

module.exports = mongoose.model('Log', LogSchema);