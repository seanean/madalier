import { toPng } from './vendor/html-to-image.bundle.js';

/*
 * Madalier browser UI (see design.md).
 *
 * State: `model` and `layout` mirror the JSON API; `positions` holds entity x/y for the diagram.
 * `canonicalTechnicalName` is the live model id; the server stores working copies under temp_* paths.
 * `cy` is the Cytoscape instance; `nodes` / `edges` are built in modelToNodesEdges().
 *
 * Server I/O: fetch() helpers (e.g. retrieveModel, retrieveLayout, persistWorkingModel, saveLayout,
 * saveCanonicalModel, export*) post JSON to /api/*. Naming rules come from GET /api/naming_config.
 *
 * Flow: dialogs create/open models → loadWorkingCopyAndRender → renderCy; edits debounce to
 * save_working_model; Save promotes via save_model. Section markers below use // --- ... ---
 */

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
/** Extra px on diagram card width so HTML overlay tracks rarely lose to bbox/rounding vs canvas measure. */
const OVERLAY_CARD_SLACK_PX = 8;
/** Added once to attribute table inner width: canvas vs DOM + row border (border-box) mismatch. */
const OVERLAY_TABLE_INNER_FUDGE_PX = 12;
/** Per-column ceil padding so grid tracks are at least as wide as rendered text. */
const OVERLAY_COLUMN_WIDTH_PAD_PX = 1;
/** Horizontal gap between attribute table columns (px); keep in sync with overlay CSS `column-gap`. */
const ATTR_TABLE_COL_GAP = 10;
/** Total horizontal padding inside each overlay row (px, left + right). */
const ATTR_TABLE_ROW_INNER_PAD = 12;
/** Matches `node[type=attribute]` height in `cyStyle`; overlay scales font/gaps vs rendered row height. */
const ATTR_OVERLAY_ROW_REF_PX = ROW_H;
/** Floor for overlay font size (px) when zoomed far out. */
const ATTR_OVERLAY_FONT_MIN_PX = 5;
/** Cytoscape scroll-wheel zoom multiplier; default in the library is 1 (lower = finer steps). */
const CY_WHEEL_SENSITIVITY = 0.5;

// --- Diagram: label metrics & entity card width ---

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

/** Canvas measureText with optional semibold/bold to match Cytoscape key-type labels. */
function measureLabelWidthWithOptions(text, { bold = false } = {}) {
    const t = text == null ? '' : String(text);
    if (!_measureLabelCanvas) {
        _measureLabelCanvas = document.createElement('canvas');
    }
    const ctx = _measureLabelCanvas.getContext('2d');
    ctx.font = bold
        ? `600 ${DIAGRAM_LABEL_FONT_PX}px ${DIAGRAM_FONT_FAMILY}`
        : DIAGRAM_LABEL_FONT;
    return ctx.measureText(t).width;
}

function displayNameForEntityCard(ent) {
    if (showTechnicalNamesInDiagram) {
        const t = String(ent?.technical_name ?? '').trim();
        if (t) return t;
    }
    return String(ent?.business_name ?? '');
}

function displayNameForAttributeCard(attr) {
    if (showTechnicalNamesInDiagram) {
        const t = String(attr?.technical_name ?? '').trim();
        if (t) return t;
    }
    return String(attr?.business_name ?? '');
}

function keyTypeAbbrev(keyType) {
    switch (keyType) {
        case 'PRIMARY':
            return 'PK';
        case 'FOREIGN':
            return 'FK';
        case 'NATURAL':
            return 'NK';
        default:
            return '';
    }
}

/** Diagram row: `PK | name *`, `name *`, `name` (no brackets). */
function formatAttributeRowLabel(displayName, keyType, mandatory) {
    const prefix = keyType ? `${keyTypeAbbrev(keyType)} | ` : '';
    const tail = mandatory ? ' *' : '';
    return `${prefix}${displayName}${tail}`;
}

function attributeRowLabelForAttr(attr) {
    return formatAttributeRowLabel(
        displayNameForAttributeCard(attr),
        attr?.key_type ?? null,
        attr?.mandatory === true,
    );
}

/** Sorted by attribute_order, matching `cyPositionAttributes` stacking. */
function sortedAttributesForEntity(ent) {
    const attrs = [...(ent?.attributes || [])];
    attrs.sort((a, b) => Number(a.attribute_order) - Number(b.attribute_order));
    return attrs;
}

function measureEntityAttributeColumnMaxes(ent) {
    const attrs = sortedAttributesForEntity(ent);
    let wName = 0;
    let wKey = 0;
    let wDt = 0;
    let wMan = 0;
    const padCol = () => OVERLAY_COLUMN_WIDTH_PAD_PX;
    for (const a of attrs) {
        const nameBold =
            a.is_meta !== true &&
            (a.key_type === 'PRIMARY' ||
                a.key_type === 'FOREIGN' ||
                a.key_type === 'NATURAL');
        wName = Math.max(
            wName,
            Math.ceil(measureLabelWidthWithOptions(displayNameForAttributeCard(a), { bold: nameBold })) +
                padCol(),
        );
        const k = keyTypeAbbrev(a.key_type ?? null);
        const keyBold =
            a.is_meta !== true &&
            (a.key_type === 'PRIMARY' ||
                a.key_type === 'FOREIGN' ||
                a.key_type === 'NATURAL');
        wKey = Math.max(
            wKey,
            Math.ceil(measureLabelWidthWithOptions(k, { bold: keyBold })) + padCol(),
        );
        wDt = Math.max(
            wDt,
            Math.ceil(measureLabelWidth(String(a.data_type ?? ''))) + padCol(),
        );
        wMan = Math.max(
            wMan,
            Math.ceil(measureLabelWidth(a.mandatory === true ? '*' : '')) + padCol(),
        );
    }
    return { wName, wKey, wDt, wMan };
}

/** Minimum inner width (px) for the four-column attribute grid: columns + gaps + padding. */
function computeAttributeTableMinInnerWidth(ent) {
    const attrs = sortedAttributesForEntity(ent);
    if (attrs.length === 0) return 0;
    const { wName, wKey, wDt, wMan } = measureEntityAttributeColumnMaxes(ent);
    return (
        wName +
        wKey +
        wDt +
        wMan +
        3 * ATTR_TABLE_COL_GAP +
        ATTR_TABLE_ROW_INNER_PAD +
        OVERLAY_TABLE_INNER_FUDGE_PX
    );
}

function computeCardWidthForEntity(ent) {
    const nameW = measureLabelWidth(displayNameForEntityCard(ent));
    const attrs = ent?.attributes || [];
    if (attrs.length === 0) {
        return Math.max(
            MIN_CARD_WIDTH,
            Math.ceil(nameW + CARD_H_PADDING + OVERLAY_CARD_SLACK_PX),
        );
    }
    const tableInner = computeAttributeTableMinInnerWidth(ent);
    const contentW = Math.max(nameW, tableInner);
    return Math.max(
        MIN_CARD_WIDTH,
        Math.ceil(contentW + CARD_H_PADDING + OVERLAY_CARD_SLACK_PX),
    );
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

// --- In-memory model + diagram globals ---

let model = {};
let layout = {};
let positions = {};
let nodes = [];
let edges = [];
/** Canonical meta.technical_name; on disk under data/models/&lt;technical_name&gt;/ (canonical JSON/CSV/PNG/DDL; working temp_* JSON under temp/ while editing). */
let canonicalTechnicalName = null;
/** When true, diagram entity/attribute labels use technical_name instead of business_name. */
let showTechnicalNamesInDiagram = false;
let workspaceResizeInitialized = false;
let cy;
let diagramOverlayRaf = null;

/** Matches [schemas/model.json](schemas/model.json) entity_type.enum */
const SCHEMA_ENTITY_TYPES = ['view', 'table'];
/** Matches schemas/model.json attributes.items.properties.data_type.enum */
const SCHEMA_DATA_TYPES = [
    'STRING',
    'VARCHAR',
    'TEXT',
    'INTEGER',
    'BIGINT',
    'SMALLINT',
    'DECIMAL',
    'FLOAT',
    'BOOLEAN',
    'DATE',
    'TIMESTAMP',
    'TIMESTAMPTZ',
    'BINARY',
];

function attributeDataTypeUsesLength(dt) {
    return dt === 'STRING' || dt === 'VARCHAR';
}

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
/** Diagram element whose details are shown; drives Remove selected (entity / attribute / relationship id). */
let diagramRemovalSelection = null;

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

// --- Naming: /api/naming_config, business name → technical_name ---

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
        if (document.getElementById('new-model-dialog')?.open) {
            syncNewModelTechnicalPreview();
        }
    } catch (e) {
        console.error(e);
        namingConfig = defaultNamingConfig();
    }
}

