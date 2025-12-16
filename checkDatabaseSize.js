/**
 * MongoDB Database Size Checker
 * Shows detailed storage statistics for your DG Monitoring System
 * 
 * HOW TO RUN:
 * 1. Save as: checkDatabaseSize.js (in your project root)
 * 2. Run: node checkDatabaseSize.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/dieselDB';

async function checkDatabaseSize() {
  try {
    console.log('Connecting to MongoDB...\n');
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000
    });
    console.log('✅ Connected to MongoDB\n');

    const db = mongoose.connection.db;

    // ========================================
    // DATABASE LEVEL STATISTICS
    // ========================================
    console.log('========================================');
    console.log('DATABASE STATISTICS');
    console.log('========================================\n');

    const dbStats = await db.stats();
    
    console.log(`Database Name: ${dbStats.db}`);
    console.log(`Total Size: ${(dbStats.dataSize / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Storage Size: ${(dbStats.storageSize / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Index Size: ${(dbStats.indexSize / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Total Collections: ${dbStats.collections}`);
    console.log(`Total Indexes: ${dbStats.indexes}`);
    console.log(`Average Object Size: ${(dbStats.avgObjSize / 1024).toFixed(2)} KB`);

    // ========================================
    // COLLECTION LEVEL STATISTICS
    // ========================================
    console.log('\n========================================');
    console.log('COLLECTION STATISTICS');
    console.log('========================================\n');

    const collections = await db.listCollections().toArray();
    
    let totalDocuments = 0;
    let collectionData = [];

    for (const collection of collections) {
      const collName = collection.name;
      
      try {
        // Use $collStats aggregation instead
        const stats = await db.collection(collName).aggregate([
          { $collStats: { storageStats: {} } }
        ]).toArray();
        
        const count = await db.collection(collName).countDocuments();
        totalDocuments += count;
        
        if (stats && stats.length > 0) {
          const storageStats = stats[0].storageStats;
          
          collectionData.push({
            name: collName,
            documents: count,
            dataSize: (storageStats.size / (1024 * 1024)).toFixed(2),
            storageSize: (storageStats.storageSize / (1024 * 1024)).toFixed(2),
            indexSize: (storageStats.totalIndexSize / (1024 * 1024)).toFixed(2),
            avgDocSize: storageStats.avgObjSize ? (storageStats.avgObjSize / 1024).toFixed(2) : '0.00'
          });
        }
      } catch (err) {
        console.log(`⚠️ Could not get stats for ${collName}: ${err.message}`);
      }
    }

    // Sort by data size (largest first)
    collectionData.sort((a, b) => parseFloat(b.dataSize) - parseFloat(a.dataSize));

    // Display collection stats
    console.log('Collection Name                | Documents | Data Size | Storage | Indexes | Avg Doc');
    console.log('-------------------------------|-----------|-----------|---------|---------|--------');
    
    collectionData.forEach(col => {
      console.log(
        `${col.name.padEnd(30)} | ${col.documents.toString().padStart(9)} | ` +
        `${(col.dataSize + ' MB').padStart(9)} | ${(col.storageSize + ' MB').padStart(7)} | ` +
        `${(col.indexSize + ' MB').padStart(7)} | ${(col.avgDocSize + ' KB').padStart(7)}`
      );
    });

    // ========================================
    // DATE RANGE ANALYSIS
    // ========================================
    console.log('\n========================================');
    console.log('DATA COLLECTION TIMELINE');
    console.log('========================================\n');

    // Check DieselConsumption collection
    const dieselColl = db.collection('dieselconsumptions');
    const oldestDiesel = await dieselColl.findOne({}, { sort: { timestamp: 1 } });
    const newestDiesel = await dieselColl.findOne({}, { sort: { timestamp: -1 } });
    
    if (oldestDiesel && newestDiesel) {
      const startDate = new Date(oldestDiesel.timestamp);
      const endDate = new Date(newestDiesel.timestamp);
      const daysDiff = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
      
      console.log(`Diesel Consumption Data:`);
      console.log(`  Oldest Record: ${startDate.toLocaleString('en-IN')}`);
      console.log(`  Newest Record: ${endDate.toLocaleString('en-IN')}`);
      console.log(`  Days of Data: ${daysDiff} days`);
    }

    // Check ElectricalReading collection
    const electricalColl = db.collection('electricalreadings');
    const oldestElectrical = await electricalColl.findOne({}, { sort: { timestamp: 1 } });
    const newestElectrical = await electricalColl.findOne({}, { sort: { timestamp: -1 } });
    
    if (oldestElectrical && newestElectrical) {
      const startDate = new Date(oldestElectrical.timestamp);
      const endDate = new Date(newestElectrical.timestamp);
      const daysDiff = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
      
      console.log(`\nElectrical Reading Data:`);
      console.log(`  Oldest Record: ${startDate.toLocaleString('en-IN')}`);
      console.log(`  Newest Record: ${endDate.toLocaleString('en-IN')}`);
      console.log(`  Days of Data: ${daysDiff} days`);
    }

    // ========================================
    // GROWTH PROJECTION
    // ========================================
    console.log('\n========================================');
    console.log('STORAGE GROWTH PROJECTION');
    console.log('========================================\n');

    const totalSizeMB = dbStats.dataSize / (1024 * 1024);
    
    if (oldestDiesel && newestDiesel) {
      const startDate = new Date(oldestDiesel.timestamp);
      const endDate = new Date(newestDiesel.timestamp);
      const daysCollected = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) || 1;
      
      const dailyGrowth = totalSizeMB / daysCollected;
      
      console.log(`Current Growth Rate: ${dailyGrowth.toFixed(2)} MB/day`);
      console.log(`Projected Monthly Growth: ${(dailyGrowth * 30).toFixed(2)} MB`);
      console.log(`Projected Yearly Growth: ${(dailyGrowth * 365).toFixed(2)} MB (${(dailyGrowth * 365 / 1024).toFixed(2)} GB)`);
    }

    // ========================================
    // SUMMARY
    // ========================================
    console.log('\n========================================');
    console.log('SUMMARY');
    console.log('========================================\n');

    console.log(`📊 Total Documents: ${totalDocuments.toLocaleString()}`);
    console.log(`💾 Total Storage Used: ${(dbStats.storageSize / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`📈 Data Size: ${(dbStats.dataSize / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`🔍 Index Size: ${(dbStats.indexSize / (1024 * 1024)).toFixed(2)} MB`);
    
    const compressionRatio = ((1 - (dbStats.dataSize / dbStats.storageSize)) * 100);
    console.log(`⚡ Compression: ${compressionRatio.toFixed(1)}% efficient`);

    console.log('\n========================================\n');

  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.connection.close();
    console.log('Connection closed.');
    process.exit(0);
  }
}

checkDatabaseSize();