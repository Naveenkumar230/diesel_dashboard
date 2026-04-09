[Unit]
Description=WiFi Auto-Reconnect Watchdog
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/pi/DIESEL_DASHBOARD
ExecStart=/home/pi/DIESEL_DASHBOARD/scripts/wifi-watchdog.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target