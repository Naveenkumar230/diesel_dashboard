const mongoose = require('mongoose');

// Your MongoDB URI
const uri = "mongodb+srv://dieselconsumption7_db_user:NSSZ9Y9X2sLJCUHX@cluster0.ortzv0q.mongodb.net/dieselDB?retryWrites=true&w=majority&tls=true&tlsAllowInvalidCertificates=true";

// Generic Schema to fetch whatever is there
const GenericSchema = new mongoose.Schema({}, { strict: false });
const DieselConsumption = mongoose.model('DieselConsumption', GenericSchema, 'dieselconsumptions');

async function checkData() {
    try {
        console.log("⏳ Connecting...");
        await mongoose.connect(uri);
        
        // Fetch the absolute latest record
        const latestRecord = await DieselConsumption.findOne().sort({ timestamp: -1 }).lean();
        
        console.log("\n🔎 LATEST RECORD STRUCTURE:");
        console.log("------------------------------------------------");
        if (latestRecord) {
            console.log(JSON.stringify(latestRecord, null, 2));
            
            console.log("------------------------------------------------");
            console.log("👉 CHECKING FOR ELECTRICAL DATA:");
            
            // Check if ANY electrical fields exist
            const hasVoltage = latestRecord.voltage !== undefined || latestRecord.R_Voltage !== undefined;
            const hasHz = latestRecord.frequency !== undefined || latestRecord.Hz !== undefined;
            const hasRunning = latestRecord.isRunning !== undefined;
            
            if (hasRunning) {
                console.log("✅ 'isRunning' flag found! You are ready.");
            } else if (hasVoltage || hasHz) {
                console.log("✅ Voltage/Frequency found! We can calculate 'isRunning'.");
            } else {
                console.log("❌ NO Electrical data found in Diesel record.");
                console.log("⚠️ We MUST update api.js to merge Electrical data first.");
            }
        } else {
            console.log("❌ No data found.");
        }

    } catch (err) {
        console.error("Error:", err);
    } finally {
        await mongoose.disconnect();
    }
}

checkData();