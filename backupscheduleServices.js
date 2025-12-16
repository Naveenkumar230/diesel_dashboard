/**
 * Scheduler Service - PRODUCTION READY TIME-VALIDATED TRACKING
 * * FINAL VERSION: Handles all edge cases including partial recovery
 * - Tracks pending changes across multiple readings
 * - Records consumption ONLY when level stabilizes low for 3+ readings
 * - Filters noise including partial recovery scenarios
 * - Detects refills accurately
 */

const cron = require('node-cron');
const mongoose = require('mongoose');
const { DieselConsumption, DailySummary, ElectricalReading } = require('../models/schemas');
const { getSystemData } = require('./plcService');
const { sendDailySummary } = require('./emailService');

// ============================================================
// CONFIGURATION
// ============================================================
const DG_RUNNING_THRESHOLD = 5; // kW
const NOISE_THRESHOLD = 2; // Changes < 2L might be noise
const REFILL_THRESHOLD = 20; // Changes > 20L are refills
const TRACKING_INTERVAL = 5; // Track every 5 minutes
const STABILITY_REQUIRED = 3; // Readings needed to confirm change (15 minutes)
const RECOVERY_THRESHOLD = 0.5; // Allow 0.5L recovery without invalidating consumption
const MAX_CONSUMPTION_PER_HOUR = 25;
const MAX_NOISE_WHEN_OFF = 2; // ✅ NEW: Ignore consumption < 2L when DG is OFF

// ============================================================
// STATE VARIABLES
// ============================================================
let dayStartLevels = null;
let lastSavedLevels = { dg1: null, dg2: null, dg3: null, total: null };
let lastTrackingDate = null;
let isSchedulerReady = false;

// Pending changes tracking
let pendingChanges = {
  dg1: { level: null, count: 0, accumulated: 0, originalLevel: null },
  dg2: { level: null, count: 0, accumulated: 0, originalLevel: null },
  dg3: { level: null, count: 0, accumulated: 0, originalLevel: null }
};

function isAnyDGRunning(electricalData) {
    const dg1Power = electricalData?.dg1?.activePower || 0;
    const dg2Power = electricalData?.dg2?.activePower || 0;
    const dg3Power = electricalData?.dg3?.activePower || 0;
    
    // Check if ANY DG has power > threshold
    const anyRunning = (dg1Power > DG_RUNNING_THRESHOLD) || 
                       (dg2Power > DG_RUNNING_THRESHOLD) || 
                       (dg3Power > DG_RUNNING_THRESHOLD);
    
    if (anyRunning) {
        console.log(`🟢 GROUP RUNNING: DG1=${dg1Power.toFixed(1)}kW, DG2=${dg2Power.toFixed(1)}kW, DG3=${dg3Power.toFixed(1)}kW`);
    }
    
    return anyRunning;
}

/**
 * ✅ Alternative: Check if ALL DGs are running (stricter)
 * Use this if you want to ensure all 3 are confirmed running
 */
function areAllDGsRunning(electricalData) {
    const dg1Power = electricalData?.dg1?.activePower || 0;
    const dg2Power = electricalData?.dg2?.activePower || 0;
    const dg3Power = electricalData?.dg3?.activePower || 0;
    
    const allRunning = (dg1Power > DG_RUNNING_THRESHOLD) && 
                       (dg2Power > DG_RUNNING_THRESHOLD) && 
                       (dg3Power > DG_RUNNING_THRESHOLD);
    
    if (allRunning) {
        console.log(`🟢 ALL 3 DGs RUNNING: DG1=${dg1Power.toFixed(1)}kW, DG2=${dg2Power.toFixed(1)}kW, DG3=${dg3Power.toFixed(1)}kW`);
    } else if (dg1Power > 0 || dg2Power > 0 || dg3Power > 0) {
        console.log(`⚠️ PARTIAL RUNNING: DG1=${dg1Power.toFixed(1)}kW, DG2=${dg2Power.toFixed(1)}kW, DG3=${dg3Power.toFixed(1)}kW`);
    }
    
    return allRunning;
}


