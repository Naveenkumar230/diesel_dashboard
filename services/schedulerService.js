/**
 * Scheduler Service - PROPERLY FIXED VERSION
 * 
 * KEY FIXES:
 * 1. Initialize dayStartLevels from CURRENT system data on new day
 * 2. Don't rely on database records that might not exist yet
 * 3. Reset dayStartLevels AFTER first reading, not before
 * 4. Extended cron to include 8 PM hour (7-20 instead of 7-19)
 */

const cron = require('node-cron');
const { DieselConsumption, DailySummary, ElectricalReading } = require('../models/schemas');
const { getSystemData } = require('./plcService');
const { sendDailySummary } = require('./emailService');

const DG_RUNNING_THRESHOLD = 5; // kW

let dayStartLevels = null;
let lastSavedLevels = { dg1: null, dg2: null, dg3: null, total: null };
let lastTrackingDate = null; // Track which date we're currently on

// ✅ FIXED: Initialize from CURRENT system data, not database
async function initializeDayStartLevels() {
  try {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    // If we already have start levels for today, don't reinitialize
    if (dayStartLevels && dayStartLevels.date === today) {
      console.log('✅ Day start levels already set for today:', dayStartLevels);
      return;
    }

    // Try to get from database first (if records exist)
    const todayRecords = await DieselConsumption.findOne({ date: today })
      .sort({ timestamp: 1 })
      .limit(1);
    
    if (todayRecords) {
      // Use first record of the day as start levels
      dayStartLevels = {
        dg1: todayRecords.dg1?.level || 0,
        dg2: todayRecords.dg2?.level || 0,
        dg3: todayRecords.dg3?.level || 0,
        total: todayRecords.total?.level || 0,
        date: today
      };
      console.log('✅ Day start levels loaded from first record:', dayStartLevels);
    } else {
      // No records yet - get CURRENT levels from PLC
      const systemData = getSystemData();
      
      if (systemData && systemData.lastUpdate) {
        dayStartLevels = {
          dg1: systemData.dg1 || 0,
          dg2: systemData.dg2 || 0,
          dg3: systemData.dg3 || 0,
          total: systemData.total || 0,
          date: today
        };
        console.log('✅ Day start levels initialized from CURRENT PLC data:', dayStartLevels);
      } else {
        console.log('⚠️ No system data available yet, will initialize on first reading');
      }
    }
  } catch (err) {
    console.error('❌ Error initializing day start levels:', err.message);
  }
}

