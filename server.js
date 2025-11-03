require('dotenv').config();
const ModbusRTU = require("modbus-serial");
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const compression = require('compression');

// ====== MongoDB Setup and Error Handling ======
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/dieselDB";
const mongooseOptions = {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
    maxPoolSize: 10,
    minPoolSize: 2,
    retryWrites: true,
    retryReads: true,
    bufferCommands: false,
    autoIndex: true
};

let isMongoConnected = false;
let connectionAttempts = 0;
const MAX_RETRY_ATTEMPTS = 3;

async function connectMongoDB() {
    connectionAttempts++;
    try {
        console.log(`MongoDB connection attempt ${connectionAttempts}/${MAX_RETRY_ATTEMPTS}...`);
        await mongoose.connect(MONGODB_URI, mongooseOptions);
        console.log('MongoDB Connected Successfully');
        isMongoConnected = true;
        connectionAttempts = 0;
    } catch (err) {
        console.error('MongoDB Connection Error:', err.message);
        if (connectionAttempts < MAX_RETRY_ATTEMPTS) {
            setTimeout(connectMongoDB, 5000);
        } else {
            console.log('MongoDB unavailable after multiple attempts. Running without persistence.');
        }
        isMongoConnected = false;
    }
}

mongoose.connection.on('connected', () => {
    isMongoConnected = true;
    console.log('MongoDB connection established');
});

mongoose.connection.on('disconnected', () => {
    isMongoConnected = false;
    console.log('MongoDB disconnected, attempting reconnection...');
    setTimeout(connectMongoDB, 5000);
});

mongoose.connection.on('error', (err) => {
    isMongoConnected = false;
    console.error('MongoDB error:', err);
});

connectMongoDB();

// ====== Email Setup ======
let emailTransporter = null;
let emailEnabled = false;

try {
    if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) {
        emailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_APP_PASSWORD
            }
        });
        emailEnabled = true;
        console.log('Email alerts enabled');
    } else {
        console.log('Email configuration missing - alerts disabled');
    }
} catch (err) {
    console.error('Email setup error:', err);
    emailEnabled = false;
}

const alertState = {
    lastAlertTime: {},
    currentAlerts: new Set(),
    lastElectricalValues: {}
};

const ALERT_COOLDOWN = parseInt(process.env.ALERT_COOLDOWN) || 3600000; // 30 minutes
const ELECTRICAL_ALERT_COOLDOWN = parseInt(process.env.ELECTRICAL_ALERT_COOLDOWN) || 300000; // 5 minutes
const CRITICAL_LEVEL = parseInt(process.env.CRITICAL_DIESEL_LEVEL) || 50;
const ALERT_RECIPIENTS = process.env.ALERT_RECIPIENTS || '';

// Electrical parameter thresholds for alerts
const ELECTRICAL_THRESHOLDS = {
    voltageMin: 200,
    voltageMax: 250,
    currentMax: 500,
    frequencyMin: 48,
    frequencyMax: 52,
    powerFactorMin: 0.7,
    temperatureMax: 120
};

// ====== DieselReading Schema ======
const DieselReadingSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now, index: true },
    dg1: { type: Number, required: true },
    dg2: { type: Number, required: true },
    dg3: { type: Number, required: true },
    total: { type: Number, required: true },
    dg1_change: { type: Number, default: 0 },
    dg2_change: { type: Number, default: 0 },
    dg3_change: { type: Number, default: 0 },
    hour: { type: Number, index: true },
    date: { type: String, index: true }
});

DieselReadingSchema.index({ date: 1, hour: 1 });
DieselReadingSchema.index({ timestamp: -1 });

const DieselReading = mongoose.model('DieselReading', DieselReadingSchema);

// ====== PLC Configuration ======
const port = process.env.PLC_PORT || '/dev/ttyUSB0';
const plcSettings = {
    baudRate: parseInt(process.env.PLC_BAUD_RATE) || 9600,
    parity: process.env.PLC_PARITY || 'none',
    dataBits: parseInt(process.env.PLC_DATA_BITS) || 8,
    stopBits: parseInt(process.env.PLC_STOP_BITS) || 1
};
const plcSlaveID = parseInt(process.env.PLC_SLAVE_ID) || 1;
const READ_DELAY = 100; // ms between reads
const RETRY_ATTEMPTS = 2;

// ====== Register Mappings with Fallback Support ======
const dgRegisters = {
    dg1: {
        primary: 4104,
        fallback: [4105, 4106],
        name: "DG-1"
    },
    dg2: {
        primary: 4100,
        fallback: [4101, 4102],
        name: "DG-2"
    },
    dg3: {
        primary: 4102,
        fallback: [4103, 4107],
        name: "DG-3"
    }
};

