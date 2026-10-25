import {writeFileSync} from 'node:fs';
const base=process.env.CALENDAR_DEMO_BASE_URL || 'https://7f81-139-59-83-26.ngrok-free.app';
const nodes=[],edges=[];
const node=(id,type,title,data,x=0,y=0)=>{const n={id,type,position:{x,y},data:{title,...data}};nodes.push(n);return n;};
const edge=(a,b,handle='next-step')=>edges.push({id:`${a.id}_${handle}_${b.id}`,source:a.id,target:b.id,sourceHandle:`${handle}-${a.id}`,targetHandle:'target',type:'button'});
const text=(id,title,body,x,y)=>node(id,'whatsappTextNode',title,{to:'{{trigger.from}}',meta_payload:{body},form_payload:{to:'{{trigger.from}}',body,is_response_wait:false}},x,y);
const trigger=node('demo_trigger','triggerNode','triggerNode_1',{trigger:'whatsapp',topic:'whatsapp.incoming_message',trigger_topic_title:'Incoming Message'},450,0);
const morning=text('demo_greeting','whatsappTextNode_1','Good morning! Please choose a time of day from our demo list.',450,180);
const items=[{id:'demo_morning',title:'Morning',description:'Demo option: 9:00 AM to 12:00 PM'},{id:'demo_afternoon',title:'Afternoon',description:'Demo option: 12:00 PM to 3:00 PM'},{id:'demo_evening',title:'Evening',description:'Demo option: 3:00 PM to 6:00 PM'}];
const api=node('demo_api','apiNode','apiNode_1',{
 description:'Fetch demo choices from the calendar backend. Test request → Use as example to refresh the response.',
 request_version:2,outcome_mode:'branches',api_type:'custom',
 url:`${base}/demo/list-options`,method:'GET',
 headers:[{key:'Accept',value:'application/json'},{key:'ngrok-skip-browser-warning',value:'true'}],parameters:[],body_mode:'none',
 timeout_ms:15000,retry_transient:false,on_http_error:'continue',on_transport_error:'continue',
 sample_payload:{items},sample_response:{status:200,ok:true,headers:{'content-type':'application/json'}},
 response_examples:[
  {id:'demo-200',status:200,headers:{'content-type':'application/json'},body:{items}},
  {id:'demo-400',status:400,headers:{},body:{message:'Example: invalid request'}},
  {id:'demo-500',status:500,headers:{},body:{message:'Example: backend unavailable'}},
 ],selected_response_example:'demo-200',
},450,380);
const dynamic_options={source:'{{an_1.data.items}}',id:'{{item.id}}',title:'{{item.title}}',description:'{{item.description}}',section_title:'Demo times',limit:10};
const body='Which time of day works for you? These are sample choices, not live availability.';
const list=node('demo_list','listMessageNode','listMessageNode_1',{options_mode:'dynamic',dynamic_options,to:'{{trigger.from}}',message_type:'interactive',meta_payload:{type:'list',body:{text:body},action:{button:'Choose a time',sections:[]}},form_payload:{options_mode:'dynamic',dynamic_options,to:'{{trigger.from}}',body,list_title:'Choose a time',is_response_wait:true,response_wait:5,response_wait_unit:'minutes',header_type:'text',list:[]}},450,600);
const selected=text('demo_selected','whatsappTextNode_2','You selected {{lmn_1.response.title}}. Demo complete — no meeting was booked.',0,900);
const empty=text('demo_empty','whatsappTextNode_3','The demo returned no options. Please try again.',350,900);
const invalid=text('demo_invalid','whatsappTextNode_4','We could not load the demo choices. Please try again.',700,900);
const timeout=text('demo_timeout','whatsappTextNode_5','No selection received. Send a new message to try the demo again.',1050,900);
const httpError=text('demo_http_error','whatsappTextNode_6','The demo API returned an error. Please try again later.',-350,600);
const requestFailed=text('demo_request_failed','whatsappTextNode_7','We could not reach the demo API. Please try again later.',1250,600);
const end=node('demo_end','endFlowNode','endFlowNode_1',{},450,1200);
edge(trigger,morning);edge(morning,api);edge(api,list,'success');edge(api,httpError,'http-error');edge(api,requestFailed,'request-failed');edge(httpError,end);edge(requestFailed,end);
for(const [outcome,n] of [['selected',selected],['empty',empty],['invalid',invalid],['no-response',timeout]]){edge(list,n,outcome);edge(n,end);}
writeFileSync(new URL('../flows/dynamic-list-demo.json',import.meta.url),JSON.stringify({_nodes:nodes,_edges:edges},null,2)+'\n');
console.log(`Generated ${nodes.length} nodes, ${edges.length} edges; no secrets.`);
