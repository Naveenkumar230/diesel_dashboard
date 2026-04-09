/**
 * FORCE CLEAR DATABASE SCRIPT
 * Purpose: Delete today's consumption record so the dashboard starts fresh.
 */
const mongoose = require('mongoose');
require('dotenv').config();

// Use the same URI logic as your server.js
const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/diesel_db';

async function clearDatabase() {
    console.log("--- ATTEMPTING DB CLEAR ---");
    try {
        // Connect to MongoDB
        await mongoose.connect(mongoUri, { 
            useNewUrlParser: true, 
            useUnifiedTopology: true 
        });
        console.log("✅ Connected to MongoDB.");

        // Get today's date string (YYYY-MM-DD)
        const today = new Date().toISOString().split('T')[0];
        
        // Target the collection directly
        const result = await mongoose.connection.collection('dieselconsumptions').deleteOne({ date: today });
        
        if (result.deletedCount > 0) {
            console.log(`✅ SUCCESS: Deleted today's record (${today}).`);
        } else {
            console.log(`ℹ️ INFO: No record found for today (${today}). It's already clean!`);
        }

    } catch (err) {
        console.error("❌ ERROR:", err.message);
    } finally {
        await mongoose.disconnect();
        console.log("--- DONE ---");
        process.exit();
    }
}

clearDatabase();