// Enhanced electrical registers with EXTENSIVE fallback options
const electricalRegisters = {
    dg1: {
        voltageR: {
            primary: 4196,
            fallback: [4100, 4101, 4102, 4103, 4104, 4105, 4106, 4107, 4108, 4109, 4110, 4111, 4112, 4113, 4114, 4115, 4116, 4117, 4118, 4119, 4120, 4121, 4122, 4123, 4124],
            scaling: 0.1,
            name: "DG1 Voltage R",
            unit: "V"
        },
        voltageY: {
            primary: 4198,
            fallback: [4125, 4126, 4127, 4128, 4129, 4130, 4131, 4132, 4133, 4134, 4135, 4136, 4137, 4138, 4139, 4140, 4141, 4142, 4143, 4144, 4145, 4146, 4147, 4148, 4149],
            scaling: 0.1,
            name: "DG1 Voltage Y",
            unit: "V"
        },
        voltageB: {
            primary: 4200,
            fallback: [4150, 4151, 4152, 4153, 4154, 4155, 4156, 4157, 4158, 4159, 4160, 4161, 4162, 4163, 4164, 4165, 4166, 4167, 4168, 4169, 4170, 4171, 4172, 4173, 4174],
            scaling: 0.1,
            name: "DG1 Voltage B",
            unit: "V"
        },
        currentR: {
            primary: 4202,
            fallback: [4175, 4176, 4177, 4178, 4179, 4180, 4181, 4182, 4183, 4184, 4185, 4186, 4187, 4188, 4189, 4190, 4191, 4192, 4193, 4194, 4195, 4197, 4199, 4201, 4203],
            scaling: 0.1,
            name: "DG1 Current R",
            unit: "A"
        },
        currentY: {
            primary: 4204,
            fallback: [4205, 4207, 4209, 4211, 4213, 4215, 4217, 4219, 4221, 4223, 4225, 4227, 4229, 4231, 4233, 4235, 4237, 4239, 4241, 4243, 4245, 4247, 4249, 4251, 4253],
            scaling: 0.1,
            name: "DG1 Current Y",
            unit: "A"
        },
        currentB: {
            primary: 4206,
            fallback: [4255, 4257, 4259, 4261, 4263, 4265, 4267, 4269, 4271, 4273, 4275, 4277, 4279, 4281, 4283, 4285, 4287, 4289, 4291, 4293, 4295, 4297, 4299, 4301, 4303],
            scaling: 0.1,
            name: "DG1 Current B",
            unit: "A"
        },
        frequency: {
            primary: 4208,
            fallback: [4305, 4307, 4309, 4311, 4313, 4315, 4317, 4319, 4321, 4323, 4325, 4327, 4329, 4331, 4333, 4335, 4337, 4339, 4341, 4343, 4345, 4347, 4349, 4351, 4353],
            scaling: 0.1,
            name: "DG1 Frequency",
            unit: "Hz"
        },
        powerFactor: {
            primary: 4210,
            fallback: [4355, 4357, 4359, 4361, 4363, 4365, 4367, 4369, 4371, 4373, 4375, 4377, 4379, 4381, 4383, 4385, 4387, 4389, 4391, 4393, 4395, 4397, 4399, 4401, 4403],
            scaling: 0.01,
            name: "DG1 Power Factor",
            unit: ""
        },
        activePower: {
            primary: 4212,
            fallback: [4405, 4407, 4409, 4411, 4413, 4415, 4417, 4419, 4421, 4423, 4425, 4427, 4429, 4431, 4433, 4435, 4437, 4439, 4441, 4443, 4445, 4447, 4449, 4451, 4453],
            scaling: 0.1,
            name: "DG1 Active Power",
            unit: "kW"
        },
        reactivePower: {
            primary: 4214,
            fallback: [4455, 4457, 4459, 4461, 4463, 4465, 4467, 4469, 4471, 4473, 4475, 4477, 4479, 4481, 4483, 4485, 4487, 4489, 4491, 4493, 4495, 4497, 4499, 4501, 4503],
            scaling: 0.1,
            name: "DG1 Reactive Power",
            unit: "kVAR"
        },
        energyMeter: {
            primary: 4216,
            fallback: [4505, 4507, 4509, 4511, 4513, 4515, 4517, 4519, 4521, 4523, 4525, 4527, 4529, 4531, 4533, 4535, 4537, 4539, 4541, 4543, 4545, 4547, 4549, 4551, 4553],
            scaling: 1,
            name: "DG1 Energy Meter",
            unit: "kWh"
        },
        runningHours: {
            primary: 4218,
            fallback: [4555, 4557, 4559, 4561, 4563, 4565, 4567, 4569, 4571, 4573, 4575, 4577, 4579, 4581, 4583, 4585, 4587, 4589, 4591, 4593, 4595, 4597, 4599, 4601, 4603],
            scaling: 1,
            name: "DG1 Running Hours",
            unit: "hrs"
        },
        windingTemp: {
            primary: 4232,
            fallback: [4605, 4607, 4609, 4611, 4613, 4615, 4617, 4619, 4621, 4623, 4625, 4627, 4629, 4631, 4633, 4635, 4637, 4639, 4641, 4643, 4645, 4647, 4649, 4651, 4653],
            scaling: 1,
            name: "DG1 Winding Temperature",
            unit: "°C"
        }
    },
    dg2: {
        voltageR: {
            primary: 4236,
            fallback: [4655, 4657, 4659, 4661, 4663, 4665, 4667, 4669, 4671, 4673, 4675, 4677, 4679, 4681, 4683, 4685, 4687, 4689, 4691, 4693, 4695, 4697, 4699, 4701, 4703],
            scaling: 0.1,
            name: "DG2 Voltage R",
            unit: "V"
        },
        voltageY: {
            primary: 4238,
            fallback: [4705, 4707, 4709, 4711, 4713, 4715, 4717, 4719, 4721, 4723, 4725, 4727, 4729, 4731, 4733, 4735, 4737, 4739, 4741, 4743, 4745, 4747, 4749, 4751, 4753],
            scaling: 0.1,
            name: "DG2 Voltage Y",
            unit: "V"
        },
        voltageB: {
            primary: 4240,
            fallback: [4755, 4757, 4759, 4761, 4763, 4765, 4767, 4769, 4771, 4773, 4775, 4777, 4779, 4781, 4783, 4785, 4787, 4789, 4791, 4793, 4795, 4797, 4799, 4801, 4803],
            scaling: 0.1,
            name: "DG2 Voltage B",
            unit: "V"
        },
        currentR: {
            primary: 4242,
            fallback: [4805, 4807, 4809, 4811, 4813, 4815, 4817, 4819, 4821, 4823, 4825, 4827, 4829, 4831, 4833, 4835, 4837, 4839, 4841, 4843, 4845, 4847, 4849, 4851, 4853],
            scaling: 0.1,
            name: "DG2 Current R",
            unit: "A"
        },
        currentY: {
            primary: 4244,
            fallback: [4855, 4857, 4859, 4861, 4863, 4865, 4867, 4869, 4871, 4873, 4875, 4877, 4879, 4881, 4883, 4885, 4887, 4889, 4891, 4893, 4895, 4897, 4899, 4901, 4903],
            scaling: 0.1,
            name: "DG2 Current Y",
            unit: "A"
        },
        currentB: {
            primary: 4246,
            fallback: [4905, 4907, 4909, 4911, 4913, 4915, 4917, 4919, 4921, 4923, 4925, 4927, 4929, 4931, 4933, 4935, 4937, 4939, 4941, 4943, 4945, 4947, 4949, 4951, 4953],
            scaling: 0.1,
            name: "DG2 Current B",
            unit: "A"
        },
        frequency: {
            primary: 4248,
            fallback: [4955, 4957, 4959, 4961, 4963, 4965, 4967, 4969, 4971, 4973, 4975, 4977, 4979, 4981, 4983, 4985, 4987, 4989, 4991, 4993, 4995, 4997, 4999, 5001, 5003],
            scaling: 0.1,
            name: "DG2 Frequency",
            unit: "Hz"
        },
        powerFactor: {
            primary: 4250,
            fallback: [5005, 5007, 5009, 5011, 5013, 5015, 5017, 5019, 5021, 5023, 5025, 5027, 5029, 5031, 5033, 5035, 5037, 5039, 5041, 5043, 5045, 5047, 5049, 5051, 5053],
            scaling: 0.01,
            name: "DG2 Power Factor",
            unit: ""
        },
        activePower: {
            primary: 4252,
            fallback: [5055, 5057, 5059, 5061, 5063, 5065, 5067, 5069, 5071, 5073, 5075, 5077, 5079, 5081, 5083, 5085, 5087, 5089, 5091, 5093, 5095, 5097, 5099, 5101, 5103],
            scaling: 0.1,
            name: "DG2 Active Power",
            unit: "kW"
        },
        reactivePower: {
            primary: 4254,
            fallback: [5105, 5107, 5109, 5111, 5113, 5115, 5117, 5119, 5121, 5123, 5125, 5127, 5129, 5131, 5133, 5135, 5137, 5139, 5141, 5143, 5145, 5147, 5149, 5151, 5153],
            scaling: 0.1,
            name: "DG2 Reactive Power",
            unit: "kVAR"
        },
        energyMeter: {
            primary: 4256,
            fallback: [5155, 5157, 5159, 5161, 5163, 5165, 5167, 5169, 5171, 5173, 5175, 5177, 5179, 5181, 5183, 5185, 5187, 5189, 5191, 5193, 5195, 5197, 5199, 5201, 5203],
            scaling: 1,
            name: "DG2 Energy Meter",
            unit: "kWh"
        },
        runningHours: {
            primary: 4258,
            fallback: [5205, 5207, 5209, 5211, 5213, 5215, 5217, 5219, 5221, 5223, 5225, 5227, 5229, 5231, 5233, 5235, 5237, 5239, 5241, 5243, 5245, 5247, 5249, 5251, 5253],
            scaling: 1,
            name: "DG2 Running Hours",
            unit: "hrs"
        },
        windingTemp: {
            primary: 4272,
            fallback: [5255, 5257, 5259, 5261, 5263, 5265, 5267, 5269, 5271, 5273, 5275, 5277, 5279, 5281, 5283, 5285, 5287, 5289, 5291, 5293, 5295, 5297, 5299, 5301, 5303],
            scaling: 1,
            name: "DG2 Winding Temperature",
            unit: "°C"
        }
    },
    dg3: {
        voltageR: {
            primary: 4276,
            fallback: [5305, 5307, 5309, 5311, 5313, 5315, 5317, 5319, 5321, 5323, 5325, 5327, 5329, 5331, 5333, 5335, 5337, 5339, 5341, 5343, 5345, 5347, 5349, 5351, 5353],
            scaling: 0.1,
            name: "DG3 Voltage R",
            unit: "V"
        },
        voltageY: {
            primary: 4278,
            fallback: [5355, 5357, 5359, 5361, 5363, 5365, 5367, 5369, 5371, 5373, 5375, 5377, 5379, 5381, 5383, 5385, 5387, 5389, 5391, 5393, 5395, 5397, 5399, 5401, 5403],
            scaling: 0.1,
            name: "DG3 Voltage Y",
            unit: "V"
        },
        voltageB: {
            primary: 4280,
            fallback: [5405, 5407, 5409, 5411, 5413, 5415, 5417, 5419, 5421, 5423, 5425, 5427, 5429, 5431, 5433, 5435, 5437, 5439, 5441, 5443, 5445, 5447, 5449, 5451, 5453],
            scaling: 0.1,
            name: "DG3 Voltage B",
            unit: "V"
        },
        currentR: {
            primary: 4282,
            fallback: [5455, 5457, 5459, 5461, 5463, 5465, 5467, 5469, 5471, 5473, 5475, 5477, 5479, 5481, 5483, 5485, 5487, 5489, 5491, 5493, 5495, 5497, 5499, 5501, 5503],
            scaling: 0.1,
            name: "DG3 Current R",
            unit: "A"
        },
        currentY: {
            primary: 4284,
            fallback: [5505, 5507, 5509, 5511, 5513, 5515, 5517, 5519, 5521, 5523, 5525, 5527, 5529, 5531, 5533, 5535, 5537, 5539, 5541, 5543, 5545, 5547, 5549, 5551, 5553],
            scaling: 0.1,
            name: "DG3 Current Y",
            unit: "A"
        },
        currentB: {
            primary: 4286,
            fallback: [5555, 5557, 5559, 5561, 5563, 5565, 5567, 5569, 5571, 5573, 5575, 5577, 5579, 5581, 5583, 5585, 5587, 5589, 5591, 5593, 5595, 5597, 5599, 5601, 5603],
            scaling: 0.1,
            name: "DG3 Current B",
            unit: "A"
        },
        frequency: {
            primary: 4288,
            fallback: [5605, 5607, 5609, 5611, 5613, 5615, 5617, 5619, 5621, 5623, 5625, 5627, 5629, 5631, 5633, 5635, 5637, 5639, 5641, 5643, 5645, 5647, 5649, 5651, 5653],
            scaling: 0.1,
            name: "DG3 Frequency",
            unit: "Hz"
        },
        powerFactor: {
            primary: 4290,
            fallback: [5655, 5657, 5659, 5661, 5663, 5665, 5667, 5669, 5671, 5673, 5675, 5677, 5679, 5681, 5683, 5685, 5687, 5689, 5691, 5693, 5695, 5697, 5699, 5701, 5703],
            scaling: 0.01,
            name: "DG3 Power Factor",
            unit: ""
        },
        activePower: {
            primary: 4292,
            fallback: [5705, 5707, 5709, 5711, 5713, 5715, 5717, 5719, 5721, 5723, 5725, 5727, 5729, 5731, 5733, 5735, 5737, 5739, 5741, 5743, 5745, 5747, 5749, 5751, 5753],
            scaling: 0.1,
            name: "DG3 Active Power",
            unit: "kW"
        },
        reactivePower: {
            primary: 4294,
            fallback: [5755, 5757, 5759, 5761, 5763, 5765, 5767, 5769, 5771, 5773, 5775, 5777, 5779, 5781, 5783, 5785, 5787, 5789, 5791, 5793, 5795, 5797, 5799, 5801, 5803],
            scaling: 0.1,
            name: "DG3 Reactive Power",
            unit: "kVAR"
        },
        energyMeter: {
            primary: 4296,
            fallback: [5805, 5807, 5809, 5811, 5813, 5815, 5817, 5819, 5821, 5823, 5825, 5827, 5829, 5831, 5833, 5835, 5837, 5839, 5841, 5843, 5845, 5847, 5849, 5851, 5853],
            scaling: 1,
            name: "DG3 Energy Meter",
            unit: "kWh"
        },
        runningHours: {
            primary: 4298,
            fallback: [5855, 5857, 5859, 5861, 5863, 5865, 5867, 5869, 5871, 5873, 5875, 5877, 5879, 5881, 5883, 5885, 5887, 5889, 5891, 5893, 5895, 5897, 5899, 5901, 5903],
            scaling: 1,
            name: "DG3 Running Hours",
            unit: "hrs"
        },
        windingTemp: {
            primary: 4312,
            fallback: [5905, 5907, 5909, 5911, 5913, 5915, 5917, 5919, 5921, 5923, 5925, 5927, 5929, 5931, 5933, 5935, 5937, 5939, 5941, 5943, 5945, 5947, 5949, 5951, 5953],
            scaling: 1,
            name: "DG3 Winding Temperature",
            unit: "°C"
        }
    }
};

