'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function command(file, args, timeout = 1800) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function defaultRoute() {
  if (process.platform !== 'linux') return null;
  try {
    const row = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1)
      .map(line => line.trim().split(/\s+/)).find(parts => parts[1] === '00000000' && (parseInt(parts[3], 16) & 2));
    if (!row) return null;
    const raw = row[2];
    const gateway = [0, 2, 4, 6].map(i => parseInt(raw.slice(i, i + 2), 16)).join('.');
    return { gateway, interface: row[0] };
  } catch { return null; }
}

function interfaces() {
  const addresses = os.networkInterfaces();
  let names = Object.keys(addresses);
  if (process.platform === 'linux') {
    try { names = fs.readdirSync('/sys/class/net'); } catch { /* retain Node interface list */ }
  }
  return names.filter(name => name !== 'lo').map(name => {
    const sys = process.platform === 'linux' ? `/sys/class/net/${name}` : null;
    const ipv4 = [], ipv6 = [];
    for (const item of addresses[name] || []) {
      if (item.internal) continue;
      (item.family === 'IPv4' ? ipv4 : ipv6).push(`${item.address}${item.cidr ? `/${item.cidr.split('/')[1]}` : ''}`);
    }
    let operstate = 'unknown', mac = null, type = 'unknown';
    if (sys) {
      try { operstate = fs.readFileSync(path.join(sys, 'operstate'), 'utf8').trim(); } catch { }
      try { mac = fs.readFileSync(path.join(sys, 'address'), 'utf8').trim(); } catch { }
      type = fs.existsSync(path.join(sys, 'wireless')) ? 'Wi-Fi' : name.startsWith('wl') ? 'Wi-Fi' : name.startsWith('en') || name.startsWith('eth') ? 'Ethernet' : 'Other';
      try {
        const output = command('ip', ['-j', 'address', 'show', 'dev', name]);
        const details = JSON.parse(output)[0];
        if (details) {
          for (const a of details.addr_info || []) {
            const list = a.family === 'inet' ? ipv4 : a.family === 'inet6' ? ipv6 : null;
            if (list) { const value = `${a.local}/${a.prefixlen}`; if (!list.includes(value)) list.push(value); }
          }
          if ((details.link_type || '').includes('ether')) type = type === 'Other' ? 'Ethernet' : type;
        }
      } catch { }
    }
    let dhcpState = 'not reported';
    if (process.platform === 'linux') {
      const method = command('nmcli', ['-g', 'IP4.METHOD', 'device', 'show', name]).split('\n')[0];
      const options = command('nmcli', ['-g', 'IP4.DHCP4.OPTION', 'device', 'show', name]);
      if (method === 'auto') dhcpState = /dhcp_lease_time\s*=/.test(options) ? 'lease confirmed' : 'automatic; no lease reported';
      else if (method === 'manual') dhcpState = 'static';
      else if (method) dhcpState = method;
    }
    return { name, type, operstate, mac, ipv4: [...new Set(ipv4)], ipv6: [...new Set(ipv6)], dhcpState };
  });
}

function dnsServers() {
  if (process.platform === 'linux') {
    try { return fs.readFileSync('/etc/resolv.conf', 'utf8').split('\n').map(line => line.match(/^\s*nameserver\s+(\S+)/)?.[1]).filter(Boolean); } catch { }
  }
  return require('dns').getServers();
}

function wifiDevices() {
  if (process.platform !== 'linux') return [];
  const output = command('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device', 'status']);
  return output.split('\n').filter(Boolean).map(line => line.split(':')).filter(parts => parts[1] === 'wifi')
    .map(parts => ({ name: parts[0], state: parts[2] || 'unknown' }));
}

function hotspotReadiness() {
  const wifi = wifiDevices();
  const manager = command('nmcli', ['-t', '-f', 'RUNNING', 'general']);
  const radio = command('nmcli', ['radio', 'wifi']).toLowerCase();
  const apModes = command('iw', ['list'], 3500).split(/\n/).some(line => /\bAP\b/.test(line));
  let blocked = false;
  try {
    for (const item of fs.readdirSync('/sys/class/rfkill')) {
      try {
        if (fs.readFileSync(`/sys/class/rfkill/${item}/type`, 'utf8').trim() === 'wlan'
          && (fs.readFileSync(`/sys/class/rfkill/${item}/soft`, 'utf8').trim() === '1' || fs.readFileSync(`/sys/class/rfkill/${item}/hard`, 'utf8').trim() === '1')) blocked = true;
      } catch { }
    }
  } catch { }
  let message = 'NetworkManager, a Wi-Fi adapter, and AP mode are required.';
  if (!wifi.length) message = 'No Wi-Fi adapter is reported by NetworkManager. Virtual Ethernet cannot create a Wi-Fi hotspot.';
  else if (blocked) message = 'Wi-Fi is blocked by rfkill. Unblock the wireless device and refresh.';
  else if (radio === 'disabled') message = 'NetworkManager Wi-Fi radio is disabled. Enable Wi-Fi and refresh.';
  else if (manager !== 'running') message = 'NetworkManager is not running.';
  else if (!apModes) message = 'The adapter/driver does not report access-point (AP) mode support.';
  else message = 'Wi-Fi and AP mode are available. Internet sharing is separate and depends on an upstream connection.';
  return { ready: Boolean(wifi.length && !blocked && radio !== 'disabled' && manager === 'running' && apModes), interfaces: wifi, message };
}

function hotspotStatus() {
  const ready = hotspotReadiness();
  let active = false, iface = null, ssid = null;
  if (process.platform === 'linux') {
    const line = command('sudo', ['-n', '/usr/local/bin/rescueos-hotspot', 'status']);
    const [status, device, network] = line.split('|');
    active = status === 'active'; iface = device || null; ssid = network || null;
  }
  const device = interfaces().find(item => item.name === iface);
  let clients = null;
  if (active && iface) {
    const stations = command('iw', ['dev', iface, 'station', 'dump']);
    if (stations || command('iw', ['dev', iface, 'info'])) clients = (stations.match(/^Station /gm) || []).length;
  }
  return { ...ready, active, interface: iface, ssid, gateway: device?.ipv4[0]?.split('/')[0] || null, clients };
}

module.exports = { command, defaultRoute, interfaces, dnsServers, wifiDevices, hotspotReadiness, hotspotStatus };
