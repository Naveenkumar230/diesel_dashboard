/**
 * Email Service - All email functionality centralized
 */

const nodemailer = require('nodemailer');

// Configuration
const ALERT_COOLDOWN = parseInt(process.env.ALERT_COOLDOWN) || 1800000; // 30 mins
// --- UPDATED: Cooldown set to 0 to send email on EVERY startup ---
const STARTUP_ALERT_COOLDOWN = 0; // Was 600000 (10 mins)
// ---
const CRITICAL_LEVEL = parseInt(process.env.CRITICAL_DIESEL_LEVEL) || 50;
const ALERT_RECIPIENTS = process.env.ALERT_RECIPIENTS || '';

let emailTransporter = null;
let emailEnabled = false;

// Alert state tracking
const alertState = {
  currentAlerts: new Set(),
  lastStartupAlerts: {}
};

// Initialize email transporter
function initializeEmail() {
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
      console.log('✅ Email alerts enabled');
    } else {
      console.log('⚠️ Email configuration missing - alerts disabled');
    }
  } catch (err) {
    console.error('Email setup error:', err);
    emailEnabled = false;
  }
}

// Get dashboard URL
function getDashboardUrl() {
  const port = process.env.PORT || 3000;
  return `http://${process.env.PI_IP_ADDRESS || 'localhost'}:${port}`;
}

// ============ EMAIL TEMPLATES ============

