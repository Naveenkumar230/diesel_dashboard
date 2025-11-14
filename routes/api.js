/**
 * API Routes for DG Monitoring System
 */

const express = require('express');
const router = express.Router();
const { getSystemData, isConnected } = require('../services/plcService');
const { DieselConsumption, DailySummary, ElectricalReading } = require('../models/schemas');

// Get current system data
router.get('/data', (req, res) => {
  try {
    const data = getSystemData();
    res.json({
      ...data,
      connected: isConnected()
    });
  } catch (err) {
    console.error('API /data error:', err);
    res.status(500).json({ error: 'Failed to fetch system data' });
  }
});

// Get consumption data with filters
router.get('/consumption', async (req, res) => {
  try {
    const { dg, startDate, endDate, date } = req.query;

    let query = {};

    // Date filtering
    if (date) {
      query.date = date;
    } else if (startDate && endDate) {
      query.date = { $gte: startDate, $lte: endDate };
    } else if (startDate) {
      query.date = { $gte: startDate };
    }

    // Since schedulerService saves electrical data at the same time,
    // we only need to query DieselConsumption for the main view.
    const records = await DieselConsumption.find(query).sort({ timestamp: 1 });

    // Filter by DG if specified
    let filteredData = records;
    if (dg && ['dg1', 'dg2', 'dg3'].includes(dg)) {
      filteredData = records.map(r => ({
        timestamp: r.timestamp,
        date: r.date,
        hour: r.hour,
        minute: r.minute,
        level: r[dg].level,
        consumption: r[dg].consumption,
        isRunning: r[dg].isRunning
      }));
    } else if (dg === 'total') {
      // Return full records for total view
      filteredData = records;
    }

    res.json({
      success: true,
      count: filteredData.length,
      data: filteredData
    });
  } catch (err) {
    console.error('API /consumption error:', err);
    res.status(500).json({ error: 'Failed to fetch consumption data' });
  }
});

// Get daily summaries
router.get('/summaries', async (req, res) => {
  try {
    const { startDate, endDate, limit } = req.query;

    let query = {};
    if (startDate && endDate) {
      query.date = { $gte: startDate, $lte: endDate };
    } else if (startDate) {
      query.date = { $gte: startDate };
    }

    const summaries = await DailySummary
      .find(query)
      .sort({ date: -1 })
      .limit(parseInt(limit) || 30);

    res.json({
      success: true,
      count: summaries.length,
      data: summaries
    });
  } catch (err) {
    console.error('API /summaries error:', err);
    res.status(500).json({ error: 'Failed to fetch summaries' });
  }
});

// Get electrical parameters history
router.get('/electrical/:dg', async (req, res) => {
  try {
    const { dg } = req.params;
    const { startDate, endDate, date } = req.query;

    if (!['dg1', 'dg2', 'dg3', 'dg4'].includes(dg)) {
      return res.status(400).json({ error: 'Invalid DG specified' });
    }

    let query = { dg };

    if (date) {
      query.date = date;
    } else if (startDate && endDate) {
      query.date = { $gte: startDate, $lte: endDate };
    }

    const records = await ElectricalReading
      .find(query)
      .sort({ timestamp: 1 })
      .limit(1000); // Limit to 1000 records for performance

    res.json({
      success: true,
      count: records.length,
      data: records
    });
  } catch (err) {
    console.error('API /electrical error:', err);
    res.status(500).json({ error: 'Failed to fetch electrical data' });
  }
});