// Track which registers are working for each parameter
const workingRegisters = {};

// ====== System State ======
let systemData = {
    dg1: 0,
    dg2: 0,
    dg3: 0,
    total: 0,
    lastUpdate: null,
    electrical: {
        dg1: {},
        dg2: {},
        dg3: {}
    }
};

let previousReading = null;
let previousDieselData = { dg1: 0, dg2: 0, dg3: 0 };
let lastSavedHour = -1;

// ====== PLC Client ======
const client = new ModbusRTU();
let isPlcConnected = false;

// ====== Express Setup ======
const app = express();
const webServerPort = parseInt(process.env.PORT) || 3000;

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname, { maxAge: '1d', etag: true, lastModified: true }));

app.use((req, res, next) => {
    if (req.url.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
    }
    next();
});

// ====== Utility Functions ======
function toSignedInt16(value) {
    if (value > 32767) return value - 65536;
    return value;
}

function isValidReading(value) {
    const signedValue = toSignedInt16(value);
    if (value === 65535 || value === 65534 || signedValue === -1) return false;
    return signedValue >= 0 && signedValue <= 600;
}

function isValidElectricalReading(value, min = -9999, max = 9999) {
    if (value === 65535 || value === 65534 || value < 0) return false;
    return value >= min && value <= max;
}

