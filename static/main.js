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

function formatValueForDisplay(value) {
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

function renderDetailsPane(kind, record) {
    const root = document.getElementById('details-content');
    if (!root) return;
    root.replaceChildren();
    const h3 = document.createElement('h3');
    h3.textContent = kind;
    root.appendChild(h3);
    const dl = document.createElement('dl');
    dl.className = 'details-props';
    const keys = Object.keys(record).sort();
    for (const key of keys) {
        const dt = document.createElement('dt');
        dt.textContent = key;
        const dd = document.createElement('dd');
        const fmt = formatValueForDisplay(record[key]);
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
                    technicalName: ent.technicalName,
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
                    technicalName: ent.technicalName,
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
                        technicalName: attr.technicalName,
                        dataType: attr.data_type,
                        precision: (attr.precision === undefined) ? undefined : attr.precision,
                        scale: (attr.scale === undefined) ? undefined : attr.scale,
                        keyType: attr.key_type,
                        sourceMapping: attr.entity_type,
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
                    label: rel.relationship_name,
                    sourceEntity: rel.parent_entity_id,
                    targetEntity: rel.child_entity_id,
                    type: 'relationship',
                    parentMandatory: rel.parent_mandatory,
                    childMandatory: rel.child_mandatory,
                    parentCardinality: rel.parent_cardinality,
                    childCardinality: rel.child_cardinality
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
            if (ent) renderDetailsPane('Entity', ent);
            else renderDetailsError('Entity not found in model.');
        } else if (nodeType === 'attribute') {
            const attr = findAttributeById(evt.target.id());
            if (attr) renderDetailsPane('Attribute', attr);
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
