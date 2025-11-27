const mongoose = require('mongoose');
require('dotenv').config();

// ✅ FIX: Import correctly from schemas.js
const { DieselConsumption: DieselModel } = require('./models/schemas');

// ==========================================
// ⚙️ CONFIGURATION (ADJUST TIMES HERE)
// ==========================================
const CONFIG = {
    // Change these times to match when the DG was ON but server was OFF
    // Format: YYYY-MM-DDTHH:MM:SS
    startTime: '2025-11-27T10:00:00', 
    endTime:   '2025-11-27T14:00:00', 
    
    // The levels you saw (Start -> End)
    startLevel: 183,
    endLevel:   176,
    
    // Add a point every 30 minutes
    intervalMinutes: 30
};
// ==========================================

async function fillGap() {
    try {
        console.log("🔌 Connecting to MongoDB...");
// 👇 Copied from your .env file
await mongoose.connect('mongodb+srv://dieselconsumption7_db_user:NSSZ9Y9X2sLJCUHX@cluster0.ortzv0q.mongodb.net/dieselDB?retryWrites=true&w=majority&tls=true&tlsAllowInvalidCertificates=true');        console.log("✅ Connected.");

        const start = new Date(CONFIG.startTime).getTime();
        const end = new Date(CONFIG.endTime).getTime();
        const durationMs = end - start;
        
        if (durationMs <= 0) {
            console.error("❌ Error: End time must be after Start time.");
            process.exit(1);
        }

        const steps = Math.floor(durationMs / (CONFIG.intervalMinutes * 60 * 1000));
        const totalDrop = CONFIG.startLevel - CONFIG.endLevel;
        const dropPerStep = totalDrop / steps;

        console.log(`📊 Generating ${steps} records...`);
        console.log(`   ${CONFIG.startLevel}L ➡️ ${CONFIG.endLevel}L`);

        let recordsCreated = 0;

        for (let i = 1; i <= steps; i++) {
            const currentStepTime = start + (i * CONFIG.intervalMinutes * 60 * 1000);
            const currentLevel = CONFIG.startLevel - (dropPerStep * i);
            const dateObj = new Date(currentStepTime);

            // ✅ FIX: Matches your 'DieselConsumption' schema exactly
            const doc = new DieselModel({
                timestamp: dateObj,
                date: dateObj.toISOString().split('T')[0], // Required by your schema
                hour: dateObj.getHours(),
                minute: dateObj.getMinutes(),
                
                dg1: { 
                    level: parseFloat(currentLevel.toFixed(2)),
                    consumption: 0,
                    isRunning: true 
                }, 
                dg2: { level: 0, consumption: 0, isRunning: false },
                dg3: { level: 0, consumption: 0, isRunning: false },
                total: { 
                    level: parseFloat(currentLevel.toFixed(2)),
                    consumption: 0 
                }
            });

            await doc.save();
            console.log(`   + Inserted: ${dateObj.toLocaleTimeString()} @ ${currentLevel.toFixed(1)} L`);
            recordsCreated++;
        }

        console.log(`\n✅ Success! Added ${recordsCreated} records.`);
        
    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await mongoose.disconnect();
        console.log("👋 Connection closed.");
    }
}

fillGap();