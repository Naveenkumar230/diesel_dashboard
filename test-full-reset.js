const ModbusRTU = require('modbus-serial');
const mongoose = require('mongoose');
require('dotenv').config();

const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const slaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;

// Use 'localhost' which is what most Pi configurations expect
const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/diesel_db';

const TARGET_REGISTER = 4100; // DG2
const TEST_VALUE = 100;

async function runFullResetDG2() {
    console.log("--- STARTING DG2 SYSTEM RESET ---");

    // --- PART 1: MONGODB RESET ---
    try {
        console.log("1. Connecting to MongoDB...");
        await mongoose.connect(mongoUri);
        
        const today = new Date().toISOString().split('T')[0];
        await mongoose.connection.collection('dieselconsumptions').updateOne(
            { date: today },
            { $set: { "dg2.consumption": 0 } }
        );
        console.log(`✅ MongoDB: Reset DG2 consumption successfully.`);
        await mongoose.disconnect();
    } catch (err) {
        console.error("⚠️ MongoDB Reset Failed (Skipping to PLC):", err.message);
    }

    // --- PART 2: PLC WRITE (Runs even if DB fails) ---
    try {
        console.log("2. Connecting to PLC...");
        const client = new ModbusRTU();
        await client.connectRTU(port, { baudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1 });
        await client.setID(slaveID);
        await client.setTimeout(2000);

        console.log(`3. Writing ${TEST_VALUE} to Register ${TARGET_REGISTER} (DG2)...`);
        await client.writeRegister(TARGET_REGISTER, TEST_VALUE);
        console.log("✅ PLC: DG2 Register updated successfully.");
        client.close();
    } catch (err) {
        console.error("❌ PLC Write Failed:", err.message);
    }

    console.log("--- RESET FINISHED ---");
    process.exit();
}

runFullResetDG2();