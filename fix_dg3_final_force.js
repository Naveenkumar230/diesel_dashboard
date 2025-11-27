const mongoose = require('mongoose');
require('dotenv').config();
const { DieselConsumption: DieselModel } = require('./models/schemas');

// ==========================================
// ⚙️ CONFIGURATION: DG3 (186 -> 179)
// ==========================================
const CONFIG = {
    startOfDay: '2025-11-27T00:00:00+05:30',
    endOfDay:   '2025-11-27T23:59:59+05:30',
    
    START_LEVEL: 186,
    END_LEVEL:   179
};

async function forceFixDG3() {
    try {
        console.log("🔌 Connecting...");
        const dbUri = process.env.MONGODB_URI || process.env.MONGO_URI; 
        await mongoose.connect(dbUri);
        console.log("✅ Connected.");

        console.log(`🔍 Updating DG3 records...`);
        const records = await DieselModel.find({
            timestamp: { 
                $gte: new Date(CONFIG.startOfDay), 
                $lte: new Date(CONFIG.endOfDay) 
            }
        }).sort({ timestamp: 1 });

        if (records.length === 0) {
            console.log("⚠️ No records found!");
            return;
        }

        let updateCount = 0;

        for (const doc of records) {
            const h = doc.timestamp.getHours();
            const m = doc.timestamp.getMinutes();
            
            // --- DG3 LOGIC (186 -> 179) ---
            let dg3_lvl = 186; // Default Start
            let consumption = 0;

            if (h < 11) {
                // Before 11 AM: Full 186L
                dg3_lvl = 186;
            } 
            else if (h === 11) { 
                // 11 AM: Drop 4L (186 -> 182)
                dg3_lvl = 182; 
                if (m === 0) consumption = 4;
            }
            else if (h === 12) { 
                // 12 PM: Drop 2L (182 -> 180)
                dg3_lvl = 180; 
                if (m === 0) consumption = 2;
            }
            else if (h >= 13) { 
                // 1 PM onwards: Drop 1L (180 -> 179) -> FINAL LEVEL
                dg3_lvl = 179; 
                if (h === 13 && m === 0) consumption = 1;
            }

            // Apply Update
            doc.dg3.level = dg3_lvl;
            doc.dg3.consumption = consumption;
            doc.dg3.isRunning = (consumption > 0);

            // ⚠️ CRITICAL: Update Total Sum
            doc.total.level = doc.dg1.level + doc.dg2.level + dg3_lvl;
            doc.total.consumption = doc.dg1.consumption + doc.dg2.consumption + consumption;

            await doc.save();
            updateCount++;
        }

        console.log(`\n✅ Success! DG3 Forced to Start: 186L / End: 179L`);
        console.log(`   Updated ${updateCount} records.`);

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

forceFixDG3();