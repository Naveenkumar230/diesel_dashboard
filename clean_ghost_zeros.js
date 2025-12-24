const mongoose = require('mongoose');

// ✅ YOUR DB CONNECTION
const mongoURI = 'mongodb+srv://dieselconsumption7_db_user:NSSZ9Y9X2sLJCUHX@cluster0.ortzv0q.mongodb.net/dieselDB?retryWrites=true&w=majority&tls=true&tlsAllowInvalidCertificates=true';

// 1. Define Schema
const DieselConsumptionSchema = new mongoose.Schema({
  timestamp: Date,
  dg1: { level: Number, consumption: Number },
  dg2: { level: Number, consumption: Number },
  dg3: { level: Number, consumption: Number },
  date: String
});
const DieselConsumption = mongoose.model('DieselConsumption', DieselConsumptionSchema);

async function cleanAllGhosts() {
  console.log("🚀 Starting Total Cleanup...");

  try {
    await mongoose.connect(mongoURI, { serverSelectionTimeoutMS: 10000 });
    console.log("✅ Connected to Database.");

    // 2. Target TODAY's records
    const today = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
    const endOfDay = new Date(today.setHours(23, 59, 59, 999));

    console.log(`📅 Cleaning records for: ${startOfDay.toISOString().split('T')[0]}`);

    // 3. DELETE if ANY DG dropped below 5 Liters (Ghost Zero)
    const result = await DieselConsumption.deleteMany({
      timestamp: { $gte: startOfDay, $lte: endOfDay },
      $or: [
        { "dg1.level": { $lt: 5 } },
        { "dg2.level": { $lt: 5 } },
        { "dg3.level": { $lt: 5 } }  // ✅ Now checking DG3 too
      ]
    });

    console.log(`🗑️ DELETED ${result.deletedCount} bad records.`);
    console.log("✨ Refresh your dashboard. The Total Consumption/Refill should be fixed.");

  } catch (err) {
    console.error("❌ ERROR:", err.message);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

cleanAllGhosts();