// ============================================================
// INITIALIZE DAY START LEVELS
// ============================================================
async function initializeDayStartLevels() {
  try {
    if (mongoose.connection.readyState !== 1) return false;

    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    if (dayStartLevels && dayStartLevels.date === today) return true;

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
      return true;
    }
    return false;
  } catch (err) {
    console.error('❌ Error initializing start levels:', err.message);
    return false;
  }
}

// ============================================================
// ✅ PRODUCTION-READY TIME-VALIDATED CONSUMPTION PROCESSING
// ============================================================
// ============================================================
// ✅ FIXED processLevelChange - Validates Net Change
// Replace your existing processLevelChange function with this
// ============================================================

function processLevelChange(dgKey, currentLevel, lastLevel, dgName, groupIsRunning) {
  let consumption = 0;
  let refill = 0;
  let newReferenceLevel = lastLevel;
  
  const diff = currentLevel - lastLevel;
  const pending = pendingChanges[dgKey];

  // 1. REFILL DETECTION (Immediate)
  if (diff > REFILL_THRESHOLD) {
    refill = diff;
    
    if (pending.accumulated > NOISE_THRESHOLD && pending.count >= 2) {
        consumption = pending.accumulated;
        console.log(`✅ Auto-confirmed ${consumption.toFixed(1)}L before refill`);
    }
    
    newReferenceLevel = currentLevel;
    pending.level = null;
    pending.count = 0;
    pending.accumulated = 0;
    pending.originalLevel = null;
    return { consumption, refill, newReferenceLevel };
  }

  // 2. CHECK FOR RECOVERY FROM PENDING DROP
  if (pending.level !== null && pending.originalLevel !== null) {
    const recoveryFromLowest = currentLevel - pending.level;
    
    // If recovering significantly, it was noise
    if (recoveryFromLowest > RECOVERY_THRESHOLD) {
      console.log(`🔇 ${dgName} PARTIAL RECOVERY: ${pending.level.toFixed(1)}→${currentLevel.toFixed(1)}L - Invalidating drop`);
      pending.level = null;
      pending.count = 0;
      pending.accumulated = 0;
      pending.originalLevel = null;
      return { consumption, refill, newReferenceLevel };
    }
  }

  // 3. LEVEL STABLE (Check if pending becomes confirmed)
  if (Math.abs(diff) < 0.5) {
    if (pending.level !== null) {
      pending.count++;
      console.log(`⏳ ${dgName} Stability check ${pending.count}/${STABILITY_REQUIRED}: Level stable at ${currentLevel.toFixed(1)}L`);
      
      // CONFIRM consumption when stability threshold reached
      if (pending.count >= STABILITY_REQUIRED) {
        consumption = pending.accumulated;
        
        // ✅ CRITICAL FIX: Validate NET CHANGE
        // Calculate actual net drop from original level to current level
        const netDrop = pending.originalLevel - currentLevel;
        
        console.log(`📊 ${dgName} Validation: Original=${pending.originalLevel.toFixed(1)}L, Current=${currentLevel.toFixed(1)}L, NetDrop=${netDrop.toFixed(1)}L, Accumulated=${consumption.toFixed(1)}L`);
        
        // If net drop is less than 50% of accumulated consumption, it's noise
        if (netDrop < consumption * 0.5) {
            console.log(`🔇 ${dgName} NET CHANGE TOO SMALL: ${netDrop.toFixed(1)}L vs ${consumption.toFixed(1)}L accumulated - NOISE`);
            consumption = 0;
            pending.level = null;
            pending.count = 0;
            pending.accumulated = 0;
            pending.originalLevel = null;
            return { consumption, refill, newReferenceLevel };
        }
        
        newReferenceLevel = currentLevel;
        console.log(`✅ ${dgName} CONFIRMED CONSUMPTION: ${consumption.toFixed(1)}L (Net drop validated)`);
        
        // Rate Validation
        const timeElapsed = pending.count * TRACKING_INTERVAL / 60; // hours
        const consumptionRate = consumption / (timeElapsed || 1);
        
        if (consumptionRate > MAX_CONSUMPTION_PER_HOUR) {
            console.log(`⚠️ ${dgName} Rate too high (${consumptionRate.toFixed(1)}L/h) - Anomaly`);
            consumption = 0; 
        }
        
        // ✅ GROUP RUNNING CHECK
        if (!groupIsRunning && consumption < MAX_NOISE_WHEN_OFF) {
            console.log(`🔇 ${dgName} FILTERED NOISE: ${consumption.toFixed(1)}L (GROUP WAS OFF)`);
            consumption = 0;
        }
        
        // Reset pending
        pending.level = null;
        pending.count = 0;
        pending.accumulated = 0;
        pending.originalLevel = null;
      }
    }
    return { consumption, refill, newReferenceLevel };
  }

  // 4. LEVEL DECREASED (Potential consumption)
  if (diff < -0.5) {
    if (pending.level === null) {
      // New potential consumption
      pending.level = currentLevel;
      pending.originalLevel = lastLevel;
      pending.count = 1;
      pending.accumulated = Math.abs(diff);
      console.log(`🔍 ${dgName} Potential consumption: ${Math.abs(diff).toFixed(1)}L (from ${lastLevel.toFixed(1)}L to ${currentLevel.toFixed(1)}L)`);
    } else {
      // Continuing drop
      pending.accumulated += Math.abs(diff);
      pending.count++;
      pending.level = currentLevel;
      console.log(`🔍 ${dgName} Accumulating: ${pending.accumulated.toFixed(1)}L (${pending.count}/${STABILITY_REQUIRED}) - Level now ${currentLevel.toFixed(1)}L`);
      
      // Auto-confirm if sustained drop matches duration
      if (pending.count >= STABILITY_REQUIRED) {
        consumption = pending.accumulated;
        
        // ✅ CRITICAL FIX: Validate NET CHANGE
        const netDrop = pending.originalLevel - currentLevel;
        
        console.log(`📊 ${dgName} Validation: Original=${pending.originalLevel.toFixed(1)}L, Current=${currentLevel.toFixed(1)}L, NetDrop=${netDrop.toFixed(1)}L, Accumulated=${consumption.toFixed(1)}L`);
        
        // If net drop is less than 50% of accumulated consumption, it's noise
        if (netDrop < consumption * 0.5) {
            console.log(`🔇 ${dgName} NET CHANGE TOO SMALL: ${netDrop.toFixed(1)}L vs ${consumption.toFixed(1)}L accumulated - NOISE`);
            consumption = 0;
            pending.level = null;
            pending.count = 0;
            pending.accumulated = 0;
            pending.originalLevel = null;
            return { consumption, refill, newReferenceLevel };
        }
        
        newReferenceLevel = currentLevel;
        console.log(`✅ ${dgName} CONFIRMED (Sustained Drop): ${consumption.toFixed(1)}L (Net drop validated)`);
        
        // ✅ GROUP RUNNING CHECK
        if (!groupIsRunning && consumption < MAX_NOISE_WHEN_OFF) {
            console.log(`🔇 ${dgName} FILTERED NOISE: ${consumption.toFixed(1)}L (GROUP WAS OFF)`);
            consumption = 0;
        }
        
        pending.level = null;
        pending.count = 0;
        pending.accumulated = 0;
        pending.originalLevel = null;
      }
    }
    return { consumption, refill, newReferenceLevel };
  }

  // 5. LEVEL INCREASED (Check for noise)
  if (diff > 0.5 && diff <= REFILL_THRESHOLD) {
    if (pending.level !== null) {
      const totalRecovery = currentLevel - pending.level;
      if (totalRecovery > RECOVERY_THRESHOLD) {
        console.log(`🔇 ${dgName} NOISE: Level recovered from ${pending.level.toFixed(1)}L to ${currentLevel.toFixed(1)}L. Resetting pending.`);
        pending.level = null;
        pending.count = 0;
        pending.accumulated = 0;
        pending.originalLevel = null;
      }
    } else {
      console.log(`🔇 ${dgName} Upward noise: +${diff.toFixed(1)}L (${lastLevel.toFixed(1)}L → ${currentLevel.toFixed(1)}L) - filtered`);
    }
    return { consumption, refill, newReferenceLevel };
  }

  return { consumption, refill, newReferenceLevel };
}