function getDieselAlertTemplate(data, criticalDGs) {
  const timestamp = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'full',
    timeStyle: 'long'
  });
  
  return {
    subject: `⚠️ CRITICAL ALERT: Low Diesel Levels Detected`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e5e7eb;border-radius:8px;">
        <div style="background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;padding:20px;border-radius:8px 8px 0 0;">
          <h1 style="margin:0;">⚠️ CRITICAL DIESEL ALERT</h1>
        </div>
        <div style="padding:20px;background:#f9fafb;color:#333;">
          <p style="font-weight:bold;color:#ef4444;font-size:16px;">
            URGENT: Low diesel levels detected in ${criticalDGs.join(', ')}
          </p>
          <ul style="list-style:none;padding:0;">
            <li style="padding:8px;border-bottom:1px solid #eee;">
              DG-1: <b style="color:${data.dg1 <= CRITICAL_LEVEL ? '#ef4444' : '#10b981'}">${data.dg1} L</b>
            </li>
            <li style="padding:8px;border-bottom:1px solid #eee;">
              DG-2: <b style="color:${data.dg2 <= CRITICAL_LEVEL ? '#ef4444' : '#10b981'}">${data.dg2} L</b>
            </li>
            <li style="padding:8px;border-bottom:1px solid #eee;">
              DG-3: <b style="color:${data.dg3 <= CRITICAL_LEVEL ? '#ef4444' : '#10b981'}">${data.dg3} L</b>
            </li>
          </ul>
          <p style="font-size:14px;margin-top:20px;">Alert Time: ${timestamp}</p>
          <a href="${getDashboardUrl()}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;margin-top:15px;">
            View Dashboard
          </a>
        </div>
      </div>
    `
  };
}

function getDailySummaryTemplate(summary, previousDay) {
  const today = new Date(summary.date);
  const formattedDate = today.toLocaleDateString('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const getDGRow = (dgNum, data, prevData) => {
    const consumption = data.totalConsumption.toFixed(1);
    const change = prevData ? (data.endLevel - prevData.endLevel).toFixed(1) : 0;
    const changeColor = change < 0 ? '#ef4444' : '#10b981';
    
    return `
      <tr>
        <td style="padding:12px;border:1px solid #e5e7eb;">DG-${dgNum}</td>
        <td style="padding:12px;border:1px solid #e5e7eb;text-align:center;">${data.startLevel} L</td>
        <td style="padding:12px;border:1px solid #e5e7eb;text-align:center;">${data.endLevel} L</td>
        <td style="padding:12px;border:1px solid #e5e7eb;text-align:center;font-weight:bold;color:#ef4444;">${consumption} L</td>
        <td style="padding:12px;border:1px solid #e5e7eb;text-align:center;">${data.runningHours.toFixed(1)} hrs</td>
        ${prevData ? `<td style="padding:12px;border:1px solid #e5e7eb;text-align:center;color:${changeColor};font-weight:bold;">${change > 0 ? '+' : ''}${change} L</td>` : ''}
      </tr>
    `;
  };

  return {
    subject: `📊 Daily Diesel Report - ${formattedDate}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;border:1px solid #e5e7eb;border-radius:8px;">
        <div style="background:linear-gradient(135deg,#2563eb,#1e40af);color:#fff;padding:20px;border-radius:8px 8px 0 0;">
          <h1 style="margin:0;">📊 Daily Diesel Consumption Report</h1>
          <p style="margin:5px 0 0 0;opacity:0.9;">${formattedDate}</p>
        </div>
        
        <div style="padding:20px;background:#f9fafb;color:#333;">
          <h2 style="color:#2563eb;margin-top:0;">Today's Summary</h2>
          
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;background:#fff;">
            <thead>
              <tr style="background:#dbeafe;">
                <th style="padding:12px;border:1px solid #e5e7eb;text-align:left;">Generator</th>
                <th style="padding:12px;border:1px solid #e5e7eb;">Start Level</th>
                <th style="padding:12px;border:1px solid #e5e7eb;">End Level</th>
                <th style="padding:12px;border:1px solid #e5e7eb;">Consumption</th>
                <th style="padding:12px;border:1px solid #e5e7eb;">Running Hours</th>
                ${previousDay ? '<th style="padding:12px;border:1px solid #e5e7eb;">vs Yesterday</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${getDGRow(1, summary.dg1, previousDay?.dg1)}
              ${getDGRow(2, summary.dg2, previousDay?.dg2)}
              ${getDGRow(3, summary.dg3, previousDay?.dg3)}
              <tr style="background:#f3f4f6;font-weight:bold;">
                <td style="padding:12px;border:1px solid #e5e7eb;">TOTAL</td>
                <td style="padding:12px;border:1px solid #e5e7eb;text-align:center;">${summary.total.startLevel} L</td>
                <td style="padding:12px;border:1px solid #e5e7eb;text-align:center;">${summary.total.endLevel} L</td>
                <td style="padding:12px;border:1px solid #e5e7eb;text-align:center;color:#ef4444;">${summary.total.totalConsumption.toFixed(1)} L</td>
                <td style="padding:12px;border:1px solid #e5e7eb;text-align:center;">-</td>
                ${previousDay ? `<td style="padding:12px;border:1px solid #e5e7eb;text-align:center;">${(summary.total.endLevel - previousDay.total.endLevel).toFixed(1)} L</td>` : ''}
              </tr>
            </tbody>
          </table>

          ${summary.dg1.endLevel <= CRITICAL_LEVEL || summary.dg2.endLevel <= CRITICAL_LEVEL || summary.dg3.endLevel <= CRITICAL_LEVEL ? `
          <div style="background:#fee2e2;border-left:4px solid #ef4444;padding:15px;margin-top:20px;border-radius:4px;">
            <h3 style="color:#dc2626;margin:0 0 10px 0;">⚠️ Critical Levels Detected</h3>
            <p style="margin:0;color:#991b1b;">
              ${[
                summary.dg1.endLevel <= CRITICAL_LEVEL ? `DG-1: ${summary.dg1.endLevel} L` : null,
                summary.dg2.endLevel <= CRITICAL_LEVEL ? `DG-2: ${summary.dg2.endLevel} L` : null,
                summary.dg3.endLevel <= CRITICAL_LEVEL ? `DG-3: ${summary.dg3.endLevel} L` : null
              ].filter(Boolean).join(' | ')}
            </p>
            <p style="margin:10px 0 0 0;color:#991b1b;font-weight:bold;">Immediate refueling required!</p>
          </div>
          ` : ''}

          <p style="font-size:14px;color:#6b7280;margin-top:25px;">
            Report generated at: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
          </p>
          
          <a href="${getDashboardUrl()}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;margin-top:15px;">
            View Live Dashboard
          </a>
        </div>
      </div>
    `
  };
}

// --- UPDATED: Startup Email Template ---
// Now includes all 12 key parameters in a simple list.
function getStartupEmailTemplate(dgName, values) {
  const timestamp = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    timeStyle: 'long'
  });

  const f = (val, dec = 1) => (val || 0).toFixed(dec);

  return {
    subject: `🟢 NOTIFICATION: ${dgName} Has Started Running`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e5e7eb;border-radius:8px;">
        <div style="background:linear-gradient(135deg,#10b981,#34d399);color:#fff;padding:20px;border-radius:8px 8px 0 0;">
          <h1 style="margin:0;">🟢 DG STARTUP NOTIFICATION</h1>
          <h2 style="margin:10px 0 0 0;">${dgName}</h2>
        </div>
        <div style="padding:20px;background:#f9fafb;color:#333;">
          <h3 style="color:#059669;">Generator is now running. Initial parameters:</h3>
          <ul style="list-style:none;padding:0;font-size:14px;">
            <li style="padding:8px;border-bottom:1px solid #eee;">
              Active Power: <b>${f(values.activePower, 1)} kW</b>
            </li>
            <li style="padding:8px;border-bottom:1px solid #eee;">
              Frequency: <b>${f(values.frequency, 2)} Hz</b>
            </li>
            <li style="padding:8px;border-bottom:1px solid #eee;">
              Power Factor: <b>${f(values.powerFactor, 2)}</b>
            </li>
            <li style="padding:8px;border-bottom:1px solid #eee;">
              Voltage R/Y/B: <b>${f(values.voltageR)}V / ${f(values.voltageY)}V / ${f(values.voltageB)}V</b>
            </li>
            <li style="padding:8px;border-bottom:1px solid #eee;">
              Current R/Y/B: <b>${f(values.currentR)}A / ${f(values.currentY)}A / ${f(values.currentB)}A</b>
            </li>
            <li style="padding:8px;border-bottom:1px solid #eee;">
              Reactive Power: <b>${f(values.reactivePower, 1)} kVAR</b>
            </li>
            <li style="padding:8px;border-bottom:1px solid #eee;">
              Total Energy: <b>${f(values.energyMeter, 0)} kWh</b>
            </li>
            <li style="padding:8px;">
              Total Run Hours: <b>${f(values.runningHours, 1)} hrs</b>
            </li>
          </ul>
          <p style="font-size:14px;margin-top:20px;">Event Time: ${timestamp}</p>
          <a href="${getDashboardUrl()}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;margin-top:15px;">
            View Live Dashboard
          </a>
        </div>
      </div>
    `
  };
}
// --- END OF UPDATE ---


