import { toPng } from './vendor/html-to-image.bundle.js';

/** Minimum entity card width (px); actual width from label measure + padding. */
const MIN_CARD_WIDTH = 220;
const HEADER_H = 28;
const ROW_H = 24;

/**
 * Must match the diagram font in `cyStyle` and roughly match `body` in index.html.
 * Cytoscape ignores typical CSS-quoted stacks (see cytoscape.js#933); use an unquoted list.
 */
const DIAGRAM_LABEL_FONT_PX = 14;
const DIAGRAM_FONT_FAMILY =
    'JetBrains Mono, ui-monospace, Cascadia Code, Consolas, DejaVu Sans Mono, monospace';
const DIAGRAM_LABEL_FONT = `${DIAGRAM_LABEL_FONT_PX}px ${DIAGRAM_FONT_FAMILY}`;

const CARD_H_PADDING = 32;

let _measureLabelCanvas;
function measureLabelWidth(text) {
    const t = text == null ? '' : String(text);
    if (!_measureLabelCanvas) {
        _measureLabelCanvas = document.createElement('canvas');
    }
    const ctx = _measureLabelCanvas.getContext('2d');
    ctx.font = DIAGRAM_LABEL_FONT;
    return ctx.measureText(t).width;
}

function computeCardWidthForEntity(ent) {
    const nameW = measureLabelWidth(ent?.business_name ?? '');
    const attrs = ent?.attributes || [];
    let maxAttrW = 0;
    for (const a of attrs) {
        maxAttrW = Math.max(maxAttrW, measureLabelWidth(a?.business_name ?? ''));
    }
    const contentW = attrs.length === 0 ? nameW : Math.max(nameW, maxAttrW);
    return Math.max(MIN_CARD_WIDTH, Math.ceil(contentW + CARD_H_PADDING));
}

function syncEntityCardWidthInCy(entityId) {
    if (!cy) return;
    const ent = findEntityById(entityId);
    if (!ent) return;
    const w = computeCardWidthForEntity(ent);
    cy.batch(() => {
        const entN = cy.getElementById(entityId);
        if (entN.nonempty()) entN.data('cardWidth', w);
        const hdr = cy.getElementById(`${entityId}_hdr`);
        if (hdr.nonempty()) hdr.data('cardWidth', w);
        cy.nodes().forEach((n) => {
            if (n.data('parent') === entityId && n.data('type') === 'attribute') {
                n.data('cardWidth', w);
            }
        });
    });
    cy.style().update();
}

/** Crow's-foot / optional-or-mandatory symbols on a canvas over the diagram (built-in Cytoscape arrows are off). */
/** Screen-space gap along the wire from the attribute edge so symbols do not sit inside the node box. */
const ER_OVERLAY_OFFSET_PX = 20;
let erOverlayRaf = null;
let erOverlayTeardown = null;

function teardownErOverlay() {
    if (typeof erOverlayTeardown === 'function') {
        erOverlayTeardown();
        erOverlayTeardown = null;
    }
}

function modelPosToRendered(cyInst, pos) {
    const z = cyInst.zoom();
    const pan = cyInst.pan();
    return { x: pos.x * z + pan.x, y: pos.y * z + pan.y };
}

function vecLen(v) {
    return Math.hypot(v.x, v.y);
}

function vecNorm(v) {
    const L = vecLen(v);
    if (L < 1e-9) return { x: 1, y: 0 };
    return { x: v.x / L, y: v.y / L };
}

/** Unit direction along the wire leaving the source node (first segment from sourceEndpoint). */
function edgeOutFromSource(edge) {
    const se = edge.sourceEndpoint();
    const te = edge.targetEndpoint();
    let pts = [];
    try {
        pts = edge.segmentPoints() || [];
    } catch {
        pts = [];
    }
    for (let i = 0; i < pts.length; i++) {
        const v = { x: pts[i].x - se.x, y: pts[i].y - se.y };
        if (vecLen(v) > 1e-3) return vecNorm(v);
    }
    return vecNorm({ x: te.x - se.x, y: te.y - se.y });
}

/** Unit direction along the wire leaving the target node (toward source; last segment into targetEndpoint). */
function edgeOutFromTarget(edge) {
    const se = edge.sourceEndpoint();
    const te = edge.targetEndpoint();
    let pts = [];
    try {
        pts = edge.segmentPoints() || [];
    } catch {
        pts = [];
    }
    for (let k = pts.length - 1; k >= 0; k--) {
        const v = { x: pts[k].x - te.x, y: pts[k].y - te.y };
        if (vecLen(v) > 1e-3) return vecNorm(v);
    }
    return vecNorm({ x: se.x - te.x, y: se.y - te.y });
}

function offsetModelAlong(cyInst, pos, dir, pxWorld) {
    const z = cyInst.zoom();
    const d = pxWorld / Math.max(z, 1e-6);
    return { x: pos.x + dir.x * d, y: pos.y + dir.y * d };
}

/**
 * +x = along wire away from entity; −x = toward entity.
 * Mandatory `|` bars sit at positive x so, scanning center → attribute, you see | then < (or || pairs).
 * optional many O< | mandatory many |< | optional one O| | mandatory one ||
 */
function drawErEndpoint(ctx, x, y, angleRad, many, optional) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angleRad);
    ctx.strokeStyle = '#444';
    ctx.fillStyle = '#444';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const barH = 10;
    const stem = 15;
    const toe = 9;
    const rO = 4.5;
    /**
     * Bars on +x: reading from the wire center toward the attribute (−x), you meet `|` then `<`.
     * OUTER = further along the wire (larger +x); INNER = closer to the crow / attribute.
     */
    const ER_BAR_INNER_X = 5;
    const ER_BAR_OUTER_X = 13;

    function drawCrowFoot(lineW) {
        ctx.lineWidth = lineW;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-stem, 0);
        ctx.moveTo(0, 0);
        ctx.lineTo(-stem, -toe);
        ctx.moveTo(0, 0);
        ctx.lineTo(-stem, toe);
        ctx.stroke();
    }

    function drawPerpBar(x0, lineW) {
        ctx.lineWidth = lineW;
        ctx.beginPath();
        ctx.moveTo(x0, -barH);
        ctx.lineTo(x0, barH);
        ctx.stroke();
    }

    if (many) {
        if (optional) {
            /* O< — circle on the wire outward (+x), then crow toward entity */
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(10, 0, rO, 0, Math.PI * 2);
            ctx.stroke();
            drawCrowFoot(2);
        } else {
            /* |< — crow at anchor; | on +x so order is | then < when moving center → attribute */
            drawCrowFoot(2.75);
            drawPerpBar(ER_BAR_OUTER_X, 2.75);
        }
    } else if (optional) {
        /* O| — circle outward, single bar toward entity */
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(8, 0, rO, 0, Math.PI * 2);
        ctx.stroke();
        drawPerpBar(ER_BAR_INNER_X, 2);
    } else {
        /* || — inner then outer on +x; same spacing as |< outer bar */
        drawPerpBar(ER_BAR_INNER_X, 2.75);
        drawPerpBar(ER_BAR_OUTER_X, 2.75);
    }
    ctx.restore();
}

function syncErOverlayCanvasSize() {
    const canvas = document.getElementById('cy-er-overlay');
    const panel = document.querySelector('.diagram-canvas-stack');
    if (!canvas || !panel) return null;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(panel.clientWidth));
    const h = Math.max(1, Math.floor(panel.clientHeight));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
}

function scheduleErOverlayRedraw() {
    if (erOverlayRaf != null) return;
    erOverlayRaf = requestAnimationFrame(() => {
        erOverlayRaf = null;
        drawErRelationshipOverlay();
    });
}

function drawErRelationshipOverlay() {
    const panel = document.querySelector('.diagram-canvas-stack');
    if (!panel || !cy) return;
    const ctx = syncErOverlayCanvasSize();
    if (!ctx) return;
    ctx.clearRect(0, 0, panel.clientWidth + 1, panel.clientHeight + 1);

    cy.edges('[type = "relationship"]').forEach((edge) => {
        const se = edge.sourceEndpoint();
        const te = edge.targetEndpoint();
        const outS = edgeOutFromSource(edge);
        const outT = edgeOutFromTarget(edge);

        const posS = offsetModelAlong(cy, se, outS, ER_OVERLAY_OFFSET_PX);
        const posT = offsetModelAlong(cy, te, outT, ER_OVERLAY_OFFSET_PX);
        const rs = modelPosToRendered(cy, posS);
        const rt = modelPosToRendered(cy, posT);
        const angS = Math.atan2(outS.y, outS.x);
        const angT = Math.atan2(outT.y, outT.x);

        const manyP = edge.data('parentCardinality') === 'Many';
        const optP = edge.data('parentMandatory') !== true;
        const manyC = edge.data('childCardinality') === 'Many';
        const optC = edge.data('childMandatory') !== true;

        drawErEndpoint(ctx, rs.x, rs.y, angS, manyP, optP);
        drawErEndpoint(ctx, rt.x, rt.y, angT, manyC, optC);
    });
}

function setupErOverlay(cyInst) {
    teardownErOverlay();
    const onV = () => scheduleErOverlayRedraw();
    cyInst.on('render', onV);
    cyInst.on('viewport', onV);
    erOverlayTeardown = () => {
        cyInst.off('render', onV);
        cyInst.off('viewport', onV);
    };
}

let model = {};
let layout = {};
let positions = {};
let nodes = [];
let edges = [];
/** Canonical meta.technical_name; files are &lt;technical_name&gt;.json and temp_&lt;technical_name&gt; while editing. */
let canonicalTechnicalName = null;
let workspaceResizeInitialized = false;
let cy;

/** Matches [schemas/model.json](schemas/model.json) entity_type.enum */
const SCHEMA_ENTITY_TYPES = ['view', 'table'];
/** Matches schemas/model.json attributes.items.properties.data_type.enum */
const SCHEMA_DATA_TYPES = [
    'STRING', 'TEXT', 'INTEGER', 'BIGINT', 'SMALLINT', 'DECIMAL', 'FLOAT',
    'BOOLEAN', 'DATE', 'TIMESTAMP', 'BINARY',
];
/** Matches schemas/model.json key_type.enum (null = none) */
const SCHEMA_KEY_TYPES = ['PRIMARY', 'FOREIGN', 'NATURAL'];
/** schemas/model.json parent_cardinality / child_cardinality.enum */
const SCHEMA_SIDE_CARDINALITY = ['One', 'Many'];

/** Must match TECHNICAL_NAME_RE in app.py (UX + displayNameToTechnicalName). */
const TECHNICAL_NAME_RE = /^[a-z][a-z0-9_]*$/;

let persistModelTimer = null;
let detailsPersistErrorText = null;
/** Debounced rename when meta.name implies a new technical_name. */
let metaRenameTimer = null;
let pendingDerivedTechnical = null;
/** Canonical stem when the working copy was loaded (for superseding old files on Save). */
let openedAsTechnicalName = null;
/** Live metadata technical field (for post-rename DOM sync). */
let metadataTechnicalInputEl = null;
/** Live metadata name field (restore after empty-name validation). */
let metadataNameInputEl = null;
/** Last non-empty trimmed model name; used to revert illegal clears. */
let lastValidModelMetaName = '';
/** Set when the user taps an entity (or its header) on the diagram; cleared on background tap. */
let selectedEntityId = null;

