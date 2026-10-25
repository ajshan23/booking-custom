import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';

// Preserve the private local URL and service credential when regenerating.
const output=new URL('../flows/flowflex-inbound-calendar.json',import.meta.url);
const previous=existsSync(output)?JSON.parse(readFileSync(output,'utf8')):null;
const previousBase=previous?._nodes.flatMap(n=>n.data.variables||[]).find(v=>v.variable_name==='calendar_base')?.value;
const previousAuth=previous?._nodes.find(n=>n.type==='apiNode')?.data.headers.find(h=>h.key==='Authorization')?.value;
const dagre=createRequire(new URL('../../flowflex/package.json',import.meta.url))('@dagrejs/dagre');
const nodes=[],edges=[],counts={};
const node=(type,description,data={})=>{const i=(counts[type]=(counts[type]||0)+1);const n={id:`calendar_${nodes.length+1}`,type,position:{x:0,y:nodes.length*180},data:{title:`${type}_${i}`,description,...data}};nodes.push(n);return n;};
const edge=(a,b,h='next-step')=>edges.push({id:`e${edges.length+1}`,source:a.id,target:b.id,sourceHandle:`${h}-${a.id}`,targetHandle:'target',type:'button'});
const alias=n=>({apiNode:'an',whatsappTextNode:'wtn',repeatUntilNode:'run',buttonMessageNode:'bmn',listMessageNode:'lmn'}[n.type]+'_'+n.data.title.split('_').at(-1));
const ref=(n,path)=>`{{${alias(n)}.${path}}}`;
const groups=(type,value,condition='equals')=>[{id:'group',method:'AND',filters:[{id:'filter',type,value,condition}]}];
const split=(description,expression)=>node('conditionSplitNode',description,{conditions:groups(expression,true,'boolean_is_true'),filterGroupCondition:'AND'});
const save=(description,values)=>node('saveVariableNode',description,{variables:Object.entries(values).map(([variable_name,value])=>({variable_name,value}))});
const text=(description,body,wait=false)=>node('whatsappTextNode',description,{to:'{{trigger.from}}',meta_payload:{body},form_payload:{to:'{{trigger.from}}',body,is_response_wait:wait,response_wait:'10',response_wait_unit:'minutes',is_check_format:false,format_unit:'text'}});
const interactiveForm=body=>({to:'{{trigger.from}}',body,is_response_wait:true,response_wait:'10',response_wait_unit:'minutes',header_type:'none',is_check_format:false,format_unit:'text'});
const buttons=(description,body,titles)=>node('buttonMessageNode',description,{to:'{{trigger.from}}',message_type:'interactive',meta_payload:{type:'button',body:{text:body},action:{buttons:titles.map((title,i)=>({type:'reply',reply:{id:`BUTTON_${i+1}`,title}}))}},form_payload:{...interactiveForm(body),buttons:titles.map(title=>({title}))}});
const api=(description,path,body={},method='POST')=>node('apiNode',description,{url:`{{calendar_base}}${path}`,method,headers:[{key:'Content-Type',value:'application/json'},{key:'Authorization',value:previousAuth||''},{key:'ngrok-skip-browser-warning',value:'true'}],body:Object.entries(body).map(([key,value])=>({key,value}))});
const loop=(description,done,max)=>node('repeatUntilNode',description,{max_iterations:max,conditions:groups(`{{!!halted || (${done})}}`,true,'boolean_is_true'),filterGroupCondition:'AND'});

const trigger=node('triggerNode','Customer initiated WhatsApp message',{trigger:'whatsapp',topic:'whatsapp.incoming_message',trigger_topic_title:'Incoming Message'});
const config=save('Calendar setup and booking state',{calendar_base:previousBase||'https://YOUR-CALENDAR-HOST',pricing_copy:'FlowFlex is a paid platform. Basic is $23/month billed $276 yearly, or $29/month billed $87 quarterly. Meta messaging charges are additional and vary by recipient country and message category.',email_prompt:'What email should receive the Calendar invitation? Please enter a valid email address.',date_prompt:'',booking_stage:'date',slot_page:0,attempt_status:'',halted:false,final_message:''});edge(trigger,config);
const end=node('endFlowNode','End conversation',{message:'Inbound booking flow ended'});
const humanMsg=text('Human handoff message','I’ll pass this to our team so they can help you here.');
const human=node('assignAgentNode','Assign to the sales or support team',{to:'{{trigger.from}}',meta_payload:{strategy:'round_robin',keep_existing:true}});edge(humanMsg,human);edge(human,end);
const exit=text('Customer chose not now','No problem. Message us here whenever you would like help.');edge(exit,end);