// ============================================================
// ✅ MAIN 24/7 TRACKING FUNCTION
// ============================================================
// ============================================================
// ✅ COMPLETE trackConsumption FUNCTION WITH GROUP RUNNING
// Replace your existing trackConsumption function with this
// ============================================================

async function trackConsumption() {
  try {
    if (mongoose.connection.readyState !== 1) return;

    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Day change logic
    if (lastTrackingDate && lastTrackingDate !== today) {
      await generateDailySummary(lastTrackingDate);
      dayStartLevels = null;
      lastSavedLevels = { dg1: null, dg2: null, dg3: null, total: null };
      Object.keys(pendingChanges).forEach(key => {
        pendingChanges[key] = { level: null, count: 0, accumulated: 0, originalLevel: null };
      });
      await initializeDayStartLevels();
    }
    lastTrackingDate = today;

    const systemData = getSystemData();
    if (!systemData || !systemData.lastUpdate) return;

    // First Run Initialization
    if (!dayStartLevels || dayStartLevels.date !== today) {
      await initializeDayStartLevels();
    }
    if (lastSavedLevels.dg1 === null) {
      lastSavedLevels = {
        dg1: systemData.dg1,
        dg2: systemData.dg2,
        dg3: systemData.dg3,
        total: systemData.total
      };
    }

    const currentData = {
      dg1: systemData.dg1,
      dg2: systemData.dg2,
      dg3: systemData.dg3,
      total: systemData.total,
      electrical: systemData.electrical
    };

    // ============================================================
    // ✅ NEW: CHECK IF ANY DG IN THE GROUP IS RUNNING
    // This implements the "All 3 DGs run together" concept
    // ============================================================
    const groupIsRunning = isAnyDGRunning(currentData.electrical);
    
    // Log group status
    if (groupIsRunning) {
      const dg1Power = currentData.electrical?.dg1?.activePower || 0;
      const dg2Power = currentData.electrical?.dg2?.activePower || 0;
      const dg3Power = currentData.electrical?.dg3?.activePower || 0;
      console.log(`🟢 DG GROUP RUNNING: DG1=${dg1Power.toFixed(1)}kW, DG2=${dg2Power.toFixed(1)}kW, DG3=${dg3Power.toFixed(1)}kW`);
    }

    // ============================================================
    // PROCESS CONSUMPTION WITH GROUP RUNNING STATUS
    // All 3 DGs use the SAME groupIsRunning status
    // ============================================================
    let consumption = { dg1: 0, dg2: 0, dg3: 0, total: 0 };
    let refills = { dg1: 0, dg2: 0, dg3: 0 };

    // ✅ Pass groupIsRunning to all DGs (synchronized behavior)
    const res1 = processLevelChange('dg1', currentData.dg1, lastSavedLevels.dg1, 'DG1', groupIsRunning);
    const res2 = processLevelChange('dg2', currentData.dg2, lastSavedLevels.dg2, 'DG2', groupIsRunning);
    const res3 = processLevelChange('dg3', currentData.dg3, lastSavedLevels.dg3, 'DG3', groupIsRunning);

    consumption.dg1 = res1.consumption; 
    refills.dg1 = res1.refill;
    consumption.dg2 = res2.consumption; 
    refills.dg2 = res2.refill;
    consumption.dg3 = res3.consumption; 
    refills.dg3 = res3.refill;
    consumption.total = consumption.dg1 + consumption.dg2 + consumption.dg3;

    // ============================================================
    // Individual Running Status (for display/logging purposes)
    // ============================================================
    const isRunning = {
      dg1: (currentData.electrical?.dg1?.activePower || 0) > DG_RUNNING_THRESHOLD,
      dg2: (currentData.electrical?.dg2?.activePower || 0) > DG_RUNNING_THRESHOLD,
      dg3: (currentData.electrical?.dg3?.activePower || 0) > DG_RUNNING_THRESHOLD
    };

    // ============================================================
    // Save to Database
    // ============================================================
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
      minute: minute
    });

    await record.save();
    
    // ============================================================
    // Update Reference Levels
    // ============================================================
    lastSavedLevels = {
      dg1: currentData.dg1,
      dg2: currentData.dg2,
      dg3: currentData.dg3,
      total: currentData.total
    };

    // ============================================================
    // Console Logging
    // ============================================================
    const time = now.toLocaleTimeString('en-IN', { hour12: false });
    let logMsg = `⚪ ${time} | DG1=${currentData.dg1.toFixed(1)}L DG2=${currentData.dg2.toFixed(1)}L DG3=${currentData.dg3.toFixed(1)}L`;
    
    if (consumption.total > 0) {
      logMsg += ` | 🔥 Consumed: ${consumption.total.toFixed(1)}L`;
      logMsg += ` (DG1: ${consumption.dg1.toFixed(1)}L, DG2: ${consumption.dg2.toFixed(1)}L, DG3: ${consumption.dg3.toFixed(1)}L)`;
    }
    
    const totalRefilled = refills.dg1 + refills.dg2 + refills.dg3;
    if (totalRefilled > 0) {
      logMsg += ` | ⛽ Refill: ${totalRefilled.toFixed(1)}L`;
      if (refills.dg1 > 0) logMsg += ` (DG1: ${refills.dg1.toFixed(1)}L)`;
      if (refills.dg2 > 0) logMsg += ` (DG2: ${refills.dg2.toFixed(1)}L)`;
      if (refills.dg3 > 0) logMsg += ` (DG3: ${refills.dg3.toFixed(1)}L)`;
    }
    
    if (groupIsRunning) {
      logMsg += ` | 🟢 GROUP ON`;
    }
    
    console.log(logMsg);

    // ============================================================
    // Save Electrical Data
    // ============================================================
    await saveElectricalData(currentData.electrical, now);

  } catch (err) {
    console.error('❌ Error tracking:', err.message);
  }
}

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
        voltageR: data.voltageR || 0, voltageY: data.voltageY || 0, voltageB: data.voltageB || 0,
        currentR: data.currentR || 0, currentY: data.currentY || 0, currentB: data.currentB || 0,
        frequency: data.frequency || 0, powerFactor: data.powerFactor || 0,
        activePower: data.activePower || 0, reactivePower: data.reactivePower || 0,
        energyMeter: data.energyMeter || 0, runningHours: data.runningHours || 0,
        windingTemp: data.windingTemp || 0,
        date: dateStr, hour: hour
      });
      await electricalRecord.save();
    }
  } catch (err) { console.error('❌ Electrical save error:', err.message); }
}