/** Captured before `cy.destroy()` so pan/zoom can be restored after rebuild; cleared when loading another model. */
let preservedCyViewport = null;

/** When true, next `renderCy()` skips preserving pan/zoom and fits all elements (e.g. after adding an entity). */
let fitCyViewportAfterNextRender = false;

/** Loaded from GET /api/naming_config; matches [schemas/naming.json](schemas/naming.json). */
let namingConfig = null;

/** Matches schemas/naming.json naming_convention.enum */
const NAMING_CONVENTIONS = [
    'lower_snake_case',
    'UPPER_SNAKE_CASE',
    'Proper_Snake_Case',
    'lower-kebab-case',
    'UPPER-KEBAB-CASE',
    'Proper-Kebab-Case',
    'camelCase',
    'PascalCase',
];

function defaultNamingConfig() {
    return { naming_convention: 'lower_snake_case', word_mappings: [] };
}

async function loadNamingConfig() {
    try {
        const res = await fetch('/api/naming_config');
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!data || typeof data !== 'object') {
            namingConfig = defaultNamingConfig();
            return;
        }
        namingConfig = data;
        if (!Array.isArray(namingConfig.word_mappings)) namingConfig.word_mappings = [];
    } catch (e) {
        console.error(e);
        namingConfig = defaultNamingConfig();
    }
}

function getSortedWordMappings() {
    const cfg = namingConfig || defaultNamingConfig();
    const list = Array.isArray(cfg.word_mappings) ? cfg.word_mappings : [];
    return [...list]
        .filter((m) => m && typeof m.business_name === 'string' && m.business_name.trim())
        .sort((a, b) => b.business_name.trim().length - a.business_name.trim().length);
}

/** Letters/digits from a single unknown word → lowercase slug. */
function slugifyBusinessWord(word) {
    let s = String(word ?? '').trim();
    try {
        s = s.normalize('NFKD').replace(/\p{M}+/gu, '');
    } catch {
        /* ignore if unsupported */
    }
    s = s.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
    return s || 'x';
}

function phraseMatchLen(remaining, phraseLower) {
    const pl = phraseLower;
    if (!pl.length) return 0;
    const r = remaining;
    if (r.length < pl.length) return 0;
    const rl = r.slice(0, pl.length).toLowerCase();
    if (rl !== pl) return 0;
    if (r.length === pl.length) return pl.length;
    const next = r[pl.length];
    if (next === ' ' || next === '\t' || next === '\n') return pl.length;
    return 0;
}

function segmentsFromBusinessName(businessName) {
    const mappings = getSortedWordMappings();
    let s = String(businessName ?? '')
        .trim()
        .replace(/\s+/g, ' ');
    if (!s) return [];
    const segments = [];
    while (s.length) {
        s = s.replace(/^\s+/, '');
        if (!s.length) break;
        let matched = false;
        for (const m of mappings) {
            const key = m.business_name.trim();
            if (!key) continue;
            const len = phraseMatchLen(s, key.toLowerCase());
            if (len > 0) {
                const abbr = String(m.technical_abbreviation ?? '').trim();
                segments.push(abbr || slugifyBusinessWord(key));
                s = s.slice(len);
                matched = true;
                break;
            }
        }
        if (matched) continue;
        const sp = s.indexOf(' ');
        const word = sp === -1 ? s : s.slice(0, sp);
        s = sp === -1 ? '' : s.slice(sp + 1);
        const wordTrim = word.trim();
        if (!wordTrim) continue;
        let mappedAbbr = null;
        for (const m of mappings) {
            if (m.business_name.trim().toLowerCase() === wordTrim.toLowerCase()) {
                mappedAbbr = String(m.technical_abbreviation ?? '').trim();
                break;
            }
        }
        segments.push(mappedAbbr || slugifyBusinessWord(wordTrim));
    }
    return segments;
}

function flattenSegmentWords(segments) {
    const words = [];
    for (const seg of segments) {
        String(seg)
            .split(/_+/)
            .filter(Boolean)
            .forEach((w) => words.push(w));
    }
    return words;
}

function capitalizeWordProper(p) {
    if (!p) return '';
    return p[0].toUpperCase() + p.slice(1).toLowerCase();
}

function applyNamingConvention(segments, convention) {
    const words = flattenSegmentWords(segments);
    if (words.length === 0) return '';
    switch (convention) {
        case 'lower_snake_case':
            return words.map((w) => w.toLowerCase()).join('_');
        case 'UPPER_SNAKE_CASE':
            return words.map((w) => w.toUpperCase()).join('_');
        case 'Proper_Snake_Case':
            return words.map((w) => capitalizeWordProper(w)).join('_');
        case 'lower-kebab-case':
            return words.map((w) => w.toLowerCase()).join('-');
        case 'UPPER-KEBAB-CASE':
            return words.map((w) => w.toUpperCase()).join('-');
        case 'Proper-Kebab-Case':
            return words.map((w) => capitalizeWordProper(w)).join('-');
        case 'camelCase': {
            const lower = words.map((w) => w.toLowerCase());
            let out = lower[0];
            for (let i = 1; i < lower.length; i++) {
                const p = lower[i];
                out += p ? p[0].toUpperCase() + p.slice(1) : '';
            }
            return out;
        }
        case 'PascalCase': {
            let out = '';
            for (const w of words) {
                const p = w.toLowerCase();
                out += p ? p[0].toUpperCase() + p.slice(1) : '';
            }
            return out;
        }
        default:
            return words.map((w) => w.toLowerCase()).join('_');
    }
}

function deriveTechnicalNameFromBusiness(businessName) {
    const cfg = namingConfig || defaultNamingConfig();
    const conv = NAMING_CONVENTIONS.includes(cfg.naming_convention)
        ? cfg.naming_convention
        : 'lower_snake_case';
    const raw = String(businessName ?? '').trim();
    if (!raw) return 'unnamed';
    const segments = segmentsFromBusinessName(raw);
    if (segments.length === 0) return 'unnamed';
    let result = applyNamingConvention(segments, conv);
    if (!result || !/[\p{L}\p{N}]/u.test(result)) result = 'unnamed';
    if (!isValidEntityAttributeTechnicalName(result)) {
        result = `x_${result}`;
    }
    if (!isValidEntityAttributeTechnicalName(result)) result = 'unnamed';
    return result;
}

/** Identifier for entity/attribute technical_name (Unicode letter/digit start; then word chars, underscore, hyphen). */
function isValidEntityAttributeTechnicalName(name) {
    if (typeof name !== 'string' || !name.trim()) return false;
    if (name.length > 500) return false;
    return /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(name);
}

function ensureUniqueEntityTechnicalName(base, excludeEntityId) {
    const entities = model.entities || [];
    const taken = new Set(
        entities.filter((e) => e.entity_id !== excludeEntityId).map((e) => e.technical_name),
    );
    const b = base || 'unnamed';
    if (!taken.has(b)) return b;
    for (let n = 2; n < 10000; n++) {
        const c = `${b}_${n}`;
        if (!taken.has(c)) return c;
    }
    return `${b}_${Date.now()}`;
}

function ensureUniqueAttributeTechnicalName(base, excludeAttributeId, entity) {
    const attrs = entity?.attributes || [];
    const taken = new Set(
        attrs.filter((a) => a.attribute_id !== excludeAttributeId).map((a) => a.technical_name),
    );
    const b = base || 'unnamed';
    if (!taken.has(b)) return b;
    for (let n = 2; n < 10000; n++) {
        const c = `${b}_${n}`;
        if (!taken.has(c)) return c;
    }
    return `${b}_${Date.now()}`;
}

function derivedEntityTechnicalNameForBusiness(businessName, excludeEntityId) {
    const base = deriveTechnicalNameFromBusiness(businessName);
    return ensureUniqueEntityTechnicalName(base, excludeEntityId);
}

function derivedAttributeTechnicalNameForBusiness(businessName, entity, excludeAttributeId) {
    const base = deriveTechnicalNameFromBusiness(businessName);
    return ensureUniqueAttributeTechnicalName(base, excludeAttributeId, entity);
}

function syncAddEntityTechnicalPreview() {
    const biz = document.getElementById('add-entity-business-name')?.value ?? '';
    const techEl = document.getElementById('add-entity-technical-name');
    if (!techEl) return;
    techEl.value = derivedEntityTechnicalNameForBusiness(biz.trim(), undefined);
}

function syncAddAttributeTechnicalPreview() {
    const biz = document.getElementById('add-attribute-business-name')?.value ?? '';
    const techEl = document.getElementById('add-attribute-technical-name');
    if (!techEl) return;
    const ent = findEntityById(selectedEntityId);
    if (!ent) {
        techEl.value = '';
        return;
    }
    techEl.value = derivedAttributeTechnicalNameForBusiness(biz.trim(), ent, undefined);
}

/** Letters, numbers, spaces, and underscores only (Unicode letters and numbers). */
function sanitizeMetaModelName(raw) {
    return String(raw ?? '').replace(/[^\p{L}\p{N}_ ]/gu, '');
}

/** Strips disallowed characters and keeps the caret in a sensible position. */
function applyMetaModelNameSanitizeToInput(el) {
    const raw = el.value;
    const caret = el.selectionStart ?? raw.length;
    const cleaned = sanitizeMetaModelName(raw);
    if (cleaned !== raw) {
        const before = raw.slice(0, Math.min(caret, raw.length));
        const newCaret = sanitizeMetaModelName(before).length;
        el.value = cleaned;
        el.setSelectionRange(newCaret, newCaret);
    }
    return el.value;
}

/**
 * Maps display name to lower_snake_case technical stem, or null if the name cannot produce a valid id
 * (must match TECHNICAL_NAME_RE: letter first, then letters/digits/underscores). No automatic fixes.
 */
function displayNameToTechnicalName(displayName) {
    let s = String(displayName ?? '').trim().toLowerCase();
    try {
        s = s.normalize('NFKD').replace(/\p{M}+/gu, '');
    } catch {
        /* ignore if unsupported */
    }
    s = s.replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!s) return null;
    if (!/^[a-z]/.test(s)) return null;
    s = s.replace(/[^a-z0-9_]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!s) return null;
    if (!/^[a-z]/.test(s)) return null;
    if (!TECHNICAL_NAME_RE.test(s)) return null;
    return s;
}

async function renameWorkingToTechnicalName(fromTn, desiredTn) {
    if (!TECHNICAL_NAME_RE.test(desiredTn)) {
        return { ok: false, error: 'Invalid technical name format.' };
    }
    const res = await fetch('/api/rename_working_model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from_technical_name: fromTn,
            to_technical_name: desiredTn,
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
        return { ok: true, technical_name: data.technical_name ?? desiredTn };
    }
    return { ok: false, error: data.error || res.statusText || 'Rename failed' };
}

