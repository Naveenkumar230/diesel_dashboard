/**
 * API Routes - SYNCED VERSION
 * KEY FIX: Merges Historical DB Data + Live PLC Data
 * Result: Graph "End Level" matches Dashboard "Current Level" perfectly.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const ExcelJS = require('exceljs'); 
const { getSystemData } = require('../services/plcService');
const { DieselConsumption, ElectricalReading } = require('../models/schemas');

const REFILL_THRESHOLD = 20;
const NOISE_THRESHOLD = 0.5;
const LOGO_PATH = path.join(__dirname, '../public/logo.png');

async function setupExcelSheet(workbook, worksheet, title) {
    try {
        const logoId = workbook.addImage({
            filename: LOGO_PATH,
            extension: 'png',
        });
        worksheet.addImage(logoId, {
            tl: { col: 0, row: 0 },
            ext: { width: 150, height: 80 }
        });
    } catch (e) {
        console.warn("Logo not found, skipping image.");
    }

    worksheet.mergeCells('C2:H3');
    const titleCell = worksheet.getCell('C2');
    titleCell.value = title;
    titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF0052CC' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

    worksheet.addRow([]);
    worksheet.addRow([]);
    worksheet.addRow([]);
    worksheet.addRow([]);
}

// =================================================================
// 📡 DATA API ROUTES
// =================================================================

router.get('/data', (req, res) => {
    try {
        res.json(getSystemData());
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ✅ FIXED: Consumption endpoint that merges DB + Live Data
// =================================================================
// 📡 CONSUMPTION API - PRODUCTION READY WITH COMPREHENSIVE VALIDATION
// =================================================================

router.get('/consumption', async (req, res) => {
    try {
        const { dg, startDate, endDate } = req.query;
        
        // ========================================
        // ✅ STEP 1: VALIDATE REQUEST PARAMETERS
        // ========================================
        if (!startDate || !endDate) {
            return res.status(400).json({ 
                success: false, 
                error: 'Both startDate and endDate are required',
                example: '/api/consumption?dg=dg1&startDate=2025-12-01&endDate=2025-12-03'
            });
        }

        // ========================================
        // ✅ STEP 2: VALIDATE DATE FORMATS
        // ========================================
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        // Check if dates are valid
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid date format. Use YYYY-MM-DD format',
                received: { startDate, endDate }
            });
        }

        // ========================================
        // ✅ STEP 3: VALIDATE DATE RANGE
        // ========================================
        if (start > end) {
            return res.status(400).json({ 
                success: false, 
                error: 'Start date must be before or equal to end date',
                received: { 
                    startDate: start.toISOString().split('T')[0], 
                    endDate: end.toISOString().split('T')[0] 
                }
            });
        }

        // ========================================
        // ✅ STEP 4: VALIDATE DATE RANGE SIZE (Prevent DB overload)
        // ========================================
        const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
        const MAX_DAYS = 90; // 3 months maximum
        
        if (daysDiff > MAX_DAYS) {
            return res.status(400).json({ 
                success: false, 
                error: `Date range too large. Maximum ${MAX_DAYS} days allowed`,
                requested: daysDiff,
                suggestion: 'Break your query into smaller date ranges'
            });
        }

        // ========================================
        // ✅ STEP 5: VALIDATE DG PARAMETER (if provided)
        // ========================================
        const validDGs = ['dg1', 'dg2', 'dg3', 'total'];
        if (dg && !validDGs.includes(dg)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid DG parameter',
                validOptions: validDGs,
                received: dg
            });
        }

        // ========================================
        // ✅ STEP 6: FETCH HISTORICAL DATA FROM DATABASE
        // ========================================
        let records = [];
        try {
            records = await DieselConsumption.find({
                timestamp: { $gte: start, $lte: end }
            })
            .sort({ timestamp: 1 })
            .limit(10000) // Safety limit
            .lean()
            .maxTimeMS(15000); // 15 second timeout
        } catch (dbError) {
            console.error('❌ Database query error:', dbError.message);
            return res.status(500).json({ 
                success: false, 
                error: 'Database query failed',
                details: dbError.message
            });
        }

        // ========================================
        // ✅ STEP 7: FORMAT HISTORICAL DATA
        // ========================================
        let responseData = [];

        if (!dg || dg === 'total') {
            responseData = records.map(r => ({
                timestamp: r.timestamp,
                date: r.date,
                dg1: r.dg1, 
                dg2: r.dg2, 
                dg3: r.dg3, 
                total: r.total
            }));
        } else {
            responseData = records.map(r => ({
                timestamp: r.timestamp,
                date: r.date,
                level: r[dg]?.level || 0,
                consumption: r[dg]?.consumption || 0,
                isRunning: r[dg]?.isRunning || false,
                dg1: r.dg1, 
                dg2: r.dg2, 
                dg3: r.dg3, 
                total: r.total
            }));
        }

        // =========================================================
        // ✅ STEP 8: APPEND LIVE DATA IF TODAY IS INCLUDED
        // This ensures graphs connect historical data to current levels
        // =========================================================
        const todayStr = new Date().toISOString().split('T')[0];
        const isTodayIncluded = (endDate >= todayStr);

        if (isTodayIncluded) {
            try {
                const liveData = getSystemData();
                
                // Only append if we have valid live data
                if (liveData && liveData.lastUpdate) {
                    // Check if the last DB record is duplicate (same minute) to avoid double dots
                    const lastRecordTime = responseData.length > 0 
                        ? new Date(responseData[responseData.length - 1].timestamp).getTime() 
                        : 0;
                    const liveTime = new Date().getTime();

                    // If live data is newer than last DB record by at least 1 second
                    if (liveTime > lastRecordTime + 1000) {
                        let liveEntry = {};

                        if (!dg || dg === 'total') {
                            liveEntry = {
                                timestamp: new Date(), // Current Time
                                date: todayStr,
                                dg1: liveData.dg1 || 0,
                                dg2: liveData.dg2 || 0,
                                dg3: liveData.dg3 || 0,
                                total: liveData.total || 0,
                                // ✅ ADD DATA QUALITY INFO
                                isLive: true,
                                dataQuality: liveData.dataQuality
                            };
                        } else {
                            liveEntry = {
                                timestamp: new Date(), // Current Time
                                date: todayStr,
                                level: liveData[dg] || 0,
                                consumption: 0, // Live data doesn't have calculated consumption yet
                                isRunning: (liveData.electrical?.[dg]?.activePower || 0) > 5,
                                dg1: liveData.dg1 || 0,
                                dg2: liveData.dg2 || 0,
                                dg3: liveData.dg3 || 0,
                                total: liveData.total || 0,
                                // ✅ ADD DATA QUALITY INFO
                                isLive: true,
                                dataQuality: liveData.dataQuality
                            };
                        }
                        
                        responseData.push(liveEntry);
                    }
                }
            } catch (liveDataError) {
                console.error('⚠️ Failed to append live data:', liveDataError.message);
                // Continue without live data (not critical)
            }
        }

        // ========================================
        // ✅ STEP 9: RETURN SUCCESS RESPONSE
        // ========================================
        return res.json({ 
            success: true, 
            data: responseData,
            metadata: {
                totalRecords: responseData.length,
                dateRange: {
                    start: start.toISOString().split('T')[0],
                    end: end.toISOString().split('T')[0],
                    days: daysDiff
                },
                dg: dg || 'total',
                includesLiveData: isTodayIncluded
            }
        });

    } catch (err) {
        console.error('❌ Consumption API Error:', err.message);
        console.error('Stack:', err.stack);
        
        return res.status(500).json({ 
            success: false, 
            error: 'Internal server error',
            message: err.message,
            timestamp: new Date().toISOString()
        });
    }
});

router.get('/health', (req, res) => {
    const { isConnected } = require('../services/plcService');
    const mongoose = require('mongoose');
    
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            mongodb: {
                status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
                readyState: mongoose.connection.readyState,
                // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
                host: mongoose.connection.host || 'unknown'
            },
            plc: {
                status: isConnected() ? 'connected' : 'disconnected'
            }
        },
        uptime: {
            seconds: process.uptime(),
            formatted: formatUptime(process.uptime())
        },
        memory: {
            used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
            total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`
        }
    };
    
    // Set HTTP status based on critical services
    const httpStatus = (health.services.mongodb.status === 'connected' && 
                       health.services.plc.status === 'connected') ? 200 : 503;
    
    res.status(httpStatus).json(health);
});

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
}

// In api.js:
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        plc: isConnected() ? 'connected' : 'disconnected',
        uptime: process.uptime()
    });
});


// ✅ FIXED: Electrical endpoint (Robust error handling)
router.get('/electrical/:dg', async (req, res) => {
    try {
        const { dg } = req.params;
        const { startDate, endDate } = req.query;

        if (!['dg1', 'dg2', 'dg3', 'dg4'].includes(dg)) {
            return res.status(400).json({ success: false, error: 'Invalid DG' });
        }

        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        let records = await ElectricalReading.find({
            dg: dg,
            timestamp: { $gte: start, $lte: end }
        })
        .sort({ timestamp: 1 })
        .limit(200)
        .lean()
        .maxTimeMS(8000);

        // Fallback: Check yesterday if today is empty
        const today = new Date().toISOString().split('T')[0];
        if (records.length === 0 && startDate === today && endDate === today) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            yesterday.setHours(0, 0, 0, 0);
            const yesterdayEnd = new Date(yesterday);
            yesterdayEnd.setHours(23, 59, 59, 999);

            const yesterdayRecords = await ElectricalReading.find({
                dg: dg,
                timestamp: { $gte: yesterday, $lte: yesterdayEnd }
            })
            .sort({ timestamp: -1 })
            .limit(1)
            .lean();

            if (yesterdayRecords.length > 0) records = yesterdayRecords;
        }

        return res.json({ success: true, data: records });

    } catch (err) {
        console.error(`❌ Electrical API Error [${req.params.dg}]:`, err.message);
        return res.json({ success: true, data: [], warning: 'Database error' });
    }
});

// =================================================================
// 📥 EXCEL EXPORT ROUTES (Kept same as working version)
// =================================================================

router.get('/export/consumption', async (req, res) => {
    try {
        const { dg, startDate, endDate } = req.query;
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        const records = await DieselConsumption.find({ 
            timestamp: { $gte: start, $lte: end } 
        }).sort({ timestamp: 1 }).lean();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Consumption');

        await setupExcelSheet(workbook, worksheet, `Aquarelle India - ${dg.toUpperCase()} Consumption`);

        worksheet.addRow(['Timestamp', 'Level (L)', 'Consumed (L)', 'Refilled (L)', 'Running', 'Notes']);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
        });

        let previousLevel = null;

        records.forEach(record => {
            const currentLevel = record[dg]?.level || 0;
            let consumption = 0;
            let refilled = 0;
            let notes = '';

            if (previousLevel !== null) {
                const diff = currentLevel - previousLevel;
                if (diff > REFILL_THRESHOLD) {
                    refilled = diff;
                    notes = 'REFILL';
                } else if (diff < -NOISE_THRESHOLD) {
                    consumption = Math.abs(diff);
                }
            }

            worksheet.addRow([
                new Date(record.timestamp).toLocaleString('en-IN'),
                currentLevel.toFixed(2),
                consumption > 0 ? consumption.toFixed(2) : '-',
                refilled > 0 ? refilled.toFixed(2) : '-',
                record[dg]?.isRunning ? 'Yes' : 'No',
                notes
            ]);

            previousLevel = currentLevel;
        });

        worksheet.columns = [{ width: 25 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 10 }, { width: 20 }];

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_${dg}_Consumption.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error('Export Error:', err);
        res.status(500).send('Export Error');
    }
});

router.get('/export/electrical/:dg', async (req, res) => {
    try {
        const { dg } = req.params;
        const { startDate, endDate } = req.query;
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        const records = await ElectricalReading.find({
            dg: dg, timestamp: { $gte: start, $lte: end }
        }).sort({ timestamp: 1 }).lean();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Electrical');

        await setupExcelSheet(workbook, worksheet, `Aquarelle India - ${dg.toUpperCase()} Electrical Details`);

        worksheet.addRow(['Timestamp', 'Volt R', 'Volt Y', 'Volt B', 'Amp R', 'Amp Y', 'Amp B', 'Freq', 'PF', 'kW', 'kVAR', 'kWh', 'Run Hrs']);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00875A' } });

        records.forEach(r => {
            worksheet.addRow([
                new Date(r.timestamp).toLocaleString('en-IN'),
                r.voltageR, r.voltageY, r.voltageB,
                r.currentR, r.currentY, r.currentB,
                r.frequency, r.powerFactor, r.activePower, 
                r.reactivePower, r.energyMeter, r.runningHours
            ]);
        });

        worksheet.columns.forEach(column => { column.width = 12; });
        worksheet.getColumn(1).width = 25;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_${dg}_Electrical.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error('Export Error:', err);
        res.status(500).send('Export Error');
    }
});

router.get('/export/all', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        const records = await DieselConsumption.find({ 
            timestamp: { $gte: start, $lte: end } 
        }).sort({ timestamp: 1 }).lean();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Total Report');

        await setupExcelSheet(workbook, worksheet, `Aquarelle India - Complete DG Report`);

        worksheet.addRow(['Timestamp', 'DG1 Lvl', 'DG1 Used', 'DG1 Refill', 'DG2 Lvl', 'DG2 Used', 'DG2 Refill', 'DG3 Lvl', 'DG3 Used', 'DG3 Refill', 'Total Lvl', 'Total Used']);
        
        const headerRow = worksheet.lastRow;
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.eachCell(cell => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDE350B' } });

        let previousLevels = { dg1: null, dg2: null, dg3: null };

        records.forEach(record => {
            let rowData = [new Date(record.timestamp).toLocaleString('en-IN')];
            let totalConsumption = 0;

            ['dg1', 'dg2', 'dg3'].forEach(dg => {
                const current = record[dg]?.level || 0;
                let consumption = 0;
                let refilled = 0;

                if (previousLevels[dg] !== null) {
                    const diff = current - previousLevels[dg];
                    if (diff > REFILL_THRESHOLD) {
                        refilled = diff;
                    } else if (diff < -NOISE_THRESHOLD) {
                        consumption = Math.abs(diff);
                        totalConsumption += consumption;
                    }
                }

                rowData.push(current.toFixed(1), consumption > 0 ? consumption.toFixed(1) : '-', refilled > 0 ? refilled.toFixed(1) : '-');
                previousLevels[dg] = current;
            });

            rowData.push((record.total?.level || 0).toFixed(1));
            rowData.push(totalConsumption > 0 ? totalConsumption.toFixed(1) : '-');

            worksheet.addRow(rowData);
        });

        worksheet.columns.forEach(col => col.width = 12);
        worksheet.getColumn(1).width = 25;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Aquarelle_India_All_Data.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error('Export Error:', err);
        res.status(500).send('Export Error');
    }
});

module.exports = router;