async function generateDailySummary(summaryDate = null) {
  // (Summary logic kept consistent with your original functionality)
  try {
    if (mongoose.connection.readyState !== 1) return;
    const targetDate = summaryDate || new Date().toISOString().split('T')[0];
    const records = await DieselConsumption.find({ date: targetDate }).sort({ timestamp: 1 });
    if (records.length === 0) return;

    const start = records[0];
    const end = records[records.length - 1];
    
    const summary = new DailySummary({
      date: targetDate,
      dg1: { startLevel: start.dg1.level, endLevel: end.dg1.level, totalConsumption: records.reduce((s,r)=>s+(r.dg1.consumption||0),0) },
      dg2: { startLevel: start.dg2.level, endLevel: end.dg2.level, totalConsumption: records.reduce((s,r)=>s+(r.dg2.consumption||0),0) },
      dg3: { startLevel: start.dg3.level, endLevel: end.dg3.level, totalConsumption: records.reduce((s,r)=>s+(r.dg3.consumption||0),0) },
      total: { startLevel: start.total.level, endLevel: end.total.level, totalConsumption: records.reduce((s,r)=>s+(r.total.consumption||0),0) }
    });
    
    await summary.save();
    console.log(`✅ Daily Summary Generated for ${targetDate}`);
  } catch (err) { console.error('Summary Error:', err.message); }
}

function startScheduledTasks() {
  console.log('⏰ Scheduler Service Started');
  
  // Track consumption every 5 minutes
  cron.schedule(`*/${TRACKING_INTERVAL} * * * *`, () => {
    console.log('\n⏰ Tracking cycle...');
    trackConsumption();
  });

  // Daily Summary at 11:59 PM
  cron.schedule('59 23 * * *', () => {
    generateDailySummary();
  });
  
  // Initialize tracking
  setTimeout(trackConsumption, 15000); 
}

module.exports = { startScheduledTasks };