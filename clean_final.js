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

async function clean() {
  try {
    await mongoose.connect(mongoURI, { serverSelectionTimeoutMS: 10000 });
    console.log("✅ DB Connected");

    const today = new Date();
    const start = new Date(today.setHours(0, 0, 0, 0));
    const end = new Date(today.setHours(23, 59, 59, 999));

    // DELETE any record where level dropped below 10L (Aggressive Clean)
    const res = await DieselConsumption.deleteMany({
      timestamp: { $gte: start, $lte: end },
      $or: [
        { "dg1.level": { $lt: 10 } },
        { "dg2.level": { $lt: 10 } },
        { "dg3.level": { $lt: 10 } }
      ]
    });

    console.log(`🗑️ DELETED ${res.deletedCount} BAD RECORDS.`);
  } catch (e) { console.error(e); } 
  finally { mongoose.disconnect(); }
}
clean();
