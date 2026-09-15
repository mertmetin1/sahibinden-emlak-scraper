/**
 * Central Turkish label maps + badge variants for every enum-like value.
 * Single source so tables, badges and filters never drift apart.
 */
import type {
    CookieValidationStatus,
    ListingOutcome,
    ListingStatus,
    ProxyHealth,
    ProxyStrategy,
    RunStatus,
    RunTrigger,
    SellerType,
} from './types';

export type BadgeTone = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' | 'info';

export const SELLER_TYPE_LABELS: Record<SellerType, string> = {
    OWNER: 'Sahibinden',
    REAL_ESTATE_OFFICE: 'Ofis',
    CONSTRUCTION_COMPANY: 'İnşaat',
    OTHER: 'Diğer',
    UNKNOWN: 'Bilinmiyor',
};

export const SELLER_TYPE_TONES: Record<SellerType, BadgeTone> = {
    OWNER: 'success',
    REAL_ESTATE_OFFICE: 'info',
    CONSTRUCTION_COMPANY: 'warning',
    OTHER: 'secondary',
    UNKNOWN: 'outline',
};

export const LISTING_STATUS_LABELS: Record<ListingStatus, string> = {
    ACTIVE: 'Aktif',
    STALE: 'Güncel Değil',
    REMOVED: 'Kaldırıldı',
};

export const LISTING_STATUS_TONES: Record<ListingStatus, BadgeTone> = {
    ACTIVE: 'success',
    STALE: 'warning',
    REMOVED: 'destructive',
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
    QUEUED: 'Kuyrukta',
    STARTING: 'Başlıyor',
    RUNNING: 'Çalışıyor',
    CANCELLING: 'İptal Ediliyor',
    CANCELLED: 'İptal Edildi',
    SUCCEEDED: 'Başarılı',
    PARTIAL: 'Kısmi',
    FAILED: 'Başarısız',
};

export const RUN_STATUS_TONES: Record<RunStatus, BadgeTone> = {
    QUEUED: 'secondary',
    STARTING: 'info',
    RUNNING: 'info',
    CANCELLING: 'warning',
    CANCELLED: 'secondary',
    SUCCEEDED: 'success',
    PARTIAL: 'warning',
    FAILED: 'destructive',
};

export const RUN_TRIGGER_LABELS: Record<RunTrigger, string> = {
    MANUAL: 'Manuel',
    SCHEDULE: 'Zamanlı',
    TEST: 'Test',
    RETRY: 'Yeniden Deneme',
};

export const PROXY_STRATEGY_LABELS: Record<ProxyStrategy, string> = {
    ROUND_ROBIN: 'Sıralı (Round Robin)',
    SESSION_STICKY: 'Oturum Sabit',
};

export const PROXY_HEALTH_LABELS: Record<ProxyHealth, string> = {
    UNKNOWN: 'Bilinmiyor',
    HEALTHY: 'Sağlıklı',
    DEGRADED: 'Degrade',
    UNHEALTHY: 'Sağlıksız',
    DISABLED: 'Devre Dışı',
};

export const PROXY_HEALTH_TONES: Record<ProxyHealth, BadgeTone> = {
    UNKNOWN: 'outline',
    HEALTHY: 'success',
    DEGRADED: 'warning',
    UNHEALTHY: 'destructive',
    DISABLED: 'secondary',
};

export const COOKIE_VALIDATION_LABELS: Record<CookieValidationStatus, string> = {
    UNKNOWN: 'Doğrulanmadı',
    VALID: 'Geçerli',
    EXPIRED: 'Süresi Dolmuş',
    INVALID: 'Geçersiz',
};

export const COOKIE_VALIDATION_TONES: Record<CookieValidationStatus, BadgeTone> = {
    UNKNOWN: 'outline',
    VALID: 'success',
    EXPIRED: 'warning',
    INVALID: 'destructive',
};

export const LISTING_OUTCOME_LABELS: Record<ListingOutcome, string> = {
    INSERTED: 'Eklendi',
    UPDATED: 'Güncellendi',
    PRICE_CHANGED: 'Fiyat Değişti',
    UNCHANGED: 'Değişmedi',
};

export const LISTING_OUTCOME_TONES: Record<ListingOutcome, BadgeTone> = {
    INSERTED: 'success',
    UPDATED: 'info',
    PRICE_CHANGED: 'warning',
    UNCHANGED: 'secondary',
};

export const LISTING_TYPE_LABELS: Record<string, string> = {
    SALE: 'Satılık',
    RENT: 'Kiralık',
    UNKNOWN: 'Bilinmiyor',
};

/** Known API error codes → operator-friendly Turkish (fallback: raw message). */
export const API_ERROR_LABELS: Record<string, string> = {
    VALIDATION_ERROR: 'Form doğrulama hatası',
    NOT_FOUND: 'Kayıt bulunamadı',
    CONFLICT: 'Çakışma',
    RUN_ALREADY_ACTIVE: 'Bu taramanın zaten aktif bir çalıştırması var',
    RUN_NOT_CANCELLABLE: 'Çalıştırma iptal edilemez',
    RUN_NOT_RETRYABLE: 'Çalıştırma yeniden denenemez',
    SCAN_HAS_ACTIVE_RUN: 'Taramanın aktif bir çalıştırması var — önce iptal edin',
    SCAN_DISABLED: 'Tarama devre dışı — önce aktifleştirin',
    PROFILE_NOT_FOUND: 'Referans verilen profil bulunamadı',
    INTERNAL: 'Sunucu hatası',
};
