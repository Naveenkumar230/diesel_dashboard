/**
 * Scheduler Service - Handles all scheduled tasks
 * - 30-minute consumption tracking (7 AM - 8 PM)
 * - Daily summary email at 8 PM
 */

const cron = require('node-cron');
const { DieselConsumption, DailySummary } = require('../models/schemas');
const { getSystemData } = require('./plcService');
const { sendDailySummary } = require('./emailService');

const DG_RUNNING_THRESHOLD = 5; // kW

let previousConsumptionData = null;
let dayStartLevels = null;

// Track consumption every 30 minutes (7 AM to 8 PM)
async function trackConsumption() {
  try {
    const now = new Date();
    const hour = now.getHours();

    // Only track between 7 AM and 8 PM
    if (hour < 7 || hour >= 20) {
      return;
    }

    const systemData = getSystemData();
    
    if (!systemData || !systemData.lastUpdate) {
      console.log('⚠️ No system data available for consumption tracking');
      return;
    }

    // Store day start levels (at 7 AM)
    if (hour === 7 && now.getMinutes() < 30 && !dayStartLevels) {
      dayStartLevels = {
        dg1: systemData.dg1,
        dg2: systemData.dg2,
        dg3: systemData.dg3,
        total: systemData.total,
        date: now.toISOString().split('T')[0]
      };
      console.log('📊 Day start levels recorded:', dayStartLevels);
    }

    const currentData = {
      dg1: systemData.dg1,
      dg2: systemData.dg2,
      dg3: systemData.dg3,
      total: systemData.total,
      electrical: systemData.electrical
    };

    // Calculate consumption
    let consumption = {
      dg1: 0,
      dg2: 0,
      dg3: 0,
      total: 0
    };

    if (previousConsumptionData) {
      consumption.dg1 = Math.max(0, previousConsumptionData.dg1 - currentData.dg1);
      consumption.dg2 = Math.max(0, previousConsumptionData.dg2 - currentData.dg2);
      consumption.dg3 = Math.max(0, previousConsumptionData.dg3 - currentData.dg3);
      consumption.total = consumption.dg1 + consumption.dg2 + consumption.dg3;
    }

    // Check if DGs are running
    const isRunning = {
      dg1: (currentData.electrical?.dg1?.activePower || 0) > DG_RUNNING_THRESHOLD,
      dg2: (currentData.electrical?.dg2?.activePower || 0) > DG_RUNNING_THRESHOLD,
      dg3: (currentData.electrical?.dg3?.activePower || 0) > DG_RUNNING_THRESHOLD
    };

    // Save to database
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
      date: now.toISOString().split('T')[0],
      hour: hour,
      minute: now.getMinutes()
    });

    await record.save();
    console.log(`✅ Consumption tracked at ${now.toLocaleTimeString('en-IN')} - Total: ${consumption.total.toFixed(1)}L`);

    previousConsumptionData = currentData;
  } catch (err) {
    console.error('Error tracking consumption:', err.message);
  }
}

// Generate and send daily summary
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
    const totalConsumption = {
      dg1: dayStartLevels.dg1 - systemData.dg1,
      dg2: dayStartLevels.dg2 - systemData.dg2,
      dg3: dayStartLevels.dg3 - systemData.dg3
    };

    totalConsumption.total = totalConsumption.dg1 + totalConsumption.dg2 + totalConsumption.dg3;

    // Calculate running hours
    const runningHours = {
      dg1: todayRecords.filter(r => r.dg1.isRunning).length * 0.5, // 0.5 hours per 30-min interval
      dg2: todayRecords.filter(r => r.dg2.isRunning).length * 0.5,
      dg3: todayRecords.filter(r => r.dg3.isRunning).length * 0.5
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

    // Get yesterday's summary for comparison
    const previousSummary = await DailySummary.findOne({ date: yesterday });

    // Send email
    await sendDailySummary(summary, previousSummary);

    // Reset for next day
    dayStartLevels = null;
    previousConsumptionData = null;
  } catch (err) {
    console.error('Error generating daily summary:', err.message);
  }
}

// Start all scheduled tasks
function startScheduledTasks() {
  console.log('🕐 Starting scheduled tasks...');

  // Track consumption every 30 minutes (7 AM - 8 PM)
  // Runs at :00 and :30 of every hour
  cron.schedule('0,30 7-19 * * *', () => {
    console.log('⏰ Running 30-minute consumption tracking...');
    trackConsumption();
  });

  // Generate and send daily summary at 8 PM
  cron.schedule('0 20 * * *', () => {
    console.log('⏰ Running daily summary generation...');
    generateDailySummary();
  });

  // Initialize first reading if within operating hours
  const now = new Date();
  const hour = now.getHours();
  if (hour >= 7 && hour < 20) {
    setTimeout(() => {
      trackConsumption();
    }, 5000);
  }

  console.log('✅ Scheduled tasks configured:');
  console.log('   - Consumption tracking: Every 30 minutes (7 AM - 8 PM)');
  console.log('   - Daily summary: 8:00 PM');
}

module.exports = {
  startScheduledTasks,
  trackConsumption,
  generateDailySummary
};