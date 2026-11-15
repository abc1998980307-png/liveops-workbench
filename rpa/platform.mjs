import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function rpaDataRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  for (const key of ['LIVEOPS_RPA_DATA', 'LIVEOPS_DATA_ROOT']) {
    if (env[key] && !paths.isAbsolute(env[key])) throw new Error(`${key} 必须是绝对路径`);
  }
  if (env.LIVEOPS_RPA_DATA) return env.LIVEOPS_RPA_DATA;
  if (env.LIVEOPS_DATA_ROOT) return paths.join(env.LIVEOPS_DATA_ROOT, 'rpa');
  if (platform === 'win32') return paths.join(env.APPDATA || paths.join(home, 'AppData', 'Roaming'), 'LiveOps', 'rpa');
  return paths.join(home, 'Library', 'Application Support', 'LiveOps', 'rpa');
}

export function browserExecutable({ platform = process.platform, env = process.env,
  home = os.homedir(), exists = fs.existsSync } = {}) {
  if (env.LIVEOPS_CHROME) return env.LIVEOPS_CHROME;
  if (platform === 'win32') {
    const paths = path.win32;
    const drive = env.SystemDrive || 'C:';
    const candidates = [
      [env.PROGRAMFILES || paths.join(drive, 'Program Files'), 'Google', 'Chrome', 'Application', 'chrome.exe'],
      [env['PROGRAMFILES(X86)'] || paths.join(drive, 'Program Files (x86)'), 'Google', 'Chrome', 'Application', 'chrome.exe'],
      [env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'],
      [env.PROGRAMFILES || paths.join(drive, 'Program Files'), 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
      [env['PROGRAMFILES(X86)'] || paths.join(drive, 'Program Files (x86)'), 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
      [env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ];
    return candidates.map(parts => paths.join(...parts)).find(exists) || null;
  }
  if (platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return exists(chrome) ? chrome : null;
  }
  return null;
}
