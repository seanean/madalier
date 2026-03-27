const CARD_WIDTH = 220;
const HEADER_H = 28;
const ROW_H = 24;

let model = {};
let layout = {};
let positions = {};
let nodes = [];
let edges = [];
/** Canonical file stem (e.g. test). Edits use temp_<stem> on the server until Save. */
let canonicalModelStem = null;
let workspaceResizeInitialized = false;
cy = undefined;

/** Matches [schemas/model.json](schemas/model.json) entity_type.enum */
const SCHEMA_ENTITY_TYPES = ['view', 'table'];
/** Matches schemas/model.json attributes.items.properties.data_type.enum */
const SCHEMA_DATA_TYPES = [
    'STRING', 'TEXT', 'INTEGER', 'BIGINT', 'SMALLINT', 'DECIMAL', 'FLOAT',
    'BOOLEAN', 'DATE', 'TIMESTAMP', 'BINARY',
];
/** Matches schemas/model.json key_type.enum (null = none) */
const SCHEMA_KEY_TYPES = ['PRIMARY', 'FOREIGN', 'NATURAL'];

let persistModelTimer = null;
let detailsPersistErrorText = null;

function workingStemForCanonical(stem) {
    return stem ? `temp_${stem}` : null;
}

async function retrieveModel(stem) {
    const res = await fetch('/api/load_model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: stem })
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText);
    }
    model = await res.json();
}