const intro=buttons('Welcome and choose an action','Hi! Welcome to FlowFlex AI.\n\n{{pricing_copy}}',['Book meeting','Pricing','Not now']);edge(config,intro);edge(intro,end,'no-response');edge(intro,humanMsg,'BUTTON_2');edge(intro,exit,'BUTTON_3');
const typeBody='What would you like to book?';
const typeList=node('listMessageNode','Choose meeting type',{to:'{{trigger.from}}',message_type:'interactive',meta_payload:{type:'list',body:{text:typeBody},action:{button:'Meeting type',sections:[{title:'Meetings',rows:[{id:'ROW_1.1',title:'Onboarding',description:'Get help setting up FlowFlex.'},{id:'ROW_1.2',title:'Support',description:'Book time with our support team.'}]}]}},form_payload:{...interactiveForm(typeBody),list_title:'Meeting type',list:[{section_title:'Meetings',rows:[{row_title:'Onboarding',row_description:'Get help setting up FlowFlex.'},{row_title:'Support',row_description:'Book time with our support team.'}]}]}});edge(intro,typeList,'BUTTON_1');edge(typeList,end,'no-response');
const nameQ=text('Collect customer name','What name should we use for the meeting?',true);edge(typeList,nameQ,'ROW_1.1');edge(typeList,nameQ,'ROW_1.2');edge(nameQ,end,'no-response');

// Invalid email input retries in place. A timeout or exhausted loop hands off.
const emailLoop=loop('Collect a valid email: maximum three attempts','false',3);edge(nameQ,emailLoop);
const emailEnd=node('endLoopNode','End email attempts');
const emailQ=text('Collect invitation email','{{email_prompt}}',true);edge(emailLoop,emailQ);
const emailTimeout=save('Email reply timed out',{halted:true});edge(emailQ,emailTimeout,'no-response');edge(emailTimeout,emailEnd);
const create=api('Create booking session and infer timezone from phone','/v1/sessions',{customerRef:'{{trigger.from}}',name:ref(nameQ,'response.message'),email:ref(emailQ,'response.message'),meetingType:`{{${alias(typeList)}.response?.id === "ROW_1.2" ? "support" : "onboarding"}}`});edge(emailQ,create);
const created=split('Booking session created',`{{${alias(create)}.ok && !!${alias(create)}.data.sessionId}}`);edge(create,created);
edge(created,emailEnd,'yes');
const emailRetry=save('Retry invalid email or hand off service failures',{email_prompt:`{{${alias(create)}.data.message || "Please enter a valid email address."}}`,halted:`{{${alias(create)}.status === 422 ? false : true}}`});edge(created,emailRetry,'no');edge(emailRetry,emailEnd);
const sessionId=ref(create,'data.sessionId'),customerTimezone=ref(create,'data.data.timezone');
emailLoop.data.conditions=groups(`{{!!halted || (${alias(create)}.ok && !!${alias(create)}.data.sessionId)}}`,true,'boolean_is_true');
const emailReady=split('Continue with a valid session',`{{!halted && ${alias(create)}.ok && !!${alias(create)}.data.sessionId}}`);edge(emailEnd,emailReady);edge(emailReady,humanMsg,'no');

// One state-machine loop handles date correction, another-day selection,
// slot pagination, confirmation and a lost slot race without nested loops.
const bookingLoop=loop('Booking conversation: maximum ten customer steps','attempt_status === "confirmed"',10);edge(emailReady,bookingLoop,'yes');
const bookingEnd=node('endLoopNode','End booking conversation step');
const isDate=split('Current step is date selection','{{booking_stage === "date"}}');edge(bookingLoop,isDate);