// --- Meta fields: default + per-model template (/api/*_meta_config) ---

let defaultMetaConfigCache = { fields: [] };
let effectiveMetaConfigState = { uses_default: true, config: { fields: [] } };
/** Editable field list while the manage-meta dialog is open */
let manageMetaDraft = [];

async function loadDefaultMetaConfig() {
    try {
        const res = await fetch('/api/default_meta_config');
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (data && Array.isArray(data.fields)) {
            defaultMetaConfigCache = data;
        }
    } catch (e) {
        console.error(e);
        defaultMetaConfigCache = { fields: [] };
    }
}

async function refreshEffectiveMetaConfig() {
    if (!canonicalTechnicalName) {
        effectiveMetaConfigState = { uses_default: true, config: { fields: [...(defaultMetaConfigCache.fields || [])] } };
        return;
    }
    try {
        const res = await fetch('/api/model_meta_config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ technical_name: canonicalTechnicalName, working: true }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        effectiveMetaConfigState = {
            uses_default: data.uses_default === true,
            config: data.config && Array.isArray(data.config.fields) ? data.config : { fields: [] },
        };
    } catch (e) {
        console.error(e);
        effectiveMetaConfigState = {
            uses_default: true,
            config: { fields: [...(defaultMetaConfigCache.fields || [])] },
        };
    }
}

function syncMetaFieldsButtons() {
    const t = document.getElementById('toggle-meta-fields-btn');
    const m = document.getElementById('manage-meta-fields-btn');
    const open = !!canonicalTechnicalName;
    if (t) {
        t.disabled = !open;
        t.setAttribute('aria-pressed', model.meta_fields_enabled === true ? 'true' : 'false');
    }
    if (m) m.disabled = !open;
}

function maxAttributeOrderOnEntity(ent) {
    let maxOrder = 0;
    for (const a of ent.attributes || []) {
        const o = a.attribute_order;
        if (typeof o === 'number' && o > maxOrder) maxOrder = o;
    }
    return maxOrder;
}

function metaTemplateFieldToAttribute(field, order) {
    const attr = {
        attribute_id: crypto.randomUUID(),
        business_name: field.business_name,
        technical_name: field.technical_name,
        data_type: field.data_type,
        attribute_order: order,
        is_meta: true,
        key_type: null,
    };
    if (field.mandatory === true) attr.mandatory = true;
    if (field.definition) attr.definition = field.definition;
    if (field.source_mapping) attr.source_mapping = field.source_mapping;
    if (field.data_type === 'DECIMAL') {
        if (typeof field.precision === 'number') attr.precision = field.precision;
        if (typeof field.scale === 'number') attr.scale = field.scale;
    } else if (attributeDataTypeUsesLength(field.data_type)) {
        if (typeof field.length === 'number') attr.length = field.length;
    }
    return attr;
}

/**
 * Assign consecutive attribute_order to meta attributes in template order, after every non-meta
 * attribute (so diagram stacking matches the meta field manager list).
 */
function reorderMetaAttributesToMatchTemplate(ent, templateFields) {
    if (ent.entity_type !== 'table') return;
    const attrs = ent.attributes || [];
    let base = 0;
    for (const a of attrs) {
        if (a.is_meta === true) continue;
        const o = Number(a.attribute_order);
        if (Number.isFinite(o) && o > base) base = o;
    }
    const metaByTn = new Map();
    for (const a of attrs) {
        if (a.is_meta === true && a.technical_name) metaByTn.set(a.technical_name, a);
    }
    let order = base;
    for (const f of templateFields) {
        const attr = metaByTn.get(f.technical_name);
        if (!attr) continue;
        order += 1;
        attr.attribute_order = order;
    }
}

/** Add missing meta attributes from the effective template; returns an error message or null. */
function applyMetaFieldsToTable(ent) {
    const fields = effectiveMetaConfigState.config?.fields || [];
    if (ent.entity_type !== 'table') return null;
    if (!ent.attributes) ent.attributes = [];
    for (const f of fields) {
        const existing = ent.attributes.find((a) => a.technical_name === f.technical_name);
        if (existing) {
            if (existing.is_meta === true) continue;
            return `Table "${ent.business_name || ent.technical_name}" already has a non-meta attribute "${f.technical_name}". Remove or rename it before enabling meta fields.`;
        }
        const order = maxAttributeOrderOnEntity(ent) + 1;
        ent.attributes.push(metaTemplateFieldToAttribute(f, order));
    }
    return null;
}

function removeAllMetaAttributesFromModel() {
    const removeIds = new Set();
    for (const ent of model.entities || []) {
        for (const a of ent.attributes || []) {
            if (a.is_meta === true) removeIds.add(a.attribute_id);
        }
        ent.attributes = (ent.attributes || []).filter((a) => a.is_meta !== true);
    }
    model.relationships = (model.relationships || []).filter(
        (r) => !removeIds.has(r.parent_attribute_id) && !removeIds.has(r.child_attribute_id),
    );
}

function syncMetaTemplateToAllTables() {
    const fields = effectiveMetaConfigState.config?.fields || [];
    const templateTns = new Set(fields.map((f) => f.technical_name));
    for (const ent of model.entities || []) {
        if (ent.entity_type !== 'table') continue;
        let attrs = ent.attributes || [];
        const removeIds = new Set();
        for (const a of attrs) {
            if (a.is_meta === true && !templateTns.has(a.technical_name)) {
                removeIds.add(a.attribute_id);
            }
        }
        if (removeIds.size > 0) {
            attrs = attrs.filter((a) => !removeIds.has(a.attribute_id));
            ent.attributes = attrs;
            model.relationships = (model.relationships || []).filter(
                (r) => !removeIds.has(r.parent_attribute_id) && !removeIds.has(r.child_attribute_id),
            );
        }
        attrs = ent.attributes || [];
        for (const f of fields) {
            const attr = attrs.find((a) => a.technical_name === f.technical_name && a.is_meta === true);
            if (attr) {
                attr.business_name = f.business_name;
                attr.data_type = f.data_type;
                if (f.mandatory === true) attr.mandatory = true;
                else delete attr.mandatory;
                if (f.definition) attr.definition = f.definition;
                else delete attr.definition;
                if (f.source_mapping) attr.source_mapping = f.source_mapping;
                else delete attr.source_mapping;
                clearPrecisionScaleUnlessDecimal(attr);
                clearLengthUnlessStringLike(attr);
                if (f.data_type === 'DECIMAL') {
                    if (typeof f.precision === 'number') attr.precision = f.precision;
                    else delete attr.precision;
                    if (typeof f.scale === 'number') attr.scale = f.scale;
                    else delete attr.scale;
                } else if (attributeDataTypeUsesLength(f.data_type)) {
                    if (typeof f.length === 'number') attr.length = f.length;
                }
                attr.key_type = null;
            }
        }
        const err = applyMetaFieldsToTable(ent);
        if (err) return err;
        reorderMetaAttributesToMatchTemplate(ent, fields);
    }
    return null;
}

function ensureMetaFieldsAfterLoad() {
    if (model.meta_fields_enabled !== true) return;
    const err = syncMetaTemplateToAllTables();
    if (err) {
        console.error(err);
        alert(err);
    }
}

function countRelatableAttributes() {
    let n = 0;
    for (const ent of model.entities || []) {
        for (const a of ent.attributes || []) {
            if (a.is_meta !== true) n += 1;
        }
    }
    return n;
}

function onToggleMetaFieldsClick() {
    if (!canonicalTechnicalName) {
        alert('Open or create a model first.');
        return;
    }
    const enabling = model.meta_fields_enabled !== true;
    if (enabling) {
        for (const ent of model.entities || []) {
            if (ent.entity_type === 'table') {
                const err = applyMetaFieldsToTable(ent);
                if (err) {
                    alert(err);
                    return;
                }
            }
        }
        model.meta_fields_enabled = true;
    } else {
        model.meta_fields_enabled = false;
        removeAllMetaAttributesFromModel();
    }
    modelToNodesEdges();
    renderCy();
    syncMetaFieldsButtons();
    syncAddRelationshipButtonState();
    schedulePersistWorkingModel();
    saveLayout();
}