async function applyPendingMetaTechnicalRename() {
    metaRenameTimer = null;
    const target = pendingDerivedTechnical;
    if (!canonicalTechnicalName) return;

    const name = (model.meta?.name ?? '').trim();
    if (!name) {
        const msg = 'Model name cannot be empty.';
        detailsPersistErrorText = msg;
        syncDetailsPersistBanner();
        alert(msg);
        ensureModelMeta();
        const revert = lastValidModelMetaName || canonicalTechnicalName;
        model.meta.name = revert;
        if (metadataNameInputEl?.isConnected) {
            metadataNameInputEl.value = revert;
        }
        const d = displayNameToTechnicalName(revert);
        pendingDerivedTechnical = d;
        if (metadataTechnicalInputEl?.isConnected) {
            const stem = model.meta.technical_name ?? canonicalTechnicalName ?? '';
            metadataTechnicalInputEl.value = d ?? stem;
        }
        detailsPersistErrorText = null;
        syncDetailsPersistBanner();
        schedulePersistWorkingModel();
        refreshDiagramMetaStrip();
        return;
    }

    if (target == null) {
        const msg =
            'This model name does not produce a valid technical id. Use a name that starts with a letter (after spaces are removed) and only yields letters, numbers, and underscores — or pick a different name.';
        detailsPersistErrorText = msg;
        syncDetailsPersistBanner();
        alert(msg);
        if (metadataTechnicalInputEl?.isConnected) {
            metadataTechnicalInputEl.value = canonicalTechnicalName;
        }
        return;
    }

    if (target === canonicalTechnicalName) {
        ensureModelMeta();
        model.meta.technical_name = target;
        lastValidModelMetaName = name;
        schedulePersistWorkingModel();
        refreshDiagramMetaStrip();
        return;
    }
    const from = canonicalTechnicalName;
    const r = await renameWorkingToTechnicalName(from, target);
    if (!r.ok) {
        detailsPersistErrorText = r.error;
        syncDetailsPersistBanner();
        alert(r.error);
        if (metadataTechnicalInputEl?.isConnected) {
            metadataTechnicalInputEl.value = canonicalTechnicalName;
        }
        return;
    }
    canonicalTechnicalName = r.technical_name;
    ensureModelMeta();
    model.meta.technical_name = r.technical_name;
    pendingDerivedTechnical = r.technical_name;
    if (metadataTechnicalInputEl?.isConnected) {
        metadataTechnicalInputEl.value = r.technical_name;
    }
    detailsPersistErrorText = null;
    syncDetailsPersistBanner();
    schedulePersistWorkingModel();
    lastValidModelMetaName = name;
    refreshDiagramMetaStrip();
}

async function retrieveModel(technicalName, working) {
    const res = await fetch('/api/load_model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ technical_name: technicalName, working }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText);
    }
    model = await res.json();
}

async function retrieveLayout(technicalName, working) {
    const res = await fetch('/api/load_layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ technical_name: technicalName, working }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText);
    }
    const rJson = await res.json();
    layout = rJson;
    positions = {};
    const arr = layout.layout || [];
    for (const position of arr) {
        positions[position.entity_id] = { x: position.x_coord, y: position.y_coord };
    }
}

async function loadWorkingCopyAndRender(technicalName) {
    clearTimeout(persistModelTimer);
    persistModelTimer = null;
    clearTimeout(metaRenameTimer);
    metaRenameTimer = null;
    pendingDerivedTechnical = null;
    canonicalTechnicalName = technicalName;
    openedAsTechnicalName = technicalName;
    await retrieveModel(technicalName, true);
    lastValidModelMetaName = (model.meta?.name ?? '').trim() || technicalName;
    await retrieveLayout(technicalName, true);
    modelToNodesEdges();
    console.log('Nodes created:', nodes.length);
    console.log('Edges created:', edges.length);
    selectedEntityId = null;
    syncAddAttributeButtonState();
    syncAddRelationshipButtonState();
    preservedCyViewport = null;
    fitCyViewportAfterNextRender = false;
    if (cy) {
        teardownErOverlay();
        cy.destroy();
        cy = undefined;
    }
    renderCy();
    clearDetailsPane();
}

async function openCanonicalModel(technicalName) {
    const res = await fetch('/api/open_model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ technical_name: technicalName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        throw new Error(data.error || res.statusText);
    }
    await loadWorkingCopyAndRender(technicalName);
}

async function openModel() {
    const btn = document.getElementById('open-model-btn');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/list_technical_names');
        if (!res.ok) {
            alert('Could not list models.');
            return;
        }
        const data = await res.json();
        const technicalNames = data.technical_names || [];
        if (technicalNames.length === 0) {
            alert('No models found in data/models.');
            return;
        }
        const listEl = document.getElementById('open-model-list');
        const dialog = document.getElementById('open-model-dialog');
        if (!listEl || !dialog) return;
        listEl.replaceChildren();
        for (const s of technicalNames) {
            const li = document.createElement('li');
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = s;
            b.addEventListener('click', async () => {
                dialog.close();
                try {
                    await openCanonicalModel(s);
                } catch (e) {
                    console.error(e);
                    alert(e.message || 'Failed to load model.');
                }
            });
            li.appendChild(b);
            listEl.appendChild(li);
        }
        dialog.showModal();
    } catch (e) {
        console.error(e);
        alert('Could not list models.');
    } finally {
        if (btn) btn.disabled = false;
    }
}

function findEntityById(id) {
    const entities = model.entities || [];
    return entities.find((e) => e.entity_id === id) ?? null;
}

function findAttributeById(id) {
    const entities = model.entities || [];
    for (const ent of entities) {
        const attrs = ent.attributes || [];
        const attr = attrs.find((a) => a.attribute_id === id);
        if (attr) return attr;
    }
    return null;
}

function findEntityContainingAttribute(attributeId) {
    const entities = model.entities || [];
    for (const ent of entities) {
        const attrs = ent.attributes || [];
        if (attrs.some((a) => a.attribute_id === attributeId)) {
            return ent;
        }
    }
    return null;
}

function findRelationshipById(id) {
    const rels = model.relationships || [];
    return rels.find((r) => r.relationship_id === id) ?? null;
}

function syncAddAttributeButtonState() {
    const btn = document.getElementById('add-attribute-btn');
    if (btn) btn.disabled = !selectedEntityId || !canonicalTechnicalName;
}

function countModelAttributes() {
    let n = 0;
    for (const ent of model.entities || []) {
        n += (ent.attributes || []).length;
    }
    return n;
}

function syncAddRelationshipButtonState() {
    const btn = document.getElementById('add-relationship-btn');
    if (btn) btn.disabled = !canonicalTechnicalName || countModelAttributes() < 2;
}

/** True when every entity in `model` has `{ x, y }` in `positions` (used to place nodes without dagre). */
function entitiesAllHaveStoredPositions() {
    const entities = model.entities || [];
    if (entities.length === 0) return false;
    return entities.every((e) => {
        const p = positions[e.entity_id];
        return p && Number.isFinite(p.x) && Number.isFinite(p.y);
    });
}

/**
 * Position for a new entity: to the left of the current left-most entity, or (0,0) if none.
 * Call before mutating `model.entities` so `cy` still reflects the prior set.
 */
function computePositionForNewEntity() {
    const existing = model.entities || [];
    if (existing.length === 0 || !cy || typeof cy.nodes !== 'function') {
        return { x: 0, y: 0 };
    }
    const entNodes = cy.nodes('[type = "entity"]');
    if (entNodes.length === 0) {
        return { x: 0, y: 0 };
    }
    let minX1 = Infinity;
    let leftNode = null;
    entNodes.forEach((ent) => {
        const bb = ent.boundingbox({ includeLabels: true });
        if (bb.x1 < minX1) {
            minX1 = bb.x1;
            leftNode = ent;
        }
    });
    if (!leftNode) return { x: 0, y: 0 };
    const bb = leftNode.boundingbox({ includeLabels: true });
    const gap = 120;
    const newW = Math.max(MIN_CARD_WIDTH * 1.5, bb.w);
    const newX = bb.x1 - gap - newW / 2;
    const newY = leftNode.position('y');
    return { x: newX, y: newY };
}

function patchRelationshipEdgeData(rel) {
    if (!cy) return;
    const e = cy.getElementById(rel.relationship_id);
    if (e.length === 0) return;
    e.data('label', rel.cardinality ?? '');
    e.data('cardinality', rel.cardinality);
    e.data('parentMandatory', rel.parent_mandatory);
    e.data('childMandatory', rel.child_mandatory);
    e.data('parentCardinality', rel.parent_cardinality);
    e.data('childCardinality', rel.child_cardinality);
    cy.style().update();
    scheduleErOverlayRedraw();
}

function patchEntityLabelInCy(entityId, businessName) {
    if (!cy) return;
    const label = businessName ?? '';
    const ent = cy.getElementById(entityId);
    if (ent.nonempty()) {
        ent.data('label', label);
        ent.data('businessName', label);
    }
    const hdr = cy.getElementById(`${entityId}_hdr`);
    if (hdr.nonempty()) {
        hdr.data('label', label);
        hdr.data('businessName', label);
    }
    syncEntityCardWidthInCy(entityId);
}

function patchAttributeLabelInCy(attributeId, businessName) {
    if (!cy) return;
    const n = cy.getElementById(attributeId);
    if (n.nonempty()) {
        n.data('label', businessName ?? '');
        n.data('businessName', businessName ?? '');
    }
    const ent = findEntityContainingAttribute(attributeId);
    if (ent) syncEntityCardWidthInCy(ent.entity_id);
}

function patchEntityTechnicalNameInCy(entityId, technicalName) {
    if (!cy) return;
    const t = technicalName ?? '';
    const ent = cy.getElementById(entityId);
    if (ent.nonempty()) ent.data('technicalName', t);
    const hdr = cy.getElementById(`${entityId}_hdr`);
    if (hdr.nonempty()) hdr.data('technicalName', t);
}

function patchAttributeTechnicalNameInCy(attributeId, technicalName) {
    if (!cy) return;
    const n = cy.getElementById(attributeId);
    if (n.nonempty()) n.data('technicalName', technicalName ?? '');
}

function syncDetailsPersistBanner() {
    const el = document.getElementById('details-persist-message');
    if (!el) return;
    if (detailsPersistErrorText) {
        el.hidden = false;
        el.textContent = detailsPersistErrorText;
        el.className = 'details-persist-message is-error';
    } else {
        el.hidden = true;
        el.textContent = '';
        el.className = 'details-persist-message';
    }
}

function schedulePersistWorkingModel() {
    clearTimeout(persistModelTimer);
    persistModelTimer = setTimeout(() => {
        persistModelTimer = null;
        persistWorkingModel();
    }, 450);
}