const dateQ=text('Ask for a meeting date',`{{date_prompt || ("What date would you prefer? Times will be shown in " + ${alias(create)}.data.data.timezone + ". Example: 21 September 2026.")}}`,true);edge(isDate,dateQ,'yes');
const dateTimeout=save('Date reply timed out',{halted:'human',final_message:'We did not receive a date, so our team can help you continue.'});edge(dateQ,dateTimeout,'no-response');edge(dateTimeout,bookingEnd);
const interpret=api('Interpret customer date',`/v1/sessions/${sessionId}/interpret`,{text:ref(dateQ,'response.message')});edge(dateQ,interpret);
const resolved=split('Date resolved',`{{${alias(interpret)}.ok && ${alias(interpret)}.data.status === "resolved"}}`);edge(interpret,resolved);
const dateRetry=save('Ask for a clearer date',{booking_stage:'date',date_prompt:`{{${alias(interpret)}.data.message || "Please enter the full date."}}`});edge(resolved,dateRetry,'no');edge(dateRetry,bookingEnd);
const firstAvailability=api('Check availability for the resolved date',`/v1/sessions/${sessionId}/availability`,{page:0});edge(resolved,firstAvailability,'yes');
const hasSlots=split('Resolved date has slots',`{{${alias(firstAvailability)}.ok && ${alias(firstAvailability)}.data.status === "slots_available"}}`);edge(firstAvailability,hasSlots);
const showSlots=save('Move to time selection',{booking_stage:'slot',slot_page:0});edge(hasSlots,showSlots,'yes');edge(showSlots,bookingEnd);
const noSlots=save('No slots: ask customer for another date',{booking_stage:'date',date_prompt:`{{${alias(firstAvailability)}.data.message || "No times are available that day. Please choose another date."}}`});edge(hasSlots,noSlots,'no');edge(noSlots,bookingEnd);

const isSlot=split('Current step is time selection','{{booking_stage === "slot"}}');edge(isDate,isSlot,'no');
const pageAvailability=api('Fetch requested availability page',`/v1/sessions/${sessionId}/availability`,{page:'{{slot_page}}'});edge(isSlot,pageAvailability,'yes');
const slotBody=`Choose an available time. Select More times for the next page. Times are shown in ${customerTimezone}.`;
const slotList=node('listMessageNode','Choose a time or request more',{to:'{{trigger.from}}',message_type:'interactive',options_mode:'dynamic',dynamic_options:{source:ref(pageAvailability,'data.data.slots'),id:'{{item.id}}',title:'{{item.title}}',description:'{{item.description}}',section_title:'Available times',limit:10},meta_payload:{type:'list',body:{text:slotBody},action:{button:'Available times'}},form_payload:{...interactiveForm(slotBody),options_mode:'dynamic',list_title:'Available times'}});edge(pageAvailability,slotList);
const slotTimeout=save('Slot choice timed out',{halted:'human',final_message:'We did not receive a time selection.'});edge(slotList,slotTimeout,'no-response');edge(slotTimeout,bookingEnd);
const slotFailed=save('Slot list or selection failed',{halted:'human',final_message:'Available times could not be selected.'});edge(slotList,slotFailed,'invalid');edge(slotList,slotFailed,'empty');edge(slotFailed,bookingEnd);
const more=split('Customer selected More times',`{{${alias(slotList)}.response?.id === "__next__"}}`);edge(slotList,more,'selected');
const nextPage=save('Advance availability page',{slot_page:'{{slot_page + 1}}'});edge(more,nextPage,'yes');edge(nextPage,bookingEnd);
const select=api('Select real slot',`/v1/sessions/${sessionId}/select`,{selection:ref(slotList,'response.id')});edge(more,select,'no');
const selectedOK=split('Slot is ready for confirmation',`{{${alias(select)}.ok && ${alias(select)}.data.status === "awaiting_confirmation"}}`);edge(select,selectedOK);edge(selectedOK,slotFailed,'no');
const selected=save('Move to confirmation',{booking_stage:'confirm',confirmation_value:ref(select,'data.data.confirmationToken'),selected_summary:ref(select,'data.message'),selected_slot:`{{${alias(select)}.data.message.split("\\n")[1] || ${alias(select)}.data.message}}`});edge(selectedOK,selected,'yes');edge(selected,bookingEnd);

