/**
 * API Routes - WITH REFILL TRACKING + LIVE DATA SUPPORT
 */

const express = require('express');
const router = express.Router();
const { getSystemData } = require('../services/plcService');
const { DieselConsumption, ElectricalReading, DailySummary } = require('../models/schemas');

const REFILL_THRESHOLD = 20; // If level increases by 20L+, consider it a refill

// Get current system data (LIVE)
router.get('/data', (req, res) => {
  try {
    const data = getSystemData();
    res.json(data);
  } catch (err) {
    console.error('Error getting system data:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ IMPROVED: Get consumption data with refill tracking
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

    // ✅ If no records and today, send live data
    if (records.length === 0 && startDate === endDate) {
      const today = new Date().toISOString().split('T')[0];
      if (startDate === today) {
        const liveData = getSystemData();
        return res.json({ 
          success: true, 
          data: [],
          liveData: liveData
        });
      }
    }

    if (records.length === 0) {
      return res.json({ success: true, data: [] });
    }

    let processedData = [];

    if (dg && dg !== 'total') {
      // Single DG with refill tracking
      let previousLevel = null;

      records.forEach(record => {
        const currentLevel = record[dg]?.level || 0;
        let consumption = 0;
        let refilled = 0;
        let isRefill = false;

        if (previousLevel !== null) {
          const levelChange = currentLevel - previousLevel;
          
          if (levelChange < 0) {
            // Consumption
            consumption = Math.abs(levelChange);
          } else if (levelChange >= REFILL_THRESHOLD) {
            // Refill detected
            refilled = levelChange;
            isRefill = true;
          }
        }

        processedData.push({
          timestamp: record.timestamp,
          level: currentLevel,
          consumption: consumption,
          refilled: refilled,
          isRefill: isRefill,
          isRunning: record[dg]?.isRunning || false,
          date: record.date,
          hour: record.hour,
          minute: record.minute
        });

        previousLevel = currentLevel;
      });

    } else {
      // Total with refill tracking
      let previousLevels = { dg1: null, dg2: null, dg3: null };

      records.forEach(record => {
        let totalConsumption = 0;
        let totalRefilled = 0;
        let hasRefill = false;
        let refillDetails = {};

        ['dg1', 'dg2', 'dg3'].forEach(dgKey => {
          const currentLevel = record[dgKey]?.level || 0;
          const prevLevel = previousLevels[dgKey];

          if (prevLevel !== null) {
            const levelChange = currentLevel - prevLevel;
            
            if (levelChange < 0) {
              totalConsumption += Math.abs(levelChange);
            } else if (levelChange >= REFILL_THRESHOLD) {
              totalRefilled += levelChange;
              hasRefill = true;
              refillDetails[dgKey] = levelChange;
            }
          }

          previousLevels[dgKey] = currentLevel;
        });

        processedData.push({
          timestamp: record.timestamp,
          dg1: { ...record.dg1._doc, refilled: refillDetails.dg1 || 0 },
          dg2: { ...record.dg2._doc, refilled: refillDetails.dg2 || 0 },
          dg3: { ...record.dg3._doc, refilled: refillDetails.dg3 || 0 },
          total: {
            level: record.total?.level || 0,
            consumption: totalConsumption,
            refilled: totalRefilled,
            isRefill: hasRefill
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

// ✅ Get electrical data (only running periods)
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
      timestamp: { $gte: start, $lte: end },
      activePower: { $gt: 5 } // Only running periods
    }).sort({ timestamp: 1 });

    // ✅ If no records and today, provide live electrical data
    if (records.length === 0 && startDate === endDate) {
      const today = new Date().toISOString().split('T')[0];
      if (startDate === today) {
        const liveData = getSystemData();
        const dgElectrical = liveData.electrical?.[dg];
        
        if (dgElectrical && dgElectrical.activePower > 5) {
          return res.json({
            success: true,
            data: [{
              timestamp: new Date(),
              dg: dg,
              ...dgElectrical,
              date: today,
              hour: new Date().getHours()
            }],
            isLive: true
          });
        }
      }
    }

    res.json({ success: true, data: records });
  } catch (err) {
    console.error('Error fetching electrical data:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Export consumption with refill tracking
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

    let csvContent = 'Timestamp,Level (L),Consumption (L),Refilled (L),Running,Notes\n';
    let previousLevel = null;

    records.forEach(record => {
      const currentLevel = record[dg]?.level || 0;
      let consumption = 0;
      let refilled = 0;
      let notes = '';

      if (previousLevel !== null) {
        const levelChange = currentLevel - previousLevel;
        
        if (levelChange < 0) {
          consumption = Math.abs(levelChange);
        } else if (levelChange >= REFILL_THRESHOLD) {
          refilled = levelChange;
          notes = 'REFILL DETECTED';
        }
      }

      const timestamp = new Date(record.timestamp).toLocaleString('en-IN');
      const isRunning = record[dg]?.isRunning ? 'Yes' : 'No';
      csvContent += `${timestamp},${currentLevel.toFixed(1)},${consumption.toFixed(1)},${refilled.toFixed(1)},${isRunning},${notes}\n`;

      previousLevel = currentLevel;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 
      `attachment; filename="${dg}_consumption_${startDate}_${endDate}.csv"`);
    res.send(csvContent);
  } catch (err) {
    console.error('Error exporting consumption:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Export electrical data
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
    res.setHeader('Content-Disposition', 
      `attachment; filename="${dg}_electrical_${startDate}_${endDate}.csv"`);
    res.send(csvContent);
  } catch (err) {
    console.error('Error exporting electrical:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Export all data with refill tracking
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

    let csvContent = 'Timestamp,DG1 Level,DG1 Consumed,DG1 Refilled,DG1 Running,DG2 Level,DG2 Consumed,DG2 Refilled,DG2 Running,DG3 Level,DG3 Consumed,DG3 Refilled,DG3 Running,Total Level,Total Consumed,Total Refilled\n';
    
    let previousLevels = { dg1: null, dg2: null, dg3: null };

    records.forEach(record => {
      const timestamp = new Date(record.timestamp).toLocaleString('en-IN');
      let row = [timestamp];

      let totalConsumption = 0;
      let totalRefilled = 0;

      ['dg1', 'dg2', 'dg3'].forEach(dg => {
        const currentLevel = record[dg]?.level || 0;
        let consumption = 0;
        let refilled = 0;

        if (previousLevels[dg] !== null) {
          const levelChange = currentLevel - previousLevels[dg];
          
          if (levelChange < 0) {
            consumption = Math.abs(levelChange);
            totalConsumption += consumption;
          } else if (levelChange >= REFILL_THRESHOLD) {
            refilled = levelChange;
            totalRefilled += refilled;
          }
        }

        row.push(currentLevel.toFixed(1));
        row.push(consumption.toFixed(1));
        row.push(refilled.toFixed(1));
        row.push(record[dg]?.isRunning ? 'Yes' : 'No');

        previousLevels[dg] = currentLevel;
      });

      row.push((record.total?.level || 0).toFixed(1));
      row.push(totalConsumption.toFixed(1));
      row.push(totalRefilled.toFixed(1));

      csvContent += row.join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 
      `attachment; filename="all_data_${startDate}_${endDate}.csv"`);
    res.send(csvContent);
  } catch (err) {
    console.error('Error exporting all data:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;