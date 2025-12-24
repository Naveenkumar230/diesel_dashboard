const mongoose = require('mongoose');

// ✅ DIRECT LINK (Copied from your .env)
const mongoURI = 'mongodb+srv://dieselconsumption7_db_user:NSSZ9Y9X2sLJCUHX@cluster0.ortzv0q.mongodb.net/dieselDB?retryWrites=true&w=majority&tls=true&tlsAllowInvalidCertificates=true';

// 1. Define Schema
const DieselConsumptionSchema = new mongoose.Schema({
  timestamp: Date,
  dg1: { level: Number, consumption: Number },
  dg2: { level: Number, consumption: Number },
  dg3: { level: Number, consumption: Number },
  date: String
});
// Explicitly use 'dieselconsumptions' collection (Mongoose pluralizes it)
const DieselConsumption = mongoose.model('DieselConsumption', DieselConsumptionSchema);

async function cleanBadData() {
  console.log("🚀 Starting Cleanup Script...");
  console.log("📡 Connecting to Atlas DB...");

  try {
    await mongoose.connect(mongoURI, { serverSelectionTimeoutMS: 10000 });
    console.log("✅ Connected successfully!");

    // 2. Define Time Range (Today)
    const today = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
    const endOfDay = new Date(today.setHours(23, 59, 59, 999));

    console.log(`📅 Cleaning bad records for: ${startOfDay.toISOString().split('T')[0]}`);

    // 3. Delete Bad Records (< 2 Liters)
    const result = await DieselConsumption.deleteMany({
      timestamp: { $gte: startOfDay, $lte: endOfDay },
      $or: [
        { "dg1.level": { $lt: 2 } },
        { "dg2.level": { $lt: 2 } }
      ]
    });

    console.log(`🗑️ DELETED ${result.deletedCount} ghost records.`);
    console.log("✨ Check your dashboard now. The 122L spike should be gone.");

  } catch (err) {
    console.error("❌ ERROR:", err.message);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

cleanBadData();