// Copy to secrets.h (git-ignored) and fill in.
#pragma once

#define WIFI_SSID "your-network"
#define WIFI_PASSWORD "your-wifi-password"

// The indoor computer running pipeline/receiver.py: its LAN address and port.
#define RECEIVER_URL "http://192.168.1.50:8765"
// Same value as receiver.py's --token.
#define RECEIVER_TOKEN "change-me"
