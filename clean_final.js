const mongoose = require('mongoose');

// YOUR CLOUD DATABASE ADDRESS
const MONGO_URI = "mongodb+srv://dieselconsumption7_db_user:NSSZ9Y9X2sLJCUHX@cluster0.ortzv0q.mongodb.net/dieselDB?retryWrites=true&w=majority&tls=true&tlsAllowInvalidCertificates=true";

const LogSchema = new mongoose.Schema({
    timestamp: Date,
    event: String,
    startLevel: Number,
    endLevel: Number,
    consumption: Number
});
const Log = mongoose.model('Log', LogSchema);

async function resetToday() {
    try {
        console.log(`🔌 Connecting to Cloud Database...`);
        await mongoose.connect(MONGO_URI);
        console.log("✅ Connected.");

        // 1. DEFINE "TODAY" (From Midnight until now)
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        // 2. FIND & DELETE BAD RECORDS
        // We delete logs from TODAY where consumption is greater than 0
        const result = await Log.deleteMany({ 
            timestamp: { $gte: startOfDay, $lte: endOfDay },
            consumption: { $gt: 0 }
        });

        if (result.deletedCount > 0) {
            console.log(`\n🎉 SUCCESS! Deleted ${result.deletedCount} records from TODAY.`);
            console.log("The '7 Liters' should now be gone from your dashboard.\n");
        } else {
            console.log("\n⚠️ No records found with consumption > 0 for today.");
        }

    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await mongoose.disconnect();
        console.log("👋 Connection Closed.");
    }
}

resetToday();