// ============ SEND EMAIL FUNCTIONS ============

async function sendEmail(recipients, subject, html) {
  if (!emailEnabled || !recipients) {
    console.log('⚠️ Email not sent: Email not configured or no recipients');
    return false;
  }

  try {
    await emailTransporter.sendMail({
      from: `"DG Monitoring System" <${process.env.EMAIL_USER}>`,
      to: recipients,
      subject: subject,
      html: html
    });
    return true;
  } catch (err) {
    console.error('Email sending error:', err.message);
    return false;
  }
}

async function sendDieselAlert(data, criticalDGs) {
  const key = `diesel_${Math.floor(Date.now() / ALERT_COOLDOWN)}`;
  if (alertState.currentAlerts.has(key)) return;

  const template = getDieselAlertTemplate(data, criticalDGs);
  const sent = await sendEmail(ALERT_RECIPIENTS, template.subject, template.html);

  if (sent) {
    alertState.currentAlerts.add(key);
    setTimeout(() => alertState.currentAlerts.delete(key), ALERT_COOLDOWN);
    console.log(`⚠️ Diesel alert email sent for ${criticalDGs.join(', ')}`);
  }
}

async function sendDailySummary(summary, previousDay = null) {
  const template = getDailySummaryTemplate(summary, previousDay);
  const sent = await sendEmail(ALERT_RECIPIENTS, template.subject, template.html);

  if (sent) {
    console.log(`📊 Daily summary email sent for ${summary.date}`);
  }
}

async function sendStartupAlert(dgName, values) {
  const dgKey = dgName.toLowerCase().replace('-', '');
  const lastAlertTime = alertState.lastStartupAlerts[dgKey] || 0;
  const now = Date.now();

  // This check will now pass every time because STARTUP_ALERT_COOLDOWN is 0
  if ((now - lastAlertTime) < STARTUP_ALERT_COOLDOWN) return;

  const template = getStartupEmailTemplate(dgName, values);
  const sent = await sendEmail(ALERT_RECIPIENTS, template.subject, template.html);

  if (sent) {
    alertState.lastStartupAlerts[dgKey] = now;
    console.log(`🟢 Startup alert email sent for ${dgName}`);
  }
}

module.exports = {
  initializeEmail,
  sendDieselAlert,
  sendDailySummary,
  sendStartupAlert,
  isEmailEnabled: () => emailEnabled
};