/** Persists in-memory `model` to temp_<technical_name>.json. Returns whether the write succeeded. */
async function persistWorkingModel() {
    if (!canonicalTechnicalName) return true;
    if (!(model.meta?.name ?? '').trim()) {
        detailsPersistErrorText = 'Model name cannot be empty.';
        syncDetailsPersistBanner();
        return false;
    }
    try {
        const res = await fetch('/api/save_working_model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                technical_name: canonicalTechnicalName,
                working: true,
                model,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            detailsPersistErrorText = data.error || res.statusText || 'Save failed';
            syncDetailsPersistBanner();
            return false;
        }
        detailsPersistErrorText = null;
        syncDetailsPersistBanner();
        return true;
    } catch (e) {
        console.error(e);
        detailsPersistErrorText = e.message || 'Save failed';
        syncDetailsPersistBanner();
        return false;
    }
}

function appendDetailsFormField(form, labelText, control) {
    const wrap = document.createElement('div');
    wrap.className = 'details-field';
    const lab = document.createElement('label');
    lab.className = 'details-field-label';
    lab.textContent = labelText;
    wrap.appendChild(lab);
    control.classList.add('details-field-control');
    wrap.appendChild(control);
    form.appendChild(wrap);
}

/** Replaces `#details-content` with persist banner, heading, and an empty `.details-form`. */
function beginDetailsPane(headingText) {
    const root = document.getElementById('details-content');
    if (!root) return null;
    root.replaceChildren();
    const banner = document.createElement('div');
    banner.id = 'details-persist-message';
    banner.className = 'details-persist-message';
    banner.hidden = true;
    root.appendChild(banner);
    syncDetailsPersistBanner();

    const h3 = document.createElement('h3');
    h3.textContent = headingText;
    root.appendChild(h3);

    const form = document.createElement('div');
    form.className = 'details-form';
    return { root, form };
}

/** Fills a `<select>` from `allowedValues`, appending `currentValue` when not in the list. */
function fillDetailsEnumSelect(select, allowedValues, currentValue) {
    const values = allowedValues.includes(currentValue)
        ? allowedValues
        : [...allowedValues, currentValue].filter(Boolean);
    select.replaceChildren();
    for (const v of values) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        if (v === currentValue) opt.selected = true;
        select.appendChild(opt);
    }
}

function renderEntityDetails(ent) {
    const shell = beginDetailsPane('Entity');
    if (!shell) return;
    const { root, form } = shell;

    const inpBusiness = document.createElement('input');
    inpBusiness.type = 'text';
    inpBusiness.value = ent.business_name ?? '';

    const inpTechnical = document.createElement('input');
    inpTechnical.type = 'text';
    inpTechnical.readOnly = true;
    inpTechnical.value = ent.technical_name ?? '';
    inpTechnical.title = 'Derived from business name and naming config';

    inpBusiness.addEventListener('input', () => {
        ent.business_name = inpBusiness.value;
        patchEntityLabelInCy(ent.entity_id, ent.business_name);
        const next = derivedEntityTechnicalNameForBusiness(ent.business_name, ent.entity_id);
        ent.technical_name = next;
        inpTechnical.value = next;
        patchEntityTechnicalNameInCy(ent.entity_id, next);
        schedulePersistWorkingModel();
    });
    appendDetailsFormField(form, 'business_name', inpBusiness);
    appendDetailsFormField(form, 'technical_name', inpTechnical);

    const taDef = document.createElement('textarea');
    taDef.rows = 4;
    taDef.value = ent.definition ?? '';
    taDef.addEventListener('input', () => {
        ent.definition = taDef.value;
        schedulePersistWorkingModel();
    });
    appendDetailsFormField(form, 'definition', taDef);

    const selType = document.createElement('select');
    fillDetailsEnumSelect(selType, SCHEMA_ENTITY_TYPES, ent.entity_type);
    selType.addEventListener('change', () => {
        ent.entity_type = selType.value;
        schedulePersistWorkingModel();
    });
    appendDetailsFormField(form, 'entity_type', selType);

    root.appendChild(form);
}

function parseOptionalIntField(attr, key, raw) {
    const t = String(raw).trim();
    if (t === '') {
        delete attr[key];
        return;
    }
    const n = parseInt(t, 10);
    if (!Number.isNaN(n)) {
        attr[key] = n;
    }
}

function clearPrecisionScaleUnlessDecimal(attr) {
    if (attr.data_type !== 'DECIMAL') {
        delete attr.precision;
        delete attr.scale;
    }
}

function sortedEntityAttributes(ent) {
    const attrs = [...(ent.attributes || [])];
    attrs.sort((a, b) => {
        const oa = Number(a.attribute_order);
        const ob = Number(b.attribute_order);
        const na = Number.isFinite(oa) ? oa : 0;
        const nb = Number.isFinite(ob) ? ob : 0;
        if (na !== nb) return na - nb;
        return String(a.attribute_id).localeCompare(String(b.attribute_id));
    });
    return attrs;
}

/** direction -1 = move up (earlier), +1 = move down (later). Swaps attribute_order with adjacent sibling. */
function swapAttributeOrderWithNeighbor(attr, direction) {
    const ent = findEntityContainingAttribute(attr.attribute_id);
    if (!ent) return false;
    const attrs = sortedEntityAttributes(ent);
    const idx = attrs.findIndex((a) => a.attribute_id === attr.attribute_id);
    if (idx < 0) return false;
    const j = idx + direction;
    if (j < 0 || j >= attrs.length) return false;
    const cur = attrs[idx];
    const other = attrs[j];
    const tmp = cur.attribute_order;
    cur.attribute_order = other.attribute_order;
    other.attribute_order = tmp;
    return true;
}

function renderAttributeDetails(attr) {
    clearPrecisionScaleUnlessDecimal(attr);

    const shell = beginDetailsPane('Attribute');
    if (!shell) return;
    const { root, form } = shell;

    const entForAttr = findEntityContainingAttribute(attr.attribute_id);

    const inpBusiness = document.createElement('input');
    inpBusiness.type = 'text';
    inpBusiness.value = attr.business_name ?? '';

    const inpTechnical = document.createElement('input');
    inpTechnical.type = 'text';
    inpTechnical.readOnly = true;
    inpTechnical.value = attr.technical_name ?? '';
    inpTechnical.title = 'Derived from business name and naming config';

    inpBusiness.addEventListener('input', () => {
        attr.business_name = inpBusiness.value;
        patchAttributeLabelInCy(attr.attribute_id, attr.business_name);
        if (entForAttr) {
            const next = derivedAttributeTechnicalNameForBusiness(
                attr.business_name,
                entForAttr,
                attr.attribute_id,
            );
            attr.technical_name = next;
            inpTechnical.value = next;
            patchAttributeTechnicalNameInCy(attr.attribute_id, next);
        }
        schedulePersistWorkingModel();
    });
    appendDetailsFormField(form, 'business_name', inpBusiness);
    appendDetailsFormField(form, 'technical_name', inpTechnical);

    const taDef = document.createElement('textarea');
    taDef.rows = 4;
    taDef.value = attr.definition ?? '';
    taDef.addEventListener('input', () => {
        attr.definition = taDef.value;
        schedulePersistWorkingModel();
    });
    appendDetailsFormField(form, 'definition', taDef);

    const inpMap = document.createElement('input');
    inpMap.type = 'text';
    inpMap.value = attr.source_mapping ?? '';
    inpMap.addEventListener('input', () => {
        attr.source_mapping = inpMap.value;
        schedulePersistWorkingModel();
    });
    appendDetailsFormField(form, 'source_mapping', inpMap);

    const selData = document.createElement('select');
    fillDetailsEnumSelect(selData, SCHEMA_DATA_TYPES, attr.data_type);
    selData.addEventListener('change', () => {
        attr.data_type = selData.value;
        clearPrecisionScaleUnlessDecimal(attr);
        schedulePersistWorkingModel();
        renderAttributeDetails(attr);
    });
    appendDetailsFormField(form, 'data_type', selData);

    if (attr.data_type === 'DECIMAL') {
        const inpPrec = document.createElement('input');
        inpPrec.type = 'text';
        inpPrec.inputMode = 'numeric';
        inpPrec.value =
            attr.precision !== undefined && attr.precision !== null ? String(attr.precision) : '';
        inpPrec.addEventListener('input', () => {
            parseOptionalIntField(attr, 'precision', inpPrec.value);
            schedulePersistWorkingModel();
        });
        appendDetailsFormField(form, 'precision', inpPrec);

        const inpScale = document.createElement('input');
        inpScale.type = 'text';
        inpScale.inputMode = 'numeric';
        inpScale.value =
            attr.scale !== undefined && attr.scale !== null ? String(attr.scale) : '';
        inpScale.addEventListener('input', () => {
            parseOptionalIntField(attr, 'scale', inpScale.value);
            schedulePersistWorkingModel();
        });
        appendDetailsFormField(form, 'scale', inpScale);
    }

    const selKey = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(none)';
    noneOpt.selected = attr.key_type === null || attr.key_type === undefined;
    selKey.appendChild(noneOpt);
    for (const v of SCHEMA_KEY_TYPES) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        if (attr.key_type === v) opt.selected = true;
        selKey.appendChild(opt);
    }
    selKey.addEventListener('change', () => {
        const v = selKey.value;
        attr.key_type = v === '' ? null : v;
        schedulePersistWorkingModel();
    });
    appendDetailsFormField(form, 'key_type', selKey);

    const attrsSorted = entForAttr ? sortedEntityAttributes(entForAttr) : [];
    const orderIdx = attrsSorted.findIndex((a) => a.attribute_id === attr.attribute_id);

    const orderWrap = document.createElement('div');
    orderWrap.className = 'details-field';
    const orderLab = document.createElement('span');
    orderLab.className = 'details-field-label';
    orderLab.textContent = 'attribute_order';
    orderWrap.appendChild(orderLab);
    const orderRow = document.createElement('div');
    orderRow.className = 'details-order-row';
    const orderVal = document.createElement('span');
    orderVal.className = 'details-order-value';
    orderVal.textContent =
        attr.attribute_order !== undefined && attr.attribute_order !== null
            ? String(attr.attribute_order)
            : '';
    const btnUp = document.createElement('button');
    btnUp.type = 'button';
    btnUp.className = 'details-order-btn';
    btnUp.setAttribute('aria-label', 'Move attribute up');
    btnUp.textContent = '↑';
    btnUp.disabled = orderIdx <= 0;
    btnUp.addEventListener('click', () => {
        if (!swapAttributeOrderWithNeighbor(attr, -1)) return;
        const eid = findEntityContainingAttribute(attr.attribute_id)?.entity_id;
        if (eid) syncEntityAttributeOrderInCy(eid);
        schedulePersistWorkingModel();
        renderAttributeDetails(attr);
    });
    const btnDown = document.createElement('button');
    btnDown.type = 'button';
    btnDown.className = 'details-order-btn';
    btnDown.setAttribute('aria-label', 'Move attribute down');
    btnDown.textContent = '↓';
    btnDown.disabled = orderIdx < 0 || orderIdx >= attrsSorted.length - 1;
    btnDown.addEventListener('click', () => {
        if (!swapAttributeOrderWithNeighbor(attr, 1)) return;
        const eid = findEntityContainingAttribute(attr.attribute_id)?.entity_id;
        if (eid) syncEntityAttributeOrderInCy(eid);
        schedulePersistWorkingModel();
        renderAttributeDetails(attr);
    });
    orderRow.appendChild(orderVal);
    orderRow.appendChild(btnUp);
    orderRow.appendChild(btnDown);
    orderWrap.appendChild(orderRow);
    form.appendChild(orderWrap);

    root.appendChild(form);
}

