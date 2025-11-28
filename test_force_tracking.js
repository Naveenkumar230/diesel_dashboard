require('dotenv').config();
const mongoose = require('mongoose');
const { DieselConsumption } = require('./models/schemas');

async function test() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected');
    
    const record = new DieselConsumption({
        timestamp: new Date(),
        dg1: { level: 173, consumption: 0, isRunning: false },
        dg2: { level: 191, consumption: 0, isRunning: true },
        dg3: { level: 180, consumption: 0, isRunning: false },
        total: { level: 544, consumption: 0 },
        date: new Date().toISOString().split('T')[0],
        hour: new Date().getHours(),
        minute: new Date().getMinutes()
    });
    
    await record.save();
    console.log('✅ Saved! Refresh browser now.');
    process.exit(0);
}

test().catch(err => { console.error(err); process.exit(1); });