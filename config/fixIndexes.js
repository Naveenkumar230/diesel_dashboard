/**
 * Fix Existing Indexes
 * This script drops old indexes and creates new optimized ones
 * 
 * Save as: config/fixIndexes.js
 * Run: node config/fixIndexes.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/dieselDB';

async function fixIndexes() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000
    });
    console.log('✅ Connected\n');

    // ========================================
    // DROP OLD INDEXES
    // ========================================
    console.log('Step 1: Dropping old indexes...\n');

    const collections = ['dieselconsumptions', 'electricalreadings', 'dailysummaries'];

    for (const collectionName of collections) {
      try {
        const collection = mongoose.connection.db.collection(collectionName);
        const indexes = await collection.indexes();
        
        console.log(`${collectionName}:`);
        console.log(`  Found ${indexes.length} indexes`);

        // Drop all indexes except _id
        for (const index of indexes) {
          if (index.name !== '_id_') {
            try {
              await collection.dropIndex(index.name);
              console.log(`  ✓ Dropped: ${index.name}`);
            } catch (e) {
              console.log(`  ⚠ Could not drop ${index.name}: ${e.message}`);
            }
          }
        }
        console.log('');
      } catch (e) {
        console.log(`  ⚠ Collection ${collectionName} not found or error: ${e.message}\n`);
      }
    }

    // ========================================
    // CREATE NEW INDEXES
    // ========================================
    console.log('Step 2: Creating optimized indexes...\n');

    // DieselConsumption Indexes
    console.log('DieselConsumption:');
    await mongoose.connection.db.collection('dieselconsumptions').createIndex(
      { date: 1, timestamp: 1 },
      { name: 'date_timestamp_idx' }
    );
    console.log('  ✓ Created: date_timestamp_idx');

    await mongoose.connection.db.collection('dieselconsumptions').createIndex(
      { timestamp: -1 },
      { name: 'timestamp_desc_idx' }
    );
    console.log('  ✓ Created: timestamp_desc_idx\n');

    // ElectricalReading Indexes
    console.log('ElectricalReading:');
    await mongoose.connection.db.collection('electricalreadings').createIndex(
      { dg: 1, date: 1, activePower: 1, timestamp: 1 },
      { name: 'dg_date_power_timestamp_idx' }
    );
    console.log('  ✓ Created: dg_date_power_timestamp_idx');

    await mongoose.connection.db.collection('electricalreadings').createIndex(
      { dg: 1, timestamp: -1 },
      { name: 'dg_timestamp_desc_idx' }
    );
    console.log('  ✓ Created: dg_timestamp_desc_idx\n');

    // DailySummary Index
    console.log('DailySummary:');
    await mongoose.connection.db.collection('dailysummaries').createIndex(
      { date: 1 },
      { name: 'date_unique_idx', unique: true }
    );
    console.log('  ✓ Created: date_unique_idx\n');

    // ========================================
    // VERIFY
    // ========================================
    console.log('========================================');
    console.log('VERIFICATION');
    console.log('========================================\n');

    for (const collectionName of collections) {
      try {
        const collection = mongoose.connection.db.collection(collectionName);
        const indexes = await collection.indexes();
        console.log(`${collectionName}:`);
        indexes.forEach(idx => {
          console.log(`  - ${idx.name}`);
        });
        console.log('');
      } catch (e) {
        console.log(`${collectionName}: Not found\n`);
      }
    }

    console.log('========================================');
    console.log('✅ INDEXES FIXED SUCCESSFULLY');
    console.log('========================================\n');

  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.connection.close();
    console.log('Connection closed.');
    process.exit(0);
  }
}

fixIndexes();