/**
 * services/dgMonitor.js
 * STRICT MODE for DG1
 */

// 1. GLOBAL STATE (Must be outside the function to persist)
let dg1State = {
    wasRunning: false,
    lockedStartLevel: 0,  // This variable holds the TRUE start level
    accumulatedConsumption: 0
};

function processDg1Data(currentRpm, currentFuelLiters) {
    // Threshold to decide if engine is ON (e.g. RPM > 300)
    const isNowOn = (currentRpm > 300);

    // =========================================================
    // SCENARIO 1: ENGINE JUST STARTED (LATCH TRIGGER)
    // =========================================================
    if (isNowOn && !dg1State.wasRunning) {
        // 🔒 LOCK ACTION: Capture the level NOW and save it to 'lockedStartLevel'
        dg1State.lockedStartLevel = currentFuelLiters;
        
        dg1State.wasRunning = true;
        dg1State.accumulatedConsumption = 0; // Reset counter
        
        console.log(`🔒 DG1 LOCKED. Start Level: ${dg1State.lockedStartLevel} L`);
        return null; // Nothing to save yet
    }

    // =========================================================
    // SCENARIO 2: ENGINE IS RUNNING (IGNORE START LEVEL)
    // =========================================================
    else if (isNowOn && dg1State.wasRunning) {
        // ⚠️ CRITICAL: DO NOT TOUCH 'lockedStartLevel' HERE!
        // We only track live consumption drops if you want real-time updates
        
        // Simple logic: If level dropped, add to consumption
        let drop = dg1State.lockedStartLevel - currentFuelLiters;
        if (drop > 0) dg1State.accumulatedConsumption = drop;
        
        return null;
    }

    // =========================================================
    // SCENARIO 3: ENGINE JUST STOPPED (FINAL CALCULATION)
    // =========================================================
    else if (!isNowOn && dg1State.wasRunning) {
        const endLevel = currentFuelLiters;

        // FINAL MATH: Use the LOCKED start level, not the current one.
        let totalConsumed = dg1State.lockedStartLevel - endLevel;

        // Safety: If sensor noise caused negative result
        if (totalConsumed < 0) totalConsumed = 0;

        console.log(`🛑 DG1 STOPPED.`);
        console.log(`   Start (Locked): ${dg1State.lockedStartLevel}`);
        console.log(`   End (Current):  ${endLevel}`);
        console.log(`   Consumption:    ${totalConsumed}`);

        // Reset State
        dg1State.wasRunning = false;
        
        // RETURN DATA TO SAVE TO MONGODB
        return {
            event: "DG_STOPPED",
            startLevel: dg1State.lockedStartLevel, // ✅ Saves the correct 128L (example)
            endLevel: endLevel,                    // ✅ Saves 121L
            consumption: totalConsumed             // ✅ Saves 7L
        };
    }

    return null;
}

module.exports = { processDg1Data };