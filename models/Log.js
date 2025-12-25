const mongoose = require('mongoose');

const LogSchema = new mongoose.Schema({
    timestamp: { 
        type: Date, 
        default: Date.now 
    },
    event: { 
        type: String, 
        required: true 
    }, // e.g., "DG_STOPPED"
    startLevel: { type: Number },
    endLevel: { type: Number },
    consumption: { type: Number },
    duration: { type: Number, default: 0 }
});

module.exports = mongoose.model('Log', LogSchema);