function cloneMetaFieldRow(f) {
    return {
        business_name: f.business_name ?? '',
        technical_name: f.technical_name ?? '',
        data_type: f.data_type ?? 'STRING',
        mandatory: f.mandatory === true,
        precision: typeof f.precision === 'number' ? f.precision : undefined,
        scale: typeof f.scale === 'number' ? f.scale : undefined,
        length: typeof f.length === 'number' ? f.length : undefined,
        definition: f.definition ?? '',
        source_mapping: f.source_mapping ?? '',
    };
}

/** Unique lower_snake_case technical id among other rows in the manage-meta dialog (matches API SCHEMA). */
function ensureUniqueMetaFieldTechnicalNameAmongDraft(base, excludeIndex) {
    const taken = new Set();
    for (let i = 0; i < manageMetaDraft.length; i++) {
        if (i === excludeIndex) continue;
        const tn = String(manageMetaDraft[i]?.technical_name ?? '').trim();
        if (tn) taken.add(tn);
    }
    let b = base || 'unnamed';
    if (!TECHNICAL_NAME_RE.test(b)) b = 'unnamed';
    if (!taken.has(b)) return b;
    for (let n = 2; n < 10000; n++) {
        const c = `${b}_${n}`;
        if (!taken.has(c)) return c;
    }
    return `${b}_${Date.now()}`;
}

/**
 * Meta template technical_name from business name: same rules as model folder names
 * (naming config + ASCII lower_snake_case), unique within the current draft row.
 */
function derivedMetaFieldTechnicalNameForDraftRow(businessName, excludeIndex) {
    const raw = String(businessName ?? '').trim();
    if (!raw) return '';
    const stem = deriveModelTechnicalNameFromDisplayName(raw);
    const base = stem && TECHNICAL_NAME_RE.test(stem) ? stem : 'unnamed';
    return ensureUniqueMetaFieldTechnicalNameAmongDraft(base, excludeIndex);
}

function renderManageMetaFieldsList() {
    const list = document.getElementById('manage-meta-fields-list');
    if (!list) return;
    list.replaceChildren();
    manageMetaDraft.forEach((field, idx) => {
        const row = document.createElement('div');
        row.className = 'manage-meta-field-row';
        row.dataset.index = String(idx);

        const labBiz = document.createElement('label');
        labBiz.textContent = 'Business name';
        const inpBiz = document.createElement('input');
        inpBiz.type = 'text';
        inpBiz.value = field.business_name;
        inpBiz.autocomplete = 'off';
        inpBiz.addEventListener('input', () => {
            manageMetaDraft[idx].business_name = inpBiz.value;
            const next = derivedMetaFieldTechnicalNameForDraftRow(inpBiz.value, idx);
            manageMetaDraft[idx].technical_name = next;
            inpTech.value = next;
        });

        const labTech = document.createElement('label');
        labTech.textContent = 'Technical name';
        const inpTech = document.createElement('input');
        inpTech.type = 'text';
        inpTech.readOnly = true;
        inpTech.value = field.technical_name;
        inpTech.autocomplete = 'off';
        inpTech.title = 'Derived from business name and naming config';

        const labDt = document.createElement('label');
        labDt.textContent = 'Data type';
        const selDt = document.createElement('select');
        for (const dt of SCHEMA_DATA_TYPES) {
            const opt = document.createElement('option');
            opt.value = dt;
            opt.textContent = dt;
            if (dt === field.data_type) opt.selected = true;
            selDt.appendChild(opt);
        }
        selDt.addEventListener('change', () => {
            manageMetaDraft[idx].data_type = selDt.value;
            renderManageMetaFieldsList();
        });

        const labMan = document.createElement('label');
        labMan.className = 'checkbox-row';
        const cbMan = document.createElement('input');
        cbMan.type = 'checkbox';
        cbMan.checked = field.mandatory === true;
        labMan.appendChild(cbMan);
        labMan.appendChild(document.createTextNode(' Mandatory'));
        cbMan.addEventListener('change', () => {
            manageMetaDraft[idx].mandatory = cbMan.checked;
        });

        const labDef = document.createElement('label');
        labDef.textContent = 'Definition';
        const taDef = document.createElement('textarea');
        taDef.rows = 2;
        taDef.value = field.definition ?? '';
        taDef.addEventListener('input', () => {
            manageMetaDraft[idx].definition = taDef.value;
        });

        const labMap = document.createElement('label');
        labMap.textContent = 'Source mapping';
        const inpMap = document.createElement('input');
        inpMap.type = 'text';
        inpMap.value = field.source_mapping ?? '';
        inpMap.addEventListener('input', () => {
            manageMetaDraft[idx].source_mapping = inpMap.value;
        });

        const btnRow = document.createElement('div');
        btnRow.className = 'manage-meta-field-actions';
        const btnUp = document.createElement('button');
        btnUp.type = 'button';
        btnUp.textContent = 'Up';
        btnUp.disabled = idx <= 0;
        btnUp.addEventListener('click', () => {
            if (idx <= 0) return;
            const t = manageMetaDraft[idx - 1];
            manageMetaDraft[idx - 1] = manageMetaDraft[idx];
            manageMetaDraft[idx] = t;
            renderManageMetaFieldsList();
        });
        const btnDn = document.createElement('button');
        btnDn.type = 'button';
        btnDn.textContent = 'Down';
        btnDn.disabled = idx >= manageMetaDraft.length - 1;
        btnDn.addEventListener('click', () => {
            if (idx >= manageMetaDraft.length - 1) return;
            const t = manageMetaDraft[idx + 1];
            manageMetaDraft[idx + 1] = manageMetaDraft[idx];
            manageMetaDraft[idx] = t;
            renderManageMetaFieldsList();
        });
        const btnRm = document.createElement('button');
        btnRm.type = 'button';
        btnRm.textContent = 'Remove';
        btnRm.addEventListener('click', () => {
            manageMetaDraft.splice(idx, 1);
            renderManageMetaFieldsList();
        });
        btnRow.append(btnUp, btnDn, btnRm);

        row.append(
            labBiz,
            inpBiz,
            labTech,
            inpTech,
            labDt,
            selDt,
            labMan,
            labDef,
            taDef,
            labMap,
            inpMap,
            btnRow,
        );

        if (field.data_type === 'DECIMAL') {
            const labP = document.createElement('label');
            labP.textContent = 'Precision';
            const inpP = document.createElement('input');
            inpP.type = 'text';
            inpP.inputMode = 'numeric';
            inpP.value =
                field.precision !== undefined && field.precision !== null ? String(field.precision) : '';
            inpP.addEventListener('input', () => {
                parseOptionalIntField(manageMetaDraft[idx], 'precision', inpP.value);
            });
            const labS = document.createElement('label');
            labS.textContent = 'Scale';
            const inpS = document.createElement('input');
            inpS.type = 'text';
            inpS.inputMode = 'numeric';
            inpS.value = field.scale !== undefined && field.scale !== null ? String(field.scale) : '';
            inpS.addEventListener('input', () => {
                parseOptionalIntField(manageMetaDraft[idx], 'scale', inpS.value);
            });
            row.append(labP, inpP, labS, inpS);
        }

        if (attributeDataTypeUsesLength(field.data_type)) {
            const labLen = document.createElement('label');
            labLen.textContent = 'Length (optional; omit for unbounded type in DDL)';
            const inpLen = document.createElement('input');
            inpLen.type = 'text';
            inpLen.inputMode = 'numeric';
            inpLen.value =
                field.length !== undefined && field.length !== null ? String(field.length) : '';
            inpLen.addEventListener('input', () => {
                parseOptionalIntField(manageMetaDraft[idx], 'length', inpLen.value);
            });
            row.append(labLen, inpLen);
        }

        list.appendChild(row);
    });
}

function addEmptyManageMetaField() {
    manageMetaDraft.push({
        business_name: '',
        technical_name: '',
        data_type: 'STRING',
        mandatory: false,
        definition: '',
        source_mapping: '',
    });
    renderManageMetaFieldsList();
}

function openManageMetaFieldsDialog() {
    if (!canonicalTechnicalName) {
        alert('Open or create a model first.');
        return;
    }
    const fields = effectiveMetaConfigState.config?.fields || [];
    manageMetaDraft = fields.map((f) => cloneMetaFieldRow(f));
    renderManageMetaFieldsList();
    document.getElementById('manage-meta-fields-dialog')?.showModal();
}

function validateManageMetaDraftForSave() {
    const seen = new Set();
    for (const f of manageMetaDraft) {
        const tn = (f.technical_name || '').trim();
        const bn = (f.business_name || '').trim();
        if (!bn) return 'Each meta field needs a business name.';
        if (!tn || !TECHNICAL_NAME_RE.test(tn)) return `Invalid technical name: "${tn || '(empty)'}"`;
        if (seen.has(tn)) return `Duplicate technical name: ${tn}`;
        seen.add(tn);
        if (!SCHEMA_DATA_TYPES.includes(f.data_type)) return `Invalid data type for ${tn}`;
    }
    return null;
}

