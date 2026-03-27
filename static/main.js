const CARD_WIDTH = 220;
const HEADER_H = 28;
const ROW_H = 24;

let model = {};
let nodes = [];
let edges = [];

async function pageInit(){
    await retrieveModel();
    modelToNodesEdges();
    console.log('Nodes created:', nodes.length); // Debug: check node count
    console.log('Edges created:', edges.length);
    renderCy();
}

async function retrieveModel() {
    let apiStr = '/api/load_model'
    let reqInit = { method: 'GET' }
    return fetch(apiStr, reqInit)
        .then(res => res.json())
        .then(rJson => {
            model = rJson;
        })
}

function modelToNodesEdges() {
    nodes = [];
    edges = [];
    for (const ent of model.entities) {
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

    for (const rel of model.relationships) {
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
    const cy = cytoscape({
        container: document.getElementById('cy'),
        elements: {
            nodes: nodes,
            edges: edges
        },
        style: cyStyle
    });

    cy.layout({
        name: 'dagre',
        rankDir: 'LR',
        nodeSep: 40,
        rankSep: 120,
        padding: 40,
        nodeDimensionsIncludeLabels: false,
        animate: false
    }).run();

    cy.nodes('[type = "entity"]').forEach(ent => cyPositionAttributes(ent));

    cy.on('dragfree','node[type = "entity"]', (evt) => {
        console.log();
        if(evt.target.data('type') === 'entity') { cyPositionAttributes(evt.target);}
        else { return; }
    });

    cy.on('grab','node[type = "attribute"]', (evt) => {
        evt.target.ungrabify();
    });

    cy.on('free','node[type = "attribute"]', (evt) => {
        evt.target.grabify();
    });
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


window.addEventListener('load', pageInit)