function smoothValue(currentValue, previousValue, maxChangePercent = 50) {
    if (previousValue === 0 || previousValue === null) return currentValue;
    const changePercent = Math.abs((currentValue - previousValue) / previousValue * 100);
    if (changePercent > maxChangePercent) {
        console.log(`Smoothing applied: ${currentValue} -> ${previousValue} (${changePercent.toFixed(1)}% change)`);
        return previousValue;
    }
    return currentValue;
}

// ====== Modbus Reading Functions with Retry and Fallback ======
async function readWithRetry(readFunc, retries = RETRY_ATTEMPTS) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const result = await readFunc();
            return result;
        } catch (err) {
            if (attempt === retries - 1) {
                throw err;
            }
            await new Promise(resolve => setTimeout(resolve, READ_DELAY));
        }
    }
}

// Enhanced diesel register reading with fallback
async function readSingleRegister(registerConfig, dataKey) {
    const addresses = [registerConfig.primary, ...(registerConfig.fallback || [])];
    
    for (let i = 0; i < addresses.length; i++) {
        const address = addresses[i];
        try {
            const data = await readWithRetry(() => client.readHoldingRegisters(address, 1));
            
            if (!data || !data.data || data.data.length < 1) {
                console.log(`No data from register ${address} for ${registerConfig.name}`);
                continue;
            }

            const rawValue = data.data[0];
            if (!isValidReading(rawValue)) {
                console.log(`Invalid reading from register ${address} for ${registerConfig.name}: ${rawValue}`);
                continue;
            }

            const signedValue = toSignedInt16(rawValue);
            let value = Math.max(0, signedValue);
            
            const previousValue = previousDieselData[dataKey] || 0;
            value = smoothValue(value, previousValue, 30);
            
            previousDieselData[dataKey] = value;
            systemData[dataKey] = value;
            
            if (i > 0) {
                console.log(`✓ Used fallback register ${address} for ${registerConfig.name}: ${value}`);
            }
            
            return value;
        } catch (err) {
            console.log(`Failed to read register ${address} for ${registerConfig.name}: ${err.message}`);
            if (i === addresses.length - 1) {
                return systemData[dataKey] || 0;
            }
        }
    }
    
    return systemData[dataKey] || 0;
}

// Enhanced electrical register reading with register tracking
async function readElectricalRegister(regConfig, paramKey, defaultValue = 0) {
    const addresses = [regConfig.primary, ...(regConfig.fallback || [])];
    
    for (let i = 0; i < addresses.length; i++) {
        const address = addresses[i];
        try {
            const data = await readWithRetry(() => client.readHoldingRegisters(address, 1));
            
            if (!data || !data.data || data.data.length < 1) {
                continue;
            }
            
            const raw = data.data[0];
            if (!isValidElectricalReading(raw)) {
                continue;
            }
            
            const value = Math.round(raw * regConfig.scaling * 100) / 100;
            
            // Track which register worked
            const registerInfo = {
                address: address,
                type: i === 0 ? 'PRIMARY' : `FALLBACK-${i}`,
                value: value,
                registerName: `D${address - 4096}`,
                decimalAddress: address,
                hexAddress: `0x${address.toString(16).toUpperCase()}`
            };
            
            if (i > 0) {
                console.log(`✓ FALLBACK SUCCESS: Register ${address} (D${address - 4096}) for ${regConfig.name}: ${value}`);
            }
            
            return { value, registerInfo };
        } catch (err) {
            if (i === addresses.length - 1) {
                return { value: defaultValue, registerInfo: null };
            }
        }
    }
    
    return { value: defaultValue, registerInfo: null };
}

async function readAllElectrical(dgKey) {
    const result = {};
    const registerMap = {};
    const regs = electricalRegisters[dgKey];
    
    for (const key in regs) {
        const { value, registerInfo } = await readElectricalRegister(regs[key], key);
        result[key] = value;
        
        if (registerInfo) {
            registerMap[key] = registerInfo;
        }
        
        await new Promise(resolve => setTimeout(resolve, READ_DELAY));
    }
    
    return { values: result, registerMap };
}

/**
 * Checks for significant changes and threshold violations in electrical parameters.
 * IMPORTANT: Suppresses V/Hz alerts if Active Power is close to zero (assumes DG is off).
 */
