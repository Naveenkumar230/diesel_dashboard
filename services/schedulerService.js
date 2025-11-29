/**
 * Scheduler Service - 24/7 TRACKING - FIXED LOGIC
 * * FIXES:
 * 1. Fixed "Ratchet Effect": Upward noise no longer resets the baseline.
 * 2. Implemented "Sticky Reference": Logic now compares current level against 
 * the last VALID level, not just the previous reading.
 */

const cron = require('node-cron');
const mongoose = require('mongoose');
const { DieselConsumption, DailySummary, ElectricalReading } = require('../models/schemas');
const { getSystemData } = require('./plcService');
const { sendDailySummary } = require('./emailService');

const DG_RUNNING_THRESHOLD = 5; // kW
const NOISE_THRESHOLD = 1.0; // 1.0L Threshold
const REFILL_THRESHOLD = 20;
const TRACKING_INTERVAL = 5; // Track every 5 minutes

let dayStartLevels = null;
let lastSavedLevels = { dg1: null, dg2: null, dg3: null, total: null };
let lastTrackingDate = null;
let isSchedulerReady = false;

// ============================================================
// INITIALIZE DAY START LEVELS
// ============================================================
async function initializeDayStartLevels() {
  try {
    if (mongoose.connection.readyState !== 1) {
      console.log('⏳ MongoDB not connected yet, skipping initialization...');
      return false;
    }

    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    if (dayStartLevels && dayStartLevels.date === today) {
      return true;
    }

    const todayRecords = await DieselConsumption.findOne({ date: today })
      .sort({ timestamp: 1 })
      .limit(1)
      .maxTimeMS(5000);
    
    if (todayRecords) {
      dayStartLevels = {
        dg1: todayRecords.dg1?.level || 0,
        dg2: todayRecords.dg2?.level || 0,
        dg3: todayRecords.dg3?.level || 0,
        total: todayRecords.total?.level || 0,
        date: today
      };
      console.log('✅ Day start levels from DB:', dayStartLevels);
      return true;
    }

    const systemData = getSystemData();
    
    if (systemData && systemData.lastUpdate) {
      dayStartLevels = {
        dg1: systemData.dg1 || 0,
        dg2: systemData.dg2 || 0,
        dg3: systemData.dg3 || 0,
        total: systemData.total || 0,
        date: today
      };
      console.log('✅ Day start levels from PLC:', dayStartLevels);
      return true;
    } else {
      console.log('⚠️ No system data available yet');
      return false;
    }
  } catch (err) {
    console.error('❌ Error initializing day start levels:', err.message);
    return false;
  }
}