function formatRecordValueForDetails(value) {
    if (value === null) return { isJson: false, text: 'null' };
    if (typeof value === 'string') {
        return { isJson: false, text: value === '' ? '(empty)' : value };
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return { isJson: false, text: String(value) };
    }
    if (typeof value === 'object') {
        return { isJson: true, text: JSON.stringify(value, null, 2) };
    }
    return { isJson: false, text: String(value) };
}

const RELATIONSHIP_EDITABLE_KEYS = new Set([
    'child_cardinality',
    'child_mandatory',
    'parent_cardinality',
    'parent_mandatory',
]);

/** Sets rel.cardinality to 1:1 / 1:M / M:1 / M:M from parent_cardinality and child_cardinality (One|Many). */
function deriveRelationshipCardinality(rel) {
    const p = rel.parent_cardinality === 'Many' ? 'M' : '1';
    const c = rel.child_cardinality === 'Many' ? 'M' : '1';
    rel.cardinality = `${p}:${c}`;
}

/** Sets rel.relationship_name from technical names and derived cardinality; no-op if entities/attributes are missing. */
function syncRelationshipName(rel) {
    deriveRelationshipCardinality(rel);
    const pEnt = findEntityById(rel.parent_entity_id);
    const cEnt = findEntityById(rel.child_entity_id);
    const pAttr = findAttributeById(rel.parent_attribute_id);
    const cAttr = findAttributeById(rel.child_attribute_id);
    if (!pEnt || !cEnt || !pAttr || !cAttr) return;
    rel.relationship_name = `${pEnt.technical_name}.${pAttr.technical_name} ${rel.cardinality} ${cEnt.technical_name}.${cAttr.technical_name}`;
}

function renderRelationshipDetails(rel) {
    const shell = beginDetailsPane('Relationship');
    if (!shell) return;
    const { root, form } = shell;

    function addBoolField(labelText, checked, onChange) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked === true;
        cb.addEventListener('change', () => {
            onChange(cb.checked);
            syncRelationshipName(rel);
            patchRelationshipEdgeData(rel);
            schedulePersistWorkingModel();
        });
        appendDetailsFormField(form, labelText, cb);
    }

    function addSideCardinalitySelect(labelText, current, setField) {
        const sel = document.createElement('select');
        fillDetailsEnumSelect(sel, SCHEMA_SIDE_CARDINALITY, current);
        sel.addEventListener('change', () => {
            setField(sel.value);
            syncRelationshipName(rel);
            cardinalityValueEl.textContent = rel.cardinality;
            patchRelationshipEdgeData(rel);
            schedulePersistWorkingModel();
        });
        appendDetailsFormField(form, labelText, sel);
    }

    const prevCardinality = rel.cardinality;
    const prevName = rel.relationship_name ?? '';
    syncRelationshipName(rel);
    if (prevCardinality !== rel.cardinality || prevName !== (rel.relationship_name ?? '')) {
        patchRelationshipEdgeData(rel);
        schedulePersistWorkingModel();
    }
    const cardinalityValueEl = document.createElement('div');
    cardinalityValueEl.className = 'details-field-control details-static';
    cardinalityValueEl.textContent = rel.cardinality;

    addSideCardinalitySelect('parent_cardinality', rel.parent_cardinality, (v) => {
        rel.parent_cardinality = v;
    });
    addSideCardinalitySelect('child_cardinality', rel.child_cardinality, (v) => {
        rel.child_cardinality = v;
    });

    const cardWrap = document.createElement('div');
    cardWrap.className = 'details-field';
    const cardLab = document.createElement('span');
    cardLab.className = 'details-field-label';
    cardLab.textContent = 'cardinality (derived)';
    cardWrap.appendChild(cardLab);
    cardWrap.appendChild(cardinalityValueEl);
    form.appendChild(cardWrap);

    addBoolField('child_mandatory', rel.child_mandatory, (v) => {
        rel.child_mandatory = v;
    });
    addBoolField('parent_mandatory', rel.parent_mandatory, (v) => {
        rel.parent_mandatory = v;
    });

    root.appendChild(form);

    const otherKeys = Object.keys(rel)
        .sort()
        .filter((k) => !RELATIONSHIP_EDITABLE_KEYS.has(k) && k !== 'cardinality');
    if (otherKeys.length > 0) {
        const sub = document.createElement('h4');
        sub.className = 'details-subheading';
        sub.textContent = 'Other properties';
        root.appendChild(sub);
        const dl = document.createElement('dl');
        dl.className = 'details-props';
        for (const key of otherKeys) {
            const dt = document.createElement('dt');
            dt.textContent = key;
            const dd = document.createElement('dd');
            const fmt = formatRecordValueForDetails(rel[key]);
            if (fmt.isJson) {
                const pre = document.createElement('pre');
                pre.textContent = fmt.text;
                dd.appendChild(pre);
            } else {
                dd.textContent = fmt.text;
            }
            dl.appendChild(dt);
            dl.appendChild(dd);
        }
        root.appendChild(dl);
    }
}

function ensureModelMeta() {
    if (!model.meta || typeof model.meta !== 'object') {
        model.meta = {};
    }
}

/** Fills #diagram-meta-strip from `model.meta` or empty state when no model is open. */
function refreshDiagramMetaStrip() {
    const strip = document.getElementById('diagram-meta-strip');
    if (!strip) return;
    strip.replaceChildren();
    if (!canonicalTechnicalName) {
        strip.classList.add('is-empty');
        strip.textContent = 'Open or create a model to see metadata above the diagram.';
        return;
    }
    strip.classList.remove('is-empty');
    ensureModelMeta();
    const meta = model.meta || {};
    const title = document.createElement('h3');
    title.className = 'diagram-meta-title';
    const nameSpan = document.createElement('span');
    const tn = (meta.technical_name ?? canonicalTechnicalName ?? '').trim();
    nameSpan.textContent = ((meta.name ?? '').trim() || canonicalTechnicalName) + ` (${tn})`;
    title.appendChild(nameSpan);
    const ver = (meta.version ?? '').trim();
    if (ver) {
        const v = document.createElement('span');
        v.className = 'diagram-meta-version';
        v.textContent = `v${ver}`;
        title.appendChild(v);
    }
    strip.appendChild(title);
    const line1 = document.createElement('p');
    line1.className = 'diagram-meta-line';
    // const tn = (meta.technical_name ?? canonicalTechnicalName ?? '').trim();
    // const cb = (meta.created_by ?? '').trim();
    // const parts = [];
    // if (tn) parts.push(`technical_name: ${tn}`);
    // if (cb) parts.push(`created_by: ${cb}`);
    // line1.textContent = parts.length ? parts.join(' · ') : canonicalTechnicalName;
    line1.textContent = `created_by: ${(meta.created_by ?? '').trim()}`;
    strip.appendChild(line1);
    const desc = (meta.description ?? '').trim();
    if (desc) {
        const p = document.createElement('p');
        p.className = 'diagram-meta-desc';
        p.textContent = desc;
        strip.appendChild(p);
    }
    const dates = document.createElement('p');
    dates.className = 'diagram-meta-dates';
    dates.textContent = `created ${formatMetaIsoDate(meta.created)} · modified ${formatMetaIsoDate(meta.modified)}`;
    strip.appendChild(dates);
}

/* Helper function for display: convert `2026-03-28T08:38:35.770638Z` to `2026-03-28 08:38:35 UTC` */
function formatMetaIsoDate(isoDate) {
    return String(isoDate).replace('T', ' ').replace(/\.\d+/, '').replace('Z', ' UTC');
}

function appendDetailsReadonlyField(form, labelText, textContent) {
    const el = document.createElement('div');
    el.className = 'details-static';
    el.textContent = textContent ?? '';
    appendDetailsFormField(form, labelText, el);
}

/** Shown when no diagram selection is active and a working model is open. */
function renderModelMetadataDetails() {
    ensureModelMeta();
    const meta = model.meta;
    const sanitizedName = sanitizeMetaModelName(meta.name ?? '');
    if (sanitizedName !== (meta.name ?? '')) {
        meta.name = sanitizedName;
        schedulePersistWorkingModel();
    }
    pendingDerivedTechnical = displayNameToTechnicalName(meta.name ?? '');
    if ((meta.name ?? '').trim()) {
        lastValidModelMetaName = (meta.name ?? '').trim();
    }
    const shell = beginDetailsPane('Model metadata');
    if (!shell) return;
    const { root, form } = shell;

    const committedStem = meta.technical_name ?? canonicalTechnicalName ?? '';
    const derivedPreview = displayNameToTechnicalName(meta.name ?? '');

    const inpName = document.createElement('input');
    inpName.type = 'text';
    inpName.maxLength = 500;
    inpName.title = 'Letters, numbers, spaces, and underscores only.';
    inpName.value = meta.name ?? '';
    inpName.addEventListener('input', () => {
        applyMetaModelNameSanitizeToInput(inpName);
        meta.name = inpName.value;
        const derived = displayNameToTechnicalName(meta.name);
        const stem = meta.technical_name ?? canonicalTechnicalName ?? '';
        inpTechnical.value = derived ?? stem;
        pendingDerivedTechnical = derived;
        const trimmed = (meta.name ?? '').trim();
        if (trimmed) {
            lastValidModelMetaName = trimmed;
            if (derived != null) {
                detailsPersistErrorText = null;
                syncDetailsPersistBanner();
            }
            schedulePersistWorkingModel();
        }
        refreshDiagramMetaStrip();
        clearTimeout(metaRenameTimer);
        metaRenameTimer = setTimeout(() => applyPendingMetaTechnicalRename(), 450);
    });
    appendDetailsFormField(form, 'name', inpName);
    metadataNameInputEl = inpName;

    const inpTechnical = document.createElement('input');
    inpTechnical.type = 'text';
    inpTechnical.readOnly = true;
    inpTechnical.value = derivedPreview ?? committedStem;
    inpTechnical.title =
        'Preview of the technical id from the model name (lower_snake_case). If the name cannot produce a valid id, or that id is already taken, you will be asked to change the name.';
    metadataTechnicalInputEl = inpTechnical;
    appendDetailsFormField(form, 'technical_name', inpTechnical);

    const inpVersion = document.createElement('input');
    inpVersion.type = 'text';
    inpVersion.value = meta.version ?? '';
    inpVersion.addEventListener('input', () => {
        meta.version = inpVersion.value;
        schedulePersistWorkingModel();
        refreshDiagramMetaStrip();
    });
    appendDetailsFormField(form, 'version', inpVersion);

    const inpCreatedBy = document.createElement('input');
    inpCreatedBy.type = 'text';
    inpCreatedBy.value = meta.created_by ?? '';
    inpCreatedBy.addEventListener('input', () => {
        meta.created_by = inpCreatedBy.value;
        schedulePersistWorkingModel();
        refreshDiagramMetaStrip();
    });
    appendDetailsFormField(form, 'created_by', inpCreatedBy);

    const taDesc = document.createElement('textarea');
    taDesc.rows = 4;
    taDesc.value = meta.description ?? '';
    taDesc.addEventListener('input', () => {
        meta.description = taDesc.value;
        schedulePersistWorkingModel();
        refreshDiagramMetaStrip();
    });
    appendDetailsFormField(form, 'description', taDesc);

    appendDetailsReadonlyField(form, 'created', meta.created ?? '');
    appendDetailsReadonlyField(form, 'modified', meta.modified ?? '');

    root.appendChild(form);
    refreshDiagramMetaStrip();
}

