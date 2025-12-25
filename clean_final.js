const mongoose = require('mongoose');
const mongoURI = 'mongodb+srv://dieselconsumption7_db_user:NSSZ9Y9X2sLJCUHX@cluster0.ortzv0q.mongodb.net/dieselDB?retryWrites=true&w=majority&tls=true&tlsAllowInvalidCertificates=true';

const DieselConsumptionSchema = new mongoose.Schema({
  timestamp: Date,
  dg1: { level: Number, consumption: Number },
  dg2: { level: Number, consumption: Number },
  dg3: { level: Number, consumption: Number },
  date: String
});
const DieselConsumption = mongoose.model('DieselConsumption', DieselConsumptionSchema);

async function cleanToday() {
  console.log("🚀 Starting Cleanup...");
  try {
    await mongoose.connect(mongoURI, { serverSelectionTimeoutMS: 10000 });
    console.log("✅ DB Connected");

    const today = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
    const endOfDay = new Date(today.setHours(23, 59, 59, 999));

    console.log(`📅 Deleting ALL records for today: ${startOfDay.toISOString().split('T')[0]}`);

    // DELETE EVERYTHING FROM TODAY (Resets stats to 0)
    const result = await DieselConsumption.deleteMany({
      timestamp: { $gte: startOfDay, $lte: endOfDay }
    });

    console.log(`🗑️ DELETED ${result.deletedCount} records.`);
    console.log("✨ Dashboard Stats (Consumption/Refill) should now be 0.");

  } catch (err) {
    console.error("❌ ERROR:", err.message);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

cleanToday();