async function retrieveLayout(stem) {
    const res = await fetch('/api/load_layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: stem })
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

async function loadWorkingCopyAndRender(canonicalStem) {
    clearTimeout(persistModelTimer);
    persistModelTimer = null;
    canonicalModelStem = canonicalStem;
    const ws = workingStemForCanonical(canonicalStem);
    await retrieveModel(ws);
    await retrieveLayout(ws);
    modelToNodesEdges();
    console.log('Nodes created:', nodes.length);
    console.log('Edges created:', edges.length);
    renderCy();
    clearDetailsPane();
}

async function openCanonicalModel(canonicalStem) {
    const res = await fetch('/api/open_model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: canonicalStem }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
        throw new Error(data.error || res.statusText);
    }
    await loadWorkingCopyAndRender(canonicalStem);
}

async function openModel() {
    const btn = document.getElementById('open-model-btn');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/list_models');
        if (!res.ok) {
            alert('Could not list models.');
            return;
        }
        const data = await res.json();
        const stems = data.models || [];
        if (stems.length === 0) {
            alert('No models found in data/models.');
            return;
        }
        const listEl = document.getElementById('open-model-list');
        const dialog = document.getElementById('open-model-dialog');
        if (!listEl || !dialog) return;
        listEl.replaceChildren();
        for (const s of stems) {
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
}

function patchAttributeLabelInCy(attributeId, businessName) {
    if (!cy) return;
    const n = cy.getElementById(attributeId);
    if (n.nonempty()) {
        n.data('label', businessName ?? '');
        n.data('businessName', businessName ?? '');
    }
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

/** Persists in-memory `model` to temp_<stem>.json. Returns whether the write succeeded. */
async function persistWorkingModel() {
    if (!canonicalModelStem) return true;
    const ws = workingStemForCanonical(canonicalModelStem);
    if (!ws) return true;
    const q = new URLSearchParams({ model: ws });
    try {
        const res = await fetch(`/api/save_working_model?${q}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(model),
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

function renderEntityDetails(ent) {
    const root = document.getElementById('details-content');
    if (!root) return;
    root.replaceChildren();
    const banner = document.createElement('div');
    banner.id = 'details-persist-message';
    banner.className = 'details-persist-message';
    banner.hidden = true;
    root.appendChild(banner);
    syncDetailsPersistBanner();

    const h3 = document.createElement('h3');
    h3.textContent = 'Entity';
    root.appendChild(h3);

    const form = document.createElement('div');
    form.className = 'details-form';

    const inpBusiness = document.createElement('input');
    inpBusiness.type = 'text';
    inpBusiness.value = ent.business_name ?? '';
    inpBusiness.addEventListener('input', () => {
        ent.business_name = inpBusiness.value;
        patchEntityLabelInCy(ent.entity_id, ent.business_name);
        schedulePersistWorkingModel();
    });
    appendDetailsFormField(form, 'business_name', inpBusiness);

    const taDef = document.createElement('textarea');
    taDef.rows = 4;
    taDef.value = ent.definition ?? '';
    taDef.addEventListener('input', () => {
        ent.definition = taDef.value;
        schedulePersistWorkingModel();
    });
    appendDetailsFormField(form, 'definition', taDef);

    const selType = document.createElement('select');
    const currentType = ent.entity_type;
    const types = SCHEMA_ENTITY_TYPES.includes(currentType)
        ? SCHEMA_ENTITY_TYPES
        : [...SCHEMA_ENTITY_TYPES, currentType].filter(Boolean);
    for (const v of types) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        if (v === currentType) opt.selected = true;
        selType.appendChild(opt);
    }
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

    const root = document.getElementById('details-content');
    if (!root) return;
    root.replaceChildren();
    const banner = document.createElement('div');
    banner.id = 'details-persist-message';
    banner.className = 'details-persist-message';
    banner.hidden = true;
    root.appendChild(banner);
    syncDetailsPersistBanner();

    const h3 = document.createElement('h3');
    h3.textContent = 'Attribute';
    root.appendChild(h3);

    const form = document.createElement('div');
    form.className = 'details-form';

    const inpBusiness = document.createElement('input');
    inpBusiness.type = 'text';
    inpBusiness.value = attr.business_name ?? '';
    inpBusiness.addEventListener('input', () => {
        attr.business_name = inpBusiness.value;
        patchAttributeLabelInCy(attr.attribute_id, attr.business_name);
        schedulePersistWorkingModel();
    });
    appendDetailsFormField(form, 'business_name', inpBusiness);

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
    const currentDt = attr.data_type;
    const dts = SCHEMA_DATA_TYPES.includes(currentDt)
        ? SCHEMA_DATA_TYPES
        : [...SCHEMA_DATA_TYPES, currentDt].filter(Boolean);
    for (const v of dts) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        if (v === currentDt) opt.selected = true;
        selData.appendChild(opt);
    }
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

    const entForOrder = findEntityContainingAttribute(attr.attribute_id);
    const attrsSorted = entForOrder ? sortedEntityAttributes(entForOrder) : [];
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
    const root = document.getElementById('details-content');
    if (!root) return;
    root.replaceChildren();
    const p = document.createElement('p');
    p.className = 'details-placeholder';
    p.textContent = 'Select an entity or attribute on the diagram.';
    root.appendChild(p);
}

function modelToNodesEdges() {
    nodes = [];
    edges = [];
    const entities = model.entities || [];
    const relationships = model.relationships || [];
    for (const ent of entities) {
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
                    attributes: ent.attributes
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
                    type: 'entity-header'
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
                        attributeOrder: attr.attribute_order
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
    if (cy) {
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
    
    if (layout && layout.layout && layout.layout.length > 0) {
        cy.batch(() => {
            cy.nodes('[type = "entity"]').forEach(ent => {
                ent.position(positions[ent.id()]);
            });
        });
    }
    else {
        console.log('here also');
        cy.layout({
            name: 'dagre',
            rankDir: 'LR',
            nodeSep: 40,
            rankSep: 120,
            padding: 40,
            nodeDimensionsIncludeLabels: false,
            animate: false
        }).run();
    }

    cy.nodes('[type = "entity"]').forEach(ent => cyPositionAttributes(ent));

    cy.on('dragfree','node[type = "entity"]', (evt) => {
        console.log();
        if(evt.target.data('type') === 'entity') { 
            cyPositionAttributes(evt.target);
            saveLayout();
        }
        else { return; }
    });

    cy.on('grab','node[type = "attribute"]', (evt) => {
        evt.target.ungrabify();
    });

    cy.on('free','node[type = "attribute"]', (evt) => {
        evt.target.grabify();
    });

    cy.on('tap', (evt) => {
        if (evt.target === cy) {
            clearDetailsPane();
        }
    });

    cy.on('tap', 'node', (evt) => {
        const nodeType = evt.target.data('type');
        if (nodeType === 'entity') {
            const ent = findEntityById(evt.target.id());
            if (ent) renderEntityDetails(ent);
            else renderDetailsError('Entity not found in model.');
        } else if (nodeType === 'attribute') {
            const attr = findAttributeById(evt.target.id());
            if (attr) renderAttributeDetails(attr);
            else renderDetailsError('Attribute not found in model.');
        }
    });

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
    cyPositionAttributes(entCy);
}

function saveLayout() {
    if (!canonicalModelStem || !cy) return;
    const ws = workingStemForCanonical(canonicalModelStem);
    const layout_arr = [];
    cy.nodes('[type = "entity"]').forEach(ent => {
        layout_arr.push({
            entity_id: ent.id(),
            x_coord: ent.position('x'),
            y_coord: ent.position('y')
        });
    });

    const q = new URLSearchParams({ model: ws });
    fetch(`/api/save_layout?${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: layout_arr })
    });
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
        }
    },
    {
        selector: 'node[type = "attribute"]',
        style: {
            'shape': 'rectangle',
            'label': 'data(label)',
            'width': `${CARD_WIDTH}px`,
            'height': `${ROW_H}px`,
            'text-valign': 'center',
            'text-halign': 'center',
            'background-color': '#f0f0f0',
            'border-color': '#ccc',
            'border-width': 1
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
        }
    },
    {
        selector: 'edge[type = "relationship"]',
        style: {
            'width': 2,
            'label': 'data(label)',
            'curve-style':'taxi',
            'taxi-direction': 'horizontal',
            'taxi-turn': 50
        }
    }
    
];
function resetNewModelForm() {
    const form = document.getElementById('new-model-form');
    if (form) form.reset();
}

function openNewModelDialog() {
    resetNewModelForm();
    const dialog = document.getElementById('new-model-dialog');
    dialog?.showModal();
    queueMicrotask(() => document.getElementById('new-model-stem')?.focus());
}

async function submitNewModel(ev) {
    ev.preventDefault();
    const stemInput = document.getElementById('new-model-stem');
    const nameInput = document.getElementById('new-model-display-name');
    const descInput = document.getElementById('new-model-description');
    const submitBtn = document.getElementById('new-model-submit');
    const dialog = document.getElementById('new-model-dialog');
    if (!stemInput || !dialog) return;
    const stem = stemInput.value.trim();
    if (!stem) {
        alert('Enter a file name.');
        return;
    }
    const nameVal = nameInput?.value.trim() ?? '';
    const description = descInput?.value ?? '';
    const body = {
        stem,
        description,
    };
    if (nameVal) body.name = nameVal;
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
        await loadWorkingCopyAndRender(data.stem);
    } catch (e) {
        console.error(e);
        alert(e.message || 'Could not create model.');
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

document.getElementById('new-model-btn')?.addEventListener('click', () => openNewModelDialog());
document.getElementById('new-model-form')?.addEventListener('submit', (ev) => submitNewModel(ev));
document.getElementById('new-model-cancel')?.addEventListener('click', () => {
    document.getElementById('new-model-dialog')?.close();
});

document.getElementById('open-model-btn')?.addEventListener('click', () => openModel());
document.getElementById('open-model-cancel')?.addEventListener('click', () => {
    document.getElementById('open-model-dialog')?.close();
});

async function saveCanonicalModel() {
    if (!canonicalModelStem) {
        alert('Open or create a model first.');
        return;
    }
    clearTimeout(persistModelTimer);
    persistModelTimer = null;
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
        const res = await fetch('/api/save_model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: canonicalModelStem }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            alert(data.error || res.statusText || 'Could not save model.');
            return;
        }
    } catch (e) {
        console.error(e);
        alert(e.message || 'Could not save model.');
    } finally {
        if (btn) btn.disabled = false;
    }
}

document.getElementById('save-model-btn')?.addEventListener('click', () => saveCanonicalModel());
