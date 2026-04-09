/**
 * WiFi Monitor Service - PRODUCTION VERSION
 * Fast reconnect with minimal downtime
 */

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class WiFiMonitor {
    constructor() {
        this.isMonitoring = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.checkInterval = 5000; // Check every 5 seconds
        this.lastSuccessfulCheck = Date.now();
        this.consecutiveFailures = 0;
        this.isReconnecting = false;
        
        this.config = {
            interface: 'wlan0',
            routerIP: process.env.ROUTER_IP || '192.168.1.1',
            maxConsecutiveFailures: 2 // Reconnect after 10 seconds of failure
        };

        this.stats = {
            totalChecks: 0,
            successfulChecks: 0,
            failedChecks: 0,
            reconnectAttempts: 0,
            successfulReconnects: 0,
            lastReconnectTime: null,
            totalDowntime: 0 // Track total downtime in seconds
        };

        this.downtimeStart = null;
    }

    start() {
        if (this.isMonitoring) {
            console.log('📡 WiFi Monitor already running');
            return;
        }

        this.isMonitoring = true;
        console.log('📡 WiFi Monitor started - Auto-reconnect enabled (5s interval)');
        this.monitorLoop();
    }

    stop() {
        this.isMonitoring = false;
        console.log('📡 WiFi Monitor stopped');
    }

    async monitorLoop() {
        while (this.isMonitoring) {
            try {
                this.stats.totalChecks++;
                const isConnected = await this.checkConnection();
                
                if (!isConnected) {
                    if (this.consecutiveFailures === 0) {
                        this.downtimeStart = Date.now();
                    }
                    
                    this.consecutiveFailures++;
                    this.stats.failedChecks++;
                    
                    console.warn(`⚠️ WiFi DOWN (${this.consecutiveFailures * 5}s) - Checking...`);
                    
                    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures && !this.isReconnecting) {
                        console.error('🚨 WiFi LOST! Reconnecting NOW...');
                        this.reconnect(); // Run in background
                    }
                } else {
                    // Connection restored
                    if (this.consecutiveFailures > 0) {
                        const downtime = Math.floor((Date.now() - this.downtimeStart) / 1000);
                        this.stats.totalDowntime += downtime;
                        console.log(`✅ WiFi RESTORED after ${downtime}s downtime`);
                    }
                    
                    this.consecutiveFailures = 0;
                    this.reconnectAttempts = 0;
                    this.lastSuccessfulCheck = Date.now();
                    this.stats.successfulChecks++;
                    this.isReconnecting = false;
                    this.downtimeStart = null;
                }
            } catch (error) {
                console.error('❌ Monitor error:', error.message);
            }

            await this.sleep(this.checkInterval);
        }
    }

    async checkConnection() {
        try {
            // Fast ping check (1 second timeout)
            await execPromise(`ping -c 1 -W 1 ${this.config.routerIP}`, { timeout: 2000 });
            return true;
        } catch {
            return false;
        }
    }

    async reconnect() {
        if (this.isReconnecting) return;
        this.isReconnecting = true;

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('🚨 Max reconnect attempts reached! Waiting 30s...');
            this.reconnectAttempts = 0;
            await this.sleep(30000);
        }

        this.reconnectAttempts++;
        this.stats.reconnectAttempts++;
        this.stats.lastReconnectTime = new Date().toISOString();
        
        console.log(`🔄 Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);

        try {
            // Quick reconnect sequence
            console.log('📉 Restarting WiFi interface...');
            await execPromise(`sudo ifconfig ${this.config.interface} down`);
            await this.sleep(1000); // Reduced from 2s
            
            await execPromise(`sudo ifconfig ${this.config.interface} up`);
            await this.sleep(2000); // Reduced from 3s
            
            console.log('🔄 Restarting DHCP...');
            try {
                await execPromise('sudo systemctl restart dhcpcd', { timeout: 5000 });
            } catch {
                await execPromise(`sudo wpa_cli -i ${this.config.interface} reconfigure`);
            }
            
            await this.sleep(5000); // Wait for connection

            const isConnected = await this.checkConnection();
            
            if (isConnected) {
                console.log('✅ WiFi reconnected successfully!');
                this.reconnectAttempts = 0;
                this.stats.successfulReconnects++;
                this.isReconnecting = false;
                return true;
            } else {
                console.warn('⚠️ Reconnect failed, will retry in 5s...');
                this.isReconnecting = false;
                return false;
            }

        } catch (error) {
            console.error('❌ Reconnect error:', error.message);
            this.isReconnecting = false;
            return false;
        }
    }

    async getStatus() {
        try {
            const { stdout: iwconfig } = await execPromise(`iwconfig ${this.config.interface}`);
            const { stdout: ifconfig } = await execPromise(`ifconfig ${this.config.interface}`);
            
            const ssidMatch = iwconfig.match(/ESSID:"(.+?)"/);
            const ssid = ssidMatch ? ssidMatch[1] : 'Not connected';
            
            const signalMatch = iwconfig.match(/Signal level=(-?\d+)/);
            const signal = signalMatch ? parseInt(signalMatch[1]) : null;
            
            const ipMatch = ifconfig.match(/inet (\d+\.\d+\.\d+\.\d+)/);
            const ip = ipMatch ? ipMatch[1] : 'No IP';

            const uptime = Math.floor((Date.now() - this.lastSuccessfulCheck) / 1000);
            const uptimePercent = this.stats.totalChecks > 0 
                ? ((this.stats.successfulChecks / this.stats.totalChecks) * 100).toFixed(1)
                : 0;

            return {
                connected: ip !== 'No IP',
                ssid,
                signal,
                signalQuality: signal ? `${signal} dBm` : 'Unknown',
                ip,
                interface: this.config.interface,
                uptime: `${uptime}s`,
                uptimePercent: `${uptimePercent}%`,
                totalDowntime: `${this.stats.totalDowntime}s`,
                stats: this.stats,
                consecutiveFailures: this.consecutiveFailures,
                isReconnecting: this.isReconnecting
            };
        } catch (error) {
            return {
                connected: false,
                error: error.message,
                stats: this.stats
            };
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

const wifiMonitor = new WiFiMonitor();
module.exports = wifiMonitor;