function renderDetailsError(message) {
    const root = document.getElementById('details-content');
    if (!root) return;
    root.replaceChildren();
    const p = document.createElement('p');
    p.className = 'details-error';
    p.textContent = message;
    root.appendChild(p);
}

function clearDetailsPane() {
    detailsPersistErrorText = null;
    clearTimeout(persistModelTimer);
    persistModelTimer = null;
    clearTimeout(metaRenameTimer);
    metaRenameTimer = null;
    if (!canonicalTechnicalName) {
        const root = document.getElementById('details-content');
        if (!root) return;
        root.replaceChildren();
        const p = document.createElement('p');
        p.className = 'details-placeholder';
        p.textContent = 'Open or create a model to view metadata and diagram elements.';
        root.appendChild(p);
        refreshDiagramMetaStrip();
        return;
    }
    renderModelMetadataDetails();
}

function modelToNodesEdges() {
    nodes = [];
    edges = [];
    const entities = model.entities || [];
    const relationships = model.relationships || [];
    for (const ent of entities) {
        const cardWidth = computeCardWidthForEntity(ent);
        nodes.push(
            {
                data: {
                    label: ent.business_name,
                    id: ent.entity_id,
                    businessName: ent.business_name,
                    technicalName: ent.technical_name,
                    entityType: ent.entity_type,
                    definition: ent.definition,
                    type: 'entity',
                    attributes: ent.attributes,
                    cardWidth,
                }
            }
        )
        nodes.push(
            {
                data: {
                    label: ent.business_name,
                    id: ent.entity_id + '_hdr',
                    businessName: ent.business_name,
                    technicalName: ent.technical_name,
                    entityType: ent.entity_type,
                    definition: ent.definition,
                    parent: ent.entity_id,
                    type: 'entity-header',
                    cardWidth,
                }
            }
        )
        for (const attr of ent.attributes) {
            nodes.push(
                {
                    data: {
                        label: attr.business_name,
                        id: attr.attribute_id,
                        businessName: attr.business_name,
                        technicalName: attr.technical_name,
                        dataType: attr.data_type,
                        precision: (attr.precision === undefined) ? undefined : attr.precision,
                        scale: (attr.scale === undefined) ? undefined : attr.scale,
                        keyType: attr.key_type,
                        sourceMapping: attr.source_mapping,
                        definition: attr.definition,
                        parent: ent.entity_id,
                        type: 'attribute',
                        attributeOrder: attr.attribute_order,
                        cardWidth,
                    }
                }
            )
        }
    }

    for (const rel of relationships) {
        edges.push(
            {
                data: {
                    id: rel.relationship_id,
                    source: rel.parent_attribute_id,
                    target: rel.child_attribute_id,
                    label: rel.cardinality,
                    sourceEntity: rel.parent_entity_id,
                    targetEntity: rel.child_entity_id,
                    type: 'relationship',
                    parentMandatory: rel.parent_mandatory,
                    childMandatory: rel.child_mandatory,
                    parentCardinality: rel.parent_cardinality,
                    childCardinality: rel.child_cardinality,
                    cardinality: rel.cardinality
                }
            }
        )
    }
}

function renderCy() {
    syncEntityPositionsMapFromCy();
    const forceFitViewport = fitCyViewportAfterNextRender;
    fitCyViewportAfterNextRender = false;
    if (cy) {
        if (!forceFitViewport) {
            try {
                preservedCyViewport = { zoom: cy.zoom(), pan: cy.pan() };
            } catch {
                preservedCyViewport = null;
            }
        } else {
            preservedCyViewport = null;
        }
        teardownErOverlay();
        cy.destroy();
        cy = undefined;
    }
    cy = cytoscape({
        container: document.getElementById('cy'),
        elements: {
            nodes: nodes,
            edges: edges
        },
        style: cyStyle
    });

    let appliedStoredOrPartialLayout = false;
    if (entitiesAllHaveStoredPositions()) {
        appliedStoredOrPartialLayout = true;
        cy.batch(() => {
            cy.nodes('[type = "entity"]').forEach((ent) => {
                ent.position(positions[ent.id()]);
            });
        });
    } else if (layout && layout.layout && layout.layout.length > 0) {
        appliedStoredOrPartialLayout = true;
        cy.batch(() => {
            cy.nodes('[type = "entity"]').forEach((ent) => {
                const p = positions[ent.id()];
                if (p) ent.position(p);
            });
        });
    } else {
        cy.layout({
            name: 'dagre',
            rankDir: 'LR',
            nodeSep: 40,
            rankSep: 120,
            padding: 40,
            nodeDimensionsIncludeLabels: false,
            animate: false
        }).run();
        syncEntityPositionsMapFromCy();
    }

    cy.nodes('[type = "entity"]').forEach((ent) => cyPositionAttributes(ent));
    if (appliedStoredOrPartialLayout) {
        stabilizeStoredEntityPositionsInCy();
    }

    cy.on('dragfree', 'node[type = "entity"]', (evt) => {
        if (evt.target.data('type') === 'entity') {
            cyPositionAttributes(evt.target);
            saveLayout();
        }
    });

    cy.on('grab','node[type = "attribute"]', (evt) => {
        evt.target.ungrabify();
    });

    cy.on('free','node[type = "attribute"]', (evt) => {
        evt.target.grabify();
    });

    cy.on('tap', (evt) => {
        if (evt.target === cy) {
            selectedEntityId = null;
            syncAddAttributeButtonState();
            syncAddRelationshipButtonState();
            clearDetailsPane();
        }
    });

    cy.on('tap', 'node', (evt) => {
        const nodeType = evt.target.data('type');
        if (nodeType === 'entity') {
            selectedEntityId = evt.target.id();
            syncAddAttributeButtonState();
            syncAddRelationshipButtonState();
            const ent = findEntityById(evt.target.id());
            if (ent) renderEntityDetails(ent);
            else renderDetailsError('Entity not found in model.');
        } else if (nodeType === 'entity-header') {
            const parentId = evt.target.data('parent');
            selectedEntityId = parentId;
            syncAddAttributeButtonState();
            syncAddRelationshipButtonState();
            const ent = findEntityById(parentId);
            if (ent) renderEntityDetails(ent);
            else renderDetailsError('Entity not found in model.');
        } else if (nodeType === 'attribute') {
            const attr = findAttributeById(evt.target.id());
            if (attr) renderAttributeDetails(attr);
            else renderDetailsError('Attribute not found in model.');
        }
    });

    cy.on('tap', 'edge', (evt) => {
        if (evt.target.data('type') !== 'relationship') return;
        const rel = findRelationshipById(evt.target.id());
        if (rel) renderRelationshipDetails(rel);
        else renderDetailsError('Relationship not found in model.');
    });

    cy.resize();
    const vp = preservedCyViewport;
    preservedCyViewport = null;
    if (
        vp != null &&
        Number.isFinite(vp.zoom) &&
        vp.pan &&
        Number.isFinite(vp.pan.x) &&
        Number.isFinite(vp.pan.y)
    ) {
        try {
            cy.zoom(vp.zoom);
            cy.pan(vp.pan);
        } catch {
            cy.fit(cy.elements(), 48);
        }
    } else {
        cy.fit(cy.elements(), 48);
    }

    const fontsReady = document.fonts?.ready;
    if (fontsReady && typeof fontsReady.then === 'function') {
        fontsReady.then(() => {
            if (!cy) return;
            cy.style().update();
            try {
                cy.resize();
            } catch {
                /* ignore */
            }
            scheduleErOverlayRedraw();
        });
    }

    setupErOverlay(cy);
    scheduleErOverlayRedraw();

    if (!workspaceResizeInitialized) {
        initWorkspaceResize();
        workspaceResizeInitialized = true;
    }
}

function initWorkspaceResize() {
    const workspace = document.querySelector('.app-workspace');
    const splitter = document.querySelector('.splitter');
    const details = document.querySelector('.details-pane');
    const diagramPanel = document.querySelector('.diagram-panel');
    if (!workspace || !splitter || !details || !diagramPanel) return;

    let dragStartX = 0;
    let dragStartWidth = 0;
    let dragging = false;

    function clampDetailsWidth(w) {
        const splitterW = splitter.offsetWidth;
        const maxW = Math.min(workspace.clientWidth * 0.8, 900);
        const minDiagram = 160;
        const maxByWorkspace = workspace.clientWidth - splitterW - minDiagram;
        const cap = Math.min(maxW, maxByWorkspace);
        const lo = Math.min(120, cap);
        return Math.min(Math.max(w, lo), cap);
    }

    function setDetailsWidth(px) {
        const w = clampDetailsWidth(px);
        details.style.width = `${w}px`;
        if (cy) cy.resize();
    }

    splitter.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        dragStartX = e.clientX;
        dragStartWidth = details.getBoundingClientRect().width;
        splitter.setPointerCapture(e.pointerId);
    });

    splitter.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = dragStartX - e.clientX;
        setDetailsWidth(dragStartWidth + dx);
    });

    function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        if (e.pointerId != null) {
            try {
                splitter.releasePointerCapture(e.pointerId);
            } catch {
                /* ignore */
            }
        }
    }

    splitter.addEventListener('pointerup', endDrag);
    splitter.addEventListener('pointercancel', endDrag);

    splitter.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 40 : 10;
        const w = details.getBoundingClientRect().width;
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setDetailsWidth(w + step);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            setDetailsWidth(w - step);
        }
    });

    const ro = new ResizeObserver(() => {
        if (cy) cy.resize();
        scheduleErOverlayRedraw();
    });
    ro.observe(diagramPanel);
}

function cyPositionAttributes(ent){
    const pos = ent.position();
    const entAttrs = ent.children().sort((a, b) => a.data('attributeOrder') - b.data('attributeOrder'));
    const totalH = HEADER_H + entAttrs.length * ROW_H;
    const topY = pos.y - totalH / 2 + HEADER_H;

    entAttrs.forEach((attr, i) => {
        attr.position({
            x: pos.x,
            y: topY + i * ROW_H + ROW_H / 2
        });
    });   
}

/** Persist current entity centers from Cytoscape into `positions` (e.g. after drag or before re-render). */
function syncEntityPositionsMapFromCy() {
    if (!cy) return;
    cy.nodes('[type = "entity"]').forEach((ent) => {
        const id = ent.id();
        const p = ent.position();
        positions[id] = { x: p.x, y: p.y };
    });
}

/**
 * After placing attributes, compound layout can shift the parent entity; restore each entity center
 * from `positions` and re-stack attributes so the entity does not move when children change.
 */
