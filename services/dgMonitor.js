// /home/pi/diesel_dashboard/services/dgMonitor.js

// 1. GLOBAL STATE (Private to this file)
let dg1State = {
    wasRunning: false,
    startLevel: 0
};

// 2. THE LOGIC FUNCTION
function processDg1Data(currentRpm, currentFuelLiters) {
    const isNowOn = (currentRpm > 300);

    // --- SCENARIO 1: ENGINE STARTED ---
    if (isNowOn && !dg1State.wasRunning) {
        dg1State.startLevel = currentFuelLiters;
        dg1State.wasRunning = true;
        console.log(`[DG1] STARTED. Start Level Locked: ${dg1State.startLevel} L`);
    }

    // --- SCENARIO 2: ENGINE STOPPED ---
    else if (!isNowOn && dg1State.wasRunning) {
        const endLevel = currentFuelLiters;
        let consumption = dg1State.startLevel - endLevel;
        
        // Safety: No negative consumption
        if (consumption < 0) consumption = 0;

        console.log(`[DG1] STOPPED. Consumed: ${consumption.toFixed(2)} L`);

        // RESET STATE
        dg1State.wasRunning = false;
        
        // RETURN THE RESULT OBJECT (To be saved to DB)
        return {
            event: "STOPPED",
            timestamp: new Date(),
            consumption: consumption,
            startLevel: dg1State.startLevel,
            endLevel: endLevel
        };
    }
    
    // Return null if nothing interesting happened
    return null;
}

// 3. EXPORT THE FUNCTION
module.exports = { processDg1Data };