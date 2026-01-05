/**
 * FUEL ACCUMULATOR SERVICE - IRON RATCHET VERSION
 * FIXED: Prevents "Vibration Looping" on DG1
 * UPDATED: Refill Threshold set to 50 Liters
 */

const { DieselConsumption } = require('../models/schemas');

// --- CONFIGURATION ---
const COMMIT_THRESHOLD = 2.0;  // Only save to DB if we have > 2 Liters accumulated
const REFILL_THRESHOLD = 20; // ✅ UPDATED: Only reset if level rises by > 50 Liters
const NOISE_FILTER = 2.0;      // IGNORE any drop smaller than 2.0 Liters

// --- STATE MEMORY ---
let state = {
    dg1: { buffer: 0, lastLevel: null },
    dg2: { buffer: 0, lastLevel: null },
    dg3: { buffer: 0, lastLevel: null },
    dg4: { buffer: 0, lastLevel: null }
};

async function processReading(dgKey, currentLevel, isEngineRunning) {
    let s = state[dgKey];

    // 1. Initialize on first run
    if (s.lastLevel === null) {
        s.lastLevel = currentLevel;
        return; 
    }

    // 2. Calculate Change
    const diff = s.lastLevel - currentLevel; // Positive = Drop, Negative = Rise

    // CASE 1: DROP DETECTED (Consumption?)
    if (diff > NOISE_FILTER) {
        if (isEngineRunning) {
            // ✅ Engine ON: Real Consumption.
            // We count the drop AND lock the level down.
            s.buffer += diff;
            s.lastLevel = currentLevel; 
        } else {
            // ❌ Engine OFF: Noise/Cooling.
            // We follow the sensor but DO NOT count consumption.
            s.lastLevel = currentLevel; 
        }
    } 
    
    // CASE 2: REFILL DETECTED (Huge Rise > 50L)
    else if (diff < -REFILL_THRESHOLD) {
        console.log(`[${dgKey}] REFILL DETECTED: +${Math.abs(diff).toFixed(1)}L`);
        s.lastLevel = currentLevel; // Reset ratchet to new high level
        s.buffer = 0; // Clear buffer
    }

    // CASE 3: SMALL RISE (Sloshing / Vibration)
    else if (diff < 0) {
        if (!isEngineRunning) {
            // ✅ Engine OFF: Allow Recovery.
            // Fuel expands when hot/stopped, so we let it rise.
            s.lastLevel = currentLevel; 
        } else {
            // 🔒 Engine ON: THE IRON RATCHET.
            // WE DO NOTHING. We strictly ignore the rise.
            // We keep s.lastLevel at the LOWEST point.
            // This prevents the "Looping" bug (18L error).
        }
    }

    // =========================================================
    // 💾 SAVE TO DB
    // =========================================================
    if (s.buffer >= COMMIT_THRESHOLD) {
        await commitBufferToDB(dgKey, s.buffer);
        s.buffer = 0; // Empty the bucket
    }
}

async function commitBufferToDB(dgKey, amount) {
    try {
        console.log(`[${dgKey}] 💾 COMMITTING: ${amount.toFixed(2)} Liters`);
        const today = new Date().toISOString().split('T')[0];
        
        await DieselConsumption.updateOne(
            { date: today },
            { 
                $inc: { [`${dgKey}.consumption`]: amount }, 
                $set: { timestamp: new Date() } 
            },
            { upsert: true }
        );

    } catch (err) {
        console.error(`[${dgKey}] DB Save Error:`, err.message);
    }
}

function getDisplayLevel(dgKey) {
    return state[dgKey].lastLevel || 0;
}

module.exports = { processReading, getDisplayLevel };