function stabilizeStoredEntityPositionsInCy() {
    if (!cy) return;
    cy.batch(() => {
        cy.nodes('[type = "entity"]').forEach((ent) => {
            const id = ent.id();
            const p = positions[id];
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
                ent.position(p);
            }
        });
    });
    cy.nodes('[type = "entity"]').forEach((ent) => cyPositionAttributes(ent));
}

function syncEntityAttributeOrderInCy(entityId) {
    if (!cy) return;
    const entCy = cy.getElementById(entityId);
    if (!entCy || entCy.length === 0) return;
    const ent = findEntityById(entityId);
    if (!ent) return;
    for (const a of ent.attributes || []) {
        const n = cy.getElementById(a.attribute_id);
        if (n.length > 0) {
            n.data('attributeOrder', a.attribute_order);
        }
    }
    const p = positions[entityId];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        entCy.position(p);
    }
    cyPositionAttributes(entCy);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        entCy.position(p);
    }
    cyPositionAttributes(entCy);
}

function saveLayout() {
    if (!canonicalTechnicalName || !cy) return;
    const layout_arr = [];
    cy.nodes('[type = "entity"]').forEach((ent) => {
        const id = ent.id();
        const x = ent.position('x');
        const y = ent.position('y');
        positions[id] = { x, y };
        layout_arr.push({
            entity_id: id,
            x_coord: x,
            y_coord: y,
        });
    });

    fetch('/api/save_layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            technical_name: canonicalTechnicalName,
            working: true,
            layout: layout_arr,
        }),
    });
}

function cyNodeCardWidth(ele) {
    const w = ele.data('cardWidth');
    return typeof w === 'number' && w > 0 ? w : MIN_CARD_WIDTH;
}

const cyStyle = [
    {
        selector: 'node[type = "entity"]',
        style: {
            'shape': 'rectangle',
            'label': '',
            'padding-top': `${HEADER_H}px`,
            'padding-bottom': '4px',
            'padding-left': '0px',
            'padding-right': '0px',
            'text-valign': 'top',
            'text-halign': 'center',
            'compound-sizing-wrt-labels': 'exclude',
            'background-color': '#a9d1f1',
            'min-width': cyNodeCardWidth,
        }
    },
    {
        selector: 'node[type = "attribute"]',
        style: {
            'shape': 'rectangle',
            'label': 'data(label)',
            'width': cyNodeCardWidth,
            'height': `${ROW_H}px`,
            'text-valign': 'center',
            'text-halign': 'center',
            'background-color': '#f0f0f0',
            'border-color': '#ccc',
            'border-width': 1,
            'font-family': DIAGRAM_FONT_FAMILY,
            'font-size': `${DIAGRAM_LABEL_FONT_PX}px`,
        }
    },
    {
        selector: 'node[type = "entity-header"]',
        style: {
            'shape': 'rectangle',
            'label': 'data(label)',
            'events': 'no',
            'text-valign': 'center',
            'text-halign': 'center',
            'background-opacity': 0,
            'width': cyNodeCardWidth,
            'height': `${HEADER_H}px`,
            'font-family': DIAGRAM_FONT_FAMILY,
            'font-size': `${DIAGRAM_LABEL_FONT_PX}px`,
        }
    },
    {
        selector: 'edge[type = "relationship"]',
        style: {
            'width': 2,
            'label': 'data(label)',
            'curve-style': 'taxi',
            'taxi-direction': 'horizontal',
            'taxi-turn': 50,
            'line-color': '#444',
            'source-arrow-shape': 'none',
            'target-arrow-shape': 'none',
            'font-family': DIAGRAM_FONT_FAMILY,
            'font-size': `${DIAGRAM_LABEL_FONT_PX}px`,
            'color': '#333',
        }
    }

];

function initAddAttributeDataTypeSelect() {
    const sel = document.getElementById('add-attribute-data-type');
    if (!sel) return;
    sel.replaceChildren();
    for (const v of SCHEMA_DATA_TYPES) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        sel.appendChild(opt);
    }
}

function resetAddEntityForm() {
    document.getElementById('add-entity-form')?.reset();
}

function openAddEntityDialog() {
    if (!canonicalTechnicalName) {
        alert('Open or create a model first.');
        return;
    }
    resetAddEntityForm();
    const bizInp = document.getElementById('add-entity-business-name');
    if (bizInp) bizInp.oninput = () => syncAddEntityTechnicalPreview();
    syncAddEntityTechnicalPreview();
    document.getElementById('add-entity-dialog')?.showModal();
    queueMicrotask(() => document.getElementById('add-entity-business-name')?.focus());
}

function submitAddEntity(ev) {
    ev.preventDefault();
    if (!canonicalTechnicalName) return;
    const businessName = document.getElementById('add-entity-business-name')?.value?.trim() ?? '';
    const technicalName = derivedEntityTechnicalNameForBusiness(businessName, undefined);
    const entityType = document.getElementById('add-entity-type')?.value ?? '';
    const definition = document.getElementById('add-entity-definition')?.value?.trim() ?? '';
    if (!businessName || !definition) {
        alert('Fill all required fields.');
        return;
    }
    if (!isValidEntityAttributeTechnicalName(technicalName)) {
        alert('Could not derive a valid technical name from the business name.');
        return;
    }
    if (!SCHEMA_ENTITY_TYPES.includes(entityType)) {
        alert('Invalid entity type.');
        return;
    }
    const pos = computePositionForNewEntity();
    const entity_id = crypto.randomUUID();
    const newEnt = {
        entity_id,
        business_name: businessName,
        technical_name: technicalName,
        entity_type: entityType,
        definition,
        attributes: [],
    };
    if (!model.entities) model.entities = [];
    model.entities.push(newEnt);
    positions[entity_id] = { x: pos.x, y: pos.y };

    document.getElementById('add-entity-dialog')?.close();
    modelToNodesEdges();
    fitCyViewportAfterNextRender = true;
    renderCy();
    selectedEntityId = entity_id;
    syncAddAttributeButtonState();
    syncAddRelationshipButtonState();
    renderEntityDetails(newEnt);
    schedulePersistWorkingModel();
    saveLayout();
}

function resetAddAttributeForm() {
    const form = document.getElementById('add-attribute-form');
    form?.reset();
    initAddAttributeDataTypeSelect();
}

function openAddAttributeDialog() {
    if (!canonicalTechnicalName) {
        alert('Open or create a model first.');
        return;
    }
    if (!selectedEntityId) {
        alert('Select an entity on the diagram first.');
        return;
    }
    resetAddAttributeForm();
    const bizInp = document.getElementById('add-attribute-business-name');
    if (bizInp) bizInp.oninput = () => syncAddAttributeTechnicalPreview();
    syncAddAttributeTechnicalPreview();
    document.getElementById('add-attribute-dialog')?.showModal();
    queueMicrotask(() => document.getElementById('add-attribute-business-name')?.focus());
}

function submitAddAttribute(ev) {
    ev.preventDefault();
    if (!canonicalTechnicalName || !selectedEntityId) return;
    const ent = findEntityById(selectedEntityId);
    if (!ent) {
        alert('Selected entity no longer exists.');
        return;
    }
    const businessName = document.getElementById('add-attribute-business-name')?.value?.trim() ?? '';
    const technicalName = derivedAttributeTechnicalNameForBusiness(businessName, ent, undefined);
    const dataType = document.getElementById('add-attribute-data-type')?.value ?? '';
    const definition = document.getElementById('add-attribute-definition')?.value?.trim() ?? '';
    if (!businessName || !definition || !dataType) {
        alert('Fill all required fields.');
        return;
    }
    if (!isValidEntityAttributeTechnicalName(technicalName)) {
        alert('Could not derive a valid technical name from the business name.');
        return;
    }
    if (!SCHEMA_DATA_TYPES.includes(dataType)) {
        alert('Invalid data type.');
        return;
    }
    const attrs = ent.attributes || [];
    let maxOrder = 0;
    for (const a of attrs) {
        const o = a.attribute_order;
        if (typeof o === 'number' && o > maxOrder) maxOrder = o;
    }
    const newAttr = {
        attribute_id: crypto.randomUUID(),
        business_name: businessName,
        technical_name: technicalName,
        data_type: dataType,
        definition,
        attribute_order: maxOrder + 1,
        key_type: null,
    };
    if (!ent.attributes) ent.attributes = [];
    ent.attributes.push(newAttr);

    document.getElementById('add-attribute-dialog')?.close();
    modelToNodesEdges();
    renderCy();
    syncEntityAttributeOrderInCy(ent.entity_id);
    renderAttributeDetails(newAttr);
    syncAddRelationshipButtonState();
    schedulePersistWorkingModel();
    saveLayout();
}

function fillEntitySelectForRelationship(selectEl) {
    if (!selectEl) return;
    selectEl.replaceChildren();
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = 'Select entity';
    ph.disabled = true;
    ph.selected = true;
    selectEl.appendChild(ph);
    for (const ent of model.entities || []) {
        const opt = document.createElement('option');
        opt.value = ent.entity_id;
        opt.textContent = ent.business_name ?? ent.technical_name ?? ent.entity_id;
        selectEl.appendChild(opt);
    }
}

function fillAttributeSelectForRelationship(selectEl, entityId, placeholderNoEntity) {
    if (!selectEl) return;
    selectEl.replaceChildren();
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = entityId ? 'Select attribute' : placeholderNoEntity;
    ph.disabled = true;
    ph.selected = true;
    selectEl.appendChild(ph);
    const ent = findEntityById(entityId);
    if (!ent) return;
    for (const attr of ent.attributes || []) {
        const opt = document.createElement('option');
        opt.value = attr.attribute_id;
        opt.textContent = attr.business_name ?? attr.technical_name ?? attr.attribute_id;
        selectEl.appendChild(opt);
    }
}

function updateAddRelationshipPreview() {
    const cardEl = document.getElementById('add-relationship-preview-cardinality');
    const nameEl = document.getElementById('add-relationship-preview-name');
    const pe = document.getElementById('add-relationship-parent-entity')?.value ?? '';
    const pa = document.getElementById('add-relationship-parent-attribute')?.value ?? '';
    const ce = document.getElementById('add-relationship-child-entity')?.value ?? '';
    const ca = document.getElementById('add-relationship-child-attribute')?.value ?? '';
    const pc = document.getElementById('add-relationship-parent-cardinality')?.value ?? 'One';
    const cc = document.getElementById('add-relationship-child-cardinality')?.value ?? 'One';
    if (!cardEl || !nameEl) return;
    if (!pe || !pa || !ce || !ca) {
        cardEl.value = '';
        nameEl.value = '';
        return;
    }
    const scratch = {
        parent_entity_id: pe,
        parent_attribute_id: pa,
        child_entity_id: ce,
        child_attribute_id: ca,
        parent_cardinality: pc,
        child_cardinality: cc,
    };
    deriveRelationshipCardinality(scratch);
    const pEnt = findEntityById(pe);
    const cEnt = findEntityById(ce);
    const pAttr = findAttributeById(pa);
    const cAttr = findAttributeById(ca);
    cardEl.value = scratch.cardinality ?? '';
    if (!pEnt || !cEnt || !pAttr || !cAttr) {
        nameEl.value = '';
        return;
    }
    nameEl.value = `${pEnt.technical_name}.${pAttr.technical_name} ${scratch.cardinality} ${cEnt.technical_name}.${cAttr.technical_name}`;
}

