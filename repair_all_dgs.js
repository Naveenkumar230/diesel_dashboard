const mongoose = require('mongoose');
require('dotenv').config();
const { DieselConsumption: DieselModel } = require('./models/schemas');

// ==========================================
// ⚙️ MASTER CONFIGURATION (10:20 - 10:45)
// ==========================================
const CONFIG = {
    // Time Range (India Time)
    startTime: '2025-11-27T10:20:00+05:30', 
    endTime:   '2025-11-27T10:45:00+05:30', 
    
    // 🛢️ DG-1 Levels (Known)
    dg1Start: 183,
    dg1End:   176,

    // 🛢️ DG-2 Levels (EDIT THESE!)
    // If it ran, put the Start and End levels. 
    // If it didn't run, make them the same (e.g., 200 and 200).
    dg2Start: 250,  // <--- CHANGE THIS
    dg2End:   245,  // <--- CHANGE THIS

    // 🛢️ DG-3 Levels (EDIT THESE!)
    dg3Start: 250,  // <--- CHANGE THIS
    dg3End:   242,  // <--- CHANGE THIS

    intervalMinutes: 5 
};
// ==========================================

async function repairAll() {
    try {
        console.log("🔌 Connecting to Database...");
        const dbUri = process.env.MONGODB_URI || process.env.MONGO_URI; 
        await mongoose.connect(dbUri);
        console.log("✅ Connected.");

        const start = new Date(CONFIG.startTime);
        const end = new Date(CONFIG.endTime);

        // 1. DELETE EXISTING DATA IN THIS RANGE (Clean Slate)
        console.log(`🧹 Deleting old records between 10:20 and 10:45...`);
        await DieselModel.deleteMany({
            timestamp: { $gte: start, $lte: end }
        });

        // 2. CALCULATE DROPS
        const durationMs = end.getTime() - start.getTime();
        const steps = Math.floor(durationMs / (CONFIG.intervalMinutes * 60 * 1000));

        // Calculate drop per step for EACH generator
        const dg1Step = (CONFIG.dg1Start - CONFIG.dg1End) / steps;
        const dg2Step = (CONFIG.dg2Start - CONFIG.dg2End) / steps;
        const dg3Step = (CONFIG.dg3Start - CONFIG.dg3End) / steps;

        console.log(`📊 Generating ${steps} records...`);

        for (let i = 0; i <= steps; i++) {
            const currentStepTime = new Date(start.getTime() + (i * CONFIG.intervalMinutes * 60 * 1000));
            
            // Calculate levels for this specific minute
            const lvl1 = CONFIG.dg1Start - (dg1Step * i);
            const lvl2 = CONFIG.dg2Start - (dg2Step * i);
            const lvl3 = CONFIG.dg3Start - (dg3Step * i);
            
            // Real Total
            const totalLvl = lvl1 + lvl2 + lvl3;

            // Generate India Date String
            const dateStr = currentStepTime.toLocaleDateString('en-IN', { 
                timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' 
            }).split('/').reverse().join('-');
            
            const doc = new DieselModel({
                timestamp: currentStepTime,
                date: dateStr,
                hour: currentStepTime.getHours(),
                minute: currentStepTime.getMinutes(),
                
                dg1: { level: parseFloat(lvl1.toFixed(2)), consumption: 0, isRunning: true }, 
                dg2: { level: parseFloat(lvl2.toFixed(2)), consumption: 0, isRunning: true },
                dg3: { level: parseFloat(lvl3.toFixed(2)), consumption: 0, isRunning: true },
                
                total: { level: parseFloat(totalLvl.toFixed(2)), consumption: 0 }
            });

            await doc.save();
            
            // Log for verification
            const timeStr = currentStepTime.toLocaleTimeString('en-IN', {timeZone: 'Asia/Kolkata'});
            console.log(`   + ${timeStr} | DG1:${lvl1.toFixed(1)} | DG2:${lvl2.toFixed(1)} | DG3:${lvl3.toFixed(1)} | Tot:${totalLvl.toFixed(1)}`);
        }

        console.log(`\n✅ Success! All 3 DGs updated for 10:20 - 10:45.`);
        
    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

repairAll();