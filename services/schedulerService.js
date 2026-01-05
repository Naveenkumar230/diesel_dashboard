/**
 * Scheduler Service - PRODUCTION READY WITH INDUSTRIAL SENSOR VALIDATION
 * ✅ FIXES:
 * 1. Validates sensor readings before calculating consumption
 * 2. Detects and filters phantom consumption from bad sensors
 * 3. Uses group running status for better accuracy
 * 4. Validates net change to prevent noise accumulation
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
const REFILL_THRESHOLD = 25; // Changes > 25L are refills
const TRACKING_INTERVAL = 5; // Track every 5 minutes
const STABILITY_REQUIRED = 3; // Readings needed to confirm change (15 minutes)
const RECOVERY_THRESHOLD = 0.5; // Allow 0.5L recovery without invalidating consumption
const MAX_CONSUMPTION_PER_HOUR = 25;
const MAX_NOISE_WHEN_OFF = 2; // Ignore consumption < 2L when DG is OFF

// ✅ NEW: Sensor quality thresholds
const SENSOR_QUALITY_THRESHOLD = 50; // Minimum quality score (0-100)
const MAX_CHANGE_RATE_PER_MINUTE = 30; // Liters per minute (impossible rate detection)
const STALE_DATA_THRESHOLD_MINUTES = 2; // Data older than 2 minutes is stale

// ============================================================
// STATE VARIABLES
// ============================================================
let dayStartLevels = null;
let lastSavedLevels = { dg1: null, dg2: null, dg3: null, total: null };
let lastTrackingDate = null;
let lastTrackingTimestamps = { dg1: null, dg2: null, dg3: null }; // ✅ NEW: Track reading times

// Pending changes tracking
let pendingChanges = {
  dg1: { level: null, count: 0, accumulated: 0, originalLevel: null, quality: 'high' },
  dg2: { level: null, count: 0, accumulated: 0, originalLevel: null, quality: 'high' },
  dg3: { level: null, count: 0, accumulated: 0, originalLevel: null, quality: 'high' }
};

// ============================================================
// 🛡️ INDUSTRIAL SENSOR VALIDATION FUNCTIONS
// ============================================================

/**
 * Validates if a diesel level reading is trustworthy
 * Returns quality score: 0 (bad) to 100 (excellent)
 */
function validateSensorReading(currentLevel, previousLevel, timestamp, previousTimestamp) {
    let qualityScore = 100;
    const issues = [];

    // Check 1: Value range validation
    if (currentLevel < 0 || currentLevel > 600) {
        qualityScore = 0;
        issues.push('OUT_OF_RANGE');
        return { valid: false, score: qualityScore, issues, trustworthy: false };
    }

    // Check 2: Impossible change rate detection
    if (previousLevel !== null && previousTimestamp) {
        const timeDiffMinutes = (new Date(timestamp) - new Date(previousTimestamp)) / 60000;
        const levelChange = Math.abs(currentLevel - previousLevel);
        
        if (timeDiffMinutes > 0) {
            const changeRatePerMinute = levelChange / timeDiffMinutes;
            
            // If consumption > 30L/min = sensor glitch (impossible rate)
            if (changeRatePerMinute > MAX_CHANGE_RATE_PER_MINUTE && currentLevel < previousLevel) {
                qualityScore -= 60;
                issues.push(`IMPOSSIBLE_CONSUMPTION_RATE: ${changeRatePerMinute.toFixed(1)}L/min`);
            }
            
            // If refill > 100L/min = sensor glitch
            if (changeRatePerMinute > 100 && currentLevel > previousLevel) {
                qualityScore -= 60;
                issues.push(`IMPOSSIBLE_REFILL_RATE: ${changeRatePerMinute.toFixed(1)}L/min`);
            }
        }
    }

    // Check 3: Timestamp freshness (reading older than 2 minutes = stale)
    const ageMinutes = (Date.now() - new Date(timestamp)) / 60000;
    if (ageMinutes > STALE_DATA_THRESHOLD_MINUTES) {
        qualityScore -= 30;
        issues.push(`STALE_DATA: ${ageMinutes.toFixed(1)} minutes old`);
    }

    const trustworthy = qualityScore >= SENSOR_QUALITY_THRESHOLD;

    return {
        valid: qualityScore > 0,
        score: qualityScore,
        issues: issues,
        trustworthy: trustworthy
    };
}

/**
 * Checks if sensor reading has suspicious patterns
 */
