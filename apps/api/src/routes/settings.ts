/**
 * Settings routes — AppSetting key-value store with a CODE-DEFINED editable
 * key whitelist (see schemas.ts EDITABLE_SETTING_KEYS for the rationale:
 * every key has a typed consumer; arbitrary keys would be dead config).
 *
 * REPOSITORY GAP (reported, not patched): the database package has no
 * SettingsRepository — these routes use the documented raw-prisma escape
 * hatch (DatabaseClient.prisma, same pattern as RunControlService).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseClient } from '@sahibindenbot/database';
import { routeDoc } from '../docs.js';
import { ApiError, parseWith, toValidationIssues } from '../errors.js';
import {
    EDITABLE_SETTING_KEYS,
    SETTING_VALUE_SCHEMAS,
    settingsPatchSchema,
    type EditableSettingKey,
} from '../schemas.js';

/** CSV export row cap: default and hard upper bound (DoS guard). */
export const EXPORT_MAX_ROWS_DEFAULT = 50_000;
export const EXPORT_MAX_ROWS_HARD_CAP = 50_000;

/** Boundary-safe: indexed access on DatabaseClient — no @prisma/client import here. */
type PrismaLike = Pick<DatabaseClient['prisma'], 'appSetting'>;

/** Reads the effective CSV export row cap (AppSetting 'export.maxRows', validated). */
export async function readExportMaxRows(prisma: PrismaLike): Promise<number> {
    const row = await prisma.appSetting.findUnique({ where: { key: 'export.maxRows' } });
    if (row === null) return EXPORT_MAX_ROWS_DEFAULT;
    const parsed = SETTING_VALUE_SCHEMAS['export.maxRows'].safeParse(row.value);
    return parsed.success && typeof parsed.data === 'number'
        ? Math.min(parsed.data, EXPORT_MAX_ROWS_HARD_CAP)
        : EXPORT_MAX_ROWS_DEFAULT;
}

async function readAllSettings(prisma: PrismaLike): Promise<Record<string, unknown>> {
    const rows = await prisma.appSetting.findMany({ orderBy: { key: 'asc' } });
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
    // GET /api/settings — every stored setting as a flat key→value map.
    app.get(
        '/api/settings',
        {
            schema: routeDoc({
                tags: ['settings'],
                summary: 'All application settings',
                description: 'Returns every AppSetting row as a flat key→value object map.',
            }),
        },
        async () => readAllSettings(app.db.prisma),
    );

    // PATCH /api/settings — upsert whitelisted keys only.
    app.patch(
        '/api/settings',
        {
            schema: routeDoc({
                tags: ['settings'],
                summary: 'Update editable settings (upsert)',
                description:
                    'Body is a key→value object; each key is upserted. Only code-defined keys are ' +
                    `editable: ${EDITABLE_SETTING_KEYS.join(', ')} — unknown keys are rejected with 400 ` +
                    'VALIDATION_ERROR because settings are typed, code-consumed configuration, not ' +
                    'free-form storage. Values are validated per key (page size 1–100, export cap ' +
                    '1–50000, scheduler toggle boolean). Returns the full settings map.',
                body: settingsPatchSchema,
            }),
        },
        async (request) => {
            const body = parseWith(settingsPatchSchema, request.body);

            // Key whitelist + per-key value validation, collecting all issues.
            const entries: Array<{ key: EditableSettingKey; value: number | boolean }> = [];
            const issues: Array<{ path: string; message: string; code: string }> = [];
            for (const [key, value] of Object.entries(body)) {
                if (!(EDITABLE_SETTING_KEYS as readonly string[]).includes(key)) {
                    issues.push({
                        path: key,
                        message: `unknown setting key — editable keys are: ${EDITABLE_SETTING_KEYS.join(', ')} (settings are code-defined, not free-form)`,
                        code: 'custom',
                    });
                    continue;
                }
                const valueSchema = SETTING_VALUE_SCHEMAS[key as EditableSettingKey];
                const parsed = valueSchema.safeParse(value);
                if (!parsed.success) {
                    issues.push(...toValidationIssues(parsed.error).map((issue) => ({ ...issue, path: key })));
                    continue;
                }
                entries.push({ key: key as EditableSettingKey, value: parsed.data });
            }
            if (issues.length > 0) {
                throw new ApiError(400, 'VALIDATION_ERROR', 'request validation failed', { issues });
            }

            for (const entry of entries) {
                await app.db.prisma.appSetting.upsert({
                    where: { key: entry.key },
                    create: { key: entry.key, value: entry.value },
                    update: { value: entry.value },
                });
            }
            return readAllSettings(app.db.prisma);
        },
    );
};
