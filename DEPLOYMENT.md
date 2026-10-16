# RescueOS Deployment Guide & Bootable USB Setup

RescueOS is engineered to deploy rapidly in the field under zero-infrastructure conditions.

---

## 1. Local Wi-Fi Hotspot Setup

RescueOS turns any standard consumer laptop into an offline emergency coordination base station.

```
Laptop Running RescueOS
      ↓
NetworkManager access point (operator-configured SSID)
      ↓
Smartphones / Tablets Connecting over Local Wi-Fi
      ↓
Browser Opens: http://<LAPTOP_IP>:8080
```

### 1.1 Debian Live hotspot
1. Open **Network** and sign in as `admin`.
2. Select a Wi-Fi device that reports AP-mode support, provide the SSID and an 8–63 character alphanumeric password, and start the hotspot.
3. Wait for NetworkManager confirmation. The panel then reports the actual interface and gateway.
4. Stop the RescueOS hotspot from the same panel when finished. Its temporary connection profile is removed on stop and does not auto-connect after reboot.

Internet sharing depends on a separate upstream link. Ethernet connectivity alone does not mean the Wi-Fi adapter supports AP mode. The VM's virtual Ethernet adapter cannot substitute for a physical Wi-Fi device.

### 1.2 Windows development host
Configure Windows Mobile Hotspot in Windows Settings. The RescueOS development server reports host interface addresses but does not control Windows networking.

---

## 2. Bootable Live USB Creation (Step 25)

You can install RescueOS onto a bootable live Linux USB drive (Ubuntu/Debian Live or Alpine Linux) for instant field triage.

### 2.1 Hardware Compatibility
- **BIOS / UEFI:** Compatible with legacy BIOS and modern UEFI (x86_64).
- **Secure Boot:** Supported on Ubuntu/Debian Live bases signed by Microsoft Third-Party UEFI CA.
- **Wi-Fi Drivers:** Standard Intel, Realtek, Qualcomm Atheros, and Broadcom drivers are included in mainstream Linux kernel distros.

### 2.2 Live USB Setup Steps
1. **Download Live Linux ISO:**
   - Ubuntu Desktop 24.04 LTS or Debian 12 Live ISO.
2. **Flash to USB Drive:**
   - Use an open-source tool like Rufus, Ventoy, or `dd`:
     ```bash
     sudo dd if=ubuntu-24.04-desktop-amd64.iso of=/dev/sdX bs=4M status=progress oflag=sync
     ```
3. **Configure Persistent Storage & Auto-Start:**
   - Copy the `RescueOS/` directory into `/opt/rescueos` on the persistence partition.
   - Install Node.js 18+ (Node 22+ recommended for built-in SQLite).

### 2.3 Systemd Auto-Start Service Unit

Use the packaged unit and live-build configuration in `deployment/debian-live/`. It runs the Node backend as the dedicated `rescueos` user and grants only the fixed hotspot helper the elevated network operations it needs. Do not run the browser-facing backend as root.

For a custom installation, reproduce the packaged service's dedicated user, writable data directory, and constrained helper permissions.

---

## 3. Captive Portal Configuration (Optional Field Optimization)

To make connected phones automatically pop up the RescueOS portal without typing an IP address:

### Using `dnsmasq`
Install `dnsmasq` on the Linux host and add this wildcard rule to redirect all DNS queries to the host laptop:
```conf
# /etc/dnsmasq.d/captive.conf
address=/#/192.168.4.1
interface=wlan0
dhcp-range=192.168.4.10,192.168.4.250,255.255.255.0,12h
```
When civilian phones connect to `RESCUEOS-EMERGENCY`, their operating system's captive portal detector will automatically open RescueOS!

---

## 4. Disaster Resilience Checklist

- [ ] Laptop battery charged + 12V car battery inverter available.
- [ ] Wi-Fi hotspot password configured or open for emergency public access.
- [ ] USB flash drives formatted for multi-station synchronization packages.
- [ ] Pre-printed laminated QR ID cards for triage identification.