function detectSensorAnomaly(currentLevel, previousLevel, dgKey) {
    // Pattern 1: Sudden spike down then recovery (classic sensor glitch)
    const pending = pendingChanges[dgKey];
    if (pending.level !== null && pending.originalLevel !== null) {
        const drop = pending.originalLevel - pending.level;
        const recovery = currentLevel - pending.level;
        
        // If dropped then recovered > 50%, it's a sensor glitch
        if (drop > 2 && recovery > drop * 0.5) {
            return {
                isAnomaly: true,
                type: 'SPIKE_RECOVERY',
                description: `Dropped ${drop.toFixed(1)}L then recovered ${recovery.toFixed(1)}L`
            };
        }
    }

    // Pattern 2: Zigzag pattern (up/down/up/down)
    // This would require a buffer of last N readings - implement if needed

    return {
        isAnomaly: false,
        type: null,
        description: null
    };
}

// ============================================================
// GROUP RUNNING STATUS DETECTION
// ============================================================

function isAnyDGRunning(electricalData) {
    const dg1Power = electricalData?.dg1?.activePower || 0;
    const dg2Power = electricalData?.dg2?.activePower || 0;
    const dg3Power = electricalData?.dg3?.activePower || 0;
    
    const anyRunning = (dg1Power > DG_RUNNING_THRESHOLD) || 
                       (dg2Power > DG_RUNNING_THRESHOLD) || 
                       (dg3Power > DG_RUNNING_THRESHOLD);
    
    if (anyRunning) {
        console.log(`🟢 GROUP RUNNING: DG1=${dg1Power.toFixed(1)}kW, DG2=${dg2Power.toFixed(1)}kW, DG3=${dg3Power.toFixed(1)}kW`);
    }
    
    return anyRunning;
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
// ✅ FIXED processLevelChange - WITH SENSOR VALIDATION
// ============================================================

function processLevelChange(dgKey, currentLevel, lastLevel, dgName, groupIsRunning, timestamp) {
  let consumption = 0;
  let refill = 0;
  let newReferenceLevel = lastLevel;
  
  const diff = currentLevel - lastLevel;
  const pending = pendingChanges[dgKey];

  // ============================================================
  // 🛡️ STEP 1: VALIDATE SENSOR READING QUALITY
  // ============================================================
  const lastTimestamp = lastTrackingTimestamps[dgKey] || new Date(Date.now() - 300000); // 5 min ago default
  const sensorQuality = validateSensorReading(
      currentLevel, 
      lastLevel, 
      timestamp, 
      lastTimestamp
  );

  // If sensor reading is BAD, reject this reading
  if (!sensorQuality.trustworthy) {
      console.error(`🚨 ${dgName} SENSOR FAILURE (Score: ${sensorQuality.score}/100)`);
      sensorQuality.issues.forEach(issue => console.error(`   - ${issue}`));
      
      // Reset pending if sensor is bad
      if (pending.level !== null) {
          console.warn(`⚠️ ${dgName} Resetting pending consumption due to sensor failure`);
          pending.level = null;
          pending.count = 0;
          pending.accumulated = 0;
          pending.originalLevel = null;
      }
      
      return { 
          consumption: 0, 
          refill: 0, 
          newReferenceLevel: lastLevel, // Keep old reference
          sensorQuality: 'bad'
      };
  }

  // ============================================================
  // 🛡️ STEP 2: DETECT SENSOR ANOMALIES (Spike patterns)
  // ============================================================
  const anomaly = detectSensorAnomaly(currentLevel, lastLevel, dgKey);
  if (anomaly.isAnomaly) {
      console.warn(`🔇 ${dgName} SENSOR ANOMALY DETECTED: ${anomaly.type} - ${anomaly.description}`);
      
      // Reset pending
      pending.level = null;
      pending.count = 0;
      pending.accumulated = 0;
      pending.originalLevel = null;
      
      return { 
          consumption: 0, 
          refill: 0, 
          newReferenceLevel: lastLevel,
          sensorQuality: 'anomaly'
      };
  }

  // ============================================================
  // STEP 3: REFILL DETECTION (Immediate)
  // ============================================================
  if (diff > REFILL_THRESHOLD) {
    refill = diff;
    
    // Auto-confirm any pending consumption before refill
    if (pending.accumulated > NOISE_THRESHOLD && pending.count >= 2) {
        consumption = pending.accumulated;
        console.log(`✅ ${dgName} Auto-confirmed ${consumption.toFixed(1)}L before refill`);
    }
    
    newReferenceLevel = currentLevel;
    pending.level = null;
    pending.count = 0;
    pending.accumulated = 0;
    pending.originalLevel = null;
    pending.quality = 'high';
    
    return { consumption, refill, newReferenceLevel, sensorQuality: 'high' };
  }

  // ============================================================
  // STEP 4: CHECK FOR RECOVERY FROM PENDING DROP (Noise filter)
  // ============================================================
  if (pending.level !== null && pending.originalLevel !== null) {
    const recoveryFromLowest = currentLevel - pending.level;
    
    // If recovering significantly, it was noise
    if (recoveryFromLowest > RECOVERY_THRESHOLD) {
      console.log(`🔇 ${dgName} PARTIAL RECOVERY: ${pending.level.toFixed(1)}→${currentLevel.toFixed(1)}L - Invalidating ${pending.accumulated.toFixed(1)}L drop`);
      pending.level = null;
      pending.count = 0;
      pending.accumulated = 0;
      pending.originalLevel = null;
      return { consumption, refill, newReferenceLevel, sensorQuality: 'recovered' };
    }
  }

  // ============================================================
  // STEP 5: LEVEL STABLE (Check if pending becomes confirmed)
  // ============================================================
  if (Math.abs(diff) < 0.5) {
    if (pending.level !== null) {
      pending.count++;
      console.log(`⏳ ${dgName} Stability check ${pending.count}/${STABILITY_REQUIRED}: Level stable at ${currentLevel.toFixed(1)}L`);
      
      // CONFIRM consumption when stability threshold reached
      if (pending.count >= STABILITY_REQUIRED) {
        consumption = pending.accumulated;
        
        // ✅ CRITICAL FIX: Validate NET CHANGE
        const netDrop = pending.originalLevel - currentLevel;
        
        console.log(`📊 ${dgName} Validation:`);
        console.log(`   Original: ${pending.originalLevel.toFixed(1)}L`);
        console.log(`   Current: ${currentLevel.toFixed(1)}L`);
        console.log(`   Net Drop: ${netDrop.toFixed(1)}L`);
        console.log(`   Accumulated: ${consumption.toFixed(1)}L`);
        
        // If net drop is less than 70% of accumulated consumption, it's noise
        if (netDrop < consumption * 0.7) {
            console.log(`🔇 ${dgName} NET CHANGE MISMATCH: ${netDrop.toFixed(1)}L vs ${consumption.toFixed(1)}L accumulated - FILTERED`);
            consumption = 0;
            pending.level = null;
            pending.count = 0;
            pending.accumulated = 0;
            pending.originalLevel = null;
            return { consumption, refill, newReferenceLevel, sensorQuality: 'noise_filtered' };
        }
        
        newReferenceLevel = currentLevel;
        console.log(`✅ ${dgName} CONFIRMED CONSUMPTION: ${consumption.toFixed(1)}L (Net drop validated)`);
        
        // Rate Validation
        const timeElapsed = pending.count * TRACKING_INTERVAL / 60; // hours
        const consumptionRate = consumption / (timeElapsed || 1);
        
        if (consumptionRate > MAX_CONSUMPTION_PER_HOUR) {
            console.log(`⚠️ ${dgName} Rate too high (${consumptionRate.toFixed(1)}L/h) - FILTERED`);
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
    return { consumption, refill, newReferenceLevel, sensorQuality: 'stable' };
  }

  // ============================================================
  // STEP 6: LEVEL DECREASED (Potential consumption)
  // ============================================================
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
      const incrementalDrop = Math.abs(diff);
      pending.accumulated += incrementalDrop;
      pending.count++;
      pending.level = currentLevel;
      console.log(`🔍 ${dgName} Accumulating: ${pending.accumulated.toFixed(1)}L (${pending.count}/${STABILITY_REQUIRED}) - Level now ${currentLevel.toFixed(1)}L`);
      
      // Auto-confirm if sustained drop
      if (pending.count >= STABILITY_REQUIRED) {
        consumption = pending.accumulated;
        
        // ✅ VALIDATE NET CHANGE
        const netDrop = pending.originalLevel - currentLevel;
        
        console.log(`📊 ${dgName} Sustained Drop Validation:`);
        console.log(`   Original: ${pending.originalLevel.toFixed(1)}L`);
        console.log(`   Current: ${currentLevel.toFixed(1)}L`);
        console.log(`   Net Drop: ${netDrop.toFixed(1)}L`);
        console.log(`   Accumulated: ${consumption.toFixed(1)}L`);
        
        if (netDrop < consumption * 0.7) {
            console.log(`🔇 ${dgName} NET CHANGE MISMATCH: ${netDrop.toFixed(1)}L vs ${consumption.toFixed(1)}L - FILTERED`);
            consumption = 0;
            pending.level = null;
            pending.count = 0;
            pending.accumulated = 0;
            pending.originalLevel = null;
            return { consumption, refill, newReferenceLevel, sensorQuality: 'noise_filtered' };
        }
        
        newReferenceLevel = currentLevel;
        console.log(`✅ ${dgName} CONFIRMED (Sustained Drop): ${consumption.toFixed(1)}L`);
        
        // ✅ GROUP RUNNING CHECK
        if (!groupIsRunning && consumption < MAX_NOISE_WHEN_OFF) {
            console.log(`🔇 ${dgName} FILTERED: ${consumption.toFixed(1)}L (GROUP OFF)`);
            consumption = 0;
        }
        
        pending.level = null;
        pending.count = 0;
        pending.accumulated = 0;
        pending.originalLevel = null;
      }
    }
    return { consumption, refill, newReferenceLevel, sensorQuality: 'tracking' };
  }

  // ============================================================
  // STEP 7: LEVEL INCREASED (Check for noise)
  // ============================================================
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
    return { consumption, refill, newReferenceLevel, sensorQuality: 'noise' };
  }

  return { consumption, refill, newReferenceLevel, sensorQuality: 'normal' };
}

// ============================================================
// ✅ MAIN TRACKING FUNCTION
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
      lastTrackingTimestamps = { dg1: null, dg2: null, dg3: null };
      Object.keys(pendingChanges).forEach(key => {
        pendingChanges[key] = { level: null, count: 0, accumulated: 0, originalLevel: null, quality: 'high' };
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
      lastTrackingTimestamps = { dg1: now, dg2: now, dg3: now };
    }

    const currentData = {
      dg1: systemData.dg1,
      dg2: systemData.dg2,
      dg3: systemData.dg3,
      total: systemData.total,
      electrical: systemData.electrical
    };

    // ============================================================
    // CHECK GROUP RUNNING STATUS
    // ============================================================
    const groupIsRunning = isAnyDGRunning(currentData.electrical);

    // ============================================================
    // PROCESS CONSUMPTION WITH SENSOR VALIDATION
    // ============================================================
    let consumption = { dg1: 0, dg2: 0, dg3: 0, total: 0 };
    let refills = { dg1: 0, dg2: 0, dg3: 0 };
    let sensorQuality = { dg1: 'unknown', dg2: 'unknown', dg3: 'unknown' };

    // Process each DG with sensor validation
    const res1 = processLevelChange('dg1', currentData.dg1, lastSavedLevels.dg1, 'DG1', groupIsRunning, now);
    const res2 = processLevelChange('dg2', currentData.dg2, lastSavedLevels.dg2, 'DG2', groupIsRunning, now);
    const res3 = processLevelChange('dg3', currentData.dg3, lastSavedLevels.dg3, 'DG3', groupIsRunning, now);

    consumption.dg1 = res1.consumption; 
    refills.dg1 = res1.refill;
    sensorQuality.dg1 = res1.sensorQuality;
    
    consumption.dg2 = res2.consumption; 
    refills.dg2 = res2.refill;
    sensorQuality.dg2 = res2.sensorQuality;
    
    consumption.dg3 = res3.consumption; 
    refills.dg3 = res3.refill;
    sensorQuality.dg3 = res3.sensorQuality;
    
    consumption.total = consumption.dg1 + consumption.dg2 + consumption.dg3;

    // Update timestamps
    lastTrackingTimestamps = { dg1: now, dg2: now, dg3: now };

    // ============================================================
    // Individual Running Status
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
    // Update Reference Levels (Only if sensor quality is good)
    // ============================================================
    lastSavedLevels = {
      dg1: sensorQuality.dg1 !== 'bad' ? currentData.dg1 : lastSavedLevels.dg1,
      dg2: sensorQuality.dg2 !== 'bad' ? currentData.dg2 : lastSavedLevels.dg2,
      dg3: sensorQuality.dg3 !== 'bad' ? currentData.dg3 : lastSavedLevels.dg3,
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
    
    // Add sensor quality warnings
    const badSensors = [];
    if (sensorQuality.dg1 === 'bad') badSensors.push('DG1');
    if (sensorQuality.dg2 === 'bad') badSensors.push('DG2');
    if (sensorQuality.dg3 === 'bad') badSensors.push('DG3');
    if (badSensors.length > 0) {
      logMsg += ` | 🚨 BAD SENSORS: ${badSensors.join(', ')}`;
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
  console.log('⏰ Scheduler Service Started with Industrial Sensor Validation');
  
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