// ============================================================
// ✅ MAIN 24/7 TRACKING FUNCTION
// ============================================================
async function trackConsumption() {
  try {
    if (mongoose.connection.readyState !== 1) {
      console.log('⏳ MongoDB not ready, skipping tracking...');
      return;
    }

    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Check if day changed
    if (lastTrackingDate && lastTrackingDate !== today) {
      console.log(`📅 Day changed: ${lastTrackingDate} → ${today}`);
      await generateDailySummary(lastTrackingDate);
      dayStartLevels = null;
      lastSavedLevels = { dg1: null, dg2: null, dg3: null, total: null };
      await initializeDayStartLevels();
    }
    lastTrackingDate = today;

    const systemData = getSystemData();
    
    if (!systemData || !systemData.lastUpdate) {
      console.log('⚠️ No system data available');
      return;
    }

    // Initialize day start levels if needed
    if (!dayStartLevels || dayStartLevels.date !== today) {
      const initialized = await initializeDayStartLevels();
      if (!initialized) {
        dayStartLevels = {
          dg1: systemData.dg1,
          dg2: systemData.dg2,
          dg3: systemData.dg3,
          total: systemData.total,
          date: today
        };
      }
    }

    // Initialize last saved levels on first run
    if (lastSavedLevels.dg1 === null) {
      lastSavedLevels = {
        dg1: systemData.dg1,
        dg2: systemData.dg2,
        dg3: systemData.dg3,
        total: systemData.total
      };
      console.log('🔄 Initialized last saved levels');
    }

    const currentData = {
      dg1: systemData.dg1,
      dg2: systemData.dg2,
      dg3: systemData.dg3,
      total: systemData.total,
      electrical: systemData.electrical
    };

    // ============================================================
    // ✅ CALCULATE CONSUMPTION WITH STICKY LOGIC
    // ============================================================
    let consumption = { dg1: 0, dg2: 0, dg3: 0, total: 0 };
    let refills = { dg1: 0, dg2: 0, dg3: 0 };
    let noiseFiltered = [];
    
    // Helper to calculate specific DG
    const processDG = (key, currentVal, lastVal, dgName) => {
        let cons = 0;
        let ref = 0;
        let newReferenceLevel = lastVal; // Default: Keep old level if noise
        
        const diff = currentVal - lastVal;

        if (diff > REFILL_THRESHOLD) {
            // REFILL DETECTED
            ref = diff;
            newReferenceLevel = currentVal; // Update reference
            console.log(`⛽ ${dgName} REFILL: +${diff.toFixed(1)}L`);
        } else if (diff < -NOISE_THRESHOLD) {
            // CONSUMPTION DETECTED
            cons = Math.abs(diff);
            newReferenceLevel = currentVal; // Update reference
        } else {
            // NOISE (Small up or small down)
            // DO NOT update newReferenceLevel.
            // This allows slow usage (0.1L per read) to accumulate until it hits 1.0L
            // and prevents upward slosh from resetting the baseline.
            if (Math.abs(diff) > 0.05) {
                noiseFiltered.push(`${dgName}: ${diff.toFixed(2)}L`);
            }
        }
        return { cons, ref, newReferenceLevel };
    };

    // Process all DGs
    const res1 = processDG('dg1', currentData.dg1, lastSavedLevels.dg1, 'DG1');
    const res2 = processDG('dg2', currentData.dg2, lastSavedLevels.dg2, 'DG2');
    const res3 = processDG('dg3', currentData.dg3, lastSavedLevels.dg3, 'DG3');

    consumption.dg1 = res1.cons; refills.dg1 = res1.ref;
    consumption.dg2 = res2.cons; refills.dg2 = res2.ref;
    consumption.dg3 = res3.cons; refills.dg3 = res3.ref;
    
    consumption.total = consumption.dg1 + consumption.dg2 + consumption.dg3;

    // Log noise filtering
    if (noiseFiltered.length > 0) {
      console.log(`🔇 Noise filtered (Baseline Maintained): ${noiseFiltered.join(', ')}`);
    }

    // ============================================================
    // ✅ RUNNING STATUS
    // ============================================================
    const isRunning = {
      dg1: (currentData.electrical?.dg1?.activePower || 0) > DG_RUNNING_THRESHOLD,
      dg2: (currentData.electrical?.dg2?.activePower || 0) > DG_RUNNING_THRESHOLD,
      dg3: (currentData.electrical?.dg3?.activePower || 0) > DG_RUNNING_THRESHOLD
    };

    // ============================================================
    // ✅ SAVE TO MONGODB
    // ============================================================
    const record = new DieselConsumption({
      timestamp: now,
      dg1: { level: currentData.dg1, consumption: consumption.dg1, isRunning: isRunning.dg1 },
      dg2: { level: currentData.dg2, consumption: consumption.dg2, isRunning: isRunning.dg2 },
      dg3: { level: currentData.dg3, consumption: consumption.dg3, isRunning: isRunning.dg3 },
      total: { level: currentData.total, consumption: consumption.total },
      date: today,
      hour: hour,
      minute: minute
    });

    await record.save();
    
    // Update last saved levels using the STICKY references
    lastSavedLevels = {
      dg1: res1.newReferenceLevel,
      dg2: res2.newReferenceLevel,
      dg3: res3.newReferenceLevel,
      total: currentData.total
    };

    // ============================================================
    // ✅ CONSOLE OUTPUT
    // ============================================================
    const time = now.toLocaleTimeString('en-IN');
    const status = Object.values(isRunning).some(v => v) ? '🟢' : '⚪';
    
    let logMsg = `${status} ${time} | DG1=${currentData.dg1.toFixed(1)}L DG2=${currentData.dg2.toFixed(1)}L DG3=${currentData.dg3.toFixed(1)}L`;
    
    if (consumption.total > 0) {
      logMsg += ` | 🔥 Used: ${consumption.total.toFixed(1)}L`;
    }
    if (refills.dg1 > 0 || refills.dg2 > 0 || refills.dg3 > 0) {
      logMsg += ` | ⛽ REFILL DETECTED!`;
    }
    
    console.log(logMsg);

    // Save electrical data
    await saveElectricalData(currentData.electrical, now);

  } catch (err) {
    console.error('❌ Error tracking:', err.message);
  }
}

