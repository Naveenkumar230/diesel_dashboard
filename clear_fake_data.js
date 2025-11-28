require('dotenv').config();
const mongoose = require('mongoose');
const { DieselConsumption, ElectricalReading } = require('./models/schemas');

async function clearData() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');
    
    const today = new Date().toISOString().split('T')[0];
    
    const deleted1 = await DieselConsumption.deleteMany({ date: today });
    const deleted2 = await ElectricalReading.deleteMany({ date: today });
    
    console.log(`🗑️ Deleted ${deleted1.deletedCount} consumption records`);
    console.log(`🗑️ Deleted ${deleted2.deletedCount} electrical records`);
    console.log('✅ All fake data cleared!');
    
    await mongoose.connection.close();
    process.exit(0);
}

clearData().catch(err => { console.error(err); process.exit(1); });