async function saveManageMetaFieldsFromDialog() {
    const err = validateManageMetaDraftForSave();
    if (err) {
        alert(err);
        return false;
    }
    const config = {
        fields: manageMetaDraft.map((f) => {
            const o = {
                business_name: f.business_name.trim(),
                technical_name: f.technical_name.trim(),
                data_type: f.data_type,
            };
            if (f.mandatory === true) o.mandatory = true;
            if (f.definition && f.definition.trim()) o.definition = f.definition.trim();
            if (f.source_mapping && f.source_mapping.trim()) o.source_mapping = f.source_mapping.trim();
            if (f.data_type === 'DECIMAL') {
                if (typeof f.precision === 'number') o.precision = f.precision;
                if (typeof f.scale === 'number') o.scale = f.scale;
            }
            if (attributeDataTypeUsesLength(f.data_type) && typeof f.length === 'number') {
                o.length = f.length;
            }
            return o;
        }),
    };
    const res = await fetch('/api/save_model_meta_config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ technical_name: canonicalTechnicalName, config }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        alert(data.error || res.statusText || 'Could not save meta config.');
        return false;
    }
    await refreshEffectiveMetaConfig();
    if (model.meta_fields_enabled === true) {
        const syncErr = syncMetaTemplateToAllTables();
        if (syncErr) {
            alert(syncErr);
            return false;
        }
    }
    document.getElementById('manage-meta-fields-dialog')?.close();
    modelToNodesEdges();
    renderCy();
    syncMetaFieldsButtons();
    schedulePersistWorkingModel();
    saveLayout();
    return true;
}