function checkElectricalChanges(dgKey, newValues, registerMap) {
    const lastKey = `electrical_${dgKey}`;
    const previousValues = alertState.lastElectricalValues[lastKey] || {};
    const changes = [];
    const alerts = [];

    // Determine if the DG is running. Assume it's OFF if Active Power is < 5 kW.
    const IS_DG_RUNNING = newValues.activePower > 5; // Use 5 kW as a practical threshold to filter noise

    for (const param in newValues) {
        const newVal = newValues[param];
        const oldVal = previousValues[param];
        
        const regConfig = electricalRegisters[dgKey][param];
        const unit = regConfig ? regConfig.unit : '';
        const thresholds = ELECTRICAL_THRESHOLDS;

        // 1. Check for significant changes
        if (oldVal !== undefined && newVal !== oldVal) {
            const changePercent = Math.abs((newVal - oldVal) / (oldVal || 1) * 100); 
            
            if (changePercent > 10) {
                changes.push({
                    parameter: param,
                    oldValue: oldVal,
                    newValue: newVal,
                    changePercent: changePercent.toFixed(2)
                });
            }
        }

        // 2. Check for threshold violations (CRITICAL ALERTS)
        
        // Suppress V/Hz/PF alerts if the DG is not running.
        if (!IS_DG_RUNNING && (param.includes('voltage') || param === 'frequency' || param === 'powerFactor')) {
             if (newVal === 0) {
                 continue; // Suppress alert for zero values when DG is off
             }
        }

        if (param.includes('voltage')) {
            if (newVal < thresholds.voltageMin || newVal > thresholds.voltageMax) {
                alerts.push({
                    parameter: param,
                    value: newVal,
                    threshold: `${thresholds.voltageMin}-${thresholds.voltageMax}${unit}`,
                    severity: 'critical'
                });
            }
        } else if (param.includes('current')) {
            if (newVal > thresholds.currentMax) {
                alerts.push({
                    parameter: param,
                    value: newVal,
                    threshold: `Max ${thresholds.currentMax}${unit}`,
                    severity: 'warning'
                });
            }
        } else if (param === 'frequency') {
            if (newVal < thresholds.frequencyMin || newVal > thresholds.frequencyMax) {
                alerts.push({
                    parameter: param,
                    value: newVal,
                    threshold: `${thresholds.frequencyMin}-${thresholds.frequencyMax}${unit}`,
                    severity: 'critical'
                });
            }
        } else if (param === 'powerFactor') {
            if (newVal < thresholds.powerFactorMin) {
                alerts.push({
                    parameter: param,
                    value: newVal,
                    threshold: `Min ${thresholds.powerFactorMin}`,
                    severity: 'warning'
                });
            }
        } else if (param === 'windingTemp') {
            if (newVal > thresholds.temperatureMax) {
                alerts.push({
                    parameter: param,
                    value: newVal,
                    threshold: `Max ${thresholds.temperatureMax}${unit}`,
                    severity: 'critical'
                });
            }
        }
    }

    // Store current values for next comparison
    alertState.lastElectricalValues[lastKey] = { ...newValues };

    // Only send email if actual threshold violations (alerts) were detected.
    if (alerts.length > 0) {
        console.log(`[${dgKey.toUpperCase()}] CRITICAL ALERT TRIGGERED (DG Running: ${IS_DG_RUNNING}):`, alerts);
        sendElectricalAlert(dgKey, changes, alerts, newValues, registerMap);
    } else if (changes.length > 0) {
        // Log changes, but DO NOT send email
        // Log only if the DG is actually producing power, otherwise, it's just noise.
        if (IS_DG_RUNNING) {
            console.log(`[${dgKey.toUpperCase()}] Significant Changes Detected (No Critical Alert):`, changes);
        }
    }
}

// ====== Main Data Reading ======
let errorCount = 0;
const MAX_ERRORS = 10;

async function readAllSystemData() {
    if (!isPlcConnected) {
        return;
    }

    try {
        // Read diesel levels with fallback support
        await readSingleRegister(dgRegisters.dg1, 'dg1');
        await new Promise(resolve => setTimeout(resolve, READ_DELAY));
        
        await readSingleRegister(dgRegisters.dg2, 'dg2');
        await new Promise(resolve => setTimeout(resolve, READ_DELAY));
        
        await readSingleRegister(dgRegisters.dg3, 'dg3');
        await new Promise(resolve => setTimeout(resolve, READ_DELAY));
        
        systemData.total = (systemData.dg1 || 0) + (systemData.dg2 || 0) + (systemData.dg3 || 0);
        
        // Read electrical parameters with fallback and register tracking
        const dg1Result = await readAllElectrical('dg1');
        systemData.electrical.dg1 = dg1Result.values;
        workingRegisters.dg1 = dg1Result.registerMap;
        checkElectricalChanges('dg1', systemData.electrical.dg1, dg1Result.registerMap);
        
        const dg2Result = await readAllElectrical('dg2');
        systemData.electrical.dg2 = dg2Result.values;
        workingRegisters.dg2 = dg2Result.registerMap;
        checkElectricalChanges('dg2', systemData.electrical.dg2, dg2Result.registerMap);
        
        const dg3Result = await readAllElectrical('dg3');
        systemData.electrical.dg3 = dg3Result.values;
        workingRegisters.dg3 = dg3Result.registerMap;
        checkElectricalChanges('dg3', systemData.electrical.dg3, dg3Result.registerMap);
        
        systemData.lastUpdate = new Date().toISOString();
        
        // Check for diesel level alerts
        checkDieselLevels(systemData);
        
        // Save to database
        await saveToDatabase(systemData);
        
        // Reset error count on success
        errorCount = 0;
        
    } catch (err) {
        errorCount++;
        console.error(`Error reading system data (${errorCount}/${MAX_ERRORS}):`, err.message);
        
        if (errorCount >= MAX_ERRORS) {
            console.log('Too many errors, reconnecting PLC...');
            isPlcConnected = false;
            errorCount = 0;
            client.close();
            setTimeout(connectToPLC, 5000);
        }
    }
}

// ====== Database Operations ======
function calculateChange(current, previous) {
    if (!previous) return 0;
    return current - previous;
}

async function saveToDatabase(data) {
    if (!isMongoConnected) return;

    try {
        const now = new Date();
        const currentHour = now.getHours();
        
        if (currentHour === lastSavedHour) return;
        
        const dateString = now.toISOString().split('T')[0];
        
        const changes = {
            dg1_change: calculateChange(data.dg1, previousReading?.dg1),
            dg2_change: calculateChange(data.dg2, previousReading?.dg2),
            dg3_change: calculateChange(data.dg3, previousReading?.dg3)
        };
        
        const reading = new DieselReading({
            timestamp: now,
            dg1: data.dg1,
            dg2: data.dg2,
            dg3: data.dg3,
            total: data.total,
            hour: currentHour,
            date: dateString,
            ...changes
        });
        
        await reading.save();
        console.log(`Saved reading for ${dateString} ${currentHour}:00`);
        
        lastSavedHour = currentHour;
        previousReading = { dg1: data.dg1, dg2: data.dg2, dg3: data.dg3 };
        
    } catch (err) {
        console.error('Database save error:', err.message);
    }
}

// ====== Alert System ======
function checkDieselLevels(data) {
    const criticalDGs = [];
    
    if (data.dg1 <= CRITICAL_LEVEL) criticalDGs.push('DG-1');
    if (data.dg2 <= CRITICAL_LEVEL) criticalDGs.push('DG-2');
    if (data.dg3 <= CRITICAL_LEVEL) criticalDGs.push('DG-3');
    
    if (criticalDGs.length > 0) {
        sendEmailAlert('critical', data, criticalDGs);
    }
}

