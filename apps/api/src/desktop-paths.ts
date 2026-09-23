import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Monorepo root: apps/api/src → ../../.. */
export function repoRoot(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function desktopStopFilePath(): string {
    const override = process.env.DESKTOP_STOP_FILE?.trim();
    if (override) return override;
    return path.join(repoRoot(), 'storage', 'desktop-stack.stop');
}

export function desktopStackEnabled(): boolean {
    return process.env.DESKTOP_STACK === '1';
}

export function lanWebUrls(webPort = 3000): string[] {
    const urls = [`http://127.0.0.1:${webPort}`];
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
        for (const info of list ?? []) {
            if (info.internal) continue;
            if (String(info.family) !== 'IPv4' && String(info.family) !== '4') continue;
            urls.push(`http://${info.address}:${webPort}`);
        }
    }
    return urls;
}

export async function requestDesktopStop(): Promise<string> {
    const file = desktopStopFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${new Date().toISOString()}\n`, 'utf8');
    return file;
}