// ✅ FIXED: Better tracking with proper day change handling
async function trackConsumption() {
  try {
    const now = new Date();
    const hour = now.getHours();
    const today = now.toISOString().split('T')[0];

    // Check if day changed - reinitialize if needed
    if (lastTrackingDate && lastTrackingDate !== today) {
      console.log(`📅 Day changed from ${lastTrackingDate} to ${today} - reinitializing...`);
      await initializeDayStartLevels();
    }
    lastTrackingDate = today;

    // Only track between 7 AM and 8 PM (inclusive)
    if (hour < 7 || hour > 20) {
      console.log(`⏰ Outside tracking hours (${hour}:00), skipping...`);
      return;
    }

    const systemData = getSystemData();
    
    if (!systemData || !systemData.lastUpdate) {
      console.log('⚠️ No system data available for consumption tracking');
      return;
    }

    // Initialize day start levels if not set OR if date changed
    if (!dayStartLevels || dayStartLevels.date !== today) {
      dayStartLevels = {
        dg1: systemData.dg1,
        dg2: systemData.dg2,
        dg3: systemData.dg3,
        total: systemData.total,
        date: today
      };
      console.log('📊 Day start levels set for', today, ':', dayStartLevels);
    }

    // Get previous record to calculate consumption
    const previousRecord = await DieselConsumption.findOne({
      date: today
    }).sort({ timestamp: -1 }).limit(1);

    const currentData = {
      dg1: systemData.dg1,
      dg2: systemData.dg2,
      dg3: systemData.dg3,
      total: systemData.total,
      electrical: systemData.electrical
    };

    // Calculate consumption (DECREASE ONLY)
    let consumption = {
      dg1: 0,
      dg2: 0,
      dg3: 0,
      total: 0
    };

    if (previousRecord) {
      // Only count if level DECREASED
      if (currentData.dg1 < previousRecord.dg1.level) {
        consumption.dg1 = previousRecord.dg1.level - currentData.dg1;
      }
      if (currentData.dg2 < previousRecord.dg2.level) {
        consumption.dg2 = previousRecord.dg2.level - currentData.dg2;
      }
      if (currentData.dg3 < previousRecord.dg3.level) {
        consumption.dg3 = previousRecord.dg3.level - currentData.dg3;
      }
      consumption.total = consumption.dg1 + consumption.dg2 + consumption.dg3;
    } else {
      console.log('📝 First record of the day');
    }

    // Check if DGs are running
    const isRunning = {
      dg1: (currentData.electrical?.dg1?.activePower || 0) > DG_RUNNING_THRESHOLD,
      dg2: (currentData.electrical?.dg2?.activePower || 0) > DG_RUNNING_THRESHOLD,
      dg3: (currentData.electrical?.dg3?.activePower || 0) > DG_RUNNING_THRESHOLD
    };

    // Save diesel consumption record
    const record = new DieselConsumption({
      timestamp: now,
      dg1: {
        level: currentData.dg1,
        consumption: consumption.dg1,
        isRunning: isRunning.dg1
      },
      dg2: {
        level: currentData.dg2,
        consumption: consumption.dg2,
        isRunning: isRunning.dg2
      },
      dg3: {
        level: currentData.dg3,
        consumption: consumption.dg3,
        isRunning: isRunning.dg3
      },
      total: {
        level: currentData.total,
        consumption: consumption.total
      },
      date: today,
      hour: hour,
      minute: now.getMinutes()
    });

    await record.save();
    
    // Update last saved levels
    lastSavedLevels = {
      dg1: currentData.dg1,
      dg2: currentData.dg2,
      dg3: currentData.dg3,
      total: currentData.total
    };

    const time = now.toLocaleTimeString('en-IN');
    const status = Object.values(isRunning).some(v => v) ? '🟢' : '⚪';
    console.log(`${status} ${time} | DG1=${currentData.dg1.toFixed(1)}L DG2=${currentData.dg2.toFixed(1)}L DG3=${currentData.dg3.toFixed(1)}L | Consumed: ${consumption.total.toFixed(1)}L`);

    // Also save electrical parameters for running DGs
    await saveElectricalData(currentData.electrical, now);

  } catch (err) {
    console.error('❌ Error tracking consumption:', err.message);
  }
}

// Save electrical parameters to database
async function saveElectricalData(electricalData, timestamp) {
  try {
    const dateStr = timestamp.toISOString().split('T')[0];
    const hour = timestamp.getHours();

    for (const dgKey of ['dg1', 'dg2', 'dg3', 'dg4']) {
      const data = electricalData[dgKey];
      
      if (!data) continue;

      // Only save if DG is running (activePower > threshold)
      if ((data.activePower || 0) > DG_RUNNING_THRESHOLD) {
        const electricalRecord = new ElectricalReading({
          timestamp: timestamp,
          dg: dgKey,
          voltageR: data.voltageR || 0,
          voltageY: data.voltageY || 0,
          voltageB: data.voltageB || 0,
          currentR: data.currentR || 0,
          currentY: data.currentY || 0,
          currentB: data.currentB || 0,
          frequency: data.frequency || 0,
          powerFactor: data.powerFactor || 0,
          activePower: data.activePower || 0,
          reactivePower: data.reactivePower || 0,
          energyMeter: data.energyMeter || 0,
          runningHours: data.runningHours || 0,
          windingTemp: data.windingTemp || 0,
          date: dateStr,
          hour: hour
        });

        await electricalRecord.save();
      }
    }
  } catch (err) {
    console.error('❌ Error saving electrical data:', err.message);
  }
}

