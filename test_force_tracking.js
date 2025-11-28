const mongoose = require('mongoose');
const { DieselConsumption, ElectricalReading } = require('./models/schemas');
const { getSystemData } = require('./services/plcService');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/dieselDB');
    const systemData = getSystemData();
    const now = new Date();
    
    const record = new DieselConsumption({
        timestamp: now,
        dg1: { level: systemData.dg1, consumption: 0, isRunning: false },
        dg2: { level: systemData.dg2, consumption: 0, isRunning: true },
        dg3: { level: systemData.dg3, consumption: 0, isRunning: false },
        total: { level: systemData.total, consumption: 0 },
        date: now.toISOString().split('T')[0],
        hour: now.getHours(),
        minute: now.getMinutes()
    });
    
    await record.save();
    console.log('✅ Test consumption saved!');
    
    const elec = new ElectricalReading({
        timestamp: now, dg: 'dg2',
        voltageR: 230, voltageY: 230, voltageB: 230,
        currentR: 100, currentY: 100, currentB: 100,
        frequency: 50, powerFactor: 0.8,
        activePower: systemData.electrical.dg2.activePower || 1300,
        reactivePower: systemData.electrical.dg2.reactivePower || 400,
        energyMeter: systemData.electrical.dg2.energyMeter || 9,
        runningHours: systemData.electrical.dg2.runningHours || 44,
        date: now.toISOString().split('T')[0], hour: now.getHours()
    });
    
    await elec.save();
    console.log('✅ Test electrical saved for DG2!');
    console.log('🎉 Now check: https://192.168.30.156:3001/consumption.html?dg=dg2');
    console.log('           and: https://192.168.30.156:3001/electrical.html?dg=dg2');
    process.exit(0);
})();
