const mongoose = require('mongoose');

// 1. Connection String (From your env/config)
const uri = "mongodb+srv://dieselconsumption7_db_user:NSSZ9Y9X2sLJCUHX@cluster0.ortzv0q.mongodb.net/dieselDB?retryWrites=true&w=majority&tls=true&tlsAllowInvalidCertificates=true";

// 2. Define Schema
const DieselConsumption = mongoose.model('DieselConsumption', new mongoose.Schema({
    timestamp: Date,
    dg1: { level: Number, consumption: Number },
    dg2: { level: Number, consumption: Number },
    dg3: { level: Number, consumption: Number },
    total: { level: Number, consumption: Number }
}));

async function getStartLevels() {
    try {
        console.log("⏳ Connecting to MongoDB...");
        await mongoose.connect(uri);
        console.log("✅ Connected.");

        // 3. Fetch Data (e.g., for Today)
        const start = new Date();
        start.setHours(0, 0, 0, 0); // Start of today
        
        const records = await DieselConsumption.find({ 
            timestamp: { $gte: start } 
        }).sort({ timestamp: 1 }).lean();

        console.log(`\nFound ${records.length} records for today.\n`);

        // 4. Calculate True Start Level for each DG
        ['dg1', 'dg2', 'dg3'].forEach(dg => {
            // Find first record where level > 0
            const validRecord = records.find(r => (r[dg]?.level || 0) > 0);
            const startLevel = validRecord ? validRecord[dg].level : (records[0]?.[dg]?.level || 0);
            
            console.log(`🔹 ${dg.toUpperCase()} Start Level: ${startLevel} Liters`);
        });

    } catch (err) {
        console.error("❌ Error:", err);
    } finally {
        await mongoose.disconnect();
        console.log("\n👋 Done.");
    }
}

getStartLevels();