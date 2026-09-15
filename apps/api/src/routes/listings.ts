/**
 * Listing routes — server-side filtered list, full detail, price history,
 * and a streaming CSV export.
 *
 * All filters compose at the DB level via ListingRepository.listWithDerived
 * (WHERE clauses + count in one transaction) — rows are never loaded and
 * filtered in memory.
 *
 * REPOSITORY GAP (reported, not patched): ListingSortField only allows
 * 'price' | 'pricePerSquareMeter' | 'firstSeenAt' | 'lastSeenAt' | 'listingDate'.
 * The API contract also sorts by 'title' and 'area' (→ grossAreaM2); both are
 * plain scalar columns the Prisma implementation orders by correctly, so the
 * mapping below uses a justified cast. 'grossAreaM2' is nullable but not in
 * the repo's SORTABLE_NULLABLE set, so ascending area sorts place NULLs first
 * (Postgres default) — cosmetic only.
 */
import { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import type { ListingFilters, ListingListRow, ListingSort, ListingSortField } from '@sahibindenbot/database';
import { routeDoc } from '../docs.js';
import { notFound, parseWith } from '../errors.js';
import {
    idParamSchema,
    listingExportQuerySchema,
    listingListQuerySchema,
    type ListingExportQuery,
    type ListingListQuery,
    type ListingSortParam,
} from '../schemas.js';
import { EXPORT_MAX_ROWS_HARD_CAP, readExportMaxRows } from './settings.js';

/** Repo-side page size while streaming exports (listWithDerived caps at 200). */
const EXPORT_PAGE_SIZE = 200;

/** UTF-8 byte-order mark (U+FEFF) — written first so Excel (tr-TR) detects UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** API sort param → repository/Prisma column (see header gap note). */
const SORT_FIELD_MAP: Record<ListingSortParam, string> = {
    price: 'price',
    firstSeenAt: 'firstSeenAt',
    lastSeenAt: 'lastSeenAt',
    title: 'title',
    area: 'grossAreaM2',
};

function toListingSort(query: { sort: ListingSortParam; order: 'asc' | 'desc' }): ListingSort {
    return {
        // Justified cast: every mapped value is a real scalar Listing column
        // (see header); ListingSortField is narrower than the impl supports.
        field: SORT_FIELD_MAP[query.sort] as ListingSortField,
        direction: query.order,
    };
}

function toListingFilters(query: ListingListQuery | ListingExportQuery): ListingFilters {
    const filters: ListingFilters = {};
    if (query.status !== undefined) filters.status = query.status;
    if (query.province !== undefined) filters.province = query.province;
    if (query.district !== undefined) filters.district = query.district;
    if (query.neighborhood !== undefined) filters.neighborhood = query.neighborhood;
    if (query.sellerType !== undefined) filters.sellerType = query.sellerType;
    if (query.listingType !== undefined) filters.listingType = query.listingType;
    if (query.propertyCategory !== undefined) filters.propertyCategory = query.propertyCategory;
    if (query.priceMin !== undefined) filters.priceMin = query.priceMin;
    if (query.priceMax !== undefined) filters.priceMax = query.priceMax;
    if (query.m2Min !== undefined) filters.m2Min = query.m2Min;
    if (query.m2Max !== undefined) filters.m2Max = query.m2Max;
    if (query.rooms !== undefined) filters.rooms = query.rooms;
    if (query.firstSeenFrom !== undefined) filters.firstSeenFrom = query.firstSeenFrom;
    if (query.lastSeenBefore !== undefined) filters.lastSeenBefore = query.lastSeenBefore;
    if (query.priceChanged === true) filters.priceChanged = true;
    if (query.scanId !== undefined) filters.scanId = query.scanId;
    if (query.search !== undefined) filters.search = query.search;
    return filters;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
    'id',
    'sourceListingId',
    'title',
    'price',
    'currency',
    'pricePerSquareMeter',
    'rooms',
    'grossAreaM2',
    'netAreaM2',
    'province',
    'district',
    'neighborhood',
    'sellerType',
    'sellerName',
    'listingType',
    'propertyCategory',
    'status',
    'firstSeenAt',
    'lastSeenAt',
    'url',
] as const;

/** RFC 4180 escaping: quote when the value contains a quote, comma, CR or LF; double inner quotes. */
function csvCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    const s = value instanceof Date ? value.toISOString() : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsvLine(row: ListingListRow): string {
    const sellerName = row.seller?.displayName ?? row.seller?.officeName ?? '';
    const cells: unknown[] = [
        row.id,
        row.sourceListingId,
        row.title,
        row.price,
        row.currency,
        row.pricePerSquareMeter,
        row.rooms,
        row.grossAreaM2,
        row.netAreaM2,
        row.province,
        row.district,
        row.neighborhood,
        row.sellerType,
        sellerName,
        row.listingType,
        row.propertyCategory,
        row.status,
        row.firstSeenAt,
        row.lastSeenAt,
        row.canonicalUrl,
    ];
    return cells.map(csvCell).join(',') + '\r\n';
}

export const listingRoutes: FastifyPluginAsync = async (app) => {
    // GET /api/listings — paginated, filtered, sorted (all server-side).
    app.get(
        '/api/listings',
        {
            schema: routeDoc({
                tags: ['listings'],
                summary: 'List listings with server-side filters, pagination and sorting',
                description:
                    'Every filter composes into the SQL WHERE via ListingRepository.listWithDerived. ' +
                    'sort is whitelisted (price|firstSeenAt|lastSeenAt|title|area; area = grossAreaM2). ' +
                    'Rows include the seller snapshot and derived price-change fields.',
                querystring: listingListQuerySchema,
            }),
        },
        async (request) => {
            const query = parseWith(listingListQuerySchema, request.query);
            const result = await app.db.repos.listings.listWithDerived(
                toListingFilters(query),
                query.page,
                query.pageSize,
                toListingSort(query),
            );
            return {
                rows: result.rows,
                total: result.total,
                page: result.page,
                pageSize: result.pageSize,
                totalPages: Math.ceil(result.total / result.pageSize),
            };
        },
    );

    // GET /api/listings/export.csv — streamed CSV (registered before /:id is
    // unnecessary: find-my-way prefers static over parametric, but the
    // explicit ordering also documents intent).
    app.get(
        '/api/listings/export.csv',
        {
            schema: routeDoc({
                tags: ['listings'],
                summary: 'Export filtered listings as CSV (streamed)',
                description:
                    'Streams the same filter set as GET /api/listings as CSV (UTF-8 with BOM for Excel ' +
                    'Turkish). Rows are paged from the DB in 200-row batches — the full set is never ' +
                    'buffered. Capped at export.maxRows (AppSetting, default 50000, hard cap 50000); ' +
                    'when capped, a final notice row is appended. Pagination is skip/take based, so rows ' +
                    'written concurrently mid-export may shift between pages (export-time snapshot is ' +
                    'best-effort, not transactional).',
                querystring: listingExportQuerySchema,
            }),
        },
        async (request, reply) => {
            const query = parseWith(listingExportQuerySchema, request.query);
            const maxRows = await readExportMaxRows(app.db.prisma);
            const filters = toListingFilters(query);
            const sort = toListingSort(query);
            const listings = app.db.repos.listings;

            async function* csvRows(): AsyncGenerator<string> {
                // BOM first — Excel (tr-TR) opens UTF-8 CSVs correctly only with it.
                yield BOM + CSV_COLUMNS.join(',') + '\r\n';
                let page = 1;
                let emitted = 0;
                let total = Number.POSITIVE_INFINITY;
                while (emitted < maxRows && emitted < total) {
                    const take = Math.min(EXPORT_PAGE_SIZE, maxRows - emitted);
                    const result = await listings.listWithDerived(filters, page, take, sort);
                    total = result.total;
                    if (result.rows.length === 0) break;
                    for (const row of result.rows) {
                        yield toCsvLine(row);
                        emitted += 1;
                    }
                    page += 1;
                }
                if (emitted < total) {
                    yield csvCell(
                        `# EXPORT CAPPED at ${maxRows} of ${total} matching rows — refine filters or raise 'export.maxRows' (max ${EXPORT_MAX_ROWS_HARD_CAP})`,
                    ) + '\r\n';
                }
            }

            const stream = Readable.from(csvRows(), { objectMode: false });
            stream.on('error', (err) => {
                request.log.error({ err: { message: err instanceof Error ? err.message : String(err) } }, 'csv export stream failed');
            });

            const stamp = new Date().toISOString().slice(0, 10);
            reply.header('content-type', 'text/csv; charset=utf-8');
            reply.header('content-disposition', `attachment; filename="listings-export-${stamp}.csv"`);
            return reply.send(stream);
        },
    );

    // GET /api/listings/:id — full detail record.
    app.get(
        '/api/listings/:id',
        {
            schema: routeDoc({
                tags: ['listings'],
                summary: 'Full listing detail',
                description:
                    'Snapshot fields plus seller, images (position-ordered), attributes (key-ordered), ' +
                    'price history (newest first), the last 50 seen-history entries, and run links ' +
                    '(run id, scanDefinitionId, status, createdAt — the repository does not select ' +
                    'startedAt here; reported gap).',
                params: idParamSchema,
            }),
        },
        async (request) => {
            const { id } = parseWith(idParamSchema, request.params);
            const found = await app.db.repos.listings.getById(id);
            if (found === null) throw notFound(`listing ${id} not found`);
            return found;
        },
    );

    // GET /api/listings/:id/price-history — ascending points + summary.
    app.get(
        '/api/listings/:id/price-history',
        {
            schema: routeDoc({
                tags: ['listings'],
                summary: 'Price history with change summary',
                description:
                    'Points ascending by changedAt (each row is a real observed price change). ' +
                    'summary.totalChangePercent is first→latest, 2dp; null when fewer than 2 points ' +
                    'or the first price is 0. changeCount = number of recorded price changes.',
                params: idParamSchema,
            }),
        },
        async (request) => {
            const { id } = parseWith(idParamSchema, request.params);
            const found = await app.db.repos.listings.getById(id);
            if (found === null) throw notFound(`listing ${id} not found`);
            // Repository returns newest-first; the API contract is ascending.
            const points = [...found.priceHistory].reverse().map((h) => ({
                price: h.price,
                currency: h.currency,
                pricePerSquareMeter: h.pricePerSquareMeter,
                changedAt: h.changedAt,
                runId: h.runId,
            }));
            const first = points[0];
            const latest = points.at(-1);
            const totalChangePercent =
                first !== undefined && latest !== undefined && points.length >= 2 && first.price !== 0
                    ? Math.round(((latest.price - first.price) / first.price) * 10000) / 100
                    : null;
            return {
                points,
                summary: {
                    firstPrice: first?.price ?? null,
                    latestPrice: latest?.price ?? null,
                    totalChangePercent,
                    changeCount: points.length,
                },
            };
        },
    );
};