// Generate daily summary
async function generateDailySummary() {
  try {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const systemData = getSystemData();
    
    if (!systemData || !dayStartLevels) {
      console.log('⚠️ Cannot generate summary: Missing start levels');
      return;
    }

    // Get consumption records for today
    const todayRecords = await DieselConsumption.find({ date: today }).sort({ timestamp: 1 });

    if (todayRecords.length === 0) {
      console.log('⚠️ No consumption records found for today');
      return;
    }

    // Calculate total consumption
    let totalConsumption = {
      dg1: todayRecords.reduce((sum, r) => sum + (r.dg1?.consumption || 0), 0),
      dg2: todayRecords.reduce((sum, r) => sum + (r.dg2?.consumption || 0), 0),
      dg3: todayRecords.reduce((sum, r) => sum + (r.dg3?.consumption || 0), 0)
    };

    totalConsumption.total = totalConsumption.dg1 + totalConsumption.dg2 + totalConsumption.dg3;

    // Calculate running hours (each record = 30 minutes)
    const runningHours = {
      dg1: todayRecords.filter(r => r.dg1?.isRunning).length * 0.5,
      dg2: todayRecords.filter(r => r.dg2?.isRunning).length * 0.5,
      dg3: todayRecords.filter(r => r.dg3?.isRunning).length * 0.5
    };

    // Create summary document
    const summary = new DailySummary({
      date: today,
      dg1: {
        startLevel: dayStartLevels.dg1,
        endLevel: systemData.dg1,
        totalConsumption: totalConsumption.dg1,
        runningHours: runningHours.dg1
      },
      dg2: {
        startLevel: dayStartLevels.dg2,
        endLevel: systemData.dg2,
        totalConsumption: totalConsumption.dg2,
        runningHours: runningHours.dg2
      },
      dg3: {
        startLevel: dayStartLevels.dg3,
        endLevel: systemData.dg3,
        totalConsumption: totalConsumption.dg3,
        runningHours: runningHours.dg3
      },
      total: {
        startLevel: dayStartLevels.total,
        endLevel: systemData.total,
        totalConsumption: totalConsumption.total
      }
    });

    await summary.save();
    console.log(`📊 Daily summary saved for ${today}`);
    console.log(`   Total consumption: ${totalConsumption.total.toFixed(1)}L`);
    console.log(`   DG1: ${totalConsumption.dg1.toFixed(1)}L (${runningHours.dg1}h)`);
    console.log(`   DG2: ${totalConsumption.dg2.toFixed(1)}L (${runningHours.dg2}h)`);
    console.log(`   DG3: ${totalConsumption.dg3.toFixed(1)}L (${runningHours.dg3}h)`);

    // Get yesterday's summary for comparison
    const previousSummary = await DailySummary.findOne({ date: yesterday });

    // Send email
    await sendDailySummary(summary, previousSummary);

    // ✅ DON'T reset here - let it reset naturally on next day's first reading
    console.log('📧 Daily summary email sent. Day start levels will reset on next tracking cycle.');

  } catch (err) {
    console.error('❌ Error generating daily summary:', err.message);
  }
}

// Start all scheduled tasks
function startScheduledTasks() {
  console.log('🕐 Starting scheduled tasks...');

  // ✅ FIXED: Extended to include 8 PM (7-20 instead of 7-19)
  cron.schedule('0,30 7-20 * * *', () => {
    console.log('\n⏰ Running 30-minute consumption/electrical tracking...');
    trackConsumption();
  }, {
    timezone: "Asia/Kolkata"
  });

  // Generate and send daily summary at 8:30 PM (after last tracking at 8:00 PM)
  cron.schedule('30 20 * * *', () => {
    console.log('\n⏰ Running daily summary generation...');
    generateDailySummary();
  }, {
    timezone: "Asia/Kolkata"
  });

  // Initialize and take first reading
  const now = new Date();
  const hour = now.getHours();
  
  console.log('✅ Scheduled tasks configured:');
  console.log('   - Consumption tracking: Every 30 minutes (7 AM - 8 PM)');
  console.log('   - Electrical logging: Every 30 minutes (during DG running)');
  console.log('   - Daily summary: 8:30 PM');
  console.log(`   - Current time: ${now.toLocaleTimeString('en-IN')}`);

  // Initialize day start levels from database or system
  initializeDayStartLevels();

  // Take first reading after 10 seconds if within operating hours
  if (hour >= 7 && hour <= 20) {
    console.log('⏳ Taking first reading in 10 seconds...');
    setTimeout(() => {
      trackConsumption();
    }, 10000);
  } else {
    console.log(`⏸️ Outside operating hours (${hour}:00), waiting for 7 AM...`);
  }
}

module.exports = {
  startScheduledTasks,
  trackConsumption,
  generateDailySummary
};