const fs=require('node:fs'),assert=require('node:assert/strict');
const {sanitiseFlowGraph}=require('../../flowflex/src/app/flows/edit-flow/flowPortability.ts');
const {partitionFlowEdges}=require('../../flowflex/src/app/flows/edit-flow/connectionService.ts');
const {buildFlowHandleRegistry}=require('../../flowflex/src/app/flows/edit-flow/sourceHandleRegistry.ts');
const {normalizeResponseExamples}=require('../../flowflex/src/app/flows/edit-flow/drawers/apiNodeState.ts');
const {compileFlowToActivities}=require('../../moleculer-flowflex/utils/temporal_compiler');
const {buildDynamicOptions}=require('../../temporal-core-flowflex/src/common/dynamic-options.ts');
const raw=JSON.parse(fs.readFileSync(new URL('../flows/dynamic-list-demo.json',`file://${__filename}`)));
const graph=sanitiseFlowGraph(raw._nodes,raw._edges,{preserveApiConfiguration:true});
assert.equal(partitionFlowEdges(graph.nodes,graph.edges,{handles:buildFlowHandleRegistry(graph.nodes)}).validEdges.length,15);
const api=graph.nodes.find(n=>n.type==='apiNode'),list=graph.nodes.find(n=>n.type==='listMessageNode');
assert.equal(api.data.request_version,2);assert.equal(api.data.body_mode,'none');
const example=normalizeResponseExamples(api.data).find(e=>e.status===200);
assert.equal(example.body.items.length,3);
assert.equal(list.data.dynamic_options.source,'{{an_1.data.items}}');
const mapped=buildDynamicOptions(example.body.items,list.data.dynamic_options,'list');
assert.equal(mapped.outcome,'ready');assert.equal(mapped.rows.length,3);
const compiled=compileFlowToActivities(graph,{_id:'demo',org_id:'demo',branch_id:'demo'});
const request=compiled.find(a=>a.name==='apiNodeV2');
assert(request);assert.equal(request.exposeAs,'an_1');assert.equal(request.args.method,'GET');
assert.equal(request.args.headers['ngrok-skip-browser-warning'],'true');
const branch=compiled.find(a=>a.args?.apiResponseOutcome);
assert(branch);
assert(branch.args.success.some(a=>a.name==='sendDynamicWhatsappMsg'));
for(const outcome of ['http-error','request-failed']){
 assert(!branch.args[outcome].some(a=>a.name==='sendDynamicWhatsappMsg'));
 assert(branch.args[outcome].some(a=>a.name==='sendWhatsappMsg'));
}
console.log('PASS: API v2 import, all 15 edges, response examples, list mappings, success/error routing.');
