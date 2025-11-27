const mongoose = require('mongoose');
require('dotenv').config();
const { DieselConsumption } = require('./models/schemas');

// Adjust this to the time the gap happened
const CONFIG = {
    startTime: '2025-11-27T10:20:00+05:30', 
    endTime:   '2025-11-27T10:40:00+05:30'
};

async function fix() {
    try {
        const dbUri = process.env.MONGODB_URI || process.env.MONGO_URI; 
        await mongoose.connect(dbUri);
        console.log("✅ Connected.");

        // 1. Get current valid levels from recent data
        // (Assuming DG2/DG3 are roughly full or static)
        const dg2Ref = 200; // Replace with actual approximate level if known
        const dg3Ref = 200; // Replace with actual approximate level if known

        console.log(`🛠 Updating existing records between ${CONFIG.startTime} and ${CONFIG.endTime}...`);

        const records = await DieselConsumption.find({
            timestamp: { 
                $gte: new Date(CONFIG.startTime), 
                $lte: new Date(CONFIG.endTime) 
            }
        });

        console.log(`Found ${records.length} records to update.`);

        for (const doc of records) {
            // Fix DG2 and DG3 levels (they were 0)
            doc.dg2.level = dg2Ref;
            doc.dg3.level = dg3Ref;
            
            // Recalculate Total
            doc.total.level = doc.dg1.level + dg2Ref + dg3Ref;
            
            await doc.save();
            console.log(`   Updated ${doc.timestamp.toLocaleTimeString()}: Total = ${doc.total.level}`);
        }

        console.log("✅ All done!");

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.disconnect();
    }
}

fix();