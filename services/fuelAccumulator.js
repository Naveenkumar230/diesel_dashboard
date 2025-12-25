/**
 * FUEL ACCUMULATOR SERVICE
 * Implements "Ratchet & Bucket" Logic for Industrial Fuel Monitoring.
 * Prevents sensor noise from creating false consumption.
 */

const { DieselConsumption } = require('../models/schemas');

// --- CONFIGURATION ---
const COMMIT_THRESHOLD = 2.0;  // Liters: Save to DB only when we have this much
const REFILL_THRESHOLD = 50.0; // Liters: Rise > 50L is a refill
const NOISE_FILTER = 2.0;      // Liters: Ignore drops smaller than this

// --- STATE MEMORY ---
// Keeps track of the "Stable Level" and "Hidden Buffer" for each DG
let state = {
    dg1: { buffer: 0, lastLevel: null },
    dg2: { buffer: 0, lastLevel: null },
    dg3: { buffer: 0, lastLevel: null },
    dg4: { buffer: 0, lastLevel: null }
};

/**
 * Main Processing Function
 * Call this every second with new data.
 * @param {string} dgKey - 'dg1', 'dg2', 'dg3', 'dg4'
 * @param {number} currentLevel - Raw sensor liters
 * @param {boolean} isEngineRunning - True if Voltage > 100V
 */
async function processReading(dgKey, currentLevel, isEngineRunning) {
    let s = state[dgKey];

    // 1. Initialize on first run
    if (s.lastLevel === null) {
        s.lastLevel = currentLevel;
        return; 
    }

    // 2. Calculate Change
    const diff = s.lastLevel - currentLevel; // Positive = Drop, Negative = Rise

    // =========================================================
    // 🧠 THE LOGIC
    // =========================================================

    // CASE 1: DROP DETECTED (Consumption?)
    if (diff > NOISE_FILTER) {
        if (isEngineRunning) {
            // ✅ Engine ON: Real Consumption.
            // 1. Add to "Hidden Bucket"
            s.buffer += diff;
            // 2. Ratchet Down (Lock new lower level)
            s.lastLevel = currentLevel; 
            
            // Console log for debugging (Optional)
            // console.log(`[${dgKey}] Burned: ${diff.toFixed(2)}L | Buffer: ${s.buffer.toFixed(2)}L`);
        } else {
            // ❌ Engine OFF: Noise/Cooling.
            // 1. Do NOT add to buffer.
            // 2. Follow sensor down (so we don't drift away from reality)
            s.lastLevel = currentLevel; 
        }
    } 
    
    // CASE 2: REFILL DETECTED (Huge Rise)
    else if (diff < -REFILL_THRESHOLD) {
        console.log(`[${dgKey}] REFILL DETECTED: +${Math.abs(diff).toFixed(1)}L`);
        s.lastLevel = currentLevel; // Reset ratchet to high level
        s.buffer = 0; // Clear buffer (don't count refill as consumption)
    }

    // CASE 3: SMALL RISE (Sloshing / Recovery)
    else if (diff < 0) {
        if (!isEngineRunning) {
            // ✅ Engine OFF: Allow Recovery.
            // Since we didn't bill any fuel, let the level float back up.
            s.lastLevel = currentLevel; 
        } else {
            // 🔒 Engine ON: Block the Rise.
            // Ignore sloshing. Keep s.lastLevel at the lowest point.
        }
    }

    // =========================================================
    // 💾 SAVE TO DB (Check Bucket)
    // =========================================================
    if (s.buffer >= COMMIT_THRESHOLD) {
        await commitBufferToDB(dgKey, s.buffer);
        s.buffer = 0; // Empty the bucket
    }
}

/**
 * Saves accumulated fuel to MongoDB
 */
async function commitBufferToDB(dgKey, amount) {
    try {
        console.log(`[${dgKey}] 💾 COMMITTING: ${amount.toFixed(2)} Liters`);
        
        const today = new Date().toISOString().split('T')[0];
        
        // Note: Ensure your Schema has fields for dg4 if you use it
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

/**
 * Returns the stable "Ratchet" level for display on the Dashboard
 */
function getDisplayLevel(dgKey) {
    return state[dgKey].lastLevel || 0;
}

module.exports = { processReading, getDisplayLevel };