// **CORRECTED DIESEL ALERT TEMPLATE FUNCTION**
function getEmailTemplate(alertType, data, criticalDGs) {
    const timestamp = new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'full',
        timeStyle: 'long'
    });
    
    const dashboardUrl = `http://${process.env.PI_IP_ADDRESS || '192.168.30.156'}:${webServerPort}`;
    
    return {
        subject: '⚠️ CRITICAL ALERT: Low Diesel Levels Detected',
        html: `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #ef4444, #dc2626); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; }
        .alert-box { background: #fef2f2; border-left: 4px solid #ef4444; padding: 15px; margin: 15px 0; }
        .levels { background: white; padding: 15px; border-radius: 8px; margin: 15px 0; }
        .level-item { display: flex; justify-content: space-between; padding: 10px; border-bottom: 1px solid #e5e7eb; }
        .critical { color: #ef4444; font-weight: bold; }
        .warning { color: #f59e0b; }
        .ok { color: #10b981; }
        .button { display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 15px 0; }
        .footer { background: #f3f4f6; padding: 15px; text-align: center; font-size: 12px; color: #6b7280; border-radius: 0 0 8px 8px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin:0;">⚠️ CRITICAL DIESEL ALERT</h1>
            <p style="margin:10px 0 0 0;">DG Monitoring System</p>
        </div>
        
        <div class="content">
            <div class="alert-box">
                <strong>URGENT:</strong> Low diesel levels detected in ${criticalDGs.join(', ')}
            </div>
            
            <div class="levels">
                <h3 style="margin-top:0;">Current Diesel Levels</h3>
                <div class="level-item">
                    <span>DG-1:</span>
                    <span class="${data.dg1 <= CRITICAL_LEVEL ? 'critical' : data.dg1 <= 100 ? 'warning' : 'ok'}">${data.dg1} Liters</span>
                </div>
                <div class="level-item">
                    <span>DG-2:</span>
                    <span class="${data.dg2 <= CRITICAL_LEVEL ? 'critical' : data.dg2 <= 100 ? 'warning' : 'ok'}">${data.dg2} Liters</span>
                </div>
                <div class="level-item">
                    <span>DG-3:</span>
                    <span class="${data.dg3 <= CRITICAL_LEVEL ? 'critical' : data.dg3 <= 100 ? 'warning' : 'ok'}">${data.dg3} Liters</span>
                </div>
                <div class="level-item" style="border-bottom:none; font-weight:bold;">
                    <span>Total:</span>
                    <span>${data.total} Liters</span>
                </div>
            </div>
            
            <p><strong>Alert Time:</strong> ${timestamp}</p>
            
            <a href="${dashboardUrl}" class="button">View Live Dashboard</a>
            
            <p style="font-size: 14px; color: #6b7280; margin-top: 20px;">
                <strong>Action Required:</strong> Please refuel the affected generators immediately to prevent power disruptions.
            </p>
        </div>
        
        <div class="footer">
            <p>This is an automated alert from the DG Monitoring System.</p>
            <p>Dashboard: <a href="${dashboardUrl}">${dashboardUrl}</a></p>
        </div>
    </div>
</body>
</html>
        `
    };
}