async function promoteMetaConfigToDefaultFromDialog() {
    if (!canonicalTechnicalName) return;
    if (
        !confirm(
            'Save this template to the model, then replace the global default meta config with config/meta_config.json?',
        )
    ) {
        return;
    }
    const saved = await saveManageMetaFieldsFromDialog();
    if (!saved) return;
    const res = await fetch('/api/promote_meta_config_to_default', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ technical_name: canonicalTechnicalName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        alert(data.error || res.statusText || 'Could not promote meta config.');
        return;
    }
    await loadDefaultMetaConfig();
    await refreshEffectiveMetaConfig();
    alert('Global default meta config updated.');
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

/**
 * Turn a technical string produced by applyNamingConvention (any configured style) into
 * meta.technical_name / on-disk stem: ASCII lower_snake_case matching TECHNICAL_NAME_RE.
 */
function namingConventionOutputToModelStem(s) {
    if (typeof s !== 'string' || !s.trim()) return null;
    let t = s.trim();
    t = t.replace(/([a-z\d])([A-Z])/g, '$1_$2');
    t = t.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
    t = t.replace(/-/g, '_');
    t = t.toLowerCase();
    try {
        t = t.normalize('NFKD').replace(/\p{M}+/gu, '');
    } catch {
        /* ignore if unsupported */
    }
    t = t.replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!t) return null;
    if (!/^[a-z]/.test(t)) {
        t = `x_${t}`.replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    }
    if (!TECHNICAL_NAME_RE.test(t)) {
        t = t.replace(/[^a-z0-9_]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
    }
    if (!/^[a-z]/.test(t)) return null;
    return TECHNICAL_NAME_RE.test(t) ? t : null;
}

/**
 * Model folder / meta.technical_name from display name: same segments and naming_convention as
 * entities/attributes (word_mappings + style), then coerced to API-safe lower_snake_case ASCII.
 */
function deriveModelTechnicalNameFromDisplayName(displayName) {
    const styled = deriveTechnicalNameFromBusiness(displayName);
    return namingConventionOutputToModelStem(styled);
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

function syncNewModelTechnicalPreview() {
    const nameInput = document.getElementById('new-model-name');
    const techEl = document.getElementById('new-model-technical-name');
    if (!techEl) return;
    const name = sanitizeMetaModelName(nameInput?.value ?? '').trim();
    if (!name) {
        techEl.value = '';
        return;
    }
    const stem = deriveModelTechnicalNameFromDisplayName(name);
    techEl.value = stem ?? '';
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

// --- Model load/save: fetch API, open canonical, working copy ---

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
    await refreshEffectiveMetaConfig();
    ensureMetaFieldsAfterLoad();
    modelToNodesEdges();
    selectedEntityId = null;
    diagramRemovalSelection = null;
    syncAddAttributeButtonState();
    syncAddRelationshipButtonState();
    syncRemoveSelectedButtonState();
    syncShowTechnicalNamesButton();
    syncMetaFieldsButtons();
    preservedCyViewport = null;
    fitCyViewportAfterNextRender = false;
    if (cy) {
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

// --- Model graph lookups & diagram-adjacent UI state ---

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
    if (btn) btn.disabled = !canonicalTechnicalName || countRelatableAttributes() < 2;
}

function syncRemoveSelectedButtonState() {
    const btn = document.getElementById('remove-selected-btn');
    if (btn) btn.disabled = !canonicalTechnicalName || !diagramRemovalSelection;
}

// --- Diagram: remove selected element, new-entity position, relationship edge data ---

/** Remove the diagram element indicated by `diagramRemovalSelection` from `model`, persist working copy, and refresh. */
function removeDiagramSelection() {
    if (!canonicalTechnicalName || !diagramRemovalSelection) {
        alert('Nothing selected to remove.');
        return;
    }
    const sel = diagramRemovalSelection;
    const rels = model.relationships || [];

    if (sel.kind === 'entity') {
        const ent = findEntityById(sel.id);
        if (!ent) {
            alert('Element no longer in model.');
            diagramRemovalSelection = null;
            syncRemoveSelectedButtonState();
            return;
        }
        const attrIds = new Set((ent.attributes || []).map((a) => a.attribute_id));
        model.entities = (model.entities || []).filter((e) => e.entity_id !== sel.id);
        delete positions[sel.id];
        model.relationships = rels.filter(
            (r) =>
                r.parent_entity_id !== sel.id &&
                r.child_entity_id !== sel.id &&
                !attrIds.has(r.parent_attribute_id) &&
                !attrIds.has(r.child_attribute_id),
        );
        if (selectedEntityId === sel.id) selectedEntityId = null;
    } else if (sel.kind === 'attribute') {
        const ent = findEntityContainingAttribute(sel.id);
        if (!ent) {
            alert('Element no longer in model.');
            diagramRemovalSelection = null;
            syncRemoveSelectedButtonState();
            return;
        }
        ent.attributes = (ent.attributes || []).filter((a) => a.attribute_id !== sel.id);
        model.relationships = rels.filter(
            (r) => r.parent_attribute_id !== sel.id && r.child_attribute_id !== sel.id,
        );
    } else {
        const exists = rels.some((r) => r.relationship_id === sel.id);
        if (!exists) {
            alert('Element no longer in model.');
            diagramRemovalSelection = null;
            syncRemoveSelectedButtonState();
            return;
        }
        model.relationships = rels.filter((r) => r.relationship_id !== sel.id);
    }

    diagramRemovalSelection = null;
    modelToNodesEdges();
    renderCy();
    clearDetailsPane();
    schedulePersistWorkingModel();
    saveLayout();
    syncAddAttributeButtonState();
    syncAddRelationshipButtonState();
    syncRemoveSelectedButtonState();
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
    e.data('label', '');
    e.data('cardinality', rel.cardinality);
    e.data('parentMandatory', rel.parent_mandatory);
    e.data('childMandatory', rel.child_mandatory);
    e.data('parentCardinality', rel.parent_cardinality);
    e.data('childCardinality', rel.child_cardinality);
    e.data('sourceMultiplicity', umlSideMultiplicity(rel.parent_cardinality, rel.parent_mandatory));
    e.data('targetMultiplicity', umlSideMultiplicity(rel.child_cardinality, rel.child_mandatory));
    cy.style().update();
}

function effectiveDiagramLabel(businessName, technicalName) {
    if (showTechnicalNamesInDiagram) {
        const t = String(technicalName ?? '').trim();
        if (t) return t;
    }
    return String(businessName ?? '');
}

/** Syncs one attribute node’s label, keyType, mandatory, and names from the in-memory model. */
function applyAttributeNodeDataInCy(attr) {
    if (!cy || !attr) return;
    const n = cy.getElementById(attr.attribute_id);
    if (n.empty()) return;
    const kt = attr.key_type == null ? null : attr.key_type;
    n.data('label', attributeRowLabelForAttr(attr));
    n.data('businessName', String(attr.business_name ?? ''));
    n.data('technicalName', String(attr.technical_name ?? ''));
    n.data('keyType', kt);
    n.data('mandatory', attr.mandatory === true);
    const ent = findEntityContainingAttribute(attr.attribute_id);
    if (ent) syncEntityCardWidthInCy(ent.entity_id);
    else cy.style().update();
    syncDiagramOverlaysAfterCardWidthChange();
}

function syncCyLabelsToDisplayMode() {
    if (!cy) return;
    cy.batch(() => {
        cy.nodes('[type = "entity"], [type = "entity-header"]').forEach((n) => {
            const biz = n.data('businessName');
            const tech = n.data('technicalName');
            n.data('label', effectiveDiagramLabel(biz, tech));
        });
        cy.nodes('[type = "attribute"]').forEach((n) => {
            const attr = findAttributeById(n.id());
            if (!attr) return;
            const kt = attr.key_type == null ? null : attr.key_type;
            n.data('label', attributeRowLabelForAttr(attr));
            n.data('businessName', String(attr.business_name ?? ''));
            n.data('technicalName', String(attr.technical_name ?? ''));
            n.data('keyType', kt);
            n.data('mandatory', attr.mandatory === true);
        });
    });
    for (const ent of model.entities || []) {
        syncEntityCardWidthInCy(ent.entity_id);
    }
    cy.style().update();
    refreshAttributeOverlayContent();
    refreshEntityHeaderOverlayContent();
    syncAttributeOverlayPositions();
    syncEntityHeaderOverlayPositions();
}

function syncShowTechnicalNamesButton() {
    const btn = document.getElementById('show-technical-names-btn');
    if (!btn) return;
    btn.disabled = !canonicalTechnicalName;
    btn.textContent = showTechnicalNamesInDiagram ? 'Show business names' : 'Show technical names';
    btn.setAttribute('aria-pressed', showTechnicalNamesInDiagram ? 'true' : 'false');
}

function patchEntityLabelInCy(entityId, businessName) {
    if (!cy) return;
    const m = findEntityById(entityId);
    const biz =
        businessName !== undefined && businessName !== null ? businessName : (m?.business_name ?? '');
    const tech = m?.technical_name ?? '';
    const label = effectiveDiagramLabel(biz, tech);
    const ent = cy.getElementById(entityId);
    if (ent.nonempty()) {
        ent.data('label', label);
        ent.data('businessName', String(biz ?? ''));
    }
    const hdr = cy.getElementById(`${entityId}_hdr`);
    if (hdr.nonempty()) {
        hdr.data('label', label);
        hdr.data('businessName', String(biz ?? ''));
    }
    syncEntityCardWidthInCy(entityId);
    syncDiagramOverlaysAfterCardWidthChange();
}

function patchAttributeLabelInCy(attributeId, businessName) {
    if (!cy) return;
    const m = findAttributeById(attributeId);
    if (!m) return;
    if (businessName !== undefined && businessName !== null) {
        m.business_name = businessName;
    }
    applyAttributeNodeDataInCy(m);
}

function patchEntityTechnicalNameInCy(entityId, technicalName) {
    if (!cy) return;
    const t = technicalName ?? '';
    const m = findEntityById(entityId);
    const label = effectiveDiagramLabel(m?.business_name ?? '', t);
    const ent = cy.getElementById(entityId);
    if (ent.nonempty()) {
        ent.data('technicalName', t);
        ent.data('label', label);
    }
    const hdr = cy.getElementById(`${entityId}_hdr`);
    if (hdr.nonempty()) {
        hdr.data('technicalName', t);
        hdr.data('label', label);
    }
    syncEntityCardWidthInCy(entityId);
    syncDiagramOverlaysAfterCardWidthChange();
}

function patchAttributeTechnicalNameInCy(attributeId, technicalName) {
    if (!cy) return;
    const m = findAttributeById(attributeId);
    if (!m) return;
    if (technicalName !== undefined) {
        m.technical_name = technicalName ?? '';
    }
    applyAttributeNodeDataInCy(m);
}

// --- Debounced persist working model + details error banner ---

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

/** Persists in-memory `model` to data/models/&lt;technical_name&gt;/temp/temp_&lt;technical_name&gt;.json. Returns whether the write succeeded. */
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

// --- Details pane: form builders & entity / attribute / relationship editors ---

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
    diagramRemovalSelection = { kind: 'entity', id: ent.entity_id };
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
        const prev = ent.entity_type;
        ent.entity_type = selType.value;
        if (ent.entity_type === 'view' && prev === 'table') {
            const removeIds = new Set();
            ent.attributes = (ent.attributes || []).filter((a) => {
                if (a.is_meta === true) {
                    removeIds.add(a.attribute_id);
                    return false;
                }
                return true;
            });
            model.relationships = (model.relationships || []).filter(
                (r) =>
                    !removeIds.has(r.parent_attribute_id) && !removeIds.has(r.child_attribute_id),
            );
            modelToNodesEdges();
            renderCy();
            syncAddRelationshipButtonState();
        }
        schedulePersistWorkingModel();
    });
    appendDetailsFormField(form, 'entity_type', selType);

    root.appendChild(form);
    syncRemoveSelectedButtonState();
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

function clearLengthUnlessStringLike(attr) {
    if (!attributeDataTypeUsesLength(attr.data_type)) {
        delete attr.length;
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
    clearLengthUnlessStringLike(attr);

    const shell = beginDetailsPane('Attribute');
    if (!shell) return;
    diagramRemovalSelection = { kind: 'attribute', id: attr.attribute_id };
    const { root, form } = shell;

    const entForAttr = findEntityContainingAttribute(attr.attribute_id);

    if (attr.is_meta === true) {
        const note = document.createElement('p');
        note.className = 'details-meta-note';
        note.textContent =
            'Meta field (edit the template via “Manage meta fields” in the header).';
        form.appendChild(note);
    }

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
        clearLengthUnlessStringLike(attr);
        applyAttributeNodeDataInCy(attr);
        schedulePersistWorkingModel();
        renderAttributeDetails(attr);
    });
    appendDetailsFormField(form, 'data_type', selData);

    if (attributeDataTypeUsesLength(attr.data_type)) {
        const inpLen = document.createElement('input');
        inpLen.type = 'text';
        inpLen.inputMode = 'numeric';
        inpLen.value =
            attr.length !== undefined && attr.length !== null ? String(attr.length) : '';
        inpLen.addEventListener('input', () => {
            parseOptionalIntField(attr, 'length', inpLen.value);
            applyAttributeNodeDataInCy(attr);
            schedulePersistWorkingModel();
        });
        appendDetailsFormField(
            form,
            'length (optional — empty uses unbounded type in DDL)',
            inpLen,
        );
    }

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

    if (attr.is_meta !== true) {
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
            applyAttributeNodeDataInCy(attr);
            schedulePersistWorkingModel();
        });
        appendDetailsFormField(form, 'key_type', selKey);
    }

    const cbMandatory = document.createElement('input');
    cbMandatory.type = 'checkbox';
    cbMandatory.checked = attr.mandatory === true;
    cbMandatory.addEventListener('change', () => {
        if (cbMandatory.checked) {
            attr.mandatory = true;
        } else {
            delete attr.mandatory;
        }
        applyAttributeNodeDataInCy(attr);
        schedulePersistWorkingModel();
    });
    appendDetailsFormField(form, 'mandatory', cbMandatory);

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
    syncRemoveSelectedButtonState();
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

/** Diagram-style label: business name, plus technical in parentheses when it differs. */
function formatBusinessTechnicalRow(obj) {
    if (!obj) return null;
    const biz = String(obj.business_name ?? '').trim();
    const tech = String(obj.technical_name ?? '').trim();
    if (biz && tech) return biz === tech ? biz : `${biz} (${tech})`;
    return biz || tech || null;
}

const RELATIONSHIP_EDITABLE_KEYS = new Set([
    'child_cardinality',
    'child_mandatory',
    'parent_cardinality',
    'parent_mandatory',
]);

/** Non-editable relationship fields shown as grey static rows (same pattern as entity technical_name / model created). */
const RELATIONSHIP_READONLY_KEYS_ORDER = [
    'relationship_id',
    'relationship_name',
    'parent_entity_id',
    'parent_attribute_id',
    'child_entity_id',
    'child_attribute_id',
];

