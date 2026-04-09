const mongoose = require('mongoose');
require('dotenv').config();

// Using 0.0.0.0 to match your successful server.js connection
const mongoUri = process.env.MONGO_URI || 'mongodb://0.0.0.0:27017/diesel_db';

async function cleanup() {
    try {
        console.log("Connecting to MongoDB...");
        await mongoose.connect(mongoUri);
        
        const today = new Date().toISOString().split('T')[0];
        
        // This deletes the '100L' record from today so the system starts fresh
        const res = await mongoose.connection.collection('dieselconsumptions').deleteOne({ date: today });
        
        console.log(`✅ Success: Deleted ${res.deletedCount} test records.`);
        console.log("Now restart your server with 'node server.js'");
    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await mongoose.disconnect();
        process.exit();
    }
}
cleanup();