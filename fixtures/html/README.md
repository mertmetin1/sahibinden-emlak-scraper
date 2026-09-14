# HTML fixtures (all sanitized)

One line per fixture: source — seller type — what it pins down — sanitization note.

| Fixture | Source | Seller type | Pins down | Sanitization |
|---|---|---|---|---|
| `category-satilik-adana-seyhan.html` | Real category page, captured 2026-09-14 (50 organic rows + 1 promoted + 1 native-ad) | n/a (rows) | 13-field category contract, row fallback chain, pagination selector | account name masked (scripts/sanitize-fixtures.mjs) |
| `detail-sample-1.html` | Real detail page, 2026-09-14 (`…/detay` id 1340140183) | real-estate office ("TEST GAYRİMENKUL", agent "Test A.") | office seller block (`.user-info-store-card` + sticky mirror), `ul.classifiedInfoList` attribute extraction, address breadcrumb, x5_ gallery, `data-opened` phone | phone, office name, agent name, member ID masked |
| `detail-sample-2.html` | Real detail page, 2026-09-14 (id 1340134786) | real-estate office, full agent name variant ("TEST SATICI GAYRİMENKUL" / "Test Satıcı") | multi-phone list (`İş` landline + `Cep` mobile) → sticky `data-opened` precedence | phone, office, agent, subdomain masked |
| `detail-sample-3.html` | Real detail page, 2026-09-14 (id 1340100069) | individual owner ("Test Y.") | **CSS-obfuscation resolution** (name + phone via `.css<uuid>:before{content}` and `attr(data-content)`), `.classified-owner-info` block, `sticky-header-indivudial-name` [sic], JSON-LD VideoObject → videoUrl | owner name + phone masked |
| `detail-missing-optional.html` | **Derived** from `detail-sample-1.html`: removed 8 optional attribute rows (Banyo Sayısı, Balkon, Eşyalı, Kullanım Durumu, Aidat (TL), Krediye Uygun, Tapu Durumu, Takas — each `<li>` removed exactly once) and deleted the `#classifiedDescription` container | office (unchanged) | missing optional fields → null/'' in the right places, remaining attributesRaw intact, no crash | inherits sample-1 sanitization (no new data added) |
| `detail-malformed.html` | **Derived** from `detail-sample-1.html`: price span text replaced by digit-less garbage ("Fiyat bilgisi yok"), hidden `#favoriteClassifiedPrice` fallback emptied, the page's only `<h1>` removed | office (unchanged) | null price + empty title without throwing; attribute extraction survives broken core markup | inherits sample-1 sanitization |
| `detail-unavailable.html` | **Synthesized** removed-listing notice page (no real source; modeled on sahibinden's notice phrasing family '…yayından kaldırılmıştır' / '…artık yayında değil…'; deliberately contains NO `classifiedInfoList` markup) | none | `isUnavailableDetailHtml` → true, `normalizeDetail` unavailable short-circuit (nullable fields null/empty, `unavailable: true`) | synthetic — contains no real data |

Derivation recipes (deterministic; verified post-hoc by label counts): each
`detail-missing-optional.html` row removal matched
`<li>\s*<strong>\s*LABEL</strong>&nbsp;\s*<span…>VALUE</span>\s*</li>` exactly
once; the description removal matched `<div id="classifiedDescription"
class="uiBoxContainer">…</div></div>` once. `detail-malformed.html`
replacements each matched exactly once. All derived fixtures are byte-derived
from already-sanitized samples, so no personal data is (re)introduced.
