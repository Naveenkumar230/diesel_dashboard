const mongoose = require('mongoose');
require('dotenv').config();
const { DieselConsumption: DieselModel } = require('./models/schemas');

// ==========================================
// ⚙️ FINAL CONFIGURATION (10:20 - 10:45)
// ==========================================
const CONFIG = {
    startTime: '2025-11-27T10:20:00+05:30', 
    endTime:   '2025-11-27T10:45:00+05:30', // Extended to 10:45
    
    dg1Start: 183,
    dg1End:   176,
    
    // We assume DG2 and DG3 were static (not running)
    // Adjust these if you know the exact levels, otherwise 200 is a safe placeholder
    dg2Level: 200, 
    dg3Level: 200,

    intervalMinutes: 5 // Data point every 5 mins
};
// ==========================================

async function runRepair() {
    try {
        console.log("🔌 Connecting...");
        const dbUri = process.env.MONGODB_URI || process.env.MONGO_URI; 
        await mongoose.connect(dbUri);
        console.log("✅ Connected.");

        const start = new Date(CONFIG.startTime);
        const end = new Date(CONFIG.endTime);

        // 1. DELETE OLD DATA IN THIS RANGE (To avoid duplicates)
        console.log(`🧹 Deleting old records between 10:20 and 10:45...`);
        await DieselModel.deleteMany({
            timestamp: { $gte: start, $lte: end }
        });

        // 2. GENERATE NEW DATA
        const durationMs = end.getTime() - start.getTime();
        const steps = Math.floor(durationMs / (CONFIG.intervalMinutes * 60 * 1000));
        const dg1Drop = CONFIG.dg1Start - CONFIG.dg1End;
        const dropPerStep = dg1Drop / steps;

        console.log(`📊 Generating ${steps} records...`);

        for (let i = 0; i <= steps; i++) {
            const currentStepTime = new Date(start.getTime() + (i * CONFIG.intervalMinutes * 60 * 1000));
            const currentDg1 = CONFIG.dg1Start - (dropPerStep * i);
            const totalLevel = currentDg1 + CONFIG.dg2Level + CONFIG.dg3Level;

            // Generate India Date String
            const dateStr = currentStepTime.toLocaleDateString('en-IN', { 
                timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' 
            }).split('/').reverse().join('-');
            
            const doc = new DieselModel({
                timestamp: currentStepTime,
                date: dateStr,
                hour: currentStepTime.getHours(),
                minute: currentStepTime.getMinutes(),
                
                dg1: { level: parseFloat(currentDg1.toFixed(2)), consumption: 0, isRunning: true }, 
                dg2: { level: CONFIG.dg2Level, consumption: 0, isRunning: false },
                dg3: { level: CONFIG.dg3Level, consumption: 0, isRunning: false },
                total: { level: parseFloat(totalLevel.toFixed(2)), consumption: 0 }
            });

            await doc.save();
            
            // Log in IST for verification
            console.log(`   + Added: ${currentStepTime.toLocaleTimeString('en-IN', {timeZone: 'Asia/Kolkata'})} | DG1: ${currentDg1.toFixed(1)}L | Total: ${totalLevel.toFixed(1)}L`);
        }

        console.log(`\n✅ Success! Data fixed for 10:20 - 10:45.`);
        
    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

runRepair();