const confirm=buttons('Confirm the booking','{{selected_summary.split("Reply")[0].trim()}}\n\nTap Confirm booking to reserve this time.',['Confirm booking','Not now','Talk to team']);edge(isSlot,confirm,'no');
const confirmTimeout=save('Confirmation timed out',{halted:'exit'});edge(confirm,confirmTimeout,'no-response');edge(confirmTimeout,bookingEnd);
const confirmExit=save('Customer chose not to book',{halted:'exit'});edge(confirm,confirmExit,'BUTTON_2');edge(confirmExit,bookingEnd);
const confirmHuman=save('Customer requested the team',{halted:'human',final_message:'Our team will help you complete the booking.'});edge(confirm,confirmHuman,'BUTTON_3');edge(confirmHuman,bookingEnd);
const book=api('Create booking once',`/v1/sessions/${sessionId}/book`,{confirmed:'{{true}}',confirmationToken:'{{confirmation_value}}'});book.data.headers.push({key:'Idempotency-Key',value:'inbound-{{confirmation_value}}'});edge(confirm,book,'BUTTON_1');
const booked=split('Meeting confirmed with a Meet link',`{{${alias(book)}.data.status === "confirmed" && !!${alias(book)}.data.data?.meetUrl}}`);edge(book,booked);
const bookingSaved=save('Remember confirmed booking',{attempt_status:'confirmed',meeting_link:ref(book,'data.data.meetUrl'),booking_id:ref(book,'data.data.bookingId')});edge(booked,bookingSaved,'yes');edge(bookingSaved,bookingEnd);
const retryableConflict=split('Selected slot was taken before booking',`{{["slot_unavailable","slot_expired"].includes(${alias(book)}.data.status) && ${alias(book)}.data.data?.canReselect === true}}`);edge(booked,retryableConflict,'no');
const retryBooking=save('Return to date selection after slot conflict',{booking_stage:'date',slot_page:0,date_prompt:`{{${alias(book)}.data.message || "That time was just taken."}} Please choose another date.`,final_message:ref(book,'data.message')});edge(retryableConflict,retryBooking,'yes');edge(retryBooking,bookingEnd);
const bookingFailed=save('Booking requires team review',{halted:'human',final_message:`{{${alias(book)}.data.message || "We could not confirm the meeting automatically."}} Please do not submit another booking.`});edge(retryableConflict,bookingFailed,'no');edge(bookingFailed,bookingEnd);

const completed=split('Booking completed successfully','{{attempt_status === "confirmed"}}');edge(bookingEnd,completed);
const success=text('Send confirmed meeting','Your meeting is confirmed.\n\n{{selected_slot}}\n\nGoogle Meet: {{meeting_link}}\nBooking reference: {{booking_id}}');edge(completed,success,'yes');edge(success,end);
const exited=split('Customer exited without booking','{{halted === "exit"}}');edge(completed,exited,'no');edge(exited,exit,'yes');
const review=text('Explain before human handoff','{{final_message || "Our team will help you complete the booking."}}');edge(exited,review,'no');edge(review,human);

const layout=new dagre.graphlib.Graph().setGraph({rankdir:'TB',ranksep:100,nodesep:90}).setDefaultEdgeLabel(()=>({}));
for(const n of nodes)layout.setNode(n.id,{width:300,height:150});
for(const e of edges)layout.setEdge(e.source,e.target);
dagre.layout(layout);
for(const n of nodes){const p=layout.node(n.id);n.position={x:Math.round(p.x-150),y:Math.round(p.y-75)};}
writeFileSync(output,JSON.stringify({_nodes:nodes,_edges:edges},null,2)+'\n',{mode:0o600});
console.log(`Generated ${nodes.length} nodes and ${edges.length} edges`);
