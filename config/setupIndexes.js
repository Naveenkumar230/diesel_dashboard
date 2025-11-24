/**
 * Database Index Setup
 * RUN THIS ONCE to create optimal indexes
 * This drastically speeds up queries and prevents 502 errors
 * 
 * HOW TO RUN:
 * 1. Save as: config/setupIndexes.js
 * 2. Run: node config/setupIndexes.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { 
  DieselConsumption, 
  ElectricalReading, 
  DailySummary 
} = require('../models/schemas');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/dieselDB';

async function setupIndexes() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000
    });
    console.log('✅ Connected\n');

    // ========================================
    // DIESEL CONSUMPTION INDEXES
    // ========================================
    console.log('Creating DieselConsumption indexes...');
    
    // Primary query: By date (used by frontend)
    await DieselConsumption.collection.createIndex(
      { date: 1, timestamp: 1 },
      { name: 'date_timestamp_idx' }
    );
    
    // Fallback: By timestamp range
    await DieselConsumption.collection.createIndex(
      { timestamp: -1 },
      { name: 'timestamp_desc_idx' }
    );

    console.log('✅ DieselConsumption indexes created');

    // ========================================
    // ELECTRICAL READING INDEXES
    // ========================================
    console.log('\nCreating ElectricalReading indexes...');
    
    // 🔥 CRITICAL: Composite index for the main query
    // Covers: { dg: 'dg1', date: '2025-01-15', activePower: { $gt: 5 } }
    await ElectricalReading.collection.createIndex(
      { dg: 1, date: 1, activePower: 1, timestamp: 1 },
      { name: 'dg_date_power_idx' }
    );
    
    // Secondary: For date range queries
    await ElectricalReading.collection.createIndex(
      { dg: 1, timestamp: -1 },
      { name: 'dg_timestamp_idx' }
    );

    console.log('✅ ElectricalReading indexes created');

    // ========================================
    // DAILY SUMMARY INDEXES
    // ========================================
    console.log('\nCreating DailySummary indexes...');
    
    await DailySummary.collection.createIndex(
      { date: 1 },
      { name: 'date_unique_idx', unique: true }
    );

    console.log('✅ DailySummary indexes created');

    // ========================================
    // VERIFY INDEXES
    // ========================================
    console.log('\n========================================');
    console.log('VERIFICATION');
    console.log('========================================\n');

    const consumptionIndexes = await DieselConsumption.collection.indexes();
    console.log('DieselConsumption indexes:', 
      consumptionIndexes.map(i => i.name).join(', '));

    const electricalIndexes = await ElectricalReading.collection.indexes();
    console.log('ElectricalReading indexes:', 
      electricalIndexes.map(i => i.name).join(', '));

    const summaryIndexes = await DailySummary.collection.indexes();
    console.log('DailySummary indexes:', 
      summaryIndexes.map(i => i.name).join(', '));

    // ========================================
    // TEST QUERY PERFORMANCE
    // ========================================
    console.log('\n========================================');
    console.log('PERFORMANCE TEST');
    console.log('========================================\n');

    const today = new Date().toISOString().split('T')[0];

    console.log('Testing ElectricalReading query...');
    const startTime = Date.now();
    
    await ElectricalReading.find({
      dg: 'dg1',
      date: today,
      activePower: { $gt: 5 }
    })
    .sort({ timestamp: 1 })
    .limit(100)
    .explain('executionStats');

    const duration = Date.now() - startTime;
    console.log(`✅ Query completed in ${duration}ms`);
    
    if (duration < 100) {
      console.log('🎉 EXCELLENT: Query is optimized!');
    } else if (duration < 500) {
      console.log('✅ GOOD: Query performance acceptable');
    } else {
      console.log('⚠️  SLOW: Consider checking data volume');
    }

    console.log('\n========================================');
    console.log('✅ INDEX SETUP COMPLETE');
    console.log('========================================');
    console.log('\nYour database is now optimized!');
    console.log('Restart your server to see improvements.\n');

  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await mongoose.connection.close();
    console.log('Connection closed.');
    process.exit(0);
  }
}

setupIndexes();