// **CORRECTED ELECTRICAL ALERT TEMPLATE FUNCTION**
function getElectricalAlertTemplate(dgName, changes, alerts, currentValues, registerMap) {
    const timestamp = new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'full',
        timeStyle: 'long'
    });
    
    const dashboardUrl = `http://${process.env.PI_IP_ADDRESS || '192.168.30.156'}:${webServerPort}`;
    
    // Generate register mapping table
    let registerMappingHtml = '';
    if (registerMap && Object.keys(registerMap).length > 0) {
        registerMappingHtml = `
            <div class="section" style="background: #f0f9ff; border: 2px solid #3b82f6; padding: 15px; margin: 15px 0; border-radius: 8px;">
                <h3 style="color: #1e40af; margin-top: 0;">📍 WORKING REGISTER MAP - ${dgName}</h3>
                <p style="color: #1e3a8a; font-weight: bold;">These registers successfully read the data:</p>
                <table style="width:100%; border-collapse: collapse; background: white;">
                    <tr style="background:#dbeafe;">
                        <th style="padding:10px; text-align:left; border:1px solid #93c5fd;">Parameter</th>
                        <th style="padding:10px; text-align:left; border:1px solid #93c5fd;">Register Type</th>
                        <th style="padding:10px; text-align:left; border:1px solid #93c5fd;">Register Name</th>
                        <th style="padding:10px; text-align:left; border:1px solid #93c5fd;">Decimal Addr</th>
                        <th style="padding:10px; text-align:left; border:1px solid #93c5fd;">Hex Addr</th>
                        <th style="padding:10px; text-align:left; border:1px solid #93c5fd;">Value</th>
                    </tr>
                    ${Object.entries(registerMap).map(([param, info]) => `
                        <tr style="${info.type !== 'PRIMARY' ? 'background:#fef3c7;' : ''}">
                            <td style="padding:10px; border:1px solid #93c5fd; font-weight: bold;">${param}</td>
                            <td style="padding:10px; border:1px solid #93c5fd;">
                                <span style="background:${info.type === 'PRIMARY' ? '#10b981' : '#f59e0b'}; color:white; padding:4px 8px; border-radius:4px; font-size:12px; font-weight:bold;">
                                    ${info.type}
                                </span>
                            </td>
                            <td style="padding:10px; border:1px solid #93c5fd; font-weight: bold;">${info.registerName}</td>
                            <td style="padding:10px; border:1px solid #93c5fd;">${info.decimalAddress}</td>
                            <td style="padding:10px; border:1px solid #93c5fd;">${info.hexAddress}</td>
                            <td style="padding:10px; border:1px solid #93c5fd; font-weight: bold;">${info.value}</td>
                        </tr>
                    `).join('')}
                </table>
                <p style="margin-top: 10px; font-size: 12px; color: #1e3a8a;">
                    <strong>Legend:</strong>
                    <span style="background:#10b981; color:white; padding:2px 6px; border-radius:3px; margin-left:5px;">PRIMARY</span> = Primary register working |
                    <span style="background:#f59e0b; color:white; padding:2px 6px; border-radius:3px; margin-left:5px;">FALLBACK</span> = Fallback register used
                </p>
            </div>
        `;
    }
    
    let changesHtml = '';
    if (changes.length > 0) {
        changesHtml = `
            <div class="section">
                <h3>⚡ Parameter Changes Detected</h3>
                <table style="width:100%; border-collapse: collapse;">
                    <tr style="background:#f3f4f6;">
                        <th style="padding:10px; text-align:left; border:1px solid #e5e7eb;">Parameter</th>
                        <th style="padding:10px; text-align:left; border:1px solid #e5e7eb;">Old Value</th>
                        <th style="padding:10px; text-align:left; border:1px solid #e5e7eb;">New Value</th>
                        <th style="padding:10px; text-align:left; border:1px solid #e5e7eb;">Change %</th>
                    </tr>
                    ${changes.map(c => `
                        <tr>
                            <td style="padding:10px; border:1px solid #e5e7eb;">${c.parameter}</td>
                            <td style="padding:10px; border:1px solid #e5e7eb;">${c.oldValue}</td>
                            <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">${c.newValue}</td>
                            <td style="padding:10px; border:1px solid #e5e7eb; color:#f59e0b;">${c.changePercent}%</td>
                        </tr>
                    `).join('')}
                </table>
            </div>
        `;
    }
    
    let alertsHtml = '';
    if (alerts.length > 0) {
        alertsHtml = `
            <div class="alert-box" style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 15px; margin: 15px 0;">
                <h3>🚨 THRESHOLD VIOLATIONS</h3>
                <table style="width:100%; border-collapse: collapse;">
                    <tr style="background:#fee2e2;">
                        <th style="padding:10px; text-align:left; border:1px solid #fecaca;">Parameter</th>
                        <th style="padding:10px; text-align:left; border:1px solid #fecaca;">Current Value</th>
                        <th style="padding:10px; text-align:left; border:1px solid #fecaca;">Threshold</th>
                        <th style="padding:10px; text-align:left; border:1px solid #fecaca;">Severity</th>
                    </tr>
                    ${alerts.map(a => `
                        <tr>
                            <td style="padding:10px; border:1px solid #fecaca;">${a.parameter}</td>
                            <td style="padding:10px; border:1px solid #fecaca; font-weight:bold; color:#dc2626;">${a.value}</td>
                            <td style="padding:10px; border:1px solid #fecaca;">${a.threshold}</td>
                            <td style="padding:10px; border:1px solid #fecaca;">
                                <span style="background:${a.severity === 'critical' ? '#dc2626' : '#f59e0b'}; color:white; padding:4px 8px; border-radius:4px; font-size:12px;">
                                    ${a.severity.toUpperCase()}
                                </span>
                            </td>
                        </tr>
                    `).join('')}
                </table>
            </div>
        `;
    }
    
    return {
        subject: `⚡ ${dgName} Electrical Parameters Alert - Register Mapping Included`,
        html: `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 900px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; }
        .section { background: white; padding: 15px; border-radius: 8px; margin: 15px 0; }
        .button { display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 15px 0; }
        .footer { background: #f3f4f6; padding: 15px; text-align: center; font-size: 12px; color: #6b7280; border-radius: 0 0 8px 8px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin:0;">⚡ Electrical Parameters Alert</h1>
            <p style="margin:10px 0 0 0;">${dgName} - DG Monitoring System</p>
        </div>
        
        <div class="content">
            ${registerMappingHtml}
            ${alertsHtml}
            ${changesHtml}
            
            <div class="section">
                <h3>📊 Current Electrical Parameters</h3>
                <table>
                    <tr style="background:#f3f4f6;">
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Voltage R</td>
                        <td style="padding:10px; border:1px solid #e5e7eb;">${currentValues.voltageR || 0} V</td>
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Current R</td>
                        <td style="padding:10px; border:1px solid #e5e7eb;">${currentValues.currentR || 0} A</td>
                    </tr>
                    <tr>
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Voltage Y</td>
                        <td style="padding:10px; border:1px solid #e5e7eb;">${currentValues.voltageY || 0} V</td>
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Current Y</td>
                        <td style="padding:10px; border:1px solid #e5e7eb;">${currentValues.currentY || 0} A</td>
                    </tr>
                    <tr style="background:#f3f4f6;">
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Voltage B</td>
                        <td style="padding:10px; border:1px solid #e5e7eb;">${currentValues.voltageB || 0} V</td>
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Current B</td>
                        <td style="padding:10px; border:1px solid #e5e7eb;">${currentValues.currentB || 0} A</td>
                    </tr>
                    <tr>
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Frequency</td>
                        <td style="padding:10px; border:1px solid #e5e7eb;">${currentValues.frequency || 0} Hz</td>
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Power Factor</td>
                        <td style="padding:10px; border:1px solid #e5e7eb;">${currentValues.powerFactor || 0}</td>
                    </tr>
                    <tr style="background:#f3f4f6;">
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Active Power</td>
                        <td style="padding:10px; border:1px solid #e5e7eb;">${currentValues.activePower || 0} kW</td>
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Reactive Power</td>
                        <td style="padding:10px; border:1px solid #e5e7eb;">${currentValues.reactivePower || 0} kVAR</td>
                    </tr>
                    <tr>
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Winding Temp</td>
                        <td style="padding:10px; border:1px solid #e5e7eb;">${currentValues.windingTemp || 0} °C</td>
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Running Hours</td>
                        <td style="padding:10px; border:1px solid #e5e7eb;">${currentValues.runningHours || 0} hrs</td>
                    </tr>
                    <tr style="background:#f3f4f6;">
                        <td style="padding:10px; border:1px solid #e5e7eb; font-weight:bold;">Energy Meter</td>
                        <td colspan="3" style="padding:10px; border:1px solid #e5e7eb;">${currentValues.energyMeter || 0} kWh</td>
                    </tr>
                </table>
            </div>
            
            <p><strong>Alert Time:</strong> ${timestamp}</p>
            
            <a href="${dashboardUrl}" class="button">View Live Dashboard</a>
            
            <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 15px 0;">
                <p style="margin: 0; font-weight: bold; color: #92400e;">⚠️ Action Required:</p>
                <p style="margin: 5px 0 0 0; color: #78350f;">Please check the generator immediately and verify all electrical parameters are within safe operating ranges. The register mapping above shows which PLC registers are currently providing data.</p>
            </div>
        </div>
        
        <div class="footer">
            <p>This is an automated alert from the DG Monitoring System with Register Mapping.</p>
            <p>Dashboard: <a href="${dashboardUrl}">${dashboardUrl}</a></p>
            <p style="margin-top: 10px; font-size: 11px;">Register information helps identify which PLC data registers are successfully communicating.</p>
        </div>
    </div>
</body>
</html>
        `
    };
}