const RELATIONSHIP_DETAIL_KNOWN_KEYS = new Set([
    ...RELATIONSHIP_READONLY_KEYS_ORDER,
    ...RELATIONSHIP_EDITABLE_KEYS,
    'cardinality',
]);

/** Readonly relationship row: resolved names for entity/attribute id keys; hover title holds the stored id. */
function relationshipReadonlyDisplay(rel, key) {
    const raw = rel[key];
    if (raw === undefined || raw === null) {
        return { text: '', title: undefined };
    }
    const idText = formatRecordValueForDetails(raw).text;
    switch (key) {
        case 'parent_entity_id': {
            const ent = findEntityById(raw);
            const name = formatBusinessTechnicalRow(ent);
            return { text: name ?? idText, title: name ? idText : undefined };
        }
        case 'child_entity_id': {
            const ent = findEntityById(raw);
            const name = formatBusinessTechnicalRow(ent);
            return { text: name ?? idText, title: name ? idText : undefined };
        }
        case 'parent_attribute_id': {
            const attr = findAttributeById(raw);
            const name = formatBusinessTechnicalRow(attr);
            return { text: name ?? idText, title: name ? idText : undefined };
        }
        case 'child_attribute_id': {
            const attr = findAttributeById(raw);
            const name = formatBusinessTechnicalRow(attr);
            return { text: name ?? idText, title: name ? idText : undefined };
        }
        default:
            return { text: idText, title: undefined };
    }
}

/** UML multiplicity for one association end: One|Many × mandatory (false → optional). */
function umlSideMultiplicity(sideCardinality, mandatory) {
    const many = sideCardinality === 'Many';
    const opt = mandatory === false;
    if (many) return opt ? '0..*' : '1..*';
    return opt ? '0..1' : '1..1';
}

/** Sets rel.cardinality to UML "parent : child" from side cardinalities and mandatory flags. */
function deriveRelationshipCardinality(rel) {
    const p = umlSideMultiplicity(rel.parent_cardinality, rel.parent_mandatory);
    const c = umlSideMultiplicity(rel.child_cardinality, rel.child_mandatory);
    rel.cardinality = `${p} : ${c}`;
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
    diagramRemovalSelection = { kind: 'relationship', id: rel.relationship_id };
    const { root, form } = shell;

    const prevCardinality = rel.cardinality;
    const prevName = rel.relationship_name ?? '';
    syncRelationshipName(rel);
    if (prevCardinality !== rel.cardinality || prevName !== (rel.relationship_name ?? '')) {
        patchRelationshipEdgeData(rel);
        schedulePersistWorkingModel();
    }

    for (const key of RELATIONSHIP_READONLY_KEYS_ORDER) {
        const { text, title } = relationshipReadonlyDisplay(rel, key);
        appendDetailsReadonlyField(form, key, text, title);
    }

    const cardinalityValueEl = document.createElement('div');
    cardinalityValueEl.className = 'details-field-control details-static';
    cardinalityValueEl.textContent = rel.cardinality;

    function addBoolField(labelText, checked, onChange) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked === true;
        cb.addEventListener('change', () => {
            onChange(cb.checked);
            syncRelationshipName(rel);
            cardinalityValueEl.textContent = rel.cardinality;
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

    const otherKeys = Object.keys(rel)
        .sort()
        .filter((k) => !RELATIONSHIP_DETAIL_KNOWN_KEYS.has(k));
    if (otherKeys.length > 0) {
        const sub = document.createElement('h4');
        sub.className = 'details-subheading';
        sub.textContent = 'Other properties';
        form.appendChild(sub);
        for (const key of otherKeys) {
            const fmt = formatRecordValueForDetails(rel[key]);
            if (fmt.isJson) {
                const ta = document.createElement('textarea');
                ta.readOnly = true;
                ta.rows = Math.min(14, fmt.text.split('\n').length + 1);
                ta.value = fmt.text;
                appendDetailsFormField(form, key, ta);
            } else {
                appendDetailsReadonlyField(form, key, fmt.text);
            }
        }
    }

    root.appendChild(form);
    syncRemoveSelectedButtonState();
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
    {
        let line = `created_by: ${(meta.created_by ?? '').trim()}`;
        const ub = (meta.updated_by ?? '').trim();
        if (ub) line += ` · updated_by: ${ub}`;
        line1.textContent = line;
    }
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

function appendDetailsReadonlyField(form, labelText, textContent, title) {
    const el = document.createElement('div');
    el.className = 'details-static';
    el.textContent = textContent ?? '';
    if (title) el.title = title;
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

    const inpUpdatedBy = document.createElement('input');
    inpUpdatedBy.type = 'text';
    inpUpdatedBy.value = meta.updated_by ?? '';
    inpUpdatedBy.addEventListener('input', () => {
        const v = inpUpdatedBy.value;
        if (!v.trim()) delete meta.updated_by;
        else meta.updated_by = v;
        schedulePersistWorkingModel();
        refreshDiagramMetaStrip();
    });
    appendDetailsFormField(form, 'updated_by', inpUpdatedBy);

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
    diagramRemovalSelection = null;
    const root = document.getElementById('details-content');
    if (!root) return;
    root.replaceChildren();
    const p = document.createElement('p');
    p.className = 'details-error';
    p.textContent = message;
    root.appendChild(p);
    syncRemoveSelectedButtonState();
}

function clearDetailsPane() {
    detailsPersistErrorText = null;
    diagramRemovalSelection = null;
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
        syncRemoveSelectedButtonState();
        return;
    }
    renderModelMetadataDetails();
    syncRemoveSelectedButtonState();
}

// --- Cytoscape: model → nodes/edges, renderCy, layout persistence, HTML overlays ---

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
                        label: attributeRowLabelForAttr(attr),
                        id: attr.attribute_id,
                        businessName: attr.business_name,
                        technicalName: attr.technical_name,
                        dataType: attr.data_type,
                        precision: (attr.precision === undefined) ? undefined : attr.precision,
                        scale: (attr.scale === undefined) ? undefined : attr.scale,
                        keyType: attr.key_type == null ? null : attr.key_type,
                        mandatory: attr.mandatory === true,
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
                    label: '',
                    sourceEntity: rel.parent_entity_id,
                    targetEntity: rel.child_entity_id,
                    type: 'relationship',
                    parentMandatory: rel.parent_mandatory,
                    childMandatory: rel.child_mandatory,
                    parentCardinality: rel.parent_cardinality,
                    childCardinality: rel.child_cardinality,
                    cardinality: rel.cardinality,
                    sourceMultiplicity: umlSideMultiplicity(rel.parent_cardinality, rel.parent_mandatory),
                    targetMultiplicity: umlSideMultiplicity(rel.child_cardinality, rel.child_mandatory),
                }
            }
        )
    }
}

/** Modifier class for PK/FK/NK (colors + semibold) on overlay name and key cells. */
function attributeOverlayKeyTypeModifierClass(attr) {
    const kt = attr?.key_type ?? null;
    if (kt === 'PRIMARY') return 'attr-key-primary';
    if (kt === 'FOREIGN') return 'attr-key-foreign';
    if (kt === 'NATURAL') return 'attr-key-natural';
    return '';
}

function refreshAttributeOverlayContent() {
    const root = document.getElementById('cy-attribute-overlay');
    if (!root) return;
    root.replaceChildren();
    if (!cy) return;
    for (const ent of model.entities || []) {
        const attrs = sortedAttributesForEntity(ent);
        if (attrs.length === 0) continue;
        const { wName, wKey, wDt, wMan } = measureEntityAttributeColumnMaxes(ent);
        for (const attr of attrs) {
            const row = document.createElement('div');
            row.className = 'cy-attr-overlay-row';
            row.dataset.attributeId = attr.attribute_id;
            row.dataset.overlayWName = String(wName);
            row.dataset.overlayWKey = String(wKey);
            row.dataset.overlayWDt = String(wDt);
            row.dataset.overlayWMan = String(wMan);

            const keyMod = attributeOverlayKeyTypeModifierClass(attr);
            const nameEl = document.createElement('span');
            nameEl.className = keyMod ? `cy-attr-cell-name ${keyMod}` : 'cy-attr-cell-name';
            nameEl.textContent = displayNameForAttributeCard(attr);

            const keyEl = document.createElement('span');
            keyEl.className = keyMod ? `cy-attr-cell-key ${keyMod}` : 'cy-attr-cell-key';
            keyEl.textContent = keyTypeAbbrev(attr.key_type ?? null);

            const dtEl = document.createElement('span');
            dtEl.className = 'cy-attr-cell-dt';
            dtEl.textContent = String(attr.data_type ?? '');

            const manEl = document.createElement('span');
            manEl.className = 'cy-attr-cell-mand';
            manEl.textContent = attr.mandatory === true ? '*' : '';

            if (attr.is_meta === true) {
                row.classList.add('cy-attr-meta');
            }
            row.append(nameEl, keyEl, dtEl, manEl);
            root.appendChild(row);
        }
    }
}