// ============================================================
// SAVE ELECTRICAL DATA
// ============================================================
async function saveElectricalData(electricalData, timestamp) {
  try {
    if (mongoose.connection.readyState !== 1) return;

    const dateStr = timestamp.toISOString().split('T')[0];
    const hour = timestamp.getHours();

    for (const dgKey of ['dg1', 'dg2', 'dg3', 'dg4']) {
      const data = electricalData[dgKey];
      if (!data) continue;

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
  } catch (err) {
    console.error('❌ Error saving electrical:', err.message);
  }
}

// ============================================================
// GENERATE DAILY SUMMARY
// ============================================================
async function generateDailySummary(summaryDate = null) {
  try {
    if (mongoose.connection.readyState !== 1) {
      console.log('⚠️ MongoDB not ready, skipping summary');
      return;
    }

    const targetDate = summaryDate || new Date().toISOString().split('T')[0];
    const yesterday = new Date(new Date(targetDate).getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    console.log(`📊 Generating summary for: ${targetDate}`);

    const todayRecords = await DieselConsumption.find({ date: targetDate })
      .sort({ timestamp: 1 })
      .maxTimeMS(10000);

    if (todayRecords.length === 0) {
      console.log('⚠️ No records for summary date:', targetDate);
      return;
    }

    const startLevels = {
      dg1: todayRecords[0].dg1?.level || 0,
      dg2: todayRecords[0].dg2?.level || 0,
      dg3: todayRecords[0].dg3?.level || 0,
      total: todayRecords[0].total?.level || 0
    };

    const endLevels = {
      dg1: todayRecords[todayRecords.length - 1].dg1?.level || 0,
      dg2: todayRecords[todayRecords.length - 1].dg2?.level || 0,
      dg3: todayRecords[todayRecords.length - 1].dg3?.level || 0,
      total: todayRecords[todayRecords.length - 1].total?.level || 0
    };

    let totalConsumption = {
      dg1: todayRecords.reduce((sum, r) => sum + (r.dg1?.consumption || 0), 0),
      dg2: todayRecords.reduce((sum, r) => sum + (r.dg2?.consumption || 0), 0),
      dg3: todayRecords.reduce((sum, r) => sum + (r.dg3?.consumption || 0), 0)
    };
    totalConsumption.total = totalConsumption.dg1 + totalConsumption.dg2 + totalConsumption.dg3;

    const runningHours = {
      dg1: todayRecords.filter(r => r.dg1?.isRunning).length * (TRACKING_INTERVAL / 60),
      dg2: todayRecords.filter(r => r.dg2?.isRunning).length * (TRACKING_INTERVAL / 60),
      dg3: todayRecords.filter(r => r.dg3?.isRunning).length * (TRACKING_INTERVAL / 60)
    };

    const summary = new DailySummary({
      date: targetDate,
      dg1: {
        startLevel: startLevels.dg1,
        endLevel: endLevels.dg1,
        totalConsumption: totalConsumption.dg1,
        runningHours: runningHours.dg1
      },
      dg2: {
        startLevel: startLevels.dg2,
        endLevel: endLevels.dg2,
        totalConsumption: totalConsumption.dg2,
        runningHours: runningHours.dg2
      },
      dg3: {
        startLevel: startLevels.dg3,
        endLevel: endLevels.dg3,
        totalConsumption: totalConsumption.dg3,
        runningHours: runningHours.dg3
      },
      total: {
        startLevel: startLevels.total,
        endLevel: endLevels.total,
        totalConsumption: totalConsumption.total
      }
    });

    await summary.save();
    console.log(`📊 Summary saved: ${totalConsumption.total.toFixed(1)}L consumed`);

    const previousSummary = await DailySummary.findOne({ date: yesterday });
    await sendDailySummary(summary, previousSummary);

    console.log('📧 Daily summary email sent');

  } catch (err) {
    console.error('❌ Error generating summary:', err.message);
  }
}

// ============================================================
// ✅ START 24/7 SCHEDULER
// ============================================================
async function startScheduledTasks() {
  console.log('🕐 Initializing 24/7 scheduled tasks...');

  let waitAttempts = 0;
  while (mongoose.connection.readyState !== 1 && waitAttempts < 30) {
    console.log(`⏳ Waiting for MongoDB... (${waitAttempts + 1}/30)`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    waitAttempts++;
  }

  if (mongoose.connection.readyState !== 1) {
    console.log('⚠️ Starting scheduler without MongoDB (limited functionality)');
  } else {
    console.log('✅ MongoDB ready, starting full 24/7 scheduler');
  }

  const cronPattern = `*/${TRACKING_INTERVAL} * * * *`;
  
  cron.schedule(cronPattern, () => {
    console.log('\n⏰ Tracking cycle...');
    trackConsumption();
  }, {
    timezone: "Asia/Kolkata"
  });

  cron.schedule('59 23 * * *', () => {
    console.log('\n⏰ Generating daily summary...');
    generateDailySummary();
  }, {
    timezone: "Asia/Kolkata"
  });

  const now = new Date();
  
  console.log('✅ 24/7 Scheduler configured:');
  console.log(`   - Tracking: Every ${TRACKING_INTERVAL} minutes (24/7)`);
  console.log(`   - Noise threshold: ${NOISE_THRESHOLD}L`);
  console.log('   - Summary: 11:59 PM daily');
  console.log(`   - Current: ${now.toLocaleTimeString('en-IN')}`);

  if (mongoose.connection.readyState === 1) {
    setTimeout(async () => {
      await initializeDayStartLevels();
    }, 3000);
  }

  console.log('⏳ First reading in 15 seconds...');
  setTimeout(() => {
    trackConsumption();
  }, 15000);

  isSchedulerReady = true;
}

module.exports = {
  startScheduledTasks,
  trackConsumption,
  generateDailySummary
};