/**
 * Filesystem debug-artifact store — replaces `Actor.setValue` KV dumps.
 * Writes `DEBUG-NNN-<label>.html|.png` with a zero-padded counter.
 *
 * Defense note: the API shape is the guardrail — it accepts only (label,
 * html) and (label, png). Cookies, headers, and proxy credentials can never
 * be passed here, so they can never land on disk (unlike upstream, which
 * logged truncated cookie values into the KV store — audit §8.2).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DebugArtifactStore } from '@sahibindenbot/shared';

export class FsDebugArtifactStore implements DebugArtifactStore {
    private counter = 0;

    constructor(private readonly dir: string) {}

    async saveHtml(label: string, html: string): Promise<void> {
        await writeFile(await this.nextPath(label, 'html'), html, 'utf8');
    }

    async saveScreenshot(label: string, png: Uint8Array): Promise<void> {
        await writeFile(await this.nextPath(label, 'png'), png);
    }

    private async nextPath(label: string, ext: string): Promise<string> {
        await mkdir(this.dir, { recursive: true });
        const idx = String(++this.counter).padStart(3, '0');
        const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_');
        return path.join(this.dir, `DEBUG-${idx}-${safeLabel}.${ext}`);
    }
}