function resetAddRelationshipForm() {
    document.getElementById('add-relationship-form')?.reset();
}

function openAddRelationshipDialog() {
    if (!canonicalTechnicalName) {
        alert('Open or create a model first.');
        return;
    }
    if (countModelAttributes() < 2) {
        alert('Add at least two attributes (across entities) before creating a relationship.');
        return;
    }
    resetAddRelationshipForm();
    fillEntitySelectForRelationship(document.getElementById('add-relationship-parent-entity'));
    fillEntitySelectForRelationship(document.getElementById('add-relationship-child-entity'));
    fillAttributeSelectForRelationship(
        document.getElementById('add-relationship-parent-attribute'),
        '',
        'Select parent entity first',
    );
    fillAttributeSelectForRelationship(
        document.getElementById('add-relationship-child-attribute'),
        '',
        'Select child entity first',
    );
    updateAddRelationshipPreview();
    document.getElementById('add-relationship-dialog')?.showModal();
    queueMicrotask(() => document.getElementById('add-relationship-parent-entity')?.focus());
}

function submitAddRelationship(ev) {
    ev.preventDefault();
    if (!canonicalTechnicalName) return;
    const parent_entity_id = document.getElementById('add-relationship-parent-entity')?.value ?? '';
    const parent_attribute_id = document.getElementById('add-relationship-parent-attribute')?.value ?? '';
    const child_entity_id = document.getElementById('add-relationship-child-entity')?.value ?? '';
    const child_attribute_id = document.getElementById('add-relationship-child-attribute')?.value ?? '';
    const parent_cardinality = document.getElementById('add-relationship-parent-cardinality')?.value ?? '';
    const child_cardinality = document.getElementById('add-relationship-child-cardinality')?.value ?? '';
    const parent_mandatory = document.getElementById('add-relationship-parent-mandatory')?.checked === true;
    const child_mandatory = document.getElementById('add-relationship-child-mandatory')?.checked === true;
    if (!parent_entity_id || !parent_attribute_id || !child_entity_id || !child_attribute_id) {
        alert('Select parent and child entities and attributes.');
        return;
    }
    if (!SCHEMA_SIDE_CARDINALITY.includes(parent_cardinality) || !SCHEMA_SIDE_CARDINALITY.includes(child_cardinality)) {
        alert('Invalid cardinality.');
        return;
    }
    if (findEntityContainingAttribute(parent_attribute_id)?.entity_id !== parent_entity_id) {
        alert('Parent attribute does not belong to the parent entity.');
        return;
    }
    if (findEntityContainingAttribute(child_attribute_id)?.entity_id !== child_entity_id) {
        alert('Child attribute does not belong to the child entity.');
        return;
    }
    const rels = model.relationships || [];
    if (rels.some((r) => r.parent_attribute_id === parent_attribute_id && r.child_attribute_id === child_attribute_id)) {
        alert('A relationship between these attributes already exists.');
        return;
    }
    const newRel = {
        relationship_id: crypto.randomUUID(),
        parent_entity_id,
        parent_attribute_id,
        child_entity_id,
        child_attribute_id,
        parent_mandatory,
        child_mandatory,
        parent_cardinality,
        child_cardinality,
    };
    syncRelationshipName(newRel);
    if (!model.relationships) model.relationships = [];
    model.relationships.push(newRel);

    document.getElementById('add-relationship-dialog')?.close();
    modelToNodesEdges();
    renderCy();
    renderRelationshipDetails(newRel);
    schedulePersistWorkingModel();
    saveLayout();
}

function wireAddRelationshipDialogControls() {
    const pe = document.getElementById('add-relationship-parent-entity');
    const pa = document.getElementById('add-relationship-parent-attribute');
    const ce = document.getElementById('add-relationship-child-entity');
    const ca = document.getElementById('add-relationship-child-attribute');
    pe?.addEventListener('change', () => {
        fillAttributeSelectForRelationship(pa, pe.value, 'Select parent entity first');
        updateAddRelationshipPreview();
    });
    ce?.addEventListener('change', () => {
        fillAttributeSelectForRelationship(ca, ce.value, 'Select child entity first');
        updateAddRelationshipPreview();
    });
    for (const id of [
        'add-relationship-parent-attribute',
        'add-relationship-child-attribute',
        'add-relationship-parent-cardinality',
        'add-relationship-child-cardinality',
    ]) {
        document.getElementById(id)?.addEventListener('change', updateAddRelationshipPreview);
    }
}

function resetNewModelForm() {
    const form = document.getElementById('new-model-form');
    if (form) form.reset();
}

function openNewModelDialog() {
    resetNewModelForm();
    const dialog = document.getElementById('new-model-dialog');
    dialog?.showModal();
    queueMicrotask(() => document.getElementById('new-model-name')?.focus());
}

async function submitNewModel(ev) {
    ev.preventDefault();
    const nameInput = document.getElementById('new-model-name');
    const technicalInput = document.getElementById('new-model-technical-name');
    const versionInput = document.getElementById('new-model-version');
    const createdByInput = document.getElementById('new-model-created-by');
    const descInput = document.getElementById('new-model-description');
    const submitBtn = document.getElementById('new-model-submit');
    const dialog = document.getElementById('new-model-dialog');
    if (!nameInput || !technicalInput || !dialog) return;
    const name = sanitizeMetaModelName(nameInput.value).trim();
    if (!name) {
        alert('Enter a name.');
        return;
    }
    const technical_name = technicalInput.value.trim();
    if (!technical_name) {
        alert('Enter a technical name.');
        return;
    }
    if (!TECHNICAL_NAME_RE.test(technical_name)) {
        alert(
            'Technical name must be lower_snake_case: start with a letter, then letters, digits, or underscores only.',
        );
        return;
    }
    const description = descInput?.value ?? '';
    const version = (versionInput?.value ?? '').trim();
    if (!version) {
        alert('Enter a version.');
        return;
    }
    const created_by = createdByInput?.value ?? '';
    const body = {
        name,
        technical_name,
        description,
        version,
        created_by,
    };
    if (submitBtn) submitBtn.disabled = true;
    try {
        const res = await fetch('/api/create_model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            alert(data.error || res.statusText || 'Could not create model.');
            return;
        }
        dialog.close();
        await loadWorkingCopyAndRender(data.technical_name);
    } catch (e) {
        console.error(e);
        alert(e.message || 'Could not create model.');
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

document.getElementById('new-model-btn')?.addEventListener('click', () => openNewModelDialog());
document.getElementById('new-model-name')?.addEventListener('input', (ev) => {
    applyMetaModelNameSanitizeToInput(ev.target);
});
document.getElementById('new-model-form')?.addEventListener('submit', (ev) => submitNewModel(ev));
document.getElementById('new-model-cancel')?.addEventListener('click', () => {
    document.getElementById('new-model-dialog')?.close();
});

document.getElementById('open-model-btn')?.addEventListener('click', () => openModel());
document.getElementById('open-model-cancel')?.addEventListener('click', () => {
    document.getElementById('open-model-dialog')?.close();
});

async function saveCanonicalModel() {
    if (!canonicalTechnicalName) {
        alert('Open or create a model first.');
        return;
    }
    clearTimeout(persistModelTimer);
    persistModelTimer = null;
    clearTimeout(metaRenameTimer);
    metaRenameTimer = null;
    await applyPendingMetaTechnicalRename();
    const flushed = await persistWorkingModel();
    if (!flushed) {
        alert(
            detailsPersistErrorText
                ? `Could not save working copy: ${detailsPersistErrorText}`
                : 'Could not save working copy.',
        );
        return;
    }
    const btn = document.getElementById('save-model-btn');
    if (btn) btn.disabled = true;
    try {
        const saveBody = { technical_name: canonicalTechnicalName };
        if (openedAsTechnicalName && openedAsTechnicalName !== canonicalTechnicalName) {
            saveBody.supersede_technical_name = openedAsTechnicalName;
        }
        const res = await fetch('/api/save_model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(saveBody),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            alert(data.error || res.statusText || 'Could not save model.');
            return;
        }
        openedAsTechnicalName = canonicalTechnicalName;
    } catch (e) {
        console.error(e);
        alert(e.message || 'Could not save model.');
    } finally {
        if (btn) btn.disabled = false;
    }
}

document.getElementById('save-model-btn')?.addEventListener('click', () => saveCanonicalModel());

async function exportDiagramPng() {
    if (!canonicalTechnicalName || !cy) {
        alert('Open or create a model first.');
        return;
    }
    const root = document.getElementById('diagram-export-root');
    if (!root) return;
    const btn = document.getElementById('export-diagram-btn');
    if (btn) btn.disabled = true;
    try {
        cy.resize();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        drawErRelationshipOverlay();
        await new Promise((r) => requestAnimationFrame(r));
        const dataUrl = await toPng(root, {
            pixelRatio: 2,
            backgroundColor: '#ffffff',
            cacheBust: true,
        });
        const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
        const b64 = m ? m[1] : dataUrl;
        const res = await fetch('/api/save_diagram_png', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                technical_name: canonicalTechnicalName,
                png_base64: b64,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            alert(data.error || res.statusText || 'Could not save diagram PNG.');
            return;
        }
        alert(`Diagram saved to data/models/diagrams/${canonicalTechnicalName}.png`);
    } catch (e) {
        console.error(e);
        alert(e.message || 'Export failed.');
    } finally {
        if (btn) btn.disabled = false;
    }
}

document.getElementById('export-diagram-btn')?.addEventListener('click', () => void exportDiagramPng());

initAddAttributeDataTypeSelect();
syncAddRelationshipButtonState();
wireAddRelationshipDialogControls();
document.getElementById('add-entity-btn')?.addEventListener('click', () => openAddEntityDialog());
document.getElementById('add-attribute-btn')?.addEventListener('click', () => openAddAttributeDialog());
document.getElementById('add-relationship-btn')?.addEventListener('click', () => openAddRelationshipDialog());
document.getElementById('add-entity-form')?.addEventListener('submit', (ev) => submitAddEntity(ev));
document.getElementById('add-entity-cancel')?.addEventListener('click', () => {
    document.getElementById('add-entity-dialog')?.close();
});
document.getElementById('add-attribute-form')?.addEventListener('submit', (ev) => submitAddAttribute(ev));
document.getElementById('add-attribute-cancel')?.addEventListener('click', () => {
    document.getElementById('add-attribute-dialog')?.close();
});
document.getElementById('add-relationship-form')?.addEventListener('submit', (ev) => submitAddRelationship(ev));
document.getElementById('add-relationship-cancel')?.addEventListener('click', () => {
    document.getElementById('add-relationship-dialog')?.close();
});

void loadNamingConfig();
refreshDiagramMetaStrip();
