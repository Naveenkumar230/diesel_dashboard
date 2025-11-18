/**
 * API Routes - CORRECTED VERSION
 * Fixed consumption calculation logic
 */

const express = require('express');
const router = express.Router();
const { getSystemData } = require('../services/plcService');
const { DieselConsumption, ElectricalReading, DailySummary } = require('../models/schemas');

// Get current system data
router.get('/data', (req, res) => {
  try {
    const data = getSystemData();
    res.json(data);
  } catch (err) {
    console.error('Error getting system data:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ FIXED: Get consumption data with CORRECT calculation
router.get('/consumption', async (req, res) => {
  try {
    const { dg, startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Start and end dates required' });
    }

    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const records = await DieselConsumption.find({
      timestamp: { $gte: start, $lte: end }
    }).sort({ timestamp: 1 });

    if (records.length === 0) {
      return res.json({ success: true, data: [] });
    }

    let processedData = [];

    if (dg && dg !== 'total') {
      // Single DG - Calculate consumption from level DECREASES only
      let previousLevel = null;

      records.forEach(record => {
        const currentLevel = record[dg]?.level || 0;
        let consumption = 0;

        if (previousLevel !== null && currentLevel < previousLevel) {
          // ✅ ONLY count decreases
          consumption = previousLevel - currentLevel;
        }
        // Ignore increases (refills)

        processedData.push({
          timestamp: record.timestamp,
          level: currentLevel,
          consumption: consumption,
          isRunning: record[dg]?.isRunning || false,
          date: record.date,
          hour: record.hour,
          minute: record.minute
        });

        previousLevel = currentLevel;
      });
    } else {
      // Total - Calculate from all 3 DGs
      let previousLevels = { dg1: null, dg2: null, dg3: null };

      records.forEach(record => {
        let totalConsumption = 0;

        ['dg1', 'dg2', 'dg3'].forEach(dgKey => {
          const currentLevel = record[dgKey]?.level || 0;
          const prevLevel = previousLevels[dgKey];

          if (prevLevel !== null && currentLevel < prevLevel) {
            // ✅ ONLY count decreases
            totalConsumption += (prevLevel - currentLevel);
          }

          previousLevels[dgKey] = currentLevel;
        });

        processedData.push({
          timestamp: record.timestamp,
          dg1: record.dg1,
          dg2: record.dg2,
          dg3: record.dg3,
          total: {
            level: record.total?.level || 0,
            consumption: totalConsumption
          },
          date: record.date,
          hour: record.hour,
          minute: record.minute
        });
      });
    }

    res.json({ success: true, data: processedData });
  } catch (err) {
    console.error('Error fetching consumption:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ FIXED: Get electrical data (ONLY RUNNING PERIODS)
router.get('/electrical/:dg', async (req, res) => {
  try {
    const { dg } = req.params;
    const { startDate, endDate } = req.query;

    if (!['dg1', 'dg2', 'dg3', 'dg4'].includes(dg)) {
      return res.status(400).json({ success: false, error: 'Invalid DG' });
    }

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'Start and end dates required' });
    }

    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const records = await ElectricalReading.find({
      dg: dg,
      timestamp: { $gte: start, $lte: end }
    }).sort({ timestamp: 1 });

    // ✅ Filter to ONLY include running periods (activePower > 5 kW)
    const runningRecords = records.filter(r => r.activePower > 5);

    res.json({ success: true, data: runningRecords });
  } catch (err) {
    console.error('Error fetching electrical data:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Export consumption data as CSV
router.get('/export/consumption', async (req, res) => {
  try {
    const { dg, startDate, endDate } = req.query;
    
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const records = await DieselConsumption.find({
      timestamp: { $gte: start, $lte: end }
    }).sort({ timestamp: 1 });

    let csvContent = 'Timestamp,Level (L),Consumption (L),Running\n';
    let previousLevel = null;

    records.forEach(record => {
      const currentLevel = record[dg]?.level || 0;
      let consumption = 0;

      if (previousLevel !== null && currentLevel < previousLevel) {
        consumption = previousLevel - currentLevel;
      }

      const timestamp = new Date(record.timestamp).toLocaleString('en-IN');
      const isRunning = record[dg]?.isRunning ? 'Yes' : 'No';
      csvContent += `${timestamp},${currentLevel.toFixed(1)},${consumption.toFixed(1)},${isRunning}\n`;

      previousLevel = currentLevel;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${dg}_consumption_${startDate}_${endDate}.csv"`);
    res.send(csvContent);
  } catch (err) {
    console.error('Error exporting consumption:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Export electrical data as CSV
router.get('/export/electrical/:dg', async (req, res) => {
  try {
    const { dg } = req.params;
    const { startDate, endDate } = req.query;
    
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const records = await ElectricalReading.find({
      dg: dg,
      timestamp: { $gte: start, $lte: end }
    }).sort({ timestamp: 1 });

    let csvContent = 'Timestamp,Voltage R,Voltage Y,Voltage B,Current R,Current Y,Current B,Frequency,Power Factor,Active Power,Reactive Power,Energy,Running Hours\n';
    
    records.forEach(record => {
      const timestamp = new Date(record.timestamp).toLocaleString('en-IN');
      csvContent += `${timestamp},${record.voltageR},${record.voltageY},${record.voltageB},${record.currentR},${record.currentY},${record.currentB},${record.frequency},${record.powerFactor},${record.activePower},${record.reactivePower},${record.energyMeter},${record.runningHours}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${dg}_electrical_${startDate}_${endDate}.csv"`);
    res.send(csvContent);
  } catch (err) {
    console.error('Error exporting electrical:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Export all data
router.get('/export/all', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const records = await DieselConsumption.find({
      timestamp: { $gte: start, $lte: end }
    }).sort({ timestamp: 1 });

    let csvContent = 'Timestamp,DG1 Level,DG1 Consumption,DG1 Running,DG2 Level,DG2 Consumption,DG2 Running,DG3 Level,DG3 Consumption,DG3 Running,Total Level,Total Consumption\n';
    
    let previousLevels = { dg1: null, dg2: null, dg3: null };

    records.forEach(record => {
      const timestamp = new Date(record.timestamp).toLocaleString('en-IN');
      let row = [timestamp];

      ['dg1', 'dg2', 'dg3'].forEach(dg => {
        const currentLevel = record[dg]?.level || 0;
        let consumption = 0;

        if (previousLevels[dg] !== null && currentLevel < previousLevels[dg]) {
          consumption = previousLevels[dg] - currentLevel;
        }

        row.push(currentLevel.toFixed(1));
        row.push(consumption.toFixed(1));
        row.push(record[dg]?.isRunning ? 'Yes' : 'No');

        previousLevels[dg] = currentLevel;
      });

      let totalConsumption = 0;
      ['dg1', 'dg2', 'dg3'].forEach(dg => {
        const currentLevel = record[dg]?.level || 0;
        if (previousLevels[dg] !== null && currentLevel < previousLevels[dg]) {
          totalConsumption += (previousLevels[dg] - currentLevel);
        }
      });

      row.push((record.total?.level || 0).toFixed(1));
      row.push(totalConsumption.toFixed(1));

      csvContent += row.join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="all_data_${startDate}_${endDate}.csv"`);
    res.send(csvContent);
  } catch (err) {
    console.error('Error exporting all data:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;