function syncAttributeOverlayPositions() {
    const root = document.getElementById('cy-attribute-overlay');
    if (!root || !cy) return;
    root.querySelectorAll('.cy-attr-overlay-row').forEach((row) => {
        const id = row.dataset.attributeId;
        if (!id) return;
        const n = cy.getElementById(id);
        if (n.empty()) return;
        const bb = n.renderedBoundingBox({ includeLabels: false });
        const bw = Number.isFinite(bb.w) ? bb.w : bb.x2 - bb.x1;
        const bh = Number.isFinite(bb.h) ? bb.h : bb.y2 - bb.y1;
        row.style.left = `${bb.x1}px`;
        row.style.top = `${bb.y1}px`;
        row.style.width = `${bw}px`;
        row.style.height = `${bh}px`;

        const bhSafe = bh > 0.5 ? bh : ATTR_OVERLAY_ROW_REF_PX;
        const scale = bhSafe / ATTR_OVERLAY_ROW_REF_PX;
        const fontPx = Math.max(ATTR_OVERLAY_FONT_MIN_PX, DIAGRAM_LABEL_FONT_PX * scale);
        row.style.fontSize = `${fontPx}px`;
        row.style.lineHeight = '1.15';
        row.style.columnGap = `${ATTR_TABLE_COL_GAP * scale}px`;
        row.style.paddingLeft = `${(ATTR_TABLE_ROW_INNER_PAD / 2) * scale}px`;
        row.style.paddingRight = `${(ATTR_TABLE_ROW_INNER_PAD / 2) * scale}px`;
        const borderW = Math.max(0.5, scale);
        row.style.border = `${borderW}px solid #ccc`;

        const wNameBase = parseFloat(row.dataset.overlayWName || '0') || 0;
        const wk = parseFloat(row.dataset.overlayWKey || '0') || 0;
        const wd = parseFloat(row.dataset.overlayWDt || '0') || 0;
        const wm = parseFloat(row.dataset.overlayWMan || '0') || 0;

        const cn = wNameBase * scale;
        const ck = wk * scale;
        const cd = wd * scale;
        const cm = wm * scale;
        if (cn + ck + cd + cm <= 0) {
            row.style.gridTemplateColumns = '1fr 1fr 1fr 1fr';
        } else {
            /** Intrinsic column widths from the same measures as card width; extra row width goes to the name column. */
            row.style.gridTemplateColumns = `minmax(${cn}px, 1fr) ${ck}px ${cd}px ${cm}px`;
        }
    });
}

function refreshEntityHeaderOverlayContent() {
    const root = document.getElementById('cy-entity-header-overlay');
    if (!root) return;
    root.replaceChildren();
    if (!cy) return;
    for (const ent of model.entities || []) {
        const el = document.createElement('div');
        el.className = 'cy-entity-header-label';
        el.dataset.entityId = ent.entity_id;
        el.textContent = displayNameForEntityCard(ent);
        root.appendChild(el);
    }
}

function syncEntityHeaderOverlayPositions() {
    const root = document.getElementById('cy-entity-header-overlay');
    if (!root || !cy) return;
    root.querySelectorAll('.cy-entity-header-label').forEach((el) => {
        const entityId = el.dataset.entityId;
        if (!entityId) return;
        const n = cy.getElementById(`${entityId}_hdr`);
        if (n.empty()) return;
        const bb = n.renderedBoundingBox({ includeLabels: false });
        const bw = Number.isFinite(bb.w) ? bb.w : bb.x2 - bb.x1;
        const bh = Number.isFinite(bb.h) ? bb.h : bb.y2 - bb.y1;
        el.style.left = `${bb.x1}px`;
        el.style.top = `${bb.y1}px`;
        el.style.width = `${bw}px`;
        el.style.height = `${bh}px`;
        const bhSafe = bh > 0.5 ? bh : HEADER_H;
        const scale = bhSafe / HEADER_H;
        const fontPx = Math.max(ATTR_OVERLAY_FONT_MIN_PX, DIAGRAM_LABEL_FONT_PX * scale);
        el.style.fontSize = `${fontPx}px`;
        el.style.lineHeight = `${fontPx * 1.15}px`;
    });
}

function scheduleDiagramOverlaysSync() {
    if (diagramOverlayRaf != null) return;
    diagramOverlayRaf = requestAnimationFrame(() => {
        diagramOverlayRaf = null;
        syncAttributeOverlayPositions();
        syncEntityHeaderOverlayPositions();
    });
}

function clearAttributeOverlay() {
    const root = document.getElementById('cy-attribute-overlay');
    if (root) root.replaceChildren();
}

function clearEntityHeaderOverlay() {
    const root = document.getElementById('cy-entity-header-overlay');
    if (root) root.replaceChildren();
}

function clearDiagramOverlays() {
    clearAttributeOverlay();
    clearEntityHeaderOverlay();
}

function syncDiagramOverlaysAfterCardWidthChange() {
    refreshAttributeOverlayContent();
    refreshEntityHeaderOverlayContent();
    requestAnimationFrame(() => {
        syncAttributeOverlayPositions();
        syncEntityHeaderOverlayPositions();
    });
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
        cy.destroy();
        cy = undefined;
    }
    clearDiagramOverlays();
    cy = cytoscape({
        container: document.getElementById('cy'),
        wheelSensitivity: CY_WHEEL_SENSITIVITY,
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
            scheduleDiagramOverlaysSync();
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
            refreshAttributeOverlayContent();
            refreshEntityHeaderOverlayContent();
            syncAttributeOverlayPositions();
            syncEntityHeaderOverlayPositions();
        });
    }

    syncCyLabelsToDisplayMode();

    cy.on('pan zoom resize render', scheduleDiagramOverlaysSync);

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
        if (cy) {
            cy.resize();
            scheduleDiagramOverlaysSync();
        }
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
    scheduleDiagramOverlaysSync();
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
    scheduleDiagramOverlaysSync();
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