// Export data as CSV
router.get('/export/consumption', async (req, res) => {
  try {
    const { dg, startDate, endDate } = req.query;

    let query = {};
    if (startDate && endDate) {
      query.date = { $gte: startDate, $lte: endDate };
    }

    const records = await DieselConsumption.find(query).sort({ timestamp: 1 });

    // Generate CSV
    let csv = '';
    
    if (dg && ['dg1', 'dg2', 'dg3'].includes(dg)) {
      csv = 'Timestamp,Date,Hour,Minute,Level (L),Consumption (L),Is Running\n';
      records.forEach(r => {
        csv += `"${r.timestamp.toLocaleString('en-IN')}",${r.date},${r.hour},${r.minute},${r[dg].level},${r[dg].consumption},${r[dg].isRunning}\n`;
      });
    } else { // Includes 'total' or no dg
      csv = 'Timestamp,Date,Hour,Minute,DG1 Level,DG1 Consumption,DG1 Running,DG2 Level,DG2 Consumption,DG2 Running,DG3 Level,DG3 Consumption,DG3 Running,Total Level,Total Consumption\n';
      records.forEach(r => {
        csv += `"${r.timestamp.toLocaleString('en-IN')}",${r.date},${r.hour},${r.minute},${r.dg1.level},${r.dg1.consumption},${r.dg1.isRunning},${r.dg2.level},${r.dg2.consumption},${r.dg2.isRunning},${r.dg3.level},${r.dg3.consumption},${r.dg3.isRunning},${r.total.level},${r.total.consumption}\n`;
      });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=consumption_${dg || 'total'}_${Date.now()}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('API /export/consumption error:', err);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// Export electrical data as CSV
router.get('/export/electrical/:dg', async (req, res) => {
  try {
    const { dg } = req.params;
    const { startDate, endDate } = req.query;

    if (!['dg1', 'dg2', 'dg3', 'dg4'].includes(dg)) {
      return res.status(400).json({ error: 'Invalid DG specified' });
    }

    let query = { dg };
    if (startDate && endDate) {
      query.date = { $gte: startDate, $lte: endDate };
    }

    const records = await ElectricalReading.find(query).sort({ timestamp: 1 });

    let csv = 'Timestamp,Date,Hour,Voltage R,Voltage Y,Voltage B,Current R,Current Y,Current B,Frequency,Power Factor,Active Power (kW),Reactive Power (kVAR),Energy Meter (kWh),Running Hours,Winding Temp\n';
    
    records.forEach(r => {
      csv += `"${r.timestamp.toLocaleString('en-IN')}",${r.date},${r.hour},${r.voltageR},${r.voltageY},${r.voltageB},${r.currentR},${r.currentY},${r.currentB},${r.frequency},${r.powerFactor},${r.activePower},${r.reactivePower},${r.energyMeter},${r.runningHours},${r.windingTemp}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${dg}_electrical_${Date.now()}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('API /export/electrical error:', err);
    res.status(500).json({ error: 'Failed to export electrical data' });
  }
});

// --- NEW ENDPOINT FOR COMBINED EXPORT ---
router.get('/export/all', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let query = {};
    if (startDate && endDate) {
      // Set time to cover the full range
      query.timestamp = { 
        $gte: new Date(`${startDate}T00:00:00.000Z`), 
        $lte: new Date(`${endDate}T23:59:59.999Z`) 
      };
    } else {
      return res.status(400).json({ error: 'Start date and end date are required' });
    }
    
    // 1. Fetch all diesel data
    const dieselData = await DieselConsumption.find(query).sort({ timestamp: 1 }).lean();
    
    // 2. Fetch all electrical data
    const electricalData = await ElectricalReading.find(query).sort({ timestamp: 1 }).lean();

    // 3. Create a lookup map for electrical data
    // Key: timestamp (ISO string), Value: { dg1: {...}, dg2: {...}, ... }
    const electricalMap = new Map();
    for (const r of electricalData) {
      const timestampStr = r.timestamp.toISOString();
      if (!electricalMap.has(timestampStr)) {
        electricalMap.set(timestampStr, {});
      }
      electricalMap.get(timestampStr)[r.dg] = r;
    }

    // 4. Define CSV Headers
    const dieselHeaders = [
      'Timestamp', 'DG1 Level (L)', 'DG1 Consumption (L)', 'DG1 Running',
      'DG2 Level (L)', 'DG2 Consumption (L)', 'DG2 Running',
      'DG3 Level (L)', 'DG3 Consumption (L)', 'DG3 Running',
      'Total Level (L)', 'Total Consumption (L)'
    ];
    
    const elHeaders = (dg) => [
      `${dg} V-R`, `${dg} V-Y`, `${dg} V-B`,
      `${dg} C-R`, `${dg} C-Y`, `${dg} C-B`,
      `${dg} Freq`, `${dg} PF`, `${dg} kW`, `${dg} kVAR`, `${dg} kWh`, `${dg} RunHrs`, `${dg} WdgTemp`
    ];

    let csv = [
      ...dieselHeaders,
      ...elHeaders('DG1'),
      ...elHeaders('DG2'),
      ...elHeaders('DG3'),
      ...elHeaders('DG4')
    ].join(',') + '\n';

    // 5. Build CSV Rows
    for (const r of dieselData) {
      const timestampStr = r.timestamp.toISOString();
      const elData = electricalMap.get(timestampStr) || {};
      
      const getElRow = (dgKey) => {
        const d = elData[dgKey] || {};
        return [
          d.voltageR || 0, d.voltageY || 0, d.voltageB || 0,
          d.currentR || 0, d.currentY || 0, d.currentB || 0,
          d.frequency || 0, d.powerFactor || 0, d.activePower || 0,
          d.reactivePower || 0, d.energyMeter || 0, d.runningHours || 0, d.windingTemp || 0
        ];
      };

      const dieselRow = [
        `"${r.timestamp.toLocaleString('en-IN')}"`,
        r.dg1.level, r.dg1.consumption, r.dg1.isRunning,
        r.dg2.level, r.dg2.consumption, r.dg2.isRunning,
        r.dg3.level, r.dg3.consumption, r.dg3.isRunning,
        r.total.level, r.total.consumption
      ];

      const row = [
        ...dieselRow,
        ...getElRow('dg1'),
        ...getElRow('dg2'),
        ...getElRow('dg3'),
        ...getElRow('dg4')
      ];
      
      csv += row.join(',') + '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=ALL_DATA_EXPORT_${Date.now()}.csv`);
    res.send(csv);

  } catch (err) {
    console.error('API /export/all error:', err);
    res.status(500).json({ error: 'Failed to export all data' });
  }
});
// --- END NEW ENDPOINT ---


// Get statistics
router.get('/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Today's consumption
    const todayRecords = await DieselConsumption.find({ date: today });
    
    // Latest summary
    const latestSummary = await DailySummary.findOne().sort({ date: -1 });

    // Calculate today's stats
    const todayStats = {
      dg1: {
        consumption: todayRecords.reduce((sum, r) => sum + r.dg1.consumption, 0),
        runningTime: todayRecords.filter(r => r.dg1.isRunning).length * 0.5
      },
      dg2: {
        consumption: todayRecords.reduce((sum, r) => sum + r.dg2.consumption, 0),
        runningTime: todayRecords.filter(r => r.dg2.isRunning).length * 0.5
      },
      dg3: {
        consumption: todayRecords.reduce((sum, r) => sum + r.dg3.consumption, 0),
        runningTime: todayRecords.filter(r => r.dg3.isRunning).length * 0.5
      }
    };

    todayStats.total = {
      consumption: todayStats.dg1.consumption + todayStats.dg2.consumption + todayStats.dg3.consumption
    };

    res.json({
      success: true,
      today: todayStats,
      latestSummary: latestSummary
    });
  } catch (err) {
    console.error('API /stats error:', err);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

module.exports = router;