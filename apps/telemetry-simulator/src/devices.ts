export interface Device {
  deviceId: string;
  deviceType: 'PORTAL_MONITOR' | 'RIID';
}

export const SITE_ID = 'POE-ALPHA';
export const VENDOR_ID = 'VANTAGE';

export const DEVICES: Device[] = [
  { deviceId: 'PM-01', deviceType: 'PORTAL_MONITOR' },
  { deviceId: 'PM-02', deviceType: 'PORTAL_MONITOR' },
  { deviceId: 'RIID-01', deviceType: 'RIID' },
];