// --- Cytoscape stylesheet ---

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
            'label': '',
            'width': cyNodeCardWidth,
            'height': `${ROW_H}px`,
            'text-valign': 'center',
            'text-halign': 'left',
            'background-opacity': 0,
            'border-opacity': 0,
            'border-width': 0,
            'text-opacity': 0,
        }
    },
    {
        selector: 'node[type = "entity-header"]',
        style: {
            'shape': 'rectangle',
            'label': '',
            'events': 'no',
            'text-valign': 'center',
            'text-halign': 'center',
            'background-opacity': 0,
            'width': cyNodeCardWidth,
            'height': `${HEADER_H}px`,
            'font-family': DIAGRAM_FONT_FAMILY,
            'font-size': `${DIAGRAM_LABEL_FONT_PX}px`,
            'text-opacity': 0,
        }
    },
    {
        selector: 'edge[type = "relationship"]',
        style: {
            'width': 2,
            'label': '',
            'source-label': 'data(sourceMultiplicity)',
            'target-label': 'data(targetMultiplicity)',
            // Along-edge distance from endpoints; margins alone sit too close to attribute rows.
            'source-text-offset': `${ROW_H}px`,
            'target-text-offset': `${ROW_H}px`,
            'source-text-margin-x': 0,
            'source-text-margin-y': -6,
            'target-text-margin-x': 0,
            'target-text-margin-y': -6,
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

// --- Dialogs: add entity, attribute, relationship ---

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

function syncAddAttributeDataTypeAuxiliaryFields() {
    const sel = document.getElementById('add-attribute-data-type');
    const decWrap = document.getElementById('add-attribute-decimal-fields');
    const strWrap = document.getElementById('add-attribute-string-fields');
    const dt = sel?.value ?? '';
    const isDec = dt === 'DECIMAL';
    const isStr = attributeDataTypeUsesLength(dt);
    if (decWrap) decWrap.hidden = !isDec;
    if (strWrap) strWrap.hidden = !isStr;
    if (!isDec) {
        const p = document.getElementById('add-attribute-precision');
        const s = document.getElementById('add-attribute-scale');
        if (p) p.value = '';
        if (s) s.value = '';
    }
    if (!isStr) {
        const l = document.getElementById('add-attribute-length');
        if (l) l.value = '';
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
    if (!businessName) {
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
    if (entityType === 'table' && model.meta_fields_enabled === true) {
        const err = applyMetaFieldsToTable(newEnt);
        if (err) {
            alert(err);
            return;
        }
    }
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
    syncAddAttributeDataTypeAuxiliaryFields();
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
    syncAddAttributeDataTypeAuxiliaryFields();
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
    const keyTypeRaw = document.getElementById('add-attribute-key-type')?.value ?? '';
    const definition = document.getElementById('add-attribute-definition')?.value?.trim() ?? '';
    const mandatory = document.getElementById('add-attribute-mandatory')?.checked === true;
    if (!businessName || !dataType) {
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
    const keyType = keyTypeRaw === '' ? null : keyTypeRaw;
    if (keyType !== null && !SCHEMA_KEY_TYPES.includes(keyType)) {
        alert('Invalid key type.');
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
        key_type: keyType,
    };
    if (mandatory) newAttr.mandatory = true;
    if (dataType === 'DECIMAL') {
        const precRaw = document.getElementById('add-attribute-precision')?.value ?? '';
        const scaleRaw = document.getElementById('add-attribute-scale')?.value ?? '';
        parseOptionalIntField(newAttr, 'precision', precRaw);
        parseOptionalIntField(newAttr, 'scale', scaleRaw);
    }
    if (attributeDataTypeUsesLength(dataType)) {
        const lenRaw = document.getElementById('add-attribute-length')?.value ?? '';
        parseOptionalIntField(newAttr, 'length', lenRaw);
        if (
            typeof newAttr.length === 'number' &&
            (!Number.isInteger(newAttr.length) || newAttr.length < 1)
        ) {
            alert('Length must be a positive integer.');
            return;
        }
    }
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
        if (attr.is_meta === true) continue;
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
    const pm = document.getElementById('add-relationship-parent-mandatory')?.checked === true;
    const cm = document.getElementById('add-relationship-child-mandatory')?.checked === true;
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
        parent_mandatory: pm,
        child_mandatory: cm,
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
    if (countRelatableAttributes() < 2) {
        alert('Add at least two non-meta attributes (across entities) before creating a relationship.');
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
    const pAttr = findAttributeById(parent_attribute_id);
    const cAttr = findAttributeById(child_attribute_id);
    if (!pAttr || !cAttr) {
        alert('Selected attribute not found.');
        return;
    }
    if (pAttr.is_meta === true || cAttr.is_meta === true) {
        alert('Relationships cannot use meta attributes.');
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

// --- Toolbar: new model, open, save, export CSV/DDL/PNG ---

function resetNewModelForm() {
    const form = document.getElementById('new-model-form');
    if (form) form.reset();
}

function openNewModelDialog() {
    resetNewModelForm();
    syncNewModelTechnicalPreview();
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
    const technical_name = deriveModelTechnicalNameFromDisplayName(name);
    if (!technical_name || !TECHNICAL_NAME_RE.test(technical_name)) {
        alert(
            'This name does not produce a valid technical id for the model folder. Use a name that maps to letters and numbers (after naming config and ASCII normalization), starting with a letter — or adjust the naming config.',
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
    syncNewModelTechnicalPreview();
});
document.getElementById('new-model-form')?.addEventListener('submit', (ev) => submitNewModel(ev));
document.getElementById('new-model-cancel')?.addEventListener('click', () => {
    document.getElementById('new-model-dialog')?.close();
});

document.getElementById('open-model-btn')?.addEventListener('click', () => openModel());
document.getElementById('open-model-cancel')?.addEventListener('click', () => {
    document.getElementById('open-model-dialog')?.close();
});

async function captureDiagramPngBase64() {
    if (!canonicalTechnicalName || !cy) {
        return null;
    }
    const root = document.getElementById('diagram-export-root');
    if (!root) return null;
    cy.resize();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const dataUrl = await toPng(root, {
        pixelRatio: 2,
        backgroundColor: '#ffffff',
        cacheBust: true,
    });
    const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    return m ? m[1] : dataUrl;
}

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
        let pngBase64 = null;
        try {
            pngBase64 = await captureDiagramPngBase64();
        } catch (e) {
            console.warn('Diagram capture for save failed:', e);
        }
        const saveBody = { technical_name: canonicalTechnicalName };
        if (openedAsTechnicalName && openedAsTechnicalName !== canonicalTechnicalName) {
            saveBody.supersede_technical_name = openedAsTechnicalName;
        }
        if (pngBase64) {
            saveBody.png_base64 = pngBase64;
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

document.getElementById('show-technical-names-btn')?.addEventListener('click', () => {
    if (!canonicalTechnicalName) return;
    showTechnicalNamesInDiagram = !showTechnicalNamesInDiagram;
    syncShowTechnicalNamesButton();
    syncCyLabelsToDisplayMode();
});

async function exportDiagramPng() {
    if (!canonicalTechnicalName || !cy) {
        alert('Open or create a model first.');
        return;
    }
    const btn = document.getElementById('export-diagram-btn');
    if (btn) btn.disabled = true;
    try {
        const b64 = await captureDiagramPngBase64();
        if (!b64) {
            alert('Could not capture diagram.');
            return;
        }
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
        alert(`Diagram saved to data/models/${canonicalTechnicalName}/${canonicalTechnicalName}.png`);
    } catch (e) {
        console.error(e);
        alert(e.message || 'Export failed.');
    } finally {
        if (btn) btn.disabled = false;
    }
}

document.getElementById('export-diagram-btn')?.addEventListener('click', () => void exportDiagramPng());

async function exportModelCsv() {
    if (!canonicalTechnicalName) {
        alert('Open or create a model first.');
        return;
    }
    const btn = document.getElementById('export-csv-btn');
    if (btn) btn.disabled = true;
    try {
        const ok = await persistWorkingModel();
        if (!ok) {
            alert(detailsPersistErrorText || 'Could not save working copy before export.');
            return;
        }
        const res = await fetch('/api/export_model_csv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                technical_name: canonicalTechnicalName,
                working: true,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            alert(data.error || res.statusText || 'Could not export CSV.');
            return;
        }
        alert(`CSV saved to ${data.path}`);
    } catch (e) {
        console.error(e);
        alert(e.message || 'Export failed.');
    } finally {
        if (btn) btn.disabled = false;
    }
}

document.getElementById('export-csv-btn')?.addEventListener('click', () => void exportModelCsv());

async function exportModelDdl() {
    if (!canonicalTechnicalName) {
        alert('Open or create a model first.');
        return;
    }
    const btn = document.getElementById('export-ddl-btn');
    if (btn) btn.disabled = true;
    try {
        const ok = await persistWorkingModel();
        if (!ok) {
            alert(detailsPersistErrorText || 'Could not save working copy before export.');
            return;
        }
        const res = await fetch('/api/export_model_ddl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                technical_name: canonicalTechnicalName,
                working: true,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            alert(data.error || res.statusText || 'Could not export DDL.');
            return;
        }
        alert(
            `DDL saved: ${data.base}/full and ${data.base}/simple (${data.file_count} files total).`,
        );
    } catch (e) {
        console.error(e);
        alert(e.message || 'Export failed.');
    } finally {
        if (btn) btn.disabled = false;
    }
}

document.getElementById('export-ddl-btn')?.addEventListener('click', () => void exportModelDdl());

// --- Startup: wire DOM controls and load naming config ---

initAddAttributeDataTypeSelect();
syncAddAttributeDataTypeAuxiliaryFields();
document
    .getElementById('add-attribute-data-type')
    ?.addEventListener('change', syncAddAttributeDataTypeAuxiliaryFields);
syncAddRelationshipButtonState();
syncRemoveSelectedButtonState();
syncShowTechnicalNamesButton();
wireAddRelationshipDialogControls();
document.getElementById('remove-selected-btn')?.addEventListener('click', () => removeDiagramSelection());
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
void loadDefaultMetaConfig();
refreshDiagramMetaStrip();

document.getElementById('toggle-meta-fields-btn')?.addEventListener('click', () => onToggleMetaFieldsClick());
document.getElementById('manage-meta-fields-btn')?.addEventListener('click', () => openManageMetaFieldsDialog());
document.getElementById('manage-meta-add-field-btn')?.addEventListener('click', () => addEmptyManageMetaField());
document.getElementById('manage-meta-save-btn')?.addEventListener('click', () => void saveManageMetaFieldsFromDialog());
document.getElementById('manage-meta-promote-default-btn')?.addEventListener('click', () =>
    void promoteMetaConfigToDefaultFromDialog(),
);
document.getElementById('manage-meta-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('manage-meta-fields-dialog')?.close();
});
