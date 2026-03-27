import cytoscape from "./cytoscape.esm.min.js";

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
    let apiStr = '/api/load_json'
    let reqInit = { method: 'GET' }
    return fetch(apiStr, reqInit)
        .then(res => res.json())
        .then(rJson => {
            model = rJson;
        })
}

function modelToNodesEdges() {
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
                    type: 'entity'
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
                        type: 'attribute'
                    }
                }
            )
            edges.push(
                {
                    data : {
                        id : ent.entity_id + attr.attribute_id,
                        source: ent.entity_id,
                        target: attr.attribute_id,
                        type: 'entity_attribute',
                        label: ent.entity_id + attr.attribute_id
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
        style: [
            {
                selector: 'node',
                style: {
                    'label': 'data(label)',
                    'background-color': '#0074D9',
                    'color': '#fff',
                    'text-valign': 'center',
                    'text-halign': 'center'
                }
            },
            {
                selector: 'edge',
                style: {
                    'label': 'data(label)',
                    'width': 2,
                    'line-color': '#ccc',
                    'target-arrow-color': '#ccc',
                    'target-arrow-shape': 'triangle',
                    'curve-style': 'bezier'
                }
            }
        ],
        layout: {
            name: 'grid',
            padding: 10
        }
    });
}

window.addEventListener('load', pageInit)