async function sendElectricalAlert(dgKey, changes, alerts, currentValues, registerMap) {
    if (!emailEnabled || !ALERT_RECIPIENTS) {
        console.log('Email alerts disabled or no recipients configured');
        return;
    }

    const alertKey = `electrical_${dgKey}_${Math.floor(Date.now() / ELECTRICAL_ALERT_COOLDOWN)}`;
    
    if (alertState.currentAlerts.has(alertKey)) {
        console.log(`Electrical alert for ${dgKey} already sent recently, skipping...`);
        return;
    }

    try {
        const dgName = dgKey.toUpperCase().replace('dg', 'DG-');
        // Pass the registerMap to the template function
        const template = getElectricalAlertTemplate(dgName, changes, alerts, currentValues, registerMap);
        
        await emailTransporter.sendMail({
            from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`,
            to: ALERT_RECIPIENTS,
            subject: template.subject,
            html: template.html
        });
        
        console.log(`⚡ Electrical alert email sent for ${dgName} to ${ALERT_RECIPIENTS}`);
        console.log(`Register Map:`, JSON.stringify(registerMap, null, 2));
        
        alertState.currentAlerts.add(alertKey);
        setTimeout(() => alertState.currentAlerts.delete(alertKey), ELECTRICAL_ALERT_COOLDOWN);
        
    } catch (err) {
        console.error('Email sending error:', err.message);
    }
}

async function sendEmailAlert(alertType, data, criticalDGs) {
    if (!emailEnabled || !ALERT_RECIPIENTS) {
        console.log('Email alerts disabled or no recipients configured');
        return;
    }

    const alertKey = `${alertType}_${Math.floor(Date.now() / ALERT_COOLDOWN)}`;
    
    if (alertState.currentAlerts.has(alertKey)) {
        console.log('Alert already sent recently, skipping...');
        return;
    }

    try {
        // Use the corrected Diesel alert template function
        const template = getEmailTemplate(alertType, data, criticalDGs);
        
        await emailTransporter.sendMail({
            from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`,
            to: ALERT_RECIPIENTS,
            subject: template.subject,
            html: template.html
        });
        
        console.log(`Alert email sent to ${ALERT_RECIPIENTS}`);
        
        alertState.currentAlerts.add(alertKey);
        setTimeout(() => alertState.currentAlerts.delete(alertKey), ALERT_COOLDOWN);
        
    } catch (err) {
        console.error('Email sending error:', err.message);
    }
}

// ====== PLC Connection ======
function connectToPLC() {
    console.log(`Attempting to connect to PLC on ${port}...`);
    
    client.connectRTU(port, plcSettings)
        .then(() => {
            client.setID(plcSlaveID);
            client.setTimeout(5000);
            isPlcConnected = true;
            errorCount = 0;
            console.log('✓ PLC connected successfully');
            
            setTimeout(() => {
                readAllSystemData();
                setInterval(readAllSystemData, 5000);
            }, 2000);
        })
        .catch((err) => {
            console.error('PLC connection error:', err.message);
            isPlcConnected = false;
            client.close();
            setTimeout(connectToPLC, 10000);
        });
}

// ====== API Endpoints ======
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/data', (req, res) => {
    res.json({
        timestamp: systemData.lastUpdate || new Date().toISOString(),
        dg1: systemData.dg1,
        dg2: systemData.dg2,
        dg3: systemData.dg3,
        total: systemData.total,
        electrical: systemData.electrical
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'running',
        timestamp: new Date().toISOString(),
        mongodb: isMongoConnected ? 'connected' : 'disconnected',
        plc: isPlcConnected ? 'connected' : 'disconnected',
        lastDataUpdate: systemData.lastUpdate,
        systemStatus: {
            totalDiesel: systemData.total,
            dg1: systemData.dg1,
            dg2: systemData.dg2,
            dg3: systemData.dg3
        },
        electrical: systemData.electrical,
        workingRegisters: workingRegisters,
        emailAlerts: emailEnabled ? 'enabled' : 'disabled'
    });
});

app.get('/api/registers/test', (req, res) => {
    res.json({
        dieselRegisters: dgRegisters,
        electricalRegisters: Object.keys(electricalRegisters).reduce((acc, dgKey) => {
            acc[dgKey] = Object.keys(electricalRegisters[dgKey]).reduce((params, param) => {
                const reg = electricalRegisters[dgKey][param];
                params[param] = {
                    primary: reg.primary,
                    fallback: reg.fallback,
                    name: reg.name
                };
                return params;
            }, {});
            return acc;
        }, {}),
        currentlyWorking: workingRegisters
    });
});

app.get('/api/history/:days', async (req, res) => {
    if (!isMongoConnected) {
        return res.status(503).json({
            success: false,
            error: 'Database not available'
        });
    }

    try {
        const days = parseInt(req.params.days) || 7;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        
        const readings = await DieselReading.find({
            timestamp: { $gte: startDate }
        }).sort({ timestamp: 1 }).limit(1000);
        
        res.json({
            success: true,
            count: readings.length,
            data: readings
        });
    } catch (err) {
        console.error('History query error:', err);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch history'
        });
    }
});

app.get('/api/stats/daily', async (req, res) => {
    if (!isMongoConnected) {
        return res.status(503).json({
            success: false,
            error: 'Database not available'
        });
    }

    try {
        const today = new Date().toISOString().split('T')[0];
        
        const readings = await DieselReading.find({ date: today }).sort({ hour: 1 });
        
        const stats = {
            date: today,
            readings: readings.length,
            hourlyData: readings,
            totalConsumption: {
                dg1: readings.reduce((sum, r) => sum + (r.dg1_change || 0), 0),
                dg2: readings.reduce((sum, r) => sum + (r.dg2_change || 0), 0),
                dg3: readings.reduce((sum, r) => sum + (r.dg3_change || 0), 0)
            }
        };
        
        res.json({
            success: true,
            data: stats
        });
    } catch (err) {
        console.error('Daily stats error:', err);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch daily stats'
        });
    }
});

// ====== Graceful Shutdown ======
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    try {
        client.close();
        await mongoose.connection.close();
        console.log('Connections closed');
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down...');
    try {
        client.close();
        await mongoose.connection.close();
        console.log('Connections closed');
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
});

// ====== Start Server ======
app.listen(webServerPort, () => {
    console.log(`\n===========================================`);
    console.log(`DG Monitoring System Server Started`);
    console.log(`===========================================`);
    console.log(`Web Server: http://localhost:${webServerPort}`);
    console.log(`PLC Port: ${port}`);
    console.log(`MongoDB: ${MONGODB_URI}`);
    console.log(`Email Alerts: ${emailEnabled ? 'Enabled' : 'Disabled'}`);
    console.log(`Electrical Monitoring: Active with fallback support`);
    console.log(`Register Mapping: Enabled for troubleshooting`);
    console.log(`===========================================\n`);
    
    connectToPLC();
});