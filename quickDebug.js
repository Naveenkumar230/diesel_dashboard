/**
 * quickDebug.js - Fast 30-second system check
 * Usage: node quickDebug.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { DieselConsumption } = require('./models/schemas');
const { getSystemData, isConnected } = require('./services/plcService');

const MONGODB_URI = process.env.MONGODB_URI;

async function quickCheck() {
  console.clear();
  console.log('🔍 QUICK SYSTEM CHECK\n');
  console.log('='.repeat(60));
  
  const results = {
    mongodb: '❌',
    plc: '❌',
    data: '❌',
    consumption: '❌'
  };
  
  // 1. MongoDB
  try {
    await mongoose.connect(MONGODB_URI, { 
      serverSelectionTimeoutMS: 5000 
    });
    results.mongodb = '✅';
    console.log('✅ MongoDB: Connected');
  } catch (e) {
    console.log('❌ MongoDB: Failed -', e.message.substring(0, 50));
  }
  
  // 2. PLC Connection
  console.log('⏳ Checking PLC (waiting 3 seconds)...');
  await new Promise(r => setTimeout(r, 3000));
  
  if (isConnected()) {
    results.plc = '✅';
    console.log('✅ PLC: Connected');
    
    const data = getSystemData();
    if (data && data.lastUpdate) {
      results.data = '✅';
      console.log('✅ Live Data: Available');
      console.log(`   DG1: ${data.dg1}L`);
      console.log(`   DG2: ${data.dg2}L`);
      console.log(`   DG3: ${data.dg3}L`);
      console.log(`   Total: ${data.total}L`);
      console.log(`   Last Update: ${new Date(data.lastUpdate).toLocaleTimeString('en-IN')}`);
    } else {
      console.log('❌ Live Data: Not available yet');
    }
  } else {
    console.log('❌ PLC: Not connected');
    console.log('   💡 Tip: Is your server running? Try: pm2 restart diesel-dashboard');
  }
  
  // 3. Today's Data
  if (results.mongodb === '✅') {
    try {
      const today = new Date().toISOString().split('T')[0];
      const count = await DieselConsumption.countDocuments({ date: today });
      
      if (count > 0) {
        results.consumption = '✅';
        console.log(`✅ Today's Records: ${count} records found`);
        
        const records = await DieselConsumption.find({ date: today })
          .sort({ timestamp: 1 })
          .lean();
        
        const first = records[0];
        const last = records[records.length - 1];
        
        const dbConsumption = records.reduce((sum, r) => sum + (r.total?.consumption || 0), 0);
        const actualConsumption = first.total.level - last.total.level;
        
        console.log(`   Start: ${first.total.level}L at ${new Date(first.timestamp).toLocaleTimeString('en-IN')}`);
        console.log(`   Current: ${last.total.level}L at ${new Date(last.timestamp).toLocaleTimeString('en-IN')}`);
        console.log(`   DB Consumption: ${dbConsumption.toFixed(1)}L`);
        console.log(`   Actual Consumption: ${actualConsumption.toFixed(1)}L`);
        
        const diff = Math.abs(dbConsumption - actualConsumption);
        if (diff > 2) {
          console.log(`   ⚠️  Noise Issue: ${diff.toFixed(1)}L discrepancy`);
          console.log('   💡 Fix: Update schedulerService.js with NOISE_THRESHOLD=1.0');
        } else {
          console.log('   ✅ Consumption tracking looks good!');
        }
      } else {
        console.log('⚠️  Today\'s Records: No data yet');
        console.log('   💡 Scheduler may not be running or tracking hasn\'t started');
      }
    } catch (e) {
      console.log('❌ Data Check Failed:', e.message);
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY:');
  console.log(`   MongoDB: ${results.mongodb}`);
  console.log(`   PLC: ${results.plc}`);
  console.log(`   Live Data: ${results.data}`);
  console.log(`   Consumption: ${results.consumption}`);
  
  const allGood = Object.values(results).every(v => v === '✅');
  
  if (allGood) {
    console.log('\n🎉 ALL SYSTEMS OPERATIONAL!');
  } else {
    console.log('\n⚠️  ISSUES DETECTED - See details above');
    
    if (results.plc === '❌') {
      console.log('\n🔧 TO FIX PLC:');
      console.log('   1. Check if server is running: pm2 list');
      console.log('   2. Start server: pm2 start server.js --name diesel-dashboard');
      console.log('   3. Check logs: pm2 logs diesel-dashboard');
    }
    
    if (results.consumption === '⚠️ ') {
      console.log('\n🔧 TO FIX CONSUMPTION:');
      console.log('   1. Update services/schedulerService.js');
      console.log('   2. Change NOISE_THRESHOLD from 1.5 to 1.0');
      console.log('   3. Restart: pm2 restart diesel-dashboard');
    }
  }
  
  await mongoose.disconnect();
  console.log('\n✅ Check complete\n');
  process.exit(0);
}

quickCheck().catch(err => {
  console.error('❌ Check failed:', err.message);
  process.exit(1);
});