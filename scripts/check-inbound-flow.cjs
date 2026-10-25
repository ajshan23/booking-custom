const fs=require('node:fs'),assert=require('node:assert/strict');
const {sanitiseFlowGraph}=require('../../flowflex/src/app/flows/edit-flow/flowPortability.ts');
const {partitionFlowEdges}=require('../../flowflex/src/app/flows/edit-flow/connectionService.ts');
const {buildFlowHandleRegistry}=require('../../flowflex/src/app/flows/edit-flow/sourceHandleRegistry.ts');
const {compileFlowToActivities}=require('../../moleculer-flowflex/utils/temporal_compiler');
const {ifelse}=require('../../temporal-core-flowflex/src/common/ifelse.ts');
const {evaluatepaths}=require('../../temporal-core-flowflex/src/common/evaluatepaths.ts');
const {buildDynamicOptions}=require('../../temporal-core-flowflex/src/common/dynamic-options.ts');
const raw=JSON.parse(fs.readFileSync('flows/flowflex-inbound-calendar.json'));
const safe=sanitiseFlowGraph(raw._nodes,raw._edges,{preserveApiConfiguration:true});
// Requires fix/json-import-flow for credential preservation on import.
// Restore authored API fields only for these runtime scenarios on older main.
for(const n of safe.nodes.filter(n=>n.type==='apiNode')){
 const authored=raw._nodes.find(r=>r.id===n.id);
 n.data.headers=structuredClone(authored.data.headers);n.data.body=structuredClone(authored.data.body);
}
const partition=partitionFlowEdges(safe.nodes,safe.edges,{handles:buildFlowHandleRegistry(safe.nodes)});
assert.equal(partition.validEdges.length,safe.edges.length,JSON.stringify(partition));
// Verify import preserves configuration without manual repairs. Do not print secrets.
for(const n of safe.nodes.filter(n=>n.type==='apiNode')){
 const auth=n.data.headers.find(h=>h.key==='Authorization').value;
 assert.ok(auth.startsWith('Bearer ') && auth.length>20,'Missing service authorization');
 if(n.data.url.endsWith('/book')){
  assert.equal(n.data.body.find(r=>r.key==='confirmationToken').value,'{{confirmation_value}}');
  assert.equal(n.data.headers.find(r=>r.key==='Idempotency-Key').value,'inbound-{{confirmation_value}}');
 }
 // Never include real credentials in mocked activity diagnostics.
 n.data.headers.find(h=>h.key==='Authorization').value='Bearer test-only';
}
const compiled=compileFlowToActivities(safe,{_id:'test',org_id:'test',branch_id:'test'});
function resolve(v,ctx){
 if(typeof v==='string'){
  const evaluate=x=>{try{return Function(...Object.keys(ctx),`return (${x})`)(...Object.values(ctx))}catch{return undefined}};
  const whole=v.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  if(whole)return evaluate(whole[1])??v;
  return v.replace(/\{\{\s*([^}]+)\s*\}\}/g,(match,x)=>{const value=evaluate(x);return value==null?match:String(value)});
 }
 if(Array.isArray(v))return v.map(x=>resolve(x,ctx));
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x,ctx)]));
 return v;
}
function scenario(mode){
 const results={trigger:{from:'919000000001',text:'hello'}},messages=[],calls=[];let ended=false,assigned=0,dateTries=0,polls=0,dynamicLists=0,selectionCalls=0,bookCalls=0,availabilityCalls=0;
 const log=console.log;console.log=()=>{};
 function run(items,scope={}){
  for(const a of items){if(ended)return;const ctx={...scope,...results};let value;
   if(a.name==='forloop'){
    let count=0,met=false;
    for(let i=0;i<a.args.n;i++){run(a.args.activitiesToLoop,{...scope,loop:{index:i}});count++;if(ended)break;met=ifelse(resolve(a.args.until,{...scope,...results,loop:{index:i}}));if(met)break;}
    value={iterations:count,conditionMet:met,exhausted:!met&&count===a.args.n};
   }else if(a.name==='conditionalSplit'){run(a.args[results[a.args.conditionActivityKey]?'ifTrue':'ifFalse'],scope);continue;
   }else if(a.name==='conditionalBranch'){run(a.args[results[a.args.conditionActivityKey]]||[],scope);continue;
   }else{
    const args=resolve(a.args,ctx);
    if(a.name==='saveVariable')value=args.value;
    else if(a.name==='ifelse')value=ifelse(args.condition??args);
    else if(a.name==='evaluatepaths')value=evaluatepaths(args);
    else if(a.name==='sendDynamicWhatsappMsg'){
     const built=buildDynamicOptions(resolve(a.args.dynamic_options.source,ctx),a.args.dynamic_options,'list');
     assert.equal(built.outcome,'ready');
     assert.ok(built.rows.length<=10,'WhatsApp list exceeds ten rows');
     const index=mode==='more_times'&&dynamicLists++===0?built.rows.findIndex(row=>row.id==='__next__'):0;
     assert.notEqual(index,-1,'Expected a More times row on the first page');
     value={outcome:'selected',response:built.rows[index],selectedItem:built.items[index]};
    }
    else if(a.name==='sendWhatsappMsg'){
     const interactive=args.payload.interactive;
     const body=args.payload.text?.body || interactive?.body.text;assert.ok(!body.includes('{{'),body);messages.push(body);value={success:true};
     if(interactive){
      assert.ok(body.length<=1024,'Interactive body exceeds limit');
      let id;
      if(interactive.type==='list'){
       assert.equal(interactive.action.sections[0].rows.length,2);
       if(mode!=='type_timeout')id=mode==='support_booking'?'ROW_1.2':'ROW_1.1';
      }else{
       assert.ok(interactive.action.buttons.length<=3);
       assert.ok(interactive.action.buttons.every(b=>b.reply.title.length<=20));
       if(body.startsWith('Hi!')){if(mode!=='menu_timeout')id=mode==='exit'?'BUTTON_3':mode==='pricing'?'BUTTON_2':'BUTTON_1';}
       else if(mode!=='no_confirm')id=mode==='confirm_cancel'?'BUTTON_2':mode==='confirm_human'?'BUTTON_3':'BUTTON_1';
      }
      if(id)value.response={id,title:'Test choice'};
     }else if(args.wait){let reply;
      if(body.startsWith('Hi!'))reply=mode==='exit'?'NOT NOW':mode==='pricing'?'PRICING':'BOOK';
      else if(body.startsWith('What name'))reply='Test Customer';
      else if((body.startsWith('What email')||body.startsWith('Please check your email')))reply=mode==='email_invalid'?'bad':'test@example.com';
      else if(body.startsWith('What date')||body.startsWith('Please clarify')||body.startsWith('No slots')||body.startsWith('That slot'))reply=mode==='silence'?undefined:'21 September 2026';
      else if(body.includes('Available slots'))reply='1';
      else if(body.includes('Reply CONFIRM'))reply=mode==='no_confirm'?undefined:'CONFIRM';
      if(reply!==undefined)value.response={message:reply};
     }
    }else if(a.name==='apiNode'){
     assert.ok(!JSON.stringify(args).includes('{{'),JSON.stringify(args));calls.push(args);let status,data;
     if(args.url.endsWith('/v1/sessions')){assert.equal(args.body.meetingType,mode==='support_booking'?'support':'onboarding');assert.equal('timezone' in args.body,false);status=mode==='unauthorized'?'unauthorized':mode==='email_invalid'?'invalid_input':'created';data={status,message:mode==='email_invalid'?'Please check your email address.':undefined,sessionId:['email_invalid','unauthorized'].includes(mode)?undefined:'session-1',data:{timezone:'Asia/Kolkata',timezoneSource:'phone_country'}};}
     else if(args.url.endsWith('/interpret')){dateTries++;status=(mode==='retry'&&dateTries===1)||mode==='exhausted'?'needs_clarification':'resolved';data={status,message:'Please clarify the date'};}
     else if(args.url.endsWith('/availability')){
      availabilityCalls++;
      assert.ok(Number.isInteger(args.body.page));
      const page=args.body.page;
      const slots=page===0
       ?Array.from({length:9},(_,i)=>({id:`slot-${i+1}`,title:`${9+i}:00`,description:'Mon, 21 Sep 2026'})).concat({id:'__next__',title:'More times',description:'Show the next available times'})
       :[{id:'slot-10',title:'6:00 PM–6:30 PM',description:'Mon, 21 Sep 2026'}];
      const unavailable=mode==='no_slots'||(mode==='no_slots_then_available'&&availabilityCalls===1);
      data={status:unavailable?'no_slots':'slots_available',message:unavailable?'No slots; choose another date':`Available slots page ${page+1}`,data:{page,hasMore:page===0,nextPage:page===0?1:null,totalSlots:10,slots}};
     }
     else if(args.url.endsWith('/select')){selectionCalls++;assert.equal(args.body.selection,mode==='more_times'?'slot-10':'slot-1');data={status:'awaiting_confirmation',message:'Confirm Monday 09:00 Asia/Kolkata',data:{confirmationToken:`token-${selectionCalls}`}};}
     else if(args.url.endsWith('/book')){bookCalls++;assert.equal(args.body.confirmed,true);assert.equal(args.body.confirmationToken,`token-${bookCalls}`);assert.equal(args.headers['Idempotency-Key'],`inbound-token-${bookCalls}`);data=mode==='slot_race'&&bookCalls===1?{status:'slot_unavailable',message:'That slot was just taken.',data:{bookingId:'booking-lost',meetUrl:null,canReselect:true}}:{status:mode==='pending'?'meet_pending':'confirmed',data:{bookingId:`booking-${bookCalls}`,meetUrl:mode==='pending'?null:'https://meet.google.com/test'}};}
     else {polls++;data={status:'meet_pending',data:{bookingId:'booking-1',meetUrl:null}};}
     value={ok:!['invalid_input','unauthorized'].includes(status),status:status==='unauthorized'?401:status==='invalid_input'?422:200,data};
    }else if(a.name==='assignAgent'){assigned++;value={assigned:true};}
    else if(a.name==='endFlow'){ended=true;}
    else if(a.name!=='updatableTimer')throw Error(a.name);
   }
   results[a.key]=value;if(a.exposeAs)results[a.exposeAs]=value;
  }
 }
 try{run(compiled);}finally{console.log=log;}
 const books=calls.filter(x=>x.url.endsWith('/book'));
 assert.ok(ended,mode+' did not end');
 if(mode==='slot_race')assert.equal(books.length,2,mode);else if(['happy','retry','no_slots_then_available','pending','support_booking','more_times'].includes(mode))assert.equal(books.length,1,mode);else assert.equal(books.length,0,mode);
 if(['happy','retry','no_slots_then_available','support_booking','more_times','slot_race'].includes(mode))assert.ok(messages.some(m=>m.startsWith('Your meeting is confirmed')),mode);
 else assert.ok(!messages.some(m=>m.startsWith('Your meeting is confirmed')),mode);
 if(mode==='unauthorized')assert.equal(calls.length,1);
 if(mode==='pending')assert.equal(polls,0);
 if(mode==='retry')assert.equal(dateTries,2);
 if(mode==='exhausted')assert.equal(dateTries,10);
 if(['silence','pricing','exhausted','no_slots','email_invalid','unauthorized','pending','confirm_human'].includes(mode))assert.equal(assigned,1,mode);
 console.log('PASS',mode);
}
for(const mode of ['happy','more_times','slot_race','no_slots_then_available','retry','silence','no_confirm','exhausted','pending','email_invalid','no_slots','exit','pricing','unauthorized','support_booking','menu_timeout','type_timeout','confirm_cancel','confirm_human'])scenario(mode);
console.log(`Verified ${safe.nodes.length} nodes, ${safe.edges.length} accepted edges, 19 mocked scenarios. No live API calls.`);
