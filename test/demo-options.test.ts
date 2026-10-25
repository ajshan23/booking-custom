import {test} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {config} from './helpers.js';
import type {BookingService} from '../src/service.js';
test('demo list is public static data and needs no calendar service',async()=>{
 const app=createApp(config,{} as BookingService,{connectUrl:async()=>'',callback:async()=>{}});
 const result=await request(app).get('/demo/list-options').expect(200);
 assert.equal(result.headers['access-control-allow-origin'],'*');
 await request(app).options('/demo/list-options').set('Origin','http://localhost:3000').set('Access-Control-Request-Headers','ngrok-skip-browser-warning').expect(204).expect('Access-Control-Allow-Headers','ngrok-skip-browser-warning');
 assert.equal(result.body.items.length,3);
 assert.equal(new Set(result.body.items.map((r:any)=>r.id)).size,3);
 for(const row of result.body.items){assert.ok(row.title.length<=24);assert.ok(row.description.length<=72);}
 await request(app).get('/v